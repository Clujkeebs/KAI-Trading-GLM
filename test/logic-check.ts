import assert from 'node:assert/strict';
import { TA, applyPositionAdjustments, updateTradeExtremes } from '../src/index';

const closes = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21,
];
assert.equal(TA.rsi(closes), 62.88);

const position = {
  pair: 'TEST/USD', status: 'open', sector: 'test', entryPrice: 100, qty: 1,
  costBasisUsd: 100, stopLoss: 90, takeProfit: 120, currentPrice: 100,
  reason: '', aiReasoning: '', openedAt: new Date().toISOString(),
} as any;
const safe = applyPositionAdjustments(position, 95, 110);
assert.equal(safe.stop, 95);
assert.equal(safe.target, 110);
assert.deepEqual(safe.rejected, []);
const rejected = applyPositionAdjustments(position, 105, 80);
assert.equal(rejected.stop, null);
assert.equal(rejected.target, null);
assert.equal(rejected.rejected.length, 2);

const state = { bestTrade: null, worstTrade: null } as any;
updateTradeExtremes(state, 1.25);
updateTradeExtremes(state, -2.5);
updateTradeExtremes(state, 0.5);
assert.equal(state.bestTrade, 1.25);
assert.equal(state.worstTrade, -2.5);
console.log('logic checks passed');
