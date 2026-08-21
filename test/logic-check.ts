import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import { TA, applyPositionAdjustments, updateTradeExtremes, parseAiResponse, rankReviewPositions } from '../src/index';

const closes = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21,
];
assert.equal(TA.rsi(closes), 62.88);
assert.equal(TA.volRatio([...Array(20).fill(100), 200, 0.001]), 2);

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

const kraken = new ccxt.kraken({ enableRateLimit: false });
kraken.markets = {
  'FAKE/USD': {
    symbol: 'FAKE/USD',
    precision: { amount: 0.01 },
    limits: { amount: { min: 0 }, cost: { min: 0 } },
  },
} as any;
const requestedSell = 1.239;
const normalizedSell = Number(kraken.amountToPrecision('FAKE/USD', requestedSell));
assert.equal(normalizedSell, 1.23);
assert.ok(normalizedSell <= requestedSell);

const validAi = parseAiResponse('{"verdict":"BUY","confidence":8,"reasoning":"clear setup","position_size_pct":5,"adjusted_stop":90,"adjusted_target":120}');
assert.equal(validAi.kind, 'parsed');
assert.equal(validAi.decision?.verdict, 'BUY');
assert.equal(validAi.decision?.adjustedStop, 90);

const fencedAi = parseAiResponse('```json\n{"verdict":"HOLD","confidence":6,"reasoning":"wait"}\n```');
assert.equal(fencedAi.kind, 'parsed');
assert.equal(fencedAi.decision?.verdict, 'HOLD');

const truncatedAi = parseAiResponse('{"verdict":"BUY","confidence":9,"reasoning":"strong setup","position_size_pct":12,"adjusted_stop":90');
assert.equal(truncatedAi.kind, 'salvaged');
assert.equal(truncatedAi.decision?.verdict, 'BUY');
assert.equal(truncatedAi.decision?.confidence, 9);
assert.equal(truncatedAi.decision?.positionSizePct, 0);
assert.equal(truncatedAi.decision?.adjustedStop, null);
assert.equal(truncatedAi.decision?.adjustedTarget, null);

const reasoningAi = parseAiResponse('', '{"verdict":"SELL","confidence":7,"reasoning":"protect capital"}');
assert.equal(reasoningAi.kind, 'parsed');
assert.equal(reasoningAi.decision?.verdict, 'SELL');
assert.equal(parseAiResponse('').kind, 'empty');

const reviewPositions = [
  { ...position, pair: 'URGENT/USD', entryPrice: 90, currentPrice: 100, stopLoss: 99, takeProfit: 130 },
  { ...position, pair: 'LOWER_PNL/USD', entryPrice: 110, currentPrice: 100, stopLoss: 80, takeProfit: 102 },
  { ...position, pair: 'HIGHER_PNL/USD', entryPrice: 80, currentPrice: 100, stopLoss: 98, takeProfit: 110 },
];
assert.deepEqual(rankReviewPositions(reviewPositions).map(p => p.pair), [
  'URGENT/USD', 'HIGHER_PNL/USD', 'LOWER_PNL/USD',
]);

console.log('logic checks passed');
