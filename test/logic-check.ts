import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TA, applyPositionAdjustments, updateTradeExtremes, parseAiResponse,
  planTrade, trailingStop, scoreSetup, closedCandles, isRetryableError,
  csvField, fmt, setConfig, loadConfig, normalizeAsset, isStakedBalance,
  normalizeStance, applyEntryPlan, normalizeTrimFraction, rankReviewPositions,
  concentrationNote, selectReviews, defaultAlertPrice, alertTriggered, rebasePlanToFill,
  isExcludedPair, composeSystemPrompt, loadSoulCharter, resolveSoulFilePath,
  isStanceFresh, Memory,
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

const existingPrompt = 'EXISTING SYSTEM PROMPT';
const charterPrompt = composeSystemPrompt(existingPrompt, 'Stand by the operator.');
assert.match(charterPrompt, /OPERATOR'S TRADING CHARTER/);
assert.ok(charterPrompt.includes('Stand by the operator.'));
assert.ok(charterPrompt.endsWith(existingPrompt));
assert.equal(composeSystemPrompt(existingPrompt, null), existingPrompt);
assert.equal(resolveSoulFilePath('/repo/src'), '/repo/SOUL.md');
assert.equal(resolveSoulFilePath('/repo/dist'), '/repo/SOUL.md');
assert.equal(loadSoulCharter('/home/ubuntu/does-not-exist/SOUL.md').contents, null);

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

const timestampedStance = {
  stance: 'NEUTRAL' as const, confidence: 5, reasoning: 'test',
  counterCase: '', cashTargetPct: 0, requestedFundsUsd: 0,
  recordedAt: new Date().toISOString(), cycle: 10,
};
assert.equal(isStanceFresh(timestampedStance, 14, 4), true);
assert.equal(isStanceFresh(timestampedStance, 15, 4), false);
assert.equal(isStanceFresh({ ...timestampedStance, recordedAt: undefined }, 10, null), false);
assert.equal(isStanceFresh(timestampedStance, 100, null), true);

const stanceStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-stance-'));
const stanceMemory = new Memory(stanceStateDir);
stanceMemory.state.cycleCount = 7;
stanceMemory.recordStance(timestampedStance);
assert.equal(stanceMemory.state.lastStance?.cycle, 8);
assert.ok(stanceMemory.state.lastStance?.recordedAt);
const reloadedStanceMemory = new Memory(stanceStateDir);
assert.equal(reloadedStanceMemory.state.lastStance?.cycle, 8);
assert.equal(reloadedStanceMemory.state.lastStance?.recordedAt, stanceMemory.state.lastStance?.recordedAt);
fs.rmSync(stanceStateDir, { recursive: true, force: true });

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

// ── Concentration preference ─────────────────────────────────────────────────
// Guidance, not a cap: it tells the model what a full-size position looks like
// and lets it disagree. With no preference set it must say nothing at all.
setConfig({ ...loadConfig(), targetPositionCount: null });
assert.equal(concentrationNote(1000, 5), '', 'no preference means no instruction');

setConfig({ ...loadConfig(), targetPositionCount: 4 });
const spread = concentrationNote(1000, 9);
assert.match(spread, /around 4 positions/);
assert.match(spread, /You currently hold 9/);
assert.match(spread, /full-size position is about \$250\.00/, '1000 split 4 ways');
assert.match(spread, /average \$111\.11/, '1000 spread across 9');
assert.match(spread, /holding more names than preferred/);
assert.match(spread, /preference, not a rule/, 'the model keeps the final say');

// At or under the target it should not be nagged to consolidate.
const focused = concentrationNote(1000, 3);
assert.ok(!/holding more names than preferred/.test(focused));
assert.match(focused, /You currently hold 3/);

// An empty book still gets a size to aim at, without a nonsense average.
const empty = concentrationNote(800, 0);
assert.match(empty, /full-size position is about \$200\.00/);
assert.ok(!/average/.test(empty), 'no positions means no average to quote');

setConfig(loadConfig());
console.log('concentration checks passed');

// ── Review selection must not starve the same positions forever ──────────────
// Urgency ranking is deterministic, so with more positions than budget the same
// low-urgency names are skipped every cycle — and a position that is never
// reviewed can never be trimmed or closed on judgement, only by its stop.
const reviewPos = (pair: string, urgencyPct: number, reviewedAgoMs?: number) => ({
  pair, status: 'open', sector: 'test', entryPrice: 100, qty: 1, costBasisUsd: 100,
  currentPrice: 100, stopLoss: 100 - urgencyPct, takeProfit: 500,
  reason: '', aiReasoning: '', openedAt: new Date().toISOString(),
  ...(reviewedAgoMs === undefined ? {} : { lastReviewedAt: new Date(Date.now() - reviewedAgoMs).toISOString() }),
}) as any;

const reviewNow = Date.now();
const book = [
  reviewPos('URGENT/USD', 1, 1_000),
  reviewPos('CLOSE/USD', 2, 1_000),
  reviewPos('MID/USD', 5, 1_000),
  reviewPos('CALM/USD', 20, 60 * 60_000),   // ignored for an hour
];
assert.deepEqual(rankReviewPositions(book).map(p => p.pair),
  ['URGENT/USD', 'CLOSE/USD', 'MID/USD', 'CALM/USD'], 'nearest to its stop first');

// Budget of 3: the two most urgent are kept, and the long-ignored position takes
// the last slot ahead of the least urgent of the selected.
const picked = selectReviews(book, 3, reviewNow).map(p => p.pair);
assert.equal(picked.length, 3);
assert.ok(picked.includes('URGENT/USD') && picked.includes('CLOSE/USD'), 'urgency still leads');
assert.ok(picked.includes('CALM/USD'), 'the longest-waiting position gets a turn');
assert.ok(!picked.includes('MID/USD'), 'it displaces the least urgent selection');

// A position never reviewed counts as waiting longest.
const withNewcomer = [...book.slice(0, 3), reviewPos('NEW/USD', 30)];
assert.ok(selectReviews(withNewcomer, 3, reviewNow).map(p => p.pair).includes('NEW/USD'));

// When everything has been reviewed equally recently, pure urgency decides.
const evenBook = [
  reviewPos('A/USD', 1, 1_000), reviewPos('B/USD', 2, 1_000),
  reviewPos('C/USD', 3, 1_000), reviewPos('D/USD', 4, 1_000),
];
assert.deepEqual(selectReviews(evenBook, 2, reviewNow).map(p => p.pair), ['A/USD', 'B/USD']);

// Budget at or above the book size reviews everything; zero reviews nothing.
assert.equal(selectReviews(book, 9, reviewNow).length, 4);
assert.deepEqual(selectReviews(book, 0, reviewNow), []);

console.log('review selection checks passed');

// ── Price alerts ─────────────────────────────────────────────────────────────
// A stop that fires automatically answers "is it down?" with "then sell". An
// alert instead puts the position in front of the model so it can ask why.
setConfig({ ...loadConfig(), alertAtR: 0.5 });
// Entry 100, stop 90 → 1R is 10, so a 0.5R drawdown alerts at 95.
assert.equal(defaultAlertPrice(100, 90), 95);
assert.equal(defaultAlertPrice(100, 80), 90);
// Nonsense geometry yields no alert rather than one that can never fire.
assert.equal(defaultAlertPrice(100, 100), null);
assert.equal(defaultAlertPrice(100, 110), null);

setConfig({ ...loadConfig(), alertAtR: 0 });
assert.equal(defaultAlertPrice(100, 90), null, 'ALERT_AT_R=0 disables alerts');
// An alert at or below the stop would never fire before the stop does.
setConfig({ ...loadConfig(), alertAtR: 1 });
assert.equal(defaultAlertPrice(100, 90), null);
setConfig({ ...loadConfig(), alertAtR: 0.5 });

const alertPos = (over: Record<string, unknown> = {}) => ({
  pair: 'AAA/USD', status: 'open', sector: 'ai', entryPrice: 100, qty: 1,
  costBasisUsd: 100, stopLoss: 90, takeProfit: 120, currentPrice: 100,
  reason: '', aiReasoning: '', openedAt: new Date().toISOString(),
  alertPrice: 95, ...over,
}) as any;

assert.equal(alertTriggered(alertPos(), 96), false, 'above the alert, nothing happens');
assert.equal(alertTriggered(alertPos(), 95), true, 'at the alert it fires');
assert.equal(alertTriggered(alertPos(), 93), true);
// Below the hard stop the stop owns the outcome, not the alert.
assert.equal(alertTriggered(alertPos(), 89), false);
assert.equal(alertTriggered(alertPos({ alertPrice: null }), 50), false);
assert.equal(alertTriggered(alertPos({ alertPrice: undefined }), 50), false);
assert.equal(alertTriggered(alertPos({ alertPrice: Number.NaN }), 50), false);

// The model can set its own alert level in a reply.
const withAlert = parseAiResponse('{"verdict":"HOLD","confidence":6,"reasoning":"watch support","alert_price":93.5}');
assert.equal(withAlert.decision?.alertPrice, 93.5);
assert.equal(parseAiResponse('{"verdict":"HOLD","confidence":6,"reasoning":"x"}').decision?.alertPrice, null);
assert.equal(parseAiResponse('{"verdict":"HOLD","confidence":6,"reasoning":"x","alert_price":-5}').decision?.alertPrice, null);
// A truncated reply must not be read as setting an alert it never expressed.
assert.equal(parseAiResponse('{"verdict":"SELL","confidence":9,"reasoning":"cut').decision?.alertPrice, null);

setConfig(loadConfig());
console.log('alert checks passed');

// ── The plan follows the price actually paid ─────────────────────────────────
// Levels are computed during the scan but the order fills later at a fresh
// quote. Left alone a position could open already below its own stop.
const planned = planTrade(base)!;   // entry 100, stop 94.05, target 115
const filled = rebasePlanToFill(planned, 100, 92);
assert.ok(filled.stop < 92, 'the stop must end up below the price actually paid');
assert.ok(Math.abs(filled.riskPct - planned.riskPct) < 1e-9, 'risk fraction is preserved');
assert.ok(Math.abs(filled.rr - planned.rr) < 1e-9, 'reward ratio is preserved');
assert.equal(rebasePlanToFill(planned, 100, 100).stop, planned.stop, 'no drift, no change');
assert.equal(rebasePlanToFill(planned, 0, 92), planned, 'nonsense input leaves the plan alone');

// ── A stop too close to entry cannot smuggle past the risk caps ──────────────
// Position size limits divide by the stop distance, so a stop a hair below entry
// drives risk toward zero and makes every risk-based cap unbounded.
const hairline = applyEntryPlan(planned, 100, decide({ adjustedStop: 99.9 }));
assert.equal(hairline.stop, 99.5, 'widened to the 0.5% floor');
assert.ok(hairline.riskPct >= 0.005 - 1e-9);
assert.match(hairline.notes.join(' '), /closer than the .* floor/);
// A stop comfortably inside the band is still honoured untouched.
assert.equal(applyEntryPlan(planned, 100, decide({ adjustedStop: 97 })).stop, 97);

// ── A fragment never opens a position ────────────────────────────────────────
const fragment = parseAiResponse('{"verdict":"BUY","confidence":9,"reasoning":"strong setup and the higher timef');
assert.equal(fragment.kind, 'salvaged');
assert.equal(fragment.decision?.salvaged, true, 'salvaged replies are flagged as such');
assert.equal(fragment.decision?.positionSizePct, 0);
const complete = parseAiResponse('{"verdict":"BUY","confidence":8,"reasoning":"ok","position_size_pct":10}');
assert.equal(complete.decision?.salvaged, false);

console.log('fill-rebase and salvage-guard checks passed');

// ── The model checks itself before committing ────────────────────────────────
// It states the strongest case against its own decision, then keeps or withdraws
// the verdict. Withdrawing is meant to have teeth, not be decoration.
const held = parseAiResponse('{"verdict":"BUY","confidence":8,"reasoning":"oversold at support","position_size_pct":15,"counter_case":"4h trend is rolling over","verdict_holds":true}');
assert.equal(held.decision?.verdict, 'BUY');
assert.equal(held.decision?.counterCase, '4h trend is rolling over');
assert.equal(held.decision?.verdictHolds, true);

const withdrawn = parseAiResponse('{"verdict":"BUY","confidence":7,"reasoning":"looks cheap","position_size_pct":15,"counter_case":"it is cheap because demand collapsed","verdict_holds":false}');
assert.equal(withdrawn.decision?.verdictHolds, false, 'an explicit false withdraws the trade');
assert.equal(withdrawn.decision?.verdict, 'BUY', 'the verdict is preserved for the log, but not acted on');

// Silence is not a withdrawal — a model that omits the field is not overruled.
const quiet = parseAiResponse('{"verdict":"SELL","confidence":9,"reasoning":"thesis broken"}');
assert.equal(quiet.decision?.verdictHolds, true);
assert.equal(quiet.decision?.counterCase, '');
// Nor is a non-boolean value treated as a withdrawal.
assert.equal(parseAiResponse('{"verdict":"HOLD","confidence":5,"reasoning":"x","verdict_holds":"yes"}').decision?.verdictHolds, true);
// A fragment never carries a self-check it did not actually make.
const torn = parseAiResponse('{"verdict":"BUY","confidence":9,"reasoning":"strong","counter_ca');
assert.equal(torn.decision?.verdictHolds, true);
assert.equal(torn.decision?.counterCase, '');

// The stance argues with itself too.
assert.equal(normalizeStance({ stance: 'RISK_ON', counter_case: 'breadth is thinning' }).counterCase, 'breadth is thinning');
assert.equal(normalizeStance({ stance: 'RISK_ON' }).counterCase, '');

// ── Sizing guidance is advice, not a floor ───────────────────────────────────
setConfig({ ...loadConfig(), targetPositionCount: 4 });
const advice = concentrationNote(400, 2);
assert.match(advice, /full-size position is about \$100\.00/);
assert.match(advice, /not worth a meaningful position, it is usually not worth taking/);
assert.match(advice, /Nothing forces your hand here/, 'it must read as guidance, not a rule');
setConfig(loadConfig());

console.log('self-check and sizing-guidance checks passed');

// ── Reserved assets are off limits entirely ──────────────────────────────────
// A hard boundary, deliberately: these are holdings the operator reserved. Being
// staked is not protection — unstaking would otherwise hand them to the bot.
setConfig({ ...loadConfig(), excludedAssets: new Set(['SOL', 'AVAX']) });
assert.equal(isExcludedPair('SOL/USD'), true);
assert.equal(isExcludedPair('AVAX/USD'), true);
assert.equal(isExcludedPair('LINK/USD'), false);
// Kraken's staking names must resolve to the same underlying asset.
assert.equal(isExcludedPair(`${normalizeAsset('SOL03.S')}/USD`), true);
assert.equal(isExcludedPair(`${normalizeAsset('AVAX.B')}/USD`), true);
// A reserved asset must not be reachable through a different quote currency.
assert.equal(isExcludedPair('SOL/USDC'), true);
assert.equal(isExcludedPair('SOL/EUR'), true);
// Nothing is excluded unless it was named.
setConfig({ ...loadConfig(), excludedAssets: new Set() });
assert.equal(isExcludedPair('SOL/USD'), false);

// Names are normalised on the way in, so casing and spacing do not defeat it.
process.env.EXCLUDED_ASSETS = ' sol , avax ';
const loaded = loadConfig();
assert.deepEqual([...loaded.excludedAssets].sort(), ['AVAX', 'SOL']);
delete process.env.EXCLUDED_ASSETS;
assert.equal(loadConfig().excludedAssets.size, 0);

// The model is told, so it never proposes one in the first place.
setConfig({ ...loadConfig(), excludedAssets: new Set(['SOL', 'AVAX']), targetPositionCount: 10 });
const guarded = concentrationNote(1000, 3);
assert.match(guarded, /RESERVED: AVAX, SOL/);
assert.match(guarded, /not yours to trade/);
assert.match(guarded, /around 10 positions/);
setConfig(loadConfig());

console.log('reserved-asset checks passed');

// ── Positions the operator bought are marked as theirs ───────────────────────
// Production sold one with the reasoning "imported position no thesis" — it read
// "I did not choose this" as a reason to sell. Origin makes the distinction real.
const legacyImported = {
  'AAA/USD': { pair: 'AAA/USD', status: 'open', reason: 'Imported from Kraken balance (Kraken trade history)' },
  'BBB/USD': { pair: 'BBB/USD', status: 'open', reason: 'RSI=29 bullish R/R=2.1' },
  'CCC/USD': { pair: 'CCC/USD', status: 'open', reason: 'anything', origin: 'bot' },
} as any;
// Records written before origin existed are classified by how they were created.
for (const position of Object.values<any>(legacyImported)) {
  if (position.origin === undefined)
    position.origin = /^Imported from Kraken balance/.test(position.reason || '') ? 'operator' : 'bot';
}
assert.equal(legacyImported['AAA/USD'].origin, 'operator', 'an imported holding was bought by the operator');
assert.equal(legacyImported['BBB/USD'].origin, 'bot', 'a bot entry keeps its own origin');
assert.equal(legacyImported['CCC/USD'].origin, 'bot', 'an explicit origin is never overwritten');

console.log('position origin checks passed');
