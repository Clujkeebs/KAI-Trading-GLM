import assert from 'node:assert/strict';
import {
  STRATEGY_BUCKETS, STRATEGY_ASSETS, STRATEGY_PAIRS, strategyBucketFor, isStrategyPair,
  allocationDrift, underweightBuckets, allocationNote, candidateAllocationNote,
  parseSellAllowances, remainingSellAllowance, approveReservedSale, reservedAllowanceNote,
  excludeAssetsFromBuckets,
  prioritizeMoverCandidates, isModelUnavailable, setConfig, loadConfig,
} from '../src/index.js';

setConfig(loadConfig());

// ── The framework itself ──
(() => {
  const total = STRATEGY_BUCKETS.reduce((sum, bucket) => sum + bucket.targetPct, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `bucket weights must sum to 1, got ${total}`);
  assert.equal(STRATEGY_BUCKETS.find(b => b.name === 'core')?.targetPct, 0.5);
  assert.ok(STRATEGY_ASSETS.has('ETH'));
  assert.ok(STRATEGY_ASSETS.has('ONDO'));
  assert.ok(STRATEGY_ASSETS.has('INJ'));

  // No asset may sit in two buckets: drift would then double-count it.
  const seen = new Set<string>();
  for (const bucket of STRATEGY_BUCKETS)
    for (const asset of bucket.assets) {
      assert.ok(!seen.has(asset), `${asset} appears in more than one bucket`);
      seen.add(asset);
    }

  assert.equal(strategyBucketFor('ETH')?.name, 'core');
  assert.equal(strategyBucketFor('LINK')?.name, 'large_cap');
  assert.equal(strategyBucketFor('SOL')?.name, 'rotational');
  assert.equal(strategyBucketFor('DOGE'), null);
  assert.ok(isStrategyPair('ETH/USD'));
  assert.ok(!isStrategyPair('DOGE/USD'));
  assert.equal(STRATEGY_PAIRS.length, STRATEGY_ASSETS.size);
  console.log('framework definition checks passed');
})();

// ── Drift ──
(() => {
  // An empty book: every bucket is short its full target.
  const empty = allocationDrift({}, 1000);
  assert.equal(empty.length, STRATEGY_BUCKETS.length);
  assert.equal(empty[0].targetUsd, 500);
  assert.equal(empty[0].actualUsd, 0);
  assert.equal(empty[0].driftUsd, 500);

  // A book that is entirely staked SOL: rotational is over, the rest are short.
  // This is the live account's actual shape, so it must read correctly.
  const solOnly = allocationDrift({ SOL: 1050 }, 1080);
  const rotational = solOnly.find(line => line.bucket === 'rotational')!;
  assert.equal(rotational.actualUsd, 1050);
  assert.ok(rotational.driftUsd < 0, 'a book that is all SOL is over the rotational target');
  assert.deepEqual(rotational.held, [{ asset: 'SOL', usd: 1050 }]);
  const core = solOnly.find(line => line.bucket === 'core')!;
  assert.equal(core.actualUsd, 0);
  assert.ok(Math.abs(core.driftUsd - 540) < 1e-9);

  // Kraken's staked names normalize back to their base before being counted.
  const staked = allocationDrift({ 'SOL03.S': 400 }, 1000);
  assert.equal(staked.find(line => line.bucket === 'rotational')!.actualUsd, 400);

  // Underweight ordering drives which bucket gets a decision slot first.
  const order = underweightBuckets(solOnly).map(line => line.bucket);
  assert.deepEqual(order, ['core', 'large_cap'], 'worst gap first, over-target buckets dropped');

  // Degenerate inputs must not produce NaN percentages.
  for (const line of allocationDrift({ ETH: 10 }, 0)) {
    assert.equal(line.actualPct, 0);
    assert.equal(line.targetUsd, 0);
    assert.ok(Number.isFinite(line.driftUsd));
  }
  // Negative and non-numeric holdings are ignored rather than subtracted.
  const junk = allocationDrift({ ETH: -50, LINK: Number.NaN, AAVE: 100 }, 1000);
  assert.equal(junk.find(line => line.bucket === 'core')!.actualUsd, 0);
  assert.equal(junk.find(line => line.bucket === 'large_cap')!.actualUsd, 100);
  console.log('allocation drift checks passed');
})();

// ── Prompt text ──
(() => {
  const lines = allocationDrift({ SOL: 1050 }, 1080);
  const note = allocationNote(lines, 1080, 29.5);
  assert.ok(note.includes('ALLOCATION FRAMEWORK'));
  assert.ok(note.includes('$29.50'), 'the model is told what it can actually deploy');
  assert.ok(/UNDER target/.test(note));
  assert.ok(/not a rule|not something to finish today|may depart|Do not buy something/i.test(note),
    'the framework must read as guidance, not a gate');
  assert.equal(allocationNote([], 1000, 10), '');
  assert.equal(allocationNote(lines, 0, 10), '');

  const inPlan = candidateAllocationNote('ETH/USD', lines, note);
  assert.ok(inPlan.includes('Core (ETH)'));
  assert.ok(/UNDER its 50% target/.test(inPlan));
  // A one-name bucket and a six-name bucket must not be told the same full size:
  // equal sizing is what put ETH at 12% of the book against a 50% target.
  const ethSize = /a full position in it is around \$([\d,.]+)/.exec(inPlan)?.[1];
  const linkSize = /a full position in it is around \$([\d,.]+)/
    .exec(candidateAllocationNote('LINK/USD', lines, note))?.[1];
  assert.ok(ethSize && linkSize, 'both candidates are told a bucket size');
  assert.notEqual(ethSize, linkSize, 'the size differs by bucket');
  assert.ok(Number(ethSize!.replace(/,/g, '')) > Number(linkSize!.replace(/,/g, '')) * 5,
    'a 50% one-name bucket is worth far more per position than a 33% six-name one');
  assert.ok(/Room left before this bucket is on target/.test(inPlan));
  assert.ok(/not a number to hit today|target to grow into/.test(inPlan),
    'sizing stays guidance, not a quota');
  const outOfPlan = candidateAllocationNote('DOGE/USD', lines, note);
  assert.ok(/not one of the names/.test(outOfPlan));
  assert.ok(/not a refusal/.test(outOfPlan), 'off-framework names stay takeable');
  assert.equal(candidateAllocationNote('ETH/USD', [], note), '');
  console.log('allocation prompt checks passed');
})();

// ── Sell allowances ──
(() => {
  const parsed = parseSellAllowances('SOL:500, AVAX:0');
  assert.equal(parsed.get('SOL'), 500);
  assert.equal(parsed.get('AVAX'), 0);
  assert.equal(parseSellAllowances('').size, 0);
  assert.equal(parseSellAllowances(undefined).size, 0);
  assert.equal(parseSellAllowances('SOL:notanumber').size, 0, 'a typo grants nothing');
  assert.equal(parseSellAllowances('SOL:-5').size, 0, 'a negative grant is refused');
  assert.equal(parseSellAllowances('sol03.s:200').get('SOL'), 200, 'staked names normalize');

  assert.equal(remainingSellAllowance('SOL', parsed, {}), 500);
  assert.equal(remainingSellAllowance('SOL', parsed, { SOL: 200 }), 300);
  assert.equal(remainingSellAllowance('SOL', parsed, { SOL: 900 }), 0, 'never goes negative');
  assert.equal(remainingSellAllowance('ETH', parsed, {}), 0, 'no grant means no allowance');

  // The three ceilings, each binding in turn.
  assert.equal(approveReservedSale('SOL', 100, parsed, {}, 1000).approvedUsd, 100);
  assert.equal(approveReservedSale('SOL', 900, parsed, {}, 1000).approvedUsd, 500);
  assert.equal(approveReservedSale('SOL', 400, parsed, {}, 120).approvedUsd, 120);
  assert.equal(approveReservedSale('SOL', 400, parsed, { SOL: 450 }, 1000).approvedUsd, 50);

  // Refusals, each with a reason the operator can act on.
  assert.equal(approveReservedSale('ETH', 100, parsed, {}, 1000).approvedUsd, 0);
  assert.match(approveReservedSale('ETH', 100, parsed, {}, 1000).reason, /no standing sell allowance/);
  const allStaked = approveReservedSale('SOL', 400, parsed, {}, 0);
  assert.equal(allStaked.approvedUsd, 0);
  assert.match(allStaked.reason, /staked or locked/, 'the operator is told to unstake, not that it failed');
  assert.equal(approveReservedSale('SOL', 0, parsed, {}, 1000).approvedUsd, 0);
  assert.equal(approveReservedSale('', 100, parsed, {}, 1000).approvedUsd, 0);
  assert.match(approveReservedSale('SOL', 400, parsed, { SOL: 500 }, 1000).reason, /already used up/);

  // The note has to state both numbers: authorised, and reachable today.
  const note = reservedAllowanceNote(parsed, {}, { SOL: 1050 }, { SOL: 1050 });
  assert.ok(note.includes('RESERVED SELL ALLOWANCE'));
  assert.ok(/cannot be sold by a spot order/.test(note));
  assert.ok(/unstake/i.test(note), 'an entirely staked holding says what the operator must do');
  const partial = reservedAllowanceNote(parsed, { SOL: 100 }, { SOL: 1050 }, { SOL: 800 });
  assert.ok(/\$400\.00 of a \$500\.00 lifetime allowance/.test(partial));
  assert.ok(/raise up to \$250\.00/.test(partial), 'capped by unlocked value, not by the grant');
  assert.equal(reservedAllowanceNote(new Map(), {}, {}, {}), '');
  console.log('sell allowance checks passed');
})();

// ── Decision-slot priority ──
(() => {
  const make = (pair: string, score: number, extra: Record<string, unknown> = {}) =>
    ({ pair, score: { score }, ...extra }) as any;
  const candidates = [
    make('DOGE/USD', 99),
    make('BONK/USD', 98, { mover: 'loser' }),
    make('LINK/USD', 10, { strategy: 'large_cap', strategyPriority: 1 }),
    make('ETH/USD', 5, { strategy: 'core', strategyPriority: 0 }),
  ];
  const ordered = prioritizeMoverCandidates(candidates, 4, 1, 0, 2).map(c => c.pair);
  assert.deepEqual(ordered.slice(0, 2), ['ETH/USD', 'LINK/USD'],
    'the most underweight bucket is looked at first, ahead of a higher raw score');
  assert.ok(ordered.includes('BONK/USD'), 'movers keep their slot behind the framework');

  // Zero strategy slots must reproduce the old behaviour exactly.
  const legacy = prioritizeMoverCandidates(candidates, 4, 1, 0, 0).map(c => c.pair);
  assert.equal(legacy[0], 'BONK/USD', 'without framework slots the mover still leads');

  // A pair that is both a framework name and a mover must not consume two slots.
  const dual = [
    make('ETH/USD', 5, { strategy: 'core', strategyPriority: 0, mover: 'loser' }),
    make('SUI/USD', 90, { mover: 'gainer' }),
    make('DOGE/USD', 80),
  ];
  const dualOrder = prioritizeMoverCandidates(dual, 3, 1, 0, 1).map(c => c.pair);
  assert.deepEqual(dualOrder, ['ETH/USD', 'SUI/USD', 'DOGE/USD'],
    'the mover slot goes to the next mover, not to an already-reserved pair');
  assert.equal(new Set(dualOrder).size, dualOrder.length, 'no duplicates');
  console.log('decision slot checks passed');
})();

// ── The 403 that halted production ──
(() => {
  // OpenRouter's exact reply for a free id it lists but will not serve. Left
  // unclassified this answered HOLD for 409 consecutive cycles.
  const gated = Object.assign(
    new Error('403 thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps'),
    { status: 403 },
  );
  assert.equal(isModelUnavailable(gated), true, 'a gated model must be walked past');

  // A genuine auth failure is not a model problem and must not rotate models.
  assert.equal(isModelUnavailable(Object.assign(new Error('401 No auth credentials found'), { status: 401 })), false);
  assert.equal(isModelUnavailable(Object.assign(new Error('403 User not found'), { status: 403 })), false);
  assert.equal(isModelUnavailable(Object.assign(new Error('429 rate limited'), { status: 429 })), false);
  // The previously handled cases still classify.
  assert.equal(isModelUnavailable(Object.assign(new Error('This model is unavailable for free.'), { status: 404 })), true);
  console.log('model availability checks passed');
})();

// ── Standing liquidation order ──
(() => {
  const stripped = excludeAssetsFromBuckets(STRATEGY_BUCKETS, ['AVAX']);
  const rotational = stripped.find(b => b.name === 'rotational')!;
  assert.ok(!rotational.assets.includes('AVAX'), 'a liquidated asset leaves the eligible list');
  assert.ok(rotational.assets.includes('SOL'), 'its bucket-mates stay');
  assert.equal(rotational.targetPct, 0.17, 'the bucket keeps the operator\'s weight');
  assert.equal(stripped.reduce((s, b) => s + b.targetPct, 0), 1, 'weights still sum to 1');
  // Kraken's staked alias must strike the same asset out.
  assert.ok(!excludeAssetsFromBuckets(STRATEGY_BUCKETS, ['AVAX.B'])
    .find(b => b.name === 'rotational')!.assets.includes('AVAX'));
  assert.deepEqual(excludeAssetsFromBuckets(STRATEGY_BUCKETS, []), STRATEGY_BUCKETS,
    'an empty list is a no-op');

  // A holding on its way out must not count toward the target it is leaving,
  // or the bucket reads as full and the names meant to fill it never get bought.
  const withAvax = allocationDrift({ AVAX: 938 }, 1000, STRATEGY_BUCKETS)
    .find(b => b.bucket === 'rotational')!;
  const without = allocationDrift({ AVAX: 938 }, 1000, excludeAssetsFromBuckets(STRATEGY_BUCKETS, ['AVAX']))
    .find(b => b.bucket === 'rotational')!;
  assert.equal(withAvax.actualUsd, 938);
  assert.equal(without.actualUsd, 0, 'a liquidated holding is not allocation');
  assert.ok(without.driftUsd > 0, 'so the sleeve correctly reads as underweight');
  console.log('liquidation-list checks passed');
})();

console.log('strategy checks passed');
