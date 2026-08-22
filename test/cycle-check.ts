import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ccxt from 'ccxt';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-cycle-'));
process.env.DATA_DIR = stateDir;
process.env.PAPER_MODE = 'true';
process.env.PORTFOLIO_VALUE = '1000';
process.env.AI_DECISIONS_PER_CYCLE = '1';
process.env.TRAILING_STOP_ATR_MULT = '2.5';
process.env.BREAKEVEN_AT_R = '1';

const hour = 3_600_000;

/** Deterministic candles: a downtrend that bottoms out and turns up. */
function bouncing(seed: number, lastClose?: number) {
  const candles = Array.from({ length: 200 }, (_, i) => {
    const decline = Math.max(0, 60 - i) * 0.4;
    const base = 100 - decline + Math.sin((i + seed) / 7) * 2 + i * 0.02;
    return {
      timestamp: i * hour, open: base - 0.2, high: base + 1.2,
      low: base - 1.2, close: base, volume: 1000 + ((i + seed) % 11) * 50,
    };
  });
  if (lastClose !== undefined) candles[candles.length - 1].close = lastClose;
  return candles;
}

interface FakeOrder { id: string; status: string; filled: number; amount: number; average: number; cost: number; fee: { cost: number; currency: string } }

/** Minimal Kraken stand-in: enough surface for a full cycle, fully deterministic. */
class FakeKraken {
  has = { fetchTickers: true };
  markets: Record<string, any> = {};
  prices: Record<string, number> = {};
  balance: any = { USD: { free: 0, used: 0, total: 0 } };
  orders: Array<{ side: string; pair: string; amount: number }> = [];
  /** Fraction of each sell that fills; 1 means a complete fill. */
  sellFillRatio = 1;
  loadMarketsCalls = 0;

  /** Pairs deliberately withheld, to exercise the unlisted-market check. */
  delisted = new Set<string>();

  constructor(public pairs: string[]) {
    for (const pair of pairs) this.ensure(pair);
  }

  /** Markets and prices materialise on demand, so any BASE/USD pair resolves. */
  private ensure(pair: string) {
    if (this.delisted.has(pair)) return null;
    if (!this.markets[pair]) {
      const [base, quote] = pair.split('/');
      this.markets[pair] = {
        symbol: pair, base, quote, active: true, spot: true,
        precision: { amount: 8 }, limits: { amount: { min: 0.0001 }, cost: { min: 5 } },
      };
      this.prices[pair] = bouncing(pair.length)[199].close;
    }
    return this.markets[pair];
  }

  async loadMarkets() { this.loadMarketsCalls++; return this.markets; }
  market(pair: string) {
    const m = this.ensure(pair);
    if (!m) throw new ccxt.BadSymbol(`no market ${pair}`);
    return m;
  }
  amountToPrecision(_pair: string, qty: number) { return String(Math.floor(qty * 1e8) / 1e8); }
  async fetchTicker(pair: string) {
    if (!this.ensure(pair)) throw new ccxt.BadSymbol(`no ticker ${pair}`);
    const last = this.prices[pair];
    return { symbol: pair, last, high: last * 1.05, low: last * 0.95, percentage: 1, quoteVolume: 250_000 };
  }
  async fetchTickers(pairs: string[]) {
    return Object.fromEntries(pairs.filter(p => this.ensure(p))
      .map(p => {
        const last = this.prices[p];
        return [p, { symbol: p, last, high: last * 1.05, low: last * 0.95, percentage: 1, quoteVolume: 250_000 }];
      }));
  }
  async fetchOHLCV(pair: string, _tf: string, _since: unknown, _limit: number) {
    if (!this.ensure(pair)) throw new ccxt.BadSymbol(`no candles ${pair}`);
    // Anchored to now so the preflight's candle-freshness check sees live data.
    const offset = Date.now() - 200 * hour;
    return bouncing(pair.length, this.prices[pair])
      .map(c => [c.timestamp + offset, c.open, c.high, c.low, c.close, c.volume]);
  }
  balanceFetches = 0;
  // A snapshot, not a live reference — otherwise a cached balance would silently
  // track later fills and stale-snapshot bugs would be invisible to these tests.
  async fetchBalance() {
    this.balanceFetches++;
    return JSON.parse(JSON.stringify(this.balance));
  }
  async fetchOrder(id: string) { return this.placed.get(id); }

  private placed = new Map<string, FakeOrder>();
  private record(side: 'buy' | 'sell', pair: string, amount: number): FakeOrder {
    this.orders.push({ side, pair, amount });
    // Fills move the real balance, exactly as Kraken would.
    const base = pair.split('/')[0];
    const held = this.balance[base]?.total ?? 0;
    const delta = side === 'buy' ? amount : -amount;
    if (this.balance[base] || side === 'buy')
      this.balance[base] = { free: held + delta, used: 0, total: held + delta };
    const filled = side === 'sell' ? amount * this.sellFillRatio : amount;
    const price = this.prices[pair];
    const order: FakeOrder = {
      id: `o${this.placed.size + 1}`, status: 'closed', filled, amount,
      average: price, cost: filled * price,
      fee: { cost: filled * price * 0.0026, currency: 'USD' },
    };
    this.placed.set(order.id, order);
    return order;
  }
  async createMarketBuyOrder(pair: string, amount: number) { return this.record('buy', pair, amount); }
  async createMarketSellOrder(pair: string, amount: number) { return this.record('sell', pair, amount); }
}

const fakeAi = (
  verdict: 'BUY' | 'HOLD' | 'SELL',
  sizePct = 20,
  {
    stance, cashTargetPct = 0, requestedFundsUsd = 0, reviewVerdict,
    trimFraction = 1, reviewSizePct = 0, verdictHolds = true, secondLookConfirms = true,
  }: {
    stance?: 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF'; cashTargetPct?: number; requestedFundsUsd?: number;
    reviewVerdict?: 'HOLD' | 'SELL' | 'BUY'; trimFraction?: number; reviewSizePct?: number;
    verdictHolds?: boolean; secondLookConfirms?: boolean;
  } = {},
) => ({
  async analyze() {
    return {
      verdict, confidence: 8, reasoning: 'test', positionSizePct: sizePct,
      adjustedStop: null, adjustedTarget: null, trimFraction: 1, alertPrice: null,
      salvaged: false, counterCase: 'test counter', verdictHolds,
    };
  },
  async review() {
    return {
      verdict: reviewVerdict ?? ('HOLD' as const), confidence: 8, reasoning: 'test',
      positionSizePct: reviewSizePct, adjustedStop: null, adjustedTarget: null,
      trimFraction, alertPrice: null, salvaged: false, counterCase: 'test counter', verdictHolds,
    };
  },
  async reviewPortfolio() {
    return { stance: stance ?? 'NEUTRAL', confidence: 7, reasoning: 'test stance', counterCase: '', cashTargetPct, requestedFundsUsd };
  },
  async checkMoverNews() {
    return '';
  },
  usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
  async reconsiderSell() {
    return { confirmed: secondLookConfirms, reasoning: 'test second look' };
  },
  activeModel: () => 'fake-model',
  async selfTest(samples: number) {
    return { valid: samples, salvaged: 0, total: samples, finishReasons: { stop: samples }, avgLatencyMs: 12, budget: 4000, lastError: '' };
  },
}) as any;

async function main() {
  const bot = await import('../src/index');
  const { Exchange, Memory, runCycle, setConfig, loadConfig } = bot;
  setConfig(loadConfig());

  const pairs = ['SOL/USD', 'LINK/USD', 'ONDO/USD'];
  const fake = new FakeKraken(pairs);
  (ccxt as any).kraken = function () { return fake; };

  // ── A paper cycle opens exactly one position and debits simulated cash ──────
  const exchange = new Exchange(undefined, undefined, true);
  const mem = new Memory();
  const startingCash = mem.paperCash();
  assert.equal(startingCash, 1000);

  await runCycle(exchange, mem, fakeAi('BUY', 20));

  const open = mem.getOpenPositions();
  assert.equal(open.length, 1, 'AI_DECISIONS_PER_CYCLE=1 permits exactly one entry');
  const position = open[0];
  assert.ok(position.costBasisUsd > 0);
  // 20% of a $1000 portfolio.
  assert.ok(Math.abs(position.costBasisUsd - 200) < 1, `unexpected size ${position.costBasisUsd}`);
  assert.ok(position.stopLoss < position.entryPrice, 'the stop sits below the entry');
  assert.ok(position.takeProfit > position.entryPrice);
  assert.equal(position.initialStopLoss, position.stopLoss);
  assert.equal(position.highWaterMark, position.entryPrice);
  assert.ok(position.entryAtr! > 0, 'the ATR at entry is recorded for the trail');
  // Risk is bounded by the configured cap rather than left to chance.
  const riskPct = (position.entryPrice - position.stopLoss) / position.entryPrice;
  assert.ok(riskPct > 0 && riskPct <= 0.15 + 1e-9, `risk ${riskPct} exceeds the cap`);
  assert.ok(Math.abs(mem.paperCash() - (startingCash - position.costBasisUsd)) < 1e-6,
    'paper cash is debited by the actual cost');

  // ── A rally trails the stop up without selling ─────────────────────────────
  // Memory hands out live objects, so the values under test have to be snapshotted
  // before the next cycle mutates them in place.
  const entryStop = position.stopLoss;
  const entry = position.entryPrice;
  // Far enough to trip the +1R ratchet, but short of the take-profit so the exit
  // under test is the trail rather than the target.
  const rallied = Math.min(entry + (entry - entryStop) * 1.5, position.takeProfit * 0.98);
  assert.ok(rallied >= entry + (entry - entryStop), 'the rally must clear +1R');
  assert.ok(rallied < position.takeProfit);
  fake.prices[position.pair] = rallied;
  await runCycle(exchange, mem, fakeAi('HOLD'));

  const trailed = mem.positions[position.pair];
  assert.equal(trailed.status, 'open', 'a rally is not an exit');
  assert.ok(trailed.stopLoss > entryStop, 'the stop ratcheted upward');
  assert.ok(trailed.stopLoss >= entry, 'at +3R the stop is at or above breakeven');
  assert.ok(trailed.stopLoss < rallied, 'the stop never reaches the market price');
  assert.equal(trailed.highWaterMark, rallied);
  assert.equal(trailed.initialStopLoss, entryStop, 'the original risk stays on record');

  // ── A pullback into the trailed stop exits and books the win ───────────────
  const trailedStop = trailed.stopLoss;
  fake.prices[position.pair] = trailedStop * 0.995;
  await runCycle(exchange, mem, fakeAi('HOLD'));

  const closed = mem.positions[position.pair];
  assert.equal(closed.status, 'closed');
  assert.ok(closed.pnlUsd! > 0, `the trail should protect a profit, got ${closed.pnlUsd}`);
  assert.equal(mem.state.wins, 1);
  assert.equal(mem.state.totalTrades, 1);
  assert.equal(mem.state.recentTrades.length, 1);
  assert.ok(mem.paperCash() > startingCash, 'a winning round trip grows paper cash');
  assert.ok(Math.abs(mem.state.totalPnl - closed.pnlUsd!) < 1e-6);

  const csv = fs.readFileSync(path.join(stateDir, 'trades.csv'), 'utf-8').trim().split('\n');
  assert.equal(csv.length, 3, 'header, buy, sell');
  assert.equal(csv[0].split(',').length, csv[1].split(',').length, 'columns stay aligned');

  // ── Live mode: a partial fill leaves the residual open ─────────────────────
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const live = new Exchange('key', 'secret', false);
  const liveMem = new Memory();
  const pair = 'SOL/USD';
  const price = fake.prices[pair];

  // Kraken reports the coins, so reconciliation imports them as a position.
  fake.balance = {
    USD: { free: 500, used: 0, total: 500 },
    SOL: { free: 10, used: 0, total: 10 },
  };
  fake.sellFillRatio = 0.4;
  await live.reconcilePositions(liveMem);
  const imported = liveMem.positions[pair];
  assert.ok(imported, 'the Kraken balance is imported as a position');
  assert.equal(imported.qty, 10);

  // Force a stop-out, but let only 40% of the sell fill.
  imported.stopLoss = price * 1.5;
  liveMem.savePositions();
  await runCycle(live, liveMem, fakeAi('HOLD'));

  const residual = liveMem.positions[pair];
  assert.equal(residual.status, 'open', 'a partially filled exit is not a closed position');
  assert.ok(Math.abs(residual.qty - 6) < 1e-6, `expected 6 units left, got ${residual.qty}`);
  assert.ok(Math.abs(residual.costBasisUsd - imported.entryPrice * 6) < 0.5,
    'the cost basis shrinks with the quantity sold');
  assert.equal(liveMem.state.totalTrades, 0, 'a partial exit is not a completed trade');
  assert.ok(residual.bookedPnlUsd !== 0, 'the sold share is realised immediately');

  // The next cycle finishes the job once fills are complete again.
  fake.sellFillRatio = 1;
  fake.balance.SOL = { free: 6, used: 0, total: 6 };
  await runCycle(live, liveMem, fakeAi('HOLD'));
  assert.equal(liveMem.positions[pair].status, 'closed', 'the residual exits on the retry');
  assert.equal(liveMem.state.totalTrades, 1);

  assert.ok(fake.loadMarketsCalls <= 2, `markets loaded ${fake.loadMarketsCalls} times; it should be memoised`);

  // ── Preflight passes against a healthy exchange ────────────────────────────
  const { runPreflight } = bot;
  const named = (checks: any[], name: string) => checks.find(c => c.name === name)!;

  fake.balance = { USD: { free: 500, used: 0, total: 500 } };
  const healthyMem = new Memory();
  const healthy = await runPreflight(live, healthyMem, fakeAi('HOLD'), 2);
  for (const check of healthy)
    assert.ok(check.ok, `${check.name} should pass on a healthy exchange: ${check.detail}`);
  assert.match(named(healthy, 'Market data').detail, /pairs analysable/);
  assert.match(named(healthy, 'Buying power').detail, /entries are possible/);
  assert.match(named(healthy, 'AI decisions').detail, /2\/2 clean/);

  // ── A watchlist pair Kraken does not list is caught, not silently skipped ──
  bot.setConfig({ ...bot.loadConfig(), scanUniverse: 'watchlist' });
  fake.delisted.add('HYPE/USD');
  delete fake.markets['HYPE/USD'];
  const delisted = await runPreflight(live, new Memory(), fakeAi('HOLD'), 0);
  const markets = named(delisted, 'Kraken markets');
  assert.equal(markets.ok, false);
  assert.equal(markets.critical, true);
  assert.match(markets.detail, /HYPE\/USD/);
  fake.delisted.delete('HYPE/USD');

  // ── A position too small to sell means its stop can never execute ──────────
  const strandedMem = new Memory();
  const stranded = 'LINK/USD';
  strandedMem.openPosition(stranded, 0.00002, fake.prices[stranded], 1, 999, 'defi', 'dust', 'dust');
  const strandedChecks = await runPreflight(live, strandedMem, fakeAi('HOLD'), 0);
  const exits = named(strandedChecks, 'Exit reachability');
  assert.equal(exits.ok, false, 'an unsellable position must be reported');
  assert.equal(exits.critical, true);
  assert.match(exits.detail, /LINK\/USD/);

  // ── An account with no free cash cannot fund entries, and says so ──────────
  // This is the state the deployed bot was actually in: $0.05 free against a
  // $203 portfolio, spending AI calls on entries it could never place.
  fake.balance = { USD: { free: 0.05, used: 0, total: 0.05 }, SOL: { free: 2, used: 0, total: 2 } };
  const brokeChecks = await runPreflight(live, new Memory(), fakeAi('HOLD'), 0);
  const buyingPower = named(brokeChecks, 'Buying power');
  assert.equal(buyingPower.ok, false);
  assert.equal(buyingPower.critical, false, 'no cash is a warning, not a reason to stop managing positions');
  assert.match(buyingPower.detail, /no new entry can be funded/);
  // And the balance is reported honestly rather than counting holdings as cash.
  assert.match(named(brokeChecks, 'Account balance').detail, /\$0\.0500 free cash \| \$20[0-9.]+ tradable/);

  // ── Dust left over from a sale is not imported as a position ──────────────
  // Production imported a $0.00002 WLD remnant, then closed it on the same pass
  // and wrote a meaningless trade to the record.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = {
    USD: { free: 100, used: 0, total: 100 },
    LINK: { free: 0.0000004, used: 0, total: 0.0000004 },
  };
  const dustMem = new Memory();
  await live.reconcilePositions(dustMem);
  assert.equal(dustMem.getOpenPositions().length, 0, 'dust must not become a position');
  assert.equal(dustMem.state.totalTrades, 0, 'and must not be recorded as a trade');

  // ── RISK_OFF means the model declines to deploy capital this cycle ─────────
  // The whole point of the stance call: it can sit in cash and wait for lower
  // prices instead of being forced to answer one pair at a time.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 1000, used: 0, total: 1000 } };
  const paper = new Exchange(undefined, undefined, true);
  const riskOffMem = new Memory();
  await runCycle(paper, riskOffMem, fakeAi('BUY', 20, { stance: 'RISK_OFF' }));
  assert.equal(riskOffMem.getOpenPositions().length, 0,
    'RISK_OFF must block new entries even when the per-pair verdict is BUY');
  assert.equal(riskOffMem.state.lastStance?.stance, 'RISK_OFF', 'the stance is remembered across cycles');

  // ── Dry powder is withheld from buys ───────────────────────────────────────
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const reserveMem = new Memory();
  const reserveStart = reserveMem.paperCash();
  await runCycle(paper, reserveMem, fakeAi('BUY', 90, { stance: 'RISK_ON', cashTargetPct: 0.6 }));
  const reserved = reserveMem.getOpenPositions();
  assert.equal(reserved.length, 1);
  // 90% of the portfolio was requested, but 60% is held back for a dip.
  assert.ok(reserved[0].costBasisUsd <= reserveStart * 0.4 + 1,
    `spent ${reserved[0].costBasisUsd} despite a 60% cash reserve`);
  assert.ok(reserved[0].costBasisUsd > 0);

  // ── A funding request survives restarts until it is actually funded ────────
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const fundingMem = new Memory();
  await runCycle(paper, fundingMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL', requestedFundsUsd: 750 }));
  assert.equal(fundingMem.state.fundingRequest?.usd, 750, 'the request is recorded');
  assert.equal(new Memory().state.fundingRequest?.usd, 750, 'and survives a restart');
  // It clears itself once that much cash is actually available.
  fundingMem.clearFundingRequestIfFunded(100);
  assert.equal(fundingMem.state.fundingRequest?.usd, 750, 'a partial top-up does not clear it');
  fundingMem.clearFundingRequestIfFunded(750);
  assert.equal(fundingMem.state.fundingRequest, null);

  // ── The model can trim a position to raise cash toward its target ─────────
  // A cash target that can only block buying is half a lever: when the account is
  // already invested, selling is the only route to it.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const trimMem = new Memory();
  const trimPair = 'SOL/USD';
  const trimPrice = fake.prices[trimPair];
  // Sized so the account still holds real cash; otherwise this would only be
  // exercising the zero-cash edge.
  trimMem.openPosition(trimPair, 2, trimPrice, trimPrice * 0.8, trimPrice * 1.5, 'l1', 'seed', 'seed');
  const cashBefore = trimMem.paperCash();
  assert.ok(cashBefore > 0, 'the scenario must start with cash on hand');

  // A standing stance asking for cash the account does not hold.
  trimMem.recordStance({ stance: 'NEUTRAL', confidence: 7, reasoning: 'raise cash', cashTargetPct: 0.5, requestedFundsUsd: 0 });
  await runCycle(paper, trimMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL', cashTargetPct: 0.5, reviewVerdict: 'SELL', trimFraction: 0.4 }));

  const trimmedPosition = trimMem.positions[trimPair];
  assert.equal(trimmedPosition.status, 'open', 'a trim keeps the position open');
  assert.ok(Math.abs(trimmedPosition.qty - 1.2) < 1e-6, `expected 1.2 units left, got ${trimmedPosition.qty}`);
  assert.ok(Math.abs(trimmedPosition.costBasisUsd - trimPrice * 1.2) < 1e-6,
    'the cost basis shrinks in proportion');
  assert.ok(Math.abs(trimMem.paperCash() - (cashBefore + trimPrice * 0.8)) < 1e-6,
    'proceeds from the 0.8 units sold land in cash');
  assert.ok(trimMem.paperCash() > cashBefore, 'the sale actually raised cash');
  assert.equal(trimMem.state.totalTrades, 0, 'a trim is not a completed trade');

  // A full SELL still closes the whole thing.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const exitMem = new Memory();
  exitMem.openPosition(trimPair, 2, trimPrice, trimPrice * 0.8, trimPrice * 1.5, 'l1', 'seed', 'seed');
  await runCycle(paper, exitMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL', reviewVerdict: 'SELL', trimFraction: 1 }));
  assert.equal(exitMem.positions[trimPair].status, 'closed', 'trim_pct of 100 exits fully');
  assert.equal(exitMem.state.totalTrades, 1);

  // ── A position under the exchange minimum is topped up so its stop can fire ──
  // Production found MORPHO/USD holding 1.7602 units against a 2.5 minimum: the
  // bot reported a stop that Kraken would have rejected the moment it triggered.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const strandPair = 'ONDO/USD';
  fake.markets[strandPair].limits.amount.min = 2.5;
  const strandPrice = fake.prices[strandPair];
  const strandedLive = new Memory();
  strandedLive.openPosition(strandPair, 1.7602, strandPrice, strandPrice * 0.9, strandPrice * 1.2, 'rwa', 'seed', 'seed');

  const before = await live.checkSellable(strandPair, 1.7602, strandPrice);
  assert.equal(before.ok, false, 'the position starts unsellable');

  // A repair costs about one exchange minimum; the account must be large enough
  // that this stays inside the TOPUP_MAX_PCT cap.
  fake.balance = { USD: { free: 20000, used: 0, total: 20000 }, ONDO: { free: 1.7602, used: 0, total: 1.7602 } };
  const buysBefore = fake.orders.filter(o => o.side === 'buy').length;
  fake.balanceFetches = 0;
  await runCycle(live, strandedLive, fakeAi('HOLD', 0, { stance: 'NEUTRAL' }));

  const restored = strandedLive.positions[strandPair];
  assert.ok(restored.qty >= 2.5, `expected the holding lifted to at least 2.5, got ${restored.qty}`);
  assert.equal((await live.checkSellable(strandPair, restored.qty, strandPrice)).ok, true,
    'the stop must be executable after the top-up');
  assert.ok(fake.orders.filter(o => o.side === 'buy').length > buysBefore, 'a buy was actually placed');
  // The average entry re-bases on total cost so P/L stays honest.
  assert.ok(Math.abs(restored.entryPrice - restored.costBasisUsd / restored.qty) < 1e-9);
  // A Phase 1 top-up spends cash, so the balance must be refetched before Phase 3
  // sizes anything against it.
  assert.ok(fake.balanceFetches > 1, 'the balance is refreshed after a Phase 1 buy');

  // A stop firing in the same cycle as the repair must sell the *restored* size.
  // Production topped MORPHO up to 4.26 units, then tried to sell 1.7602 — the
  // pre-repair quantity from a stale balance snapshot — and Kraken rejected it.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 20000, used: 0, total: 20000 }, ONDO: { free: 1.7602, used: 0, total: 1.7602 } };
  const stopAfterTopUp = new Memory();
  // Stop sits above the market, so it triggers the moment the repair completes.
  stopAfterTopUp.openPosition(strandPair, 1.7602, strandPrice, strandPrice * 1.05, strandPrice * 2, 'rwa', 'seed', 'seed');
  const sellsBefore = fake.orders.filter(o => o.side === 'sell' && o.pair === strandPair).length;
  await runCycle(live, stopAfterTopUp, fakeAi('HOLD', 0, { stance: 'NEUTRAL' }));
  const exitSells = fake.orders.filter(o => o.side === 'sell' && o.pair === strandPair);
  assert.ok(exitSells.length > sellsBefore, 'the stop must actually place a sell');
  assert.ok(exitSells[exitSells.length - 1].amount >= 2.5,
    `the sell must use the restored size, got ${exitSells[exitSells.length - 1].amount}`);
  assert.equal(stopAfterTopUp.positions[strandPair].status, 'closed', 'and the position actually exits');

  // A repair that would dominate the account is refused: restoring an exit is
  // defensive, buying a much larger position is not.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 400, used: 0, total: 400 }, ONDO: { free: 1.7602, used: 0, total: 1.7602 } };
  const cappedMem = new Memory();
  cappedMem.openPosition(strandPair, 1.7602, strandPrice, strandPrice * 0.9, strandPrice * 1.2, 'rwa', 'seed', 'seed');
  const buysBeforeCap = fake.orders.filter(o => o.side === 'buy').length;
  await runCycle(live, cappedMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL' }));
  assert.ok(Math.abs(cappedMem.positions[strandPair].qty - 1.7602) < 1e-9,
    'an oversized repair must be refused');
  assert.equal(fake.orders.filter(o => o.side === 'buy').length, buysBeforeCap);

  // With no cash it must warn rather than silently leave a fake stop in place.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 0, used: 0, total: 0 }, ONDO: { free: 1.7602, used: 0, total: 1.7602 } };
  const brokeStranded = new Memory();
  brokeStranded.openPosition(strandPair, 1.7602, strandPrice, strandPrice * 0.9, strandPrice * 1.2, 'rwa', 'seed', 'seed');
  const buysBeforeBroke = fake.orders.filter(o => o.side === 'buy').length;
  await runCycle(live, brokeStranded, fakeAi('HOLD', 0, { stance: 'NEUTRAL' }));
  assert.ok(Math.abs(brokeStranded.positions[strandPair].qty - 1.7602) < 1e-9,
    'without cash the position is left untouched');
  assert.equal(fake.orders.filter(o => o.side === 'buy').length, buysBeforeBroke, 'and no order is placed');
  fake.markets[strandPair].limits.amount.min = 0.0001;

  // ── A full exit clears the whole balance, leaving no dust ─────────────────
  // The live account accumulated WLD, RENDER and UNI remnants worth fractions of
  // a cent because exits sold the remembered quantity while the exchange held
  // slightly more.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const dustPair = 'LINK/USD';
  const dustPrice = fake.prices[dustPair];
  // Memory says 5 units; the exchange actually holds slightly more.
  fake.balance = { USD: { free: 500, used: 0, total: 500 }, LINK: { free: 5.00004, used: 0, total: 5.00004 } };
  const exitAllMem = new Memory();
  exitAllMem.openPosition(dustPair, 5, dustPrice, dustPrice * 1.05, dustPrice * 2, 'defi', 'seed', 'seed');
  const sellsBeforeExit = fake.orders.filter(o => o.side === 'sell' && o.pair === dustPair).length;
  await runCycle(live, exitAllMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL' }));
  const dustSells = fake.orders.filter(o => o.side === 'sell' && o.pair === dustPair);
  assert.ok(dustSells.length > sellsBeforeExit, 'the stop placed a sell');
  assert.ok(Math.abs(dustSells[dustSells.length - 1].amount - 5.00004) < 1e-9,
    `a full exit must sell the entire balance, sold ${dustSells[dustSells.length - 1].amount}`);
  assert.ok(Math.abs((fake.balance.LINK?.total ?? 0)) < 1e-9, 'nothing is left behind');

  // ── An alert wakes the model instead of selling ───────────────────────────
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const alertPair = 'ADA/USD';
  const alertPrice = fake.prices[alertPair];
  fake.balance = { USD: { free: 500, used: 0, total: 500 }, ADA: { free: 4, used: 0, total: 4 } };
  const alertMem = new Memory();
  // Alert sits just above the market; the hard stop is well below it.
  alertMem.openPosition(alertPair, 4, alertPrice * 1.1, alertPrice * 0.8, alertPrice * 2,
    'l1', 'seed', 'seed', 0, null, alertPrice * 1.02);
  const sellsBeforeAlert = fake.orders.filter(o => o.side === 'sell' && o.pair === alertPair).length;
  await runCycle(live, alertMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL' }));
  const alerted = alertMem.positions[alertPair];
  assert.equal(alerted.status, 'open', 'an alert must not sell the position');
  assert.equal(fake.orders.filter(o => o.side === 'sell' && o.pair === alertPair).length, sellsBeforeAlert,
    'no exit order is placed by an alert');
  assert.equal(alerted.alertPrice, null, 'the alert is consumed once it fires');
  assert.ok(alerted.lastReviewedAt, 'and the position was actually reviewed');

  // ── The model can add to a position it is shown ───────────────────────────
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 500, used: 0, total: 500 }, ADA: { free: 4, used: 0, total: 4 } };
  const addMem = new Memory();
  addMem.openPosition(alertPair, 4, alertPrice, alertPrice * 0.8, alertPrice * 2, 'l1', 'seed', 'seed');
  const qtyBeforeAdd = addMem.positions[alertPair].qty;
  await runCycle(live, addMem, fakeAi('HOLD', 0, { stance: 'NEUTRAL', reviewVerdict: 'BUY', reviewSizePct: 20 }));
  const added = addMem.positions[alertPair];
  assert.ok(added.qty > qtyBeforeAdd, `adding must increase the position, ${qtyBeforeAdd} → ${added.qty}`);
  assert.ok(Math.abs(added.entryPrice - added.costBasisUsd / added.qty) < 1e-9,
    'the average entry re-bases on total cost');
  assert.equal(added.status, 'open');

  // ── A withdrawn verdict is not traded ─────────────────────────────────────
  // The self-check has to have teeth: arguing itself out of a trade must stop the
  // trade, not just print a nice sentence next to it.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 1000, used: 0, total: 1000 } };
  const withdrawnMem = new Memory();
  const buysBeforeWithdrawn = fake.orders.filter(o => o.side === 'buy').length;
  await runCycle(paper, withdrawnMem, fakeAi('BUY', 25, { stance: 'RISK_ON', verdictHolds: false }));
  assert.equal(withdrawnMem.getOpenPositions().length, 0, 'a withdrawn BUY must not open anything');
  assert.equal(fake.orders.filter(o => o.side === 'buy').length, buysBeforeWithdrawn, 'and places no order');

  // The same decision, kept, does trade — proving it was the withdrawal that stopped it.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const keptMem = new Memory();
  await runCycle(paper, keptMem, fakeAi('BUY', 25, { stance: 'RISK_ON', verdictHolds: true }));
  assert.equal(keptMem.getOpenPositions().length, 1, 'the identical decision, kept, opens a position');

  // ── An undersized request is skipped, not rounded up ──────────────────────
  // Rounding an undersized request up to the exchange minimum manufactured
  // positions nobody chose — the source of the ~$5 book.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  const tinyMem = new Memory();
  const buysBeforeTiny = fake.orders.filter(o => o.side === 'buy').length;
  // 0.01% of a $1000 portfolio is $0.10, far under any exchange minimum.
  await runCycle(paper, tinyMem, fakeAi('BUY', 0.01, { stance: 'RISK_ON' }));
  assert.equal(tinyMem.getOpenPositions().length, 0, 'a token-sized request is declined outright');
  assert.equal(fake.orders.filter(o => o.side === 'buy').length, buysBeforeTiny);

  // ── Reserved assets are never traded, even when already held ──────────────
  // The operator's SOL and AVAX must survive a cycle untouched: not adopted as
  // positions, not sold, and not counted as capital the bot can deploy.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  // Earlier scenarios in this file traded SOL, so start the log clean.
  fs.rmSync(path.join(stateDir, 'trades.csv'), { force: true });
  setConfig({ ...loadConfig(), excludedAssets: new Set(['SOL', 'AVAX']) });
  fake.balance = {
    USD: { free: 300, used: 0, total: 300 },
    SOL: { free: 5, used: 0, total: 5 },
    AVAX: { free: 9, used: 0, total: 9 },
    LINK: { free: 2, used: 0, total: 2 },
  };
  const reservedMem = new Memory();
  // Pretend an earlier run had adopted SOL, with a stop sitting above the market
  // so it would certainly be sold if the bot still considered it its own.
  reservedMem.openPosition('SOL/USD', 5, fake.prices['SOL/USD'] * 1.5,
    fake.prices['SOL/USD'] * 1.4, fake.prices['SOL/USD'] * 2, 'l1', 'legacy', 'legacy');
  const ordersBefore = fake.orders.length;
  await runCycle(live, reservedMem, fakeAi('BUY', 25, { stance: 'RISK_ON' }));

  const touched = fake.orders.slice(ordersBefore)
    .filter(o => o.pair === 'SOL/USD' || o.pair === 'AVAX/USD');
  assert.deepEqual(touched, [], 'no order may be placed against a reserved asset');
  assert.equal(reservedMem.positions['SOL/USD'], undefined,
    'the stale position is released from management, not closed as a trade');
  assert.ok(!reservedMem.getOpenPositions().some(p => p.pair === 'SOL/USD'));
  // Releasing must not write a fictitious exit into the record. Other pairs may
  // legitimately trade in the same cycle, so check the log rather than the count.
  const tradeLog = fs.existsSync(path.join(stateDir, 'trades.csv'))
    ? fs.readFileSync(path.join(stateDir, 'trades.csv'), 'utf-8') : '';
  assert.ok(!/SOL\/USD|AVAX\/USD/.test(tradeLog), 'no reserved asset appears in the trade history');
  assert.ok(!reservedMem.state.recentTrades.some(t => t.pair === 'SOL/USD' || t.pair === 'AVAX/USD'));
  // The balances themselves are untouched.
  assert.equal(fake.balance.SOL.total, 5);
  assert.equal(fake.balance.AVAX.total, 9);

  // A direct order is refused outright, whatever asks for it. `fake.orders` is
  // cumulative across this file, so measure only what these two calls placed.
  const beforeDirect = fake.orders.length;
  assert.equal(await live.buy('SOL/USD', 50), null, 'buying a reserved asset is refused');
  assert.equal(await live.sell('SOL/USD', 5), null, 'selling a reserved asset is refused');
  assert.deepEqual(fake.orders.slice(beforeDirect), [], 'neither reached the exchange');
  setConfig(loadConfig());

  // ── What the operator bought is not sold on a whim ────────────────────────
  // Production sold a position with the reasoning "imported position no thesis":
  // it treated "I did not choose this" as a reason to sell.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'trades.csv'), { force: true });
  const ownedPair = 'PENDLE/USD';
  const ownedPrice = fake.prices[ownedPair];
  fake.balance = { USD: { free: 300, used: 0, total: 300 }, PENDLE: { free: 6, used: 0, total: 6 } };
  const ownedMem = new Memory();
  ownedMem.openPosition(ownedPair, 6, ownedPrice, ownedPrice * 0.8, ownedPrice * 2,
    'defi', 'operator buy', 'operator buy', 0, null, null, 'operator');
  const sellsBeforeOwned = fake.orders.filter(o => o.side === 'sell' && o.pair === ownedPair).length;

  // The model wants to sell, but the second look does not confirm.
  await runCycle(live, ownedMem, fakeAi('HOLD', 0,
    { stance: 'NEUTRAL', reviewVerdict: 'SELL', secondLookConfirms: false }));
  assert.equal(ownedMem.positions[ownedPair].status, 'open',
    "an unconfirmed second look must keep the operator's position");
  assert.equal(fake.orders.filter(o => o.side === 'sell' && o.pair === ownedPair).length, sellsBeforeOwned,
    'and place no sell order');

  // The identical decision, confirmed on the second look, does sell — proving it
  // was the second look that saved it, not an accident.
  await runCycle(live, ownedMem, fakeAi('HOLD', 0,
    { stance: 'NEUTRAL', reviewVerdict: 'SELL', secondLookConfirms: true }));
  assert.equal(ownedMem.positions[ownedPair].status, 'closed',
    'a confirmed sell still goes through');

  // A position the bot opened itself needs no second look.
  fs.rmSync(path.join(stateDir, 'positions.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'state.json'), { force: true });
  fake.balance = { USD: { free: 300, used: 0, total: 300 }, PENDLE: { free: 6, used: 0, total: 6 } };
  const botMem = new Memory();
  botMem.openPosition(ownedPair, 6, ownedPrice, ownedPrice * 0.8, ownedPrice * 2,
    'defi', 'bot entry', 'bot entry');
  assert.equal(botMem.positions[ownedPair].origin, 'bot');
  await runCycle(live, botMem, fakeAi('HOLD', 0,
    { stance: 'NEUTRAL', reviewVerdict: 'SELL', secondLookConfirms: false }));
  assert.equal(botMem.positions[ownedPair].status, 'closed',
    "the bot's own position sells without needing a second opinion");

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('cycle checks passed');
}

main().catch(e => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
