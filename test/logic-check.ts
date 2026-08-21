import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {
  TA, applyPositionAdjustments, updateTradeExtremes, parseAiResponse,
  planTrade, trailingStop, scoreSetup, closedCandles, isRetryableError,
  csvField, fmt, setConfig, loadConfig, normalizeAsset, isStakedBalance,
  normalizeStance, applyEntryPlan, normalizeTrimFraction, rankReviewPositions,
} from '../src/index';
import type { TechnicalAnalysis } from '../src/index';

setConfig(loadConfig());

// ── RSI ──────────────────────────────────────────────────────────────────────
const closes = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21,
];
assert.equal(TA.rsi(closes), 62.88);

// The one-pass series must agree with the scalar RSI and start at the first bar
// that has a full lookback (index `period`), not with a placeholder value.
const series = TA.rsiSeries(closes);
assert.equal(series.length, closes.length - 14);
assert.equal(+series[series.length - 1].toFixed(2), TA.rsi(closes));
for (const value of series) assert.ok(value >= 0 && value <= 100, `RSI out of range: ${value}`);
assert.deepEqual(TA.rsiSeries([1, 2, 3]), []);

// ── StochRSI ─────────────────────────────────────────────────────────────────
// %D is the 3-period average of %K, so both must live on the same 0-100 scale.
// The old implementation averaged raw RSI values and produced a "D" that could
// never be compared against K.
// A monotonic advance has zero average loss, so RSI pins at 100 and the stochastic
// window is flat; both lines fall back to the neutral 50 rather than dividing by zero.
const rising = Array.from({ length: 80 }, (_, i) => 100 + i);
assert.deepEqual(TA.stochRsi(rising), [50, 50]);
// A pullback inside an uptrend gives a real range: %K sits at the top of it.
const pullback = [...Array.from({ length: 60 }, (_, i) => 100 + i), 158, 155, 152, 156, 160, 164];
const [pullbackK, pullbackD] = TA.stochRsi(pullback);
assert.ok(pullbackK > pullbackD, '%K leads %D as the bounce resumes');
assert.ok(pullbackK <= 100 && pullbackD >= 0);
const choppy = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5);
const [k, d] = TA.stochRsi(choppy);
for (const value of [k, d]) assert.ok(value >= 0 && value <= 100, `StochRSI out of range: ${value}`);
assert.deepEqual(TA.stochRsi([1, 2, 3]), [50, 50]);

// ── Supports and resistances are nearest-first ───────────────────────────────
// Stops are placed just under supports[0]; sorting ascending handed callers the
// *lowest* swing low in the whole window and produced absurdly wide stops.
const lows = [10, 8, 5, 8, 10, 9, 7, 9, 10, 9, 9.5, 8.5, 9.5, 10, 11, 10, 10, 10, 10, 10];
const supports = TA.supports(lows, 12);
assert.ok(supports.length >= 2);
assert.ok(supports[0] > supports[supports.length - 1], 'nearest support must come first');
assert.ok(supports.every(s => s < 12));

const highs = [10, 12, 15, 12, 10, 11, 13, 11, 10, 11, 10.5, 11.5, 10.5, 10, 9, 10, 10, 10, 10, 10];
const resistances = TA.resistances(highs, 9);
assert.ok(resistances.length >= 2);
assert.ok(resistances[0] < resistances[resistances.length - 1], 'nearest resistance must come first');
assert.ok(resistances.every(r => r > 9));

// ── Volume ratio reads the latest closed bar ─────────────────────────────────
assert.equal(TA.volRatio([...Array(20).fill(100), 200]), 2);
assert.equal(TA.volRatio([...Array(20).fill(0), 5]), 1, 'a zero-volume average must not divide by zero');
assert.equal(TA.volRatio([1, 2, 3]), 1);

// ── Candle hygiene ───────────────────────────────────────────────────────────
const hour = 3_600_000;
const now = 1_700_000_000_000;
const bars = [0, 1, 2, 3].map(i => ({
  timestamp: now - (3 - i) * hour, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
}));
// The final bar opened this hour and is still forming, so it must be dropped.
const closedOnly = closedCandles(bars, '1h', now + hour / 2);
assert.equal(closedOnly.length, 3);
assert.equal(closedOnly[closedOnly.length - 1].timestamp, now - hour);
assert.equal(closedCandles(bars, '1h', now + hour).length, 4, 'a bar whose span has elapsed is closed');
assert.equal(closedCandles(bars, 'unknown-tf', now).length, 4);

// ── ATR ──────────────────────────────────────────────────────────────────────
const flat = Array.from({ length: 30 }, (_, i) => ({
  timestamp: i * hour, open: 100, high: 102, low: 98, close: 100, volume: 1,
}));
assert.equal(TA.atr(flat), 4, 'constant 4-wide bars give an ATR of exactly 4');
assert.equal(TA.atr(flat.slice(0, 5)), null, 'too little history yields no ATR');

// ── Aggregation to a higher timeframe ────────────────────────────────────────
const eight = Array.from({ length: 8 }, (_, i) => ({
  timestamp: i * hour, open: i, high: i + 2, low: i - 1, close: i + 1, volume: 10,
}));
const fourHour = TA.aggregate(eight, 4);
assert.equal(fourHour.length, 2);
assert.equal(fourHour[0].open, 0);
assert.equal(fourHour[0].close, 4);
assert.equal(fourHour[0].high, 5);
assert.equal(fourHour[0].low, -1);
assert.equal(fourHour[0].volume, 40);
// Anchoring to the end keeps the most recent bucket complete rather than partial.
assert.equal(TA.aggregate(eight.slice(0, 7), 4).length, 1);
assert.equal(TA.aggregate(eight, 1).length, 8);

// ── MACD ─────────────────────────────────────────────────────────────────────
assert.equal(TA.macdHistogram(closes), null, '21 closes is short of the 26+9 lookback');
const uptrend = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
const histogram = TA.macdHistogram(uptrend);
assert.ok(histogram !== null && Number.isFinite(histogram));

// ── Full snapshot ────────────────────────────────────────────────────────────
const candles = Array.from({ length: 120 }, (_, i) => {
  const base = 100 + i * 0.4 + Math.sin(i / 5) * 3;
  return { timestamp: i * hour, open: base, high: base + 1.5, low: base - 1.5, close: base, volume: 100 + (i % 7) };
});
const snapshot = TA.full(candles, candles[candles.length - 1].close);
assert.ok(snapshot);
assert.ok(snapshot!.atr !== null && snapshot!.atr > 0);
assert.equal(snapshot!.atrPct, snapshot!.atr! / snapshot!.currentPrice);
assert.equal(snapshot!.htfTrend, 'bullish', 'a steadily rising series is bullish on the 4h aggregate');
assert.equal(TA.full(candles, 0), null, 'a non-positive price yields no analysis');
assert.equal(TA.full(candles.slice(0, 10), 100), null);

// ── Trade plan ───────────────────────────────────────────────────────────────
const base: TechnicalAnalysis = {
  currentPrice: 100, rsi: 30, sma5: 99, sma20: 101, sma50: 102,
  bollinger: { upper: 110, middle: 100, lower: 90 },
  supports: [95, 90], resistances: [115, 130],
  volumeRatio: 1.2, stochRsiK: 15, stochRsiD: 10,
  trend: 'neutral', maScore: 1, atr: 2, atrPct: 0.02,
  htfTrend: 'bullish', macdHistogram: 0.1,
};
const plan = planTrade(base)!;
assert.ok(plan);
// Structure (95 * 0.99 = 94.05) sits below the 2x ATR stop (96), and the safer of
// the two wins so ordinary volatility cannot shake the position out.
assert.equal(plan.stop, 94.05);
assert.equal(plan.target, 115, 'nearest resistance is far enough away to be the target');
assert.ok(Math.abs(plan.rr - (115 - 100) / (100 - 94.05)) < 1e-9);
assert.ok(Math.abs(plan.riskPct - 0.0595) < 1e-9);

// A stop is never allowed further than MAX_STOP_DISTANCE_PCT from entry.
const wide = planTrade({ ...base, supports: [40], atr: 30, atrPct: 0.3 })!;
assert.equal(wide.stop, 85, 'the 15% cap bounds the risk on a single trade');

// With resistance too close to pay for the risk, the target reaches past it.
const nearResistance = planTrade({ ...base, resistances: [101] })!;
assert.ok(nearResistance.target > 101);
assert.ok(nearResistance.rr >= 1.5);

// No ATR and no structure still produces a usable, bounded plan.
const bare = planTrade({ ...base, supports: [], resistances: [], atr: null, atrPct: null })!;
assert.equal(bare.stop, 85);
assert.ok(bare.target > 100);
assert.equal(planTrade({ ...base, currentPrice: 0 }), null);

// ── Trailing stop ────────────────────────────────────────────────────────────
const makePosition = (over: Record<string, unknown> = {}) => ({
  pair: 'TEST/USD', status: 'open', sector: 'test', entryPrice: 100, qty: 1,
  costBasisUsd: 100, stopLoss: 94, takeProfit: 120, currentPrice: 100,
  reason: '', aiReasoning: '', openedAt: new Date().toISOString(),
  initialStopLoss: 94, highWaterMark: 100, entryAtr: 2, ...over,
}) as any;

// Nothing moves until the trade has earned it: engaging the trail early would
// override the entry stop, which was placed at structure deliberately.
assert.equal(trailingStop(makePosition(), 100, 2), null, 'a flat trade moves nothing');
assert.equal(trailingStop(makePosition({ highWaterMark: 105 }), 105, 2), null, 'below +1R the plan stands');

// At +1R (entry + 6) the ratchet fires. With a wide ATR the volatility trail still
// sits under the entry stop, so breakeven is what actually locks in.
const breakeven = trailingStop(makePosition({ highWaterMark: 106, entryAtr: 10 }), 106, 10)!;
assert.equal(breakeven.stop, 100);
assert.match(breakeven.reason, /breakeven/);

// Further up, the 2.5x ATR trail takes over: 130 - 2.5 * 2 = 125.
const trailed = trailingStop(makePosition({ highWaterMark: 130 }), 130, 2)!;
assert.equal(trailed.stop, 125);
assert.match(trailed.reason, /trailing/);

// The trail never loosens an already-tighter stop, and never lands at or above
// the market — that would be an instant, unintended exit.
assert.equal(trailingStop(makePosition({ stopLoss: 126, highWaterMark: 130 }), 130, 2), null);
assert.equal(trailingStop(makePosition({ highWaterMark: 130 }), 124, 2), null);
// A missing live ATR falls back to the ATR recorded at entry.
assert.equal(trailingStop(makePosition({ highWaterMark: 130 }), 130, null)!.stop, 125);

// ── Setup scoring ────────────────────────────────────────────────────────────
const bullishScore = scoreSetup(base);
const knifeScore = scoreSetup({ ...base, htfTrend: 'bearish', trend: 'bearish', stochRsiK: 5, stochRsiD: 20 });
assert.ok(bullishScore.score > knifeScore.score,
  'an oversold coin falling on the higher timeframe must rank below a supported one');
for (const s of [bullishScore, knifeScore]) assert.ok(s.score >= 0 && s.score <= 100);
assert.equal(scoreSetup({ ...base, supports: [] }).supportDistance, null);
assert.ok(Math.abs(scoreSetup(base).supportDistance! - 0.05) < 1e-9);

// ── Position adjustments ─────────────────────────────────────────────────────
const position = makePosition({ stopLoss: 90 });
const safe = applyPositionAdjustments(position, 95, 110);
assert.equal(safe.stop, 95);
assert.equal(safe.target, 110);
assert.deepEqual(safe.rejected, []);
const rejected = applyPositionAdjustments(position, 105, 80);
assert.equal(rejected.stop, null);
assert.equal(rejected.target, null);
assert.equal(rejected.rejected.length, 2);
assert.equal(applyPositionAdjustments(position, 85, null).stop, null, 'stops never widen');

// ── Trade extremes ───────────────────────────────────────────────────────────
const state = { bestTrade: null, worstTrade: null } as any;
updateTradeExtremes(state, 1.25);
updateTradeExtremes(state, -2.5);
updateTradeExtremes(state, 0.5);
assert.equal(state.bestTrade, 1.25);
assert.equal(state.worstTrade, -2.5);

// ── Exchange precision ───────────────────────────────────────────────────────
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

// ── Retry classification ─────────────────────────────────────────────────────
// Retrying a rejected order or a bad key can never succeed; it only stalls the
// cycle and burns rate limit.
assert.equal(isRetryableError(new ccxt.AuthenticationError('bad key')), false);
assert.equal(isRetryableError(new ccxt.InsufficientFunds('no cash')), false);
assert.equal(isRetryableError(new ccxt.InvalidOrder('too small')), false);
assert.equal(isRetryableError(new ccxt.NetworkError('socket hang up')), true);
assert.equal(isRetryableError(new ccxt.ExchangeNotAvailable('503')), true);
assert.equal(isRetryableError({ status: 400, message: 'bad request' }), false);
assert.equal(isRetryableError({ status: 429, message: 'slow down' }), true);
assert.equal(isRetryableError({ status: 408 }), true);
assert.equal(isRetryableError({ status: 502 }), true);
assert.equal(isRetryableError(new Error('boom')), true);

// ── CSV escaping ─────────────────────────────────────────────────────────────
// AI reasoning is free text and routinely contains commas and quotes; unescaped
// it silently shifted every later column of trades.csv.
assert.equal(csvField('plain'), 'plain');
assert.equal(csvField('oversold, near support'), '"oversold, near support"');
assert.equal(csvField('he said "buy"'), '"he said ""buy"""');
assert.equal(csvField('line\nbreak'), '"line\nbreak"');
assert.equal(csvField(null), '');
assert.equal(csvField(12.5), '12.5');

// ── Money formatting ─────────────────────────────────────────────────────────
assert.equal(fmt(1234.5), '$1234.50');
assert.equal(fmt(0.1234), '$0.1234');
assert.equal(fmt(0), '$0.00');
// Sub-cent assets used to collapse to "$0.0000" and became indistinguishable.
assert.equal(fmt(0.00001234), '$0.00001234');
assert.equal(fmt(-0.00001234), '$-0.00001234');
assert.equal(fmt(Number.NaN), '$n/a');

// ── AI response parsing ──────────────────────────────────────────────────────
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

// ── Kraken staking-balance names resolve to their underlying asset ───────────
// SOL03.S / DOT28.S carry a duration code. Keeping the digits meant the asset
// matched no market, so a staked position was invisible in the portfolio total.
assert.equal(normalizeAsset('SOL03.S'), 'SOL');
assert.equal(normalizeAsset('DOT28.S'), 'DOT');
assert.equal(normalizeAsset('ATOM21.S'), 'ATOM');
assert.equal(normalizeAsset('AVAX.B'), 'AVAX');
assert.equal(normalizeAsset('ETH2.S'), 'ETH');
assert.equal(normalizeAsset('XXBT'), 'BTC');
assert.equal(normalizeAsset('ZUSD'), 'USD');
assert.equal(normalizeAsset('sol'), 'SOL');
// A name that is only digits must not normalise away to nothing.
assert.equal(normalizeAsset('1INCH'), '1INCH');
assert.equal(isStakedBalance('SOL03.S'), true);
assert.equal(isStakedBalance('SOL'), false);

console.log('asset naming checks passed');

// ── Portfolio stance parsing ─────────────────────────────────────────────────
assert.equal(normalizeStance({ stance: 'RISK_OFF' }).stance, 'RISK_OFF');
assert.equal(normalizeStance({ stance: 'risk on' }).stance, 'RISK_ON');
assert.equal(normalizeStance({ stance: 'risk-off' }).stance, 'RISK_OFF');
// Anything unrecognised must not silently freeze or unleash the account.
assert.equal(normalizeStance({ stance: 'PANIC' }).stance, 'NEUTRAL');
assert.equal(normalizeStance({}).stance, 'NEUTRAL');
assert.equal(normalizeStance({ cash_target_pct: 40 }).cashTargetPct, 0.4);
assert.equal(normalizeStance({ cash_target_pct: 500 }).cashTargetPct, 1, 'a cash target is a share, capped at 100%');
assert.equal(normalizeStance({ cash_target_pct: -10 }).cashTargetPct, 0);
assert.equal(normalizeStance({ requested_funds_usd: 500 }).requestedFundsUsd, 500);
assert.equal(normalizeStance({ requested_funds_usd: -5 }).requestedFundsUsd, 0);
assert.equal(normalizeStance({ confidence: 99 }).confidence, 10);

// ── The model owns the entry plan, inside the risk cap ───────────────────────
const entryPlan = planTrade(base)!;
const decide = (over: Record<string, unknown> = {}) => ({
  verdict: 'BUY' as const, confidence: 8, reasoning: 'test', positionSizePct: 10,
  adjustedStop: null, adjustedTarget: null, ...over,
});

// No opinion offered: the bot's ATR plan stands.
assert.equal(applyEntryPlan(entryPlan, 100, decide()).stop, entryPlan.stop);

// A deliberate, wider stop inside the cap is honoured — this is the model taking
// a considered risk, which is exactly what it is there to do.
const wider = applyEntryPlan(entryPlan, 100, decide({ adjustedStop: 88 }));
assert.equal(wider.stop, 88);
assert.ok(Math.abs(wider.riskPct - 0.12) < 1e-9);
assert.match(wider.notes.join(' '), /AI stop .* replaces/);

// A tighter stop is honoured too.
assert.equal(applyEntryPlan(entryPlan, 100, decide({ adjustedStop: 97 })).stop, 97);

// Past the 15% cap it is clamped, not obeyed: one trade cannot cost the account
// an unbounded amount.
const clamped = applyEntryPlan(entryPlan, 100, decide({ adjustedStop: 40 }));
assert.equal(clamped.stop, 85);
assert.match(clamped.notes.join(' '), /clamped/);

// A stop at or above entry is nonsense and is refused outright.
const nonsense = applyEntryPlan(entryPlan, 100, decide({ adjustedStop: 101 }));
assert.equal(nonsense.stop, entryPlan.stop);
assert.match(nonsense.notes.join(' '), /not below entry/);

const retarget = applyEntryPlan(entryPlan, 100, decide({ adjustedTarget: 140 }));
assert.equal(retarget.target, 140);
assert.ok(retarget.rr > entryPlan.rr, 'a higher target improves the stated reward ratio');
assert.equal(applyEntryPlan(entryPlan, 100, decide({ adjustedTarget: 90 })).target, entryPlan.target);

console.log('stance and entry-plan checks passed');

// ── Partial exits ────────────────────────────────────────────────────────────
// trim_pct lets the model take some profit or raise cash without abandoning a
// thesis. Anything missing or nonsensical means a full exit, never a silent
// partial one.
assert.equal(normalizeTrimFraction(40), 0.4);
assert.equal(normalizeTrimFraction(100), 1);
assert.equal(normalizeTrimFraction(250), 1, 'over 100% is still just the whole position');
assert.equal(normalizeTrimFraction(null), 1);
assert.equal(normalizeTrimFraction(undefined), 1);
assert.equal(normalizeTrimFraction('60'), 0.6);
assert.equal(normalizeTrimFraction(0), 1, 'a zero trim is meaningless, so exit fully');
assert.equal(normalizeTrimFraction(-10), 1);
assert.equal(normalizeTrimFraction('nonsense'), 1);

const trimmed = parseAiResponse('{"verdict":"SELL","confidence":8,"reasoning":"take some profit","trim_pct":35}');
assert.equal(trimmed.decision?.verdict, 'SELL');
assert.equal(trimmed.decision?.trimFraction, 0.35);
const fullExit = parseAiResponse('{"verdict":"SELL","confidence":9,"reasoning":"thesis broken"}');
assert.equal(fullExit.decision?.trimFraction, 1, 'no trim_pct means the whole position');
// A truncated reply must not be read as a partial exit it never expressed.
const cutOff = parseAiResponse('{"verdict":"SELL","confidence":9,"reasoning":"thesis brok');
assert.equal(cutOff.kind, 'salvaged');
assert.equal(cutOff.decision?.trimFraction, 1);

console.log('trim checks passed');
