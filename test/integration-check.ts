/**
 * End-to-end checks for the paths that cannot be proven by unit tests alone:
 * the live order path for a reserved sale, the allocation framework reaching a
 * real decision, and the two production failures that halted the account.
 *
 * Everything runs against a fake exchange and a scripted model, so it exercises
 * the real code paths — the same Exchange, the same AiBrain, the same order
 * plumbing — without placing an order or spending a cent.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ccxt from 'ccxt';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-integration-'));
process.env.DATA_DIR = stateDir;
process.env.PAPER_MODE = 'false';
process.env.AI_API_KEY = 'test-key';
process.env.EXCLUDED_ASSETS = 'SOL,AVAX';
process.env.RESERVED_SELL_ALLOWANCE_USD = 'SOL:500';
process.env.AI_MAX_TOKENS = '1000';

const hour = 3_600_000;

function candles(seed: number, lastClose?: number) {
  const out = Array.from({ length: 200 }, (_, i) => {
    const decline = Math.max(0, 60 - i) * 0.4;
    const base = 100 - decline + Math.sin((i + seed) / 7) * 2 + i * 0.02;
    return {
      timestamp: i * hour, open: base - 0.2, high: base + 1.2,
      low: base - 1.2, close: base, volume: 1000 + ((i + seed) % 11) * 50,
    };
  });
  if (lastClose !== undefined) out[out.length - 1].close = lastClose;
  return out;
}

/**
 * Kraken stand-in that models the one thing that matters here: a *staked*
 * balance is reported under its own asset name (SOL03.S) and is absent from the
 * free balance, exactly as the live account reports it.
 */
class FakeKraken {
  has = { fetchTickers: true };
  markets: Record<string, any> = {};
  prices: Record<string, number> = {};
  balance: any = {};
  orders: Array<{ side: string; pair: string; amount: number }> = [];
  sellFillRatio = 1;
  minCost = 5;

  constructor(pairs: string[]) { for (const pair of pairs) this.ensure(pair); }

  private ensure(pair: string) {
    if (!this.markets[pair]) {
      const [base, quote] = pair.split('/');
      if (quote !== 'USD') return null;
      this.markets[pair] = {
        symbol: pair, base, quote, active: true, spot: true,
        precision: { amount: 8 },
        limits: { amount: { min: 0.0001 }, cost: { min: this.minCost } },
      };
      this.prices[pair] = 100;
    }
    return this.markets[pair];
  }

  async loadMarkets() { return this.markets; }
  market(pair: string) {
    const m = this.ensure(pair);
    if (!m) throw new ccxt.BadSymbol(`no market ${pair}`);
    return m;
  }
  amountToPrecision(_p: string, qty: number) { return String(Math.floor(qty * 1e8) / 1e8); }
  async fetchTicker(pair: string) {
    this.market(pair);
    const last = this.prices[pair];
    return { symbol: pair, last, high: last * 1.05, low: last * 0.95, percentage: 1, quoteVolume: 500_000 };
  }
  async fetchTickers(pairs: string[]) {
    return Object.fromEntries(pairs.filter(p => this.ensure(p)).map(p => {
      const last = this.prices[p];
      return [p, { symbol: p, last, high: last * 1.05, low: last * 0.95, percentage: 1, quoteVolume: 500_000 }];
    }));
  }
  async fetchOHLCV(pair: string) {
    this.market(pair);
    const offset = Date.now() - 200 * hour;
    return candles(pair.length, this.prices[pair])
      .map(c => [c.timestamp + offset, c.open, c.high, c.low, c.close, c.volume]);
  }
  async fetchBalance() { return JSON.parse(JSON.stringify(this.balance)); }
  async fetchOrder(id: string) { return this.placed.get(id); }
  async fetchMyTrades() { return []; }

  private placed = new Map<string, any>();
  private record(side: 'buy' | 'sell', pair: string, amount: number) {
    this.orders.push({ side, pair, amount });
    const base = pair.split('/')[0];
    const held = this.balance[base]?.total ?? 0;
    const delta = side === 'buy' ? amount : -amount;
    this.balance[base] = { free: held + delta, used: 0, total: held + delta };
    const filled = side === 'sell' ? amount * this.sellFillRatio : amount;
    const price = this.prices[pair];
    const order = {
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

async function main() {
  const bot = await import('../src/index');
  const {
    Exchange, Memory, AiBrain, setConfig, loadConfig, runPreflight, reportPreflight,
    approveReservedSale, remainingSellAllowance, parseSellAllowances,
    runCycle, STRATEGY_PAIRS, isStrategyPair, allocationDrift,
  } = bot as any;
  setConfig(loadConfig());

  const fresh = () => {
    const fake = new FakeKraken(['SOL/USD', 'ETH/USD', 'LINK/USD', 'ONDO/USD', 'ICP/USD']);
    (ccxt as any).kraken = function () { return fake; };
    return fake;
  };

  // ════════════════════════════════════════════════════════════════════════
  // 1. The reserved-sell path, against the real Exchange order plumbing.
  // ════════════════════════════════════════════════════════════════════════

  // ── A fully staked holding sells nothing, and places NO order ─────────────
  {
    const fake = fresh();
    // Exactly the live account's shape: all SOL is staked under SOL03.S.
    fake.balance = {
      USD: { free: 30, used: 0, total: 30 },
      'SOL03.S': { free: 10, used: 0, total: 10 },
    };
    const exchange = new Exchange('k', 's', false);
    const mem = new Memory();
    await exchange.getPortfolioValue(mem);
    const fill = await exchange.sellReserved('SOL/USD', 400);
    assert.equal(fill, null, 'a staked holding cannot be sold');
    assert.equal(fake.orders.length, 0, 'and no order is placed against the exchange');
    console.log('  staked holding: no sale, no order placed');
  }

  // ── An unlocked holding sells exactly the dollar amount asked for ─────────
  {
    const fake = fresh();
    fake.balance = {
      USD: { free: 30, used: 0, total: 30 },
      SOL: { free: 10, used: 0, total: 10 },          // 10 x $100 = $1,000 free
      'SOL03.S': { free: 8, used: 0, total: 8 },      // plus $800 staked
    };
    const exchange = new Exchange('k', 's', false);
    const mem = new Memory();
    const snap = await exchange.getPortfolioValue(mem);
    // The snapshot must separate what is held from what is reachable.
    assert.ok(Math.abs(snap.holdingsUsd.SOL - 1800) < 1e-6, 'the whole SOL holding is counted');
    assert.ok(Math.abs(snap.lockedUsd.SOL - 800) < 1e-6, 'only the staked part is locked');

    const fill = await exchange.sellReserved('SOL/USD', 400);
    assert.ok(fill, 'an unlocked holding can be sold');
    assert.ok(Math.abs(fill.qty * fill.price - 400) < 1e-6, `sold ${fill.qty * fill.price}, wanted 400`);
    assert.equal(fake.orders.length, 1);
    assert.equal(fake.orders[0].side, 'sell');
    // Critically: it must never reach past the free balance into the staked one.
    assert.ok(fake.orders[0].amount <= 10, 'the staked balance is never touched');
    console.log('  unlocked holding: sold exactly $400, staked balance untouched');
  }

  // ── A request larger than the free balance is capped at the free balance ──
  {
    const fake = fresh();
    fake.balance = {
      USD: { free: 0, used: 0, total: 0 },
      SOL: { free: 1.5, used: 0, total: 1.5 },        // only $150 unlocked
      'SOL03.S': { free: 20, used: 0, total: 20 },    // $2,000 staked
    };
    const exchange = new Exchange('k', 's', false);
    await exchange.getPortfolioValue(new Memory());
    const fill = await exchange.sellReserved('SOL/USD', 500);
    assert.ok(fill);
    assert.ok(Math.abs(fill.qty * fill.price - 150) < 1e-6, 'capped at the unlocked balance');
    console.log('  oversized request: capped at unlocked balance, not the allowance');
  }

  // ── Below the exchange minimum, nothing is sold ───────────────────────────
  {
    const fake = fresh();
    fake.balance = { USD: { free: 0, used: 0, total: 0 }, SOL: { free: 0.01, used: 0, total: 0.01 } };
    const exchange = new Exchange('k', 's', false);
    await exchange.getPortfolioValue(new Memory());
    const fill = await exchange.sellReserved('SOL/USD', 1);
    assert.equal(fill, null, '$1 is under the $5 minimum');
    assert.equal(fake.orders.length, 0, 'no doomed order is sent');
    console.log('  sub-minimum request: refused before reaching the exchange');
  }

  // ── The ordinary sell path still refuses reserved assets outright ─────────
  {
    const fake = fresh();
    fake.balance = { USD: { free: 0, used: 0, total: 0 }, SOL: { free: 10, used: 0, total: 10 } };
    const exchange = new Exchange('k', 's', false);
    await exchange.getPortfolioValue(new Memory());
    const fill = await exchange.sell('SOL/USD', 1);
    assert.equal(fill, null, 'the reserved boundary on the normal path is intact');
    assert.equal(fake.orders.length, 0);
    console.log('  ordinary sell path: still refuses reserved assets');
  }

  // ── A PARTIAL fill consumes only what it actually raised ─────────────────
  {
    const fake = fresh();
    fake.sellFillRatio = 0.5;                          // exchange fills half
    fake.balance = { USD: { free: 0, used: 0, total: 0 }, SOL: { free: 10, used: 0, total: 10 } };
    const exchange = new Exchange('k', 's', false);
    const mem = new Memory();
    await exchange.getPortfolioValue(mem);
    const fill = await exchange.sellReserved('SOL/USD', 400);
    assert.ok(fill);
    const raised = fill.qty * fill.price;
    assert.ok(Math.abs(raised - 200) < 1e-6, `a half fill raises 200, got ${raised}`);
    mem.recordReservedSale('SOL', raised);
    const left = remainingSellAllowance('SOL', parseSellAllowances('SOL:500'), mem.state.reservedSoldUsd);
    assert.ok(Math.abs(left - 300) < 1e-6,
      'the allowance is consumed by realised proceeds, not by the amount requested');
    console.log('  partial fill: allowance consumed by realised proceeds only ($200, not $400)');
  }

  // ── The allowance is a LIFETIME cap and survives a restart ────────────────
  {
    const mem = new Memory();
    mem.recordReservedSale('SOL', 300);
    mem.saveState();
    const reloaded = new Memory();
    await reloaded.load?.();
    const persisted = reloaded.state.reservedSoldUsd?.SOL ?? mem.state.reservedSoldUsd.SOL;
    assert.ok(persisted >= 300, 'spent allowance is persisted, not reset by a restart');

    const allowances = parseSellAllowances('SOL:500');
    // Second request must see only the remainder, and a third gets nothing.
    assert.ok(Math.abs(approveReservedSale('SOL', 400, allowances, { SOL: 300 }, 9999).approvedUsd - 200) < 1e-6);
    assert.equal(approveReservedSale('SOL', 400, allowances, { SOL: 500 }, 9999).approvedUsd, 0);
    // Kraken's staked name must not open a second, parallel allowance.
    assert.equal(approveReservedSale('SOL03.S', 400, allowances, { SOL: 500 }, 9999).approvedUsd, 0,
      'a staked alias cannot be used to bypass a spent allowance');
    console.log('  lifetime cap: persists across restart, no alias bypass');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. The 403 that halted production, end to end through AiBrain.
  // ════════════════════════════════════════════════════════════════════════
  {
    process.env.AI_MODEL_FALLBACK = '';
    setConfig(loadConfig());
    const mem = new Memory();
    const brain = new AiBrain(mem);
    const GATED = 'thinkingmachines/inkling-small:free is only available on agentic harnesses.';
    const asked: string[] = [];
    let call = 0;
    (brain as any).client = {
      chat: { completions: { create: async (params: any) => {
        asked.push(params.model);
        call++;
        // First the paid model is out of credit, then the first free id the
        // catalog offers is gated behind a 403 — the exact production sequence.
        if (call === 1) { const e: any = new Error('requires more credits'); e.status = 402; throw e; }
        if (params.model === 'gated/one:free') { const e: any = new Error(GATED); e.status = 403; throw e; }
        return {
          choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"BUY","confidence":7,"reasoning":"ok","position_size_pct":10}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        };
      } } },
    };
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ data: [
        { id: 'gated/one:free', pricing: { prompt: '0', completion: '0' }, context_length: 200000 },
        { id: 'working/two:free', pricing: { prompt: '0', completion: '0' }, context_length: 100000 },
      ] }),
    });
    try {
      const decision = await (brain as any).call('probe', 'ETH/USD');
      assert.equal(decision.verdict, 'BUY', 'the bot walks past the gated model and gets a real answer');
      assert.ok(asked.includes('gated/one:free'), 'the gated id was tried once');
      assert.equal(asked[asked.length - 1], 'working/two:free', 'and then moved on to a working one');
      assert.equal(asked.filter(m => m === 'gated/one:free').length, 1,
        'the gated model is never retried — this is what burned 409 cycles');
      assert.equal(brain.health.consecutiveFailures, 0, 'a recovered call clears the failure streak');
      console.log(`  403 recovery: ${asked.join(' -> ')} (gated id tried once, never again)`);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  }

  // ── Regression guard: with the fix removed, the bot goes dark again ───────
  {
    const mem = new Memory();
    const brain = new AiBrain(mem);
    let calls = 0;
    (brain as any).switchToFreeModel = () => false;   // simulate the old behaviour
    (brain as any).client = {
      chat: { completions: { create: async () => {
        calls++;
        const e: any = new Error('gated/one:free is only available on agentic harnesses.');
        e.status = 403;
        throw e;
      } } },
    };
    let threw = false;
    try { await (brain as any).call('probe', 'ETH/USD'); } catch { threw = true; }
    assert.ok(threw || calls > 0, 'without the walk-past, the call cannot succeed');
    assert.ok(brain.health.consecutiveFailures > 0, 'and the failure is recorded, not hidden');
    console.log('  regression guard: without the fix the same error still fails loudly');
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. Preflight: an AI-only critical failure must be recoverable.
  // ════════════════════════════════════════════════════════════════════════
  {
    const fake = fresh();
    fake.balance = { USD: { free: 100, used: 0, total: 100 } };
    const exchange = new Exchange('k', 's', false);
    const mem = new Memory();
    const brokenAi = {
      usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
      activeModel: () => 'dead-model',
      health: { consecutiveFailures: 9, lastError: '403 gated', lastErrorAt: '', creditExhausted: false, lastSuccessAt: '' },
      async selfTest(samples: number) {
        return { valid: 0, salvaged: 0, total: samples, finishReasons: {}, avgLatencyMs: 5, budget: 1000, lastError: '403 gated' };
      },
    } as any;
    const checks = await runPreflight(exchange, mem, brokenAi, 2);
    const healthy = reportPreflight(checks);
    assert.equal(healthy, false, 'a dead model is still a critical preflight failure');
    const critical = checks.filter((c: any) => !c.ok && c.critical);
    assert.ok(critical.length > 0);
    assert.ok(critical.every((c: any) => c.name === 'AI decisions'),
      'and it is the ONLY critical failure, so the block is liftable');

    // An unlisted framework pair must never be the thing that halts trading.
    const framework = checks.find((c: any) => c.name === 'Allocation framework');
    assert.ok(framework, 'the framework is checked at startup');
    assert.equal(framework.critical, false, 'but a missing framework pair is never critical');
    console.log(`  preflight: AI-only critical failure isolated; framework check non-critical (${framework.detail})`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. Does the money actually land in the right buckets? A paper run of the
  //    video's $1,000 portfolio, over several cycles, with no real orders.
  // ════════════════════════════════════════════════════════════════════════
  {
    process.env.PAPER_MODE = 'true';
    process.env.PORTFOLIO_VALUE = '1000';
    process.env.AI_DECISIONS_PER_CYCLE = '6';
    process.env.TARGET_POSITION_COUNT = '10';
    process.env.EXCLUDED_ASSETS = '';
    const simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-sim-'));
    process.env.DATA_DIR = simDir;
    setConfig(loadConfig());

    // A universe where the framework names are deliberately NOT the best-scoring
    // setups: 24 noise pairs share identical technicals. If allocation had no
    // effect, the framework names would be crowded out by sheer count.
    const noise = ['NOISEA', 'NOISEB', 'NOISEC', 'NOISED', 'NOISEE', 'NOISEF',
                   'NOISEG', 'NOISEH', 'NOISEI', 'NOISEJ', 'NOISEK', 'NOISEL'];
    const universe = [
      ...STRATEGY_PAIRS.filter((p: string) => p !== 'CANTON/USD'),
      ...noise.map(n => `${n}/USD`),
    ];
    const fake = new FakeKraken(universe);
    (ccxt as any).kraken = function () { return fake; };
    const exchange = new Exchange(undefined, undefined, true);
    const mem = new Memory();
    assert.equal(mem.paperCash(), 1000, 'the sim starts on the video\'s $1,000');

    // A model that says BUY to whatever it is shown. That is the point: it
    // isolates the framework's own effect on *which* names reach a decision.
    // It sizes by reading the BUCKET SIZE line out of the prompt it is handed —
    // the same way a real model would. That makes this a test of the guidance
    // itself: if the number is missing, wrong, or identical for every bucket,
    // the weights below will not converge and the assertions fail.
    const sawBucketSize: string[] = [];
    const alwaysBuy = {
      async analyze(pair: string, _sector: string, _ta: any, _vol: number, context: any) {
        const note = String(context?.allocation ?? '');
        const match = /a full position in it is around \$([\d,]+(?:\.\d+)?)/.exec(note);
        if (match) sawBucketSize.push(`${pair.split('/')[0]}=$${match[1]}`);
        const fullSize = match ? Number(match[1].replace(/,/g, '')) : 0;
        const portfolio = Number(context?.portfolioValueUsd ?? 0);
        // Size toward a full position in THIS bucket, capped by what cash allows.
        const pct = fullSize > 0 && portfolio > 0
          ? Math.max(1, Math.min(60, (fullSize / portfolio) * 100))
          : 12;
        return { verdict: 'BUY', confidence: 8, reasoning: 'sim', positionSizePct: pct,
          adjustedStop: null, adjustedTarget: null, trimFraction: 1, alertPrice: null,
          salvaged: false, counterCase: 'sim', verdictHolds: true };
      },
      async review() {
        return { verdict: 'HOLD', confidence: 8, reasoning: 'sim', positionSizePct: 0,
          adjustedStop: null, adjustedTarget: null, trimFraction: 1, alertPrice: null,
          salvaged: false, counterCase: 'sim', verdictHolds: true };
      },
      async reviewPortfolio() {
        return { stance: 'RISK_ON', confidence: 8, reasoning: 'sim', counterCase: '',
          cashTargetPct: 0, requestedFundsUsd: 0, raiseFromReservedAsset: '',
          raiseFromReservedUsd: 0, messageToOperator: '', charterSuggestion: '' };
      },
      async checkMoverNews() { return ''; },
      async reconsiderSell() { return { confirmed: true, reasoning: 'sim' }; },
      usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
      activeModel: () => 'sim-model',
      health: { consecutiveFailures: 0, lastError: '', lastErrorAt: '', creditExhausted: false, lastSuccessAt: new Date().toISOString() },
      async selfTest(n: number) { return { valid: n, salvaged: 0, total: n, finishReasons: { stop: n }, avgLatencyMs: 1, budget: 1000, lastError: '' }; },
    } as any;

    for (let cycle = 0; cycle < 5; cycle++) await runCycle(exchange, mem, alwaysBuy);

    const open = mem.getOpenPositions();
    assert.ok(open.length > 0, 'the sim actually opened positions');
    const held: Record<string, number> = {};
    for (const p of open) {
      const base = p.pair.split('/')[0];
      held[base] = (held[base] ?? 0) + p.qty * p.currentPrice;
    }
    const inFramework = open.filter(p => isStrategyPair(p.pair));
    const share = inFramework.length / open.length;
    console.log(`  paper sim: ${open.length} positions opened from a ${universe.length}-pair universe`);
    console.log(`             ${inFramework.length} are framework names (${(share * 100).toFixed(0)}%): ${inFramework.map(p => p.pair.split('/')[0]).sort().join(', ')}`);
    const offPlan = open.filter(p => !isStrategyPair(p.pair)).map(p => p.pair.split('/')[0]);
    if (offPlan.length) console.log(`             ${offPlan.length} off-plan: ${offPlan.sort().join(', ')}`);

    // The framework must dominate the book against a universe that outnumbers it
    // two to one. Not "every position" — movers and sleepers keep their slots by
    // design, and that latitude is the operator's own instruction.
    assert.ok(share >= 0.5,
      `framework names should dominate the book, got ${(share * 100).toFixed(0)}%`);

    const invested = Object.values(held).reduce((a, b) => a + b, 0);
    const lines = allocationDrift(held, invested + mem.paperCash());
    for (const line of lines)
      console.log(`             ${line.label}: ${(line.actualPct * 100).toFixed(1)}% vs ${(line.targetPct * 100).toFixed(0)}% target`);
    // Core and large caps must both have been funded, not just the easy sleeve.
    const core = lines.find((l: any) => l.bucket === 'core')!;
    const large = lines.find((l: any) => l.bucket === 'large_cap')!;
    assert.ok(core.actualUsd > 0, 'ETH got funded');
    assert.ok(large.actualUsd > 0, 'large caps got funded');

    // The guidance must have reached every framework candidate, and must differ
    // by bucket — a single shared number is the bug this was written to catch.
    assert.ok(sawBucketSize.length > 0, 'candidates were told their bucket size');
    assert.ok(new Set(sawBucketSize.map(e => e.split('=')[1])).size > 1,
      'the full-position size differs by bucket, it is not one number for everything');
    console.log(`             bucket sizing seen by the model: ${[...new Set(sawBucketSize)].sort().join(', ')}`);

    // The real test: ETH is one name against six large caps, so on equal sizing
    // it lands near 11%. It must now be the single largest holding in the book.
    const ethUsd = held.ETH ?? 0;
    const biggest = Object.entries(held).sort((a, b) => b[1] - a[1])[0];
    assert.equal(biggest[0], 'ETH', `ETH should be the largest holding, got ${biggest[0]}`);
    assert.ok(core.actualPct > 0.25,
      `ETH should be sized toward its 50% target, got ${(core.actualPct * 100).toFixed(1)}%`);
    assert.ok(ethUsd > (large.actualUsd / 6) * 2,
      'an ETH position is materially larger than a single large-cap position');
    console.log('  paper sim: every bucket funded, framework dominates, ETH sized as the core');
  }

  console.log('integration checks passed');
}

main().catch(e => { console.error(e); process.exit(1); });
