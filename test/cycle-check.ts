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
    return { symbol: pair, last: this.prices[pair], quoteVolume: 250_000 };
  }
  async fetchTickers(pairs: string[]) {
    return Object.fromEntries(pairs.filter(p => this.ensure(p))
      .map(p => [p, { symbol: p, last: this.prices[p], quoteVolume: 250_000 }]));
  }
  async fetchOHLCV(pair: string, _tf: string, _since: unknown, _limit: number) {
    if (!this.ensure(pair)) throw new ccxt.BadSymbol(`no candles ${pair}`);
    // Anchored to now so the preflight's candle-freshness check sees live data.
    const offset = Date.now() - 200 * hour;
    return bouncing(pair.length, this.prices[pair])
      .map(c => [c.timestamp + offset, c.open, c.high, c.low, c.close, c.volume]);
  }
  async fetchBalance() { return this.balance; }
  async fetchOrder(id: string) { return this.placed.get(id); }

  private placed = new Map<string, FakeOrder>();
  private record(side: 'buy' | 'sell', pair: string, amount: number): FakeOrder {
    this.orders.push({ side, pair, amount });
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
  { stance, cashTargetPct = 0, requestedFundsUsd = 0 }: {
    stance?: 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF'; cashTargetPct?: number; requestedFundsUsd?: number;
  } = {},
) => ({
  async analyze() {
    return { verdict, confidence: 8, reasoning: 'test', positionSizePct: sizePct, adjustedStop: null, adjustedTarget: null };
  },
  async review() {
    return { verdict: 'HOLD' as const, confidence: 5, reasoning: 'test', positionSizePct: 0, adjustedStop: null, adjustedTarget: null };
  },
  async reviewPortfolio() {
    return { stance: stance ?? 'NEUTRAL', confidence: 7, reasoning: 'test stance', cashTargetPct, requestedFundsUsd };
  },
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

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('cycle checks passed');
}

main().catch(e => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
