import dotenv from 'dotenv';
import ccxt from 'ccxt';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// ============================================================
// AI CRYPTO TRADING BOT v2.1 — GLM 5.2 + KRAKEN
// Single-file, production-ready. Deploy to Railway.
// AI: GLM 5.2 via OpenRouter (US, English)
// Exchange: Kraken (paper or live)
// ============================================================

// --- TYPES ---

export interface OhlcvCandle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
type Trend = 'bullish' | 'bearish' | 'neutral';
export interface TechnicalAnalysis {
  currentPrice: number; rsi: number;
  sma5: number | null; sma20: number | null; sma50: number | null;
  bollinger: { upper: number | null; middle: number | null; lower: number | null };
  supports: number[]; resistances: number[];
  volumeRatio: number; stochRsiK: number; stochRsiD: number;
  trend: Trend; maScore: number;
  /** Wilder ATR(14) on the analysed timeframe; null when history is too short. */
  atr: number | null;
  /** ATR as a fraction of price, the volatility unit used for stops and targets. */
  atrPct: number | null;
  /** Trend of the 4x-aggregated timeframe, used as a higher-timeframe filter. */
  htfTrend: Trend;
  /** MACD(12,26,9) histogram; positive means momentum is turning up. */
  macdHistogram: number | null;
}
export interface AiDecision {
  verdict: 'BUY' | 'HOLD' | 'SELL'; confidence: number; reasoning: string;
  positionSizePct: number; adjustedStop: number | null; adjustedTarget: number | null;
  /** Fraction of the position a SELL should close, 0-1. Defaults to all of it. */
  trimFraction: number;
}
interface BuyContext {
  portfolioValueUsd: number;
  spendableCashUsd: number;
  marketMinimumUsd: number | null;
  openPositions: number;
  exposureUsd: number;
  sectorExposureUsd: number;
  sectorTargetPct: number;
  concentration: string;
}
export interface Position {
  pair: string; status: 'open' | 'closed'; sector: string;
  entryPrice: number; qty: number; costBasisUsd: number;
  stopLoss: number; takeProfit: number; currentPrice: number;
  reason: string; aiReasoning: string; openedAt: string;
  /** Stop at entry, kept so realised risk (1R) stays measurable after trailing. */
  initialStopLoss?: number;
  /** Highest price seen while open; the anchor for the ATR trailing stop. */
  highWaterMark?: number;
  /** ATR at entry, so the trail keeps a consistent volatility distance. */
  entryAtr?: number | null;
  /** P/L already booked from partial exits on this position. */
  bookedPnlUsd?: number;
  closedAt?: string; exitPrice?: number; exitValueUsd?: number;
  pnlUsd?: number; pnlPct?: number; closeReason?: string;
}
interface ClosedTradeSummary {
  pair: string; sector: string; pnlUsd: number; pnlPct: number;
  closedAt: string; closeReason: string; holdDays: number;
}
interface SectorStat { trades: number; wins: number; pnlUsd: number }
/**
 * The model's call on the whole book, made once per cycle before any individual
 * entry is considered. Without this the AI could only answer BUY/HOLD/SELL on one
 * pair at a time and had no way to say "this market is toppy, sit in cash and wait
 * for lower prices" — or to ask for more capital.
 */
interface PortfolioStance {
  stance: 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
  confidence: number;
  reasoning: string;
  /** Share of the portfolio the model wants held back as dry powder, 0-1. */
  cashTargetPct: number;
  /** Extra capital the model is asking the operator to add, in USD. */
  requestedFundsUsd: number;
}
interface FundingRequest { usd: number; reasoning: string; requestedAt: string }
interface TradeRecord {
  timestamp: string; pair: string; side: 'BUY' | 'SELL';
  price: number; qty: number; costBasisUsd: number;
  stopLoss: number; takeProfit: number;
  pnlUsd: number; pnlPct: number; status: string;
  sector: string; reason: string; aiVerdict: string; aiConfidence: number;
}
interface OrderFill { qty: number; price: number; feeUsd: number }
/**
 * Honest breakdown of the account. Reporting "portfolio value minus tracked
 * positions" as cash counted staked and untracked holdings as spendable money —
 * production logs showed $70.96 of "cash" against a real free balance of $0.05.
 */
interface PortfolioSnapshot {
  /** Everything the account holds, including balances that cannot be traded. */
  totalUsd: number;
  /** Free cash and cash equivalents — what a buy can actually spend. */
  cashUsd: number;
  /** Cash plus freely tradable crypto. The base for position sizing. */
  tradableUsd: number;
  /** Staked or otherwise locked value, held but unusable. */
  stakedUsd: number;
}
interface BotState {
  startedAt: string; totalTrades: number; wins: number; losses: number;
  totalPnl: number; bestTrade: number | null; worstTrade: number | null;
  lastScan: string; lastAiDecision: string; cycleCount: number;
  /** Most recent closes, so the AI's "I remember my trades" is actually true. */
  recentTrades: ClosedTradeSummary[];
  /** Per-sector realised performance, used to steer allocation over time. */
  sectorStats: Record<string, SectorStat>;
  /** UTC day the realised-loss ledger below belongs to. */
  riskDay: string;
  /** Realised P/L booked during `riskDay`, for the daily-loss circuit breaker. */
  riskDayPnl: number;
  /** Simulated cash in paper mode, so paper results actually compound. */
  paperCash: number | null;
  /** The model's most recent read on the market, for continuity across cycles. */
  lastStance: PortfolioStance | null;
  /** Standing request for more capital, surfaced until the operator acts on it. */
  fundingRequest: FundingRequest | null;
}

// --- CONFIG ---

type TradingConfig = {
  paperMode: boolean;
  fallbackPortfolioValue: number;
  scanIntervalMs: number;
  maxExposurePct: number | null;
  maxRiskPerTradePct: number | null;
  maxPortfolioRiskPct: number | null;
  minRrRatio: number | null;
  minTradeUsd: number | null;
  aiConfidenceThreshold: number | null;
  aiSellConfidenceThreshold: number | null;
  aiDecisionsPerCycle: number;
  aiReviewsPerCycle: number | null;
  /** Preferred number of concurrent positions. Guidance for the AI, not a cap. */
  targetPositionCount: number | null;
  topUpStrandedPositions: boolean;
  topUpMaxPct: number;
  scanMaxRsi: number | null;
  feeReservePct: number;
  aiMaxTokens: number;
  aiBaseUrl: string | null;
  loopMode: boolean;
  atrStopMult: number;
  atrTargetMult: number;
  trailingStopAtrMult: number;
  breakevenAtR: number;
  maxDailyLossPct: number | null;
  maxOpenPositions: number | null;
  maxSectorExposurePct: number | null;
  ohlcvConcurrency: number;
  maxStopDistancePct: number;
  aiReasoningEffort: 'off' | 'low' | 'medium' | 'high';
  preflight: boolean;
  preflightAiSamples: number;
};
let CONFIG: TradingConfig;

/** Installs the active configuration. `main()` calls this; tests use it to set up. */
export function setConfig(config: TradingConfig): TradingConfig {
  CONFIG = config;
  return CONFIG;
}

function envNumber(name: string, fallback: number, min: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max))
    throw new Error(`${name} must be a number${max === undefined ? ` >= ${min}` : ` between ${min} and ${max}`}; got "${raw}"`);
  return value;
}

function envInteger(name: string, fallback: number, min: number): number {
  const value = envNumber(name, fallback, min);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number; got "${process.env[name]}"`);
  return value;
}

function optionalEnvInteger(name: string, min: number, fallback: number | null): number | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || !Number.isInteger(value))
    throw new Error(`${name} must be a positive whole number; got "${raw}"`);
  return value;
}

function optionalEnvNumber(name: string, min: number, max?: number): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max))
    throw new Error(`${name} must be a number${max === undefined ? ` >= ${min}` : ` between ${min} and ${max}`}; got "${raw}"`);
  return value;
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase() as T;
  if (!allowed.includes(value))
    throw new Error(`${name} must be one of ${allowed.join(', ')}; got "${raw}"`);
  return value;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false; got "${raw}"`);
}

function loadConfig(): TradingConfig {
  const loopMode = !process.argv.includes('--once') &&
    (process.argv.includes('--loop') || envBoolean('LOOP_MODE', true));
  return {
    paperMode: envBoolean('PAPER_MODE', false),
    fallbackPortfolioValue: envNumber('PORTFOLIO_VALUE', 200, 0.01),
    scanIntervalMs: envNumber('SCAN_INTERVAL_MINUTES', 30, 0.01) * 60 * 1000,
    maxExposurePct: optionalEnvNumber('MAX_EXPOSURE_PCT', 0, 1),
    maxRiskPerTradePct: optionalEnvNumber('MAX_RISK_PER_TRADE_PCT', 0, 1),
    maxPortfolioRiskPct: optionalEnvNumber('MAX_PORTFOLIO_RISK_PCT', 0, 1),
    minRrRatio: optionalEnvNumber('MIN_RR_RATIO', 0),
    minTradeUsd: optionalEnvNumber('MIN_TRADE_USD', 0),
    aiConfidenceThreshold: optionalEnvNumber('AI_CONFIDENCE_THRESHOLD', 1, 10),
    aiSellConfidenceThreshold: optionalEnvNumber('AI_SELL_CONFIDENCE_THRESHOLD', 1, 10),
    aiDecisionsPerCycle: envInteger('AI_DECISIONS_PER_CYCLE', 3, 1),
    aiReviewsPerCycle: optionalEnvInteger('AI_REVIEWS_PER_CYCLE', 1, 5),
    targetPositionCount: optionalEnvInteger('TARGET_POSITION_COUNT', 1, null),
    topUpStrandedPositions: envBoolean('TOPUP_STRANDED_POSITIONS', true),
    topUpMaxPct: envNumber('TOPUP_MAX_PCT', 0.05, 0, 1),
    scanMaxRsi: optionalEnvNumber('SCAN_MAX_RSI', 0, 100),
    feeReservePct: envNumber('FEE_RESERVE_PCT', 0.01, 0, 0.1),
    aiMaxTokens: envInteger('AI_MAX_TOKENS', 4000, 1),
    aiBaseUrl: process.env.AI_BASE_URL?.trim() || null,
    loopMode,
    atrStopMult: envNumber('ATR_STOP_MULT', 2, 0.1, 20),
    atrTargetMult: envNumber('ATR_TARGET_MULT', 4, 0.1, 50),
    trailingStopAtrMult: envNumber('TRAILING_STOP_ATR_MULT', 2.5, 0, 20),
    breakevenAtR: envNumber('BREAKEVEN_AT_R', 1, 0, 10),
    maxDailyLossPct: optionalEnvNumber('MAX_DAILY_LOSS_PCT', 0, 1),
    maxOpenPositions: optionalEnvNumber('MAX_OPEN_POSITIONS', 1),
    maxSectorExposurePct: optionalEnvNumber('MAX_SECTOR_EXPOSURE_PCT', 0, 1),
    ohlcvConcurrency: envInteger('OHLCV_CONCURRENCY', 4, 1),
    maxStopDistancePct: envNumber('MAX_STOP_DISTANCE_PCT', 0.15, 0.01, 0.9),
    aiReasoningEffort: envEnum('AI_REASONING_EFFORT', ['off', 'low', 'medium', 'high'], 'low'),
    preflight: envBoolean('PREFLIGHT', true),
    preflightAiSamples: envInteger('PREFLIGHT_AI_SAMPLES', 2, 0),
  };
}

const BALANCE_DUST_USD = 1;
const POSITION_QTY_TOLERANCE_PCT = 0.01;
const IMPORTED_POSITION_STOP_PCT = 0.05;
const IMPORTED_POSITION_TARGET_PCT = 0.10;
const REQUEST_TIMEOUT_MS = 20_000;
const RECENT_TRADE_MEMORY = 25;
const MAX_AI_TOKEN_BUDGET = 16_000;
const ORDER_POLL_ATTEMPTS = 5;
const ORDER_POLL_DELAY_MS = 1_000;
/** A residual worth less than this after a partial exit is dust, not a position. */
const PARTIAL_EXIT_DUST_PCT = 0.10;
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

const WATCHLIST: Record<string, string[]> = {
  ai: ['VIRTUAL/USD', 'RENDER/USD', 'FET/USD', 'TAO/USD'],
  rwa: ['ONDO/USD'],
  defi: ['MORPHO/USD', 'AERO/USD', 'LINK/USD', 'PENDLE/USD', 'UNI/USD'],
  l1: ['NEAR/USD', 'SOL/USD', 'SUI/USD', 'ADA/USD'],
  depin: ['AKT/USD'],
  perp_dex: ['HYPE/USD'],
  momentum: ['PUMP/USD', 'DOGE/USD', 'BONK/USD'],
  privacy: ['XMR/USD'],
};
const ALL_PAIRS = Object.values(WATCHLIST).flat();
const SECTOR_WEIGHTS: Record<string, number> = {
  ai: 0.25, rwa: 0.20, defi: 0.25, l1: 0.10,
  perp_dex: 0.10, momentum: 0.05, depin: 0.03, privacy: 0.02,
};

// Railway-style hosts wipe the working directory on redeploy; point DATA_DIR at a
// mounted volume to keep positions and trade history across restarts.
const DATA_DIR = path.resolve(process.env.DATA_DIR?.trim() || path.join(process.cwd(), 'data'));
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.csv');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// --- HELPERS ---

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const fmt = (n: number) => {
  if (!Number.isFinite(n)) return '$n/a';
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs === 0) return '$0.00';
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  // Sub-cent assets (BONK, PUMP) need enough decimals to stay distinguishable.
  return `$${n.toFixed(Math.min(12, Math.ceil(-Math.log10(abs)) + 3))}`;
};
const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
const ASSET_ALIASES: Record<string, string> = {
  XBT: 'BTC', XXBT: 'BTC', XDG: 'DOGE', XXDG: 'DOGE', ZUSD: 'USD', ETH2: 'ETH',
};
const STAKED_BALANCE_SUFFIXES = new Set(['S', 'B', 'F', 'M']);
const CASH_EQUIVALENTS = new Set([
  'USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'TUSD', 'USDP', 'USDD', 'FDUSD',
  'USDS', 'USDE', 'USDA', 'USDG', 'RLUSD', 'GUSD', 'FRAX', 'LUSD',
]);

/**
 * Kraken names staking balances `<ASSET><DURATION>.<SUFFIX>` — SOL03.S, DOT28.S,
 * ATOM21.S. Keeping the duration digits meant `SOL03` matched no market, so a
 * staked SOL position was invisible to the bot: it appeared in neither the
 * portfolio total nor the unmapped-holding warnings.
 */
function normalizeAsset(asset: string): string {
  const base = asset.toUpperCase().split('.')[0];
  if (ASSET_ALIASES[base]) return ASSET_ALIASES[base];
  const withoutDuration = base.replace(/\d+$/, '');
  if (withoutDuration && withoutDuration !== base)
    return ASSET_ALIASES[withoutDuration] || withoutDuration;
  return base;
}

function isStakedBalance(asset: string): boolean {
  return asset.toUpperCase().split('.').slice(1).some(suffix => STAKED_BALANCE_SUFFIXES.has(suffix));
}

const utcDay = () => new Date().toISOString().slice(0, 10);

/** RFC 4180 quoting. AI reasoning is free text and routinely contains commas. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function getSector(pair: string): string {
  for (const [sector, pairs] of Object.entries(WATCHLIST)) {
    if (pairs.includes(pair)) return sector;
  }
  return 'unlisted';
}

// Retrying an authentication failure, a rejected order, or an unknown symbol can
// never succeed; it only delays the cycle and hammers the exchange's rate limit.
const NON_RETRYABLE_ERRORS = new Set([
  'AuthenticationError', 'PermissionDenied', 'AccountSuspended', 'AccountNotEnabled',
  'InsufficientFunds', 'InvalidOrder', 'OrderNotFound', 'BadSymbol', 'BadRequest',
  'ArgumentsRequired', 'NotSupported', 'InvalidAddress',
]);

export function isRetryableError(error: unknown): boolean {
  const value = error as any;
  for (const name of [value?.constructor?.name, value?.name]) {
    if (typeof name === 'string' && NON_RETRYABLE_ERRORS.has(name)) return false;
  }
  const status = Number(value?.status ?? value?.statusCode ?? value?.response?.status);
  // 4xx means the request itself is wrong; 408 (timeout) and 429 (rate limit) are the
  // two that a later attempt can still satisfy.
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429)
    return false;
  return true;
}

async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = RETRY_ATTEMPTS,
  shouldRetry: (error: unknown) => boolean = isRetryableError,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[RETRY] ${label} failed (${attempt}/${attempts}): ${message}`);
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Drops any candle that has not closed yet. Exchanges return the in-progress bar as
 * the last element, so every average built on it repaints between cycles.
 */
export function closedCandles(candles: OhlcvCandle[], timeframe: string, now = Date.now()): OhlcvCandle[] {
  const span = TIMEFRAME_MS[timeframe];
  if (!span || candles.length === 0) return candles;
  let end = candles.length;
  while (end > 0 && candles[end - 1].timestamp + span > now) end--;
  return candles.slice(0, end);
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ============================================================
// TECHNICAL ANALYZER — Pure math, no side effects
// ============================================================

const TA = {
  /**
   * Wilder RSI for every close from index `period` onward, in one pass.
   * The previous implementation recomputed RSI from scratch per bar, which was
   * quadratic and seeded the series with a placeholder 50.
   */
  rsiSeries(closes: number[], period = 14): number[] {
    if (closes.length < period + 1) return [];
    const deltas = closes.slice(1).map((close, i) => close - closes[i]);
    const value = (gain: number, loss: number) => {
      if (gain === 0 && loss === 0) return 50;
      if (loss === 0) return 100;
      if (gain === 0) return 0;
      return 100 - 100 / (1 + gain / loss);
    };
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      avgGain += Math.max(deltas[i], 0);
      avgLoss += Math.max(-deltas[i], 0);
    }
    avgGain /= period;
    avgLoss /= period;
    const series = [value(avgGain, avgLoss)];
    for (let i = period; i < deltas.length; i++) {
      avgGain = (avgGain * (period - 1) + Math.max(deltas[i], 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-deltas[i], 0)) / period;
      series.push(value(avgGain, avgLoss));
    }
    return series;
  },

  rsi(closes: number[], period = 14): number {
    const series = this.rsiSeries(closes, period);
    if (!series.length) return 50;
    return parseFloat(series[series.length - 1].toFixed(2));
  },

  sma(closes: number[], period: number): number | null {
    if (closes.length < period) return null;
    return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(6));
  },

  ema(closes: number[], period: number): number | null {
    if (closes.length < period) return null;
    const m = 2 / (period + 1);
    let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) e = (closes[i] - e) * m + e;
    return parseFloat(e.toFixed(6));
  },

  bollinger(closes: number[], period = 20, mult = 2.0) {
    if (closes.length < period) return { upper: null, middle: null, lower: null };
    const s = closes.slice(-period);
    const mean = s.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(s.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period);
    return { upper: +(mean + mult * std).toFixed(6), middle: +mean.toFixed(6), lower: +(mean - mult * std).toFixed(6) };
  },

  supports(lows: number[], price: number, count = 3): number[] {
    if (lows.length < 10) return [];
    const hits: number[] = [];
    for (let i = 2; i < lows.length - 2; i++) {
      if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 2] && lows[i] < price)
        hits.push(+lows[i].toFixed(6));
    }
    // Nearest support first: callers place stops just under supports[0], and sorting
    // ascending handed them the *lowest* swing low in ~8 days of history instead.
    const out: number[] = [];
    for (const s of [...new Set(hits)].sort((a, b) => b - a)) {
      if (!out.length || Math.abs(s - out[out.length - 1]) / out[out.length - 1] > 0.01) out.push(s);
    }
    return out.slice(0, count);
  },

  resistances(highs: number[], price: number, count = 3): number[] {
    if (highs.length < 10) return [];
    const hits: number[] = [];
    for (let i = 2; i < highs.length - 2; i++) {
      if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 2] && highs[i] > price)
        hits.push(+highs[i].toFixed(6));
    }
    const out: number[] = [];
    for (const r of [...new Set(hits)].sort((a, b) => a - b)) {
      if (!out.length || Math.abs(r - out[out.length - 1]) / out[out.length - 1] > 0.01) out.push(r);
    }
    return out.slice(0, count);
  },

  /** Expects closed candles only; the caller drops any still-forming bar first. */
  volRatio(volumes: number[]): number {
    if (volumes.length < 21) return 1;
    const last = volumes[volumes.length - 1];
    const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    return avg === 0 ? 1 : +(last / avg).toFixed(2);
  },

  /** Wilder ATR — the volatility unit used for stops, targets and sizing. */
  atr(candles: OhlcvCandle[], period = 14): number | null {
    if (candles.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const { high, low } = candles[i];
      const previousClose = candles[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
    }
    let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) value = (value * (period - 1) + trs[i]) / period;
    return Number.isFinite(value) && value > 0 ? value : null;
  },

  /** MACD histogram (12/26/9). Positive and rising means momentum is turning up. */
  macdHistogram(closes: number[], fast = 12, slow = 26, signal = 9): number | null {
    if (closes.length < slow + signal) return null;
    const emaSeries = (values: number[], period: number): number[] => {
      const multiplier = 2 / (period + 1);
      let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const out = [current];
      for (let i = period; i < values.length; i++) {
        current = (values[i] - current) * multiplier + current;
        out.push(current);
      }
      return out;
    };
    const fastSeries = emaSeries(closes, fast);
    const slowSeries = emaSeries(closes, slow);
    // Align on the shorter (slow) series, which starts `slow - fast` bars later.
    const offset = fastSeries.length - slowSeries.length;
    const macd = slowSeries.map((value, i) => fastSeries[i + offset] - value);
    if (macd.length < signal) return null;
    const signalSeries = emaSeries(macd, signal);
    const histogram = macd[macd.length - 1] - signalSeries[signalSeries.length - 1];
    return Number.isFinite(histogram) ? histogram : null;
  },

  /** Aggregates candles into `factor`-times-longer bars for a higher-timeframe read. */
  aggregate(candles: OhlcvCandle[], factor: number): OhlcvCandle[] {
    if (factor <= 1) return candles;
    const out: OhlcvCandle[] = [];
    // Anchor to the end so the most recent bucket is complete rather than partial.
    const start = candles.length % factor;
    for (let i = start; i + factor <= candles.length; i += factor) {
      const bucket = candles.slice(i, i + factor);
      out.push({
        timestamp: bucket[0].timestamp,
        open: bucket[0].open,
        high: Math.max(...bucket.map(c => c.high)),
        low: Math.min(...bucket.map(c => c.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((sum, c) => sum + c.volume, 0),
      });
    }
    return out;
  },

  stochRsi(closes: number[], rsiP = 14, stochP = 14): [number, number] {
    const rsis = this.rsiSeries(closes, rsiP);
    if (rsis.length < stochP) return [50, 50];
    const kSeries: number[] = [];
    for (let i = stochP - 1; i < rsis.length; i++) {
      const window = rsis.slice(i - stochP + 1, i + 1);
      const min = Math.min(...window);
      const max = Math.max(...window);
      kSeries.push(max === min ? 50 : ((rsis[i] - min) / (max - min)) * 100);
    }
    const k = kSeries[kSeries.length - 1];
    // %D is the 3-period average of %K. It previously averaged raw RSI values,
    // which produced a "D" on a completely different scale from K.
    const recentK = kSeries.slice(-3);
    const d = recentK.reduce((a, b) => a + b, 0) / recentK.length;
    return [+k.toFixed(2), +d.toFixed(2)];
  },

  /** Stacked-average trend read: fast above medium above slow is an uptrend. */
  trendFrom(closes: number[], periods: [number, number, number]): Trend {
    const [fast, medium, slow] = periods;
    if (closes.length < slow) return 'neutral';
    const a = this.sma(closes, fast), b = this.sma(closes, medium), c = this.sma(closes, slow);
    if (a !== null && b !== null && c !== null) {
      if (a > b && b > c) return 'bullish';
      if (a < b && b < c) return 'bearish';
    }
    return 'neutral';
  },

  trend(closes: number[]): Trend {
    return this.trendFrom(closes, [5, 20, 50]);
  },

  /**
   * Full snapshot. `candles` must contain closed candles only — a still-forming bar
   * makes every average repaint between cycles. Use `closedCandles()` first.
   */
  full(candles: OhlcvCandle[], price: number): TechnicalAnalysis | null {
    if (candles.length < 50 || !Number.isFinite(price) || price <= 0) return null;
    const c = candles.map(x => x.close), h = candles.map(x => x.high);
    const l = candles.map(x => x.low), v = candles.map(x => x.volume);
    const s5 = this.sma(c, 5), s20 = this.sma(c, 20), s50 = this.sma(c, 50);
    let maScore = 0;
    if (s5 !== null) maScore += price > s5 ? 1 : -1;
    if (s20 !== null) maScore += price > s20 ? 1 : -1;
    if (s50 !== null) maScore += price > s50 ? 1 : -1;
    const [stochK, stochD] = this.stochRsi(c);
    const atr = this.atr(candles);
    // A 4x aggregate of the same candles gives a higher-timeframe trend filter for
    // free, without spending another rate-limited request per pair.
    const higher = this.aggregate(candles, 4);
    return {
      currentPrice: price, rsi: this.rsi(c), sma5: s5, sma20: s20, sma50: s50,
      bollinger: this.bollinger(c), supports: this.supports(l, price),
      resistances: this.resistances(h, price), volumeRatio: this.volRatio(v),
      stochRsiK: stochK, stochRsiD: stochD, trend: this.trend(c), maScore,
      atr,
      atrPct: atr === null ? null : atr / price,
      htfTrend: this.trendFrom(higher.map(x => x.close), [5, 10, 20]),
      macdHistogram: this.macdHistogram(c),
    };
  },
};

function applyPositionAdjustments(
  position: Position,
  adjustedStop: number | null,
  adjustedTarget: number | null
): { stop: number | null; target: number | null; rejected: string[] } {
  let stop: number | null = null;
  let target: number | null = null;
  const rejected: string[] = [];
  if (adjustedStop !== null) {
    if (!Number.isFinite(adjustedStop) || adjustedStop <= 0 || adjustedStop >= position.currentPrice)
      rejected.push(`stop ${fmt(adjustedStop)} is not below current price ${fmt(position.currentPrice)}`);
    else if (adjustedStop <= position.stopLoss)
      rejected.push(`stop ${fmt(adjustedStop)} would loosen the existing stop ${fmt(position.stopLoss)}`);
    else stop = adjustedStop;
  }
  if (adjustedTarget !== null) {
    if (!Number.isFinite(adjustedTarget) || adjustedTarget <= position.currentPrice)
      rejected.push(`target ${fmt(adjustedTarget)} is not above current price ${fmt(position.currentPrice)}`);
    else target = adjustedTarget;
  }
  return { stop, target, rejected };
}

interface TradePlan { stop: number; target: number; rr: number; riskPct: number; basis: string }

/**
 * How the operator wants capital concentrated, phrased for the model.
 *
 * Spreading a small account across many positions loses a disproportionate share
 * to fees and to exchange minimums, and leaves no single winner big enough to
 * matter. This is deliberately advisory: it tells the model what is preferred and
 * what a full-size position looks like, and lets it disagree with a reason.
 */
export function concentrationNote(portfolioValue: number, openCount: number): string {
  const target = CONFIG.targetPositionCount;
  if (target === null) return '';
  const fullSize = portfolioValue / target;
  const average = openCount > 0 ? portfolioValue / openCount : 0;
  const lines = [
    'CONCENTRATION PREFERENCE:',
    `The operator prefers a concentrated book — around ${target} positions rather than many small ones.`,
    `You currently hold ${openCount}.`,
    `At that concentration a full-size position is about ${fmt(fullSize)}.`,
  ];
  if (openCount > 0)
    lines.push(`Your positions currently average ${fmt(average)}.`);
  if (openCount > target)
    lines.push(`You are holding more names than preferred. Closing or trimming the weakest is how you free capital to size the best ones properly.`);
  lines.push(
    'Fees and exchange minimums take a disproportionate bite out of small positions,',
    'and a position too small to matter cannot pay for the risk of holding it.',
    'Size toward full size when conviction is high; take nothing when it is not.',
    'This is a preference, not a rule — concentrate further or spread wider if you can say why.',
  );
  return lines.join('\n');
}

/**
 * Builds the stop and target for a new entry.
 *
 * The previous model put the stop a flat 3% under a swing low and the target at a
 * flat +20%, which ignored volatility entirely: the same distance is noise on a
 * meme coin and a thesis-breaking move on a blue chip. Stops are placed below
 * structure *and* outside normal volatility, then capped so a single trade cannot
 * risk an unbounded share of the entry.
 */
export function planTrade(ta: TechnicalAnalysis): TradePlan | null {
  const price = ta.currentPrice;
  if (!Number.isFinite(price) || price <= 0) return null;
  const atr = ta.atr && ta.atr > 0 ? ta.atr : null;
  const support = ta.supports.find(s => s < price);
  const resistance = ta.resistances.find(r => r > price);

  const candidates: number[] = [];
  if (support !== undefined) candidates.push(support * 0.99);
  if (atr !== null) candidates.push(price - CONFIG.atrStopMult * atr);
  if (!candidates.length) candidates.push(price * (1 - CONFIG.maxStopDistancePct));
  // Take the safer (lower) of structure and volatility, then cap the risk.
  const floor = price * (1 - CONFIG.maxStopDistancePct);
  const stop = Math.max(floor, Math.min(...candidates));
  if (!(stop > 0) || stop >= price) return null;

  const risk = price - stop;
  const atrTarget = atr !== null ? price + CONFIG.atrTargetMult * atr : price * 1.20;
  // Resistance is a realistic exit, but only when it is far enough away to pay for
  // the risk taken; otherwise aim past it at the volatility target.
  const target = resistance !== undefined && resistance - price >= risk * 1.5
    ? resistance
    : Math.max(atrTarget, price + risk * 1.5);
  const basis = atr === null ? 'structure only (ATR unavailable)' : `${CONFIG.atrStopMult}x ATR ${fmt(atr)}`;
  return { stop, target, rr: (target - price) / risk, riskPct: risk / price, basis };
}

/**
 * Applies the model's own stop and target for a new entry, falling back to the
 * bot's ATR plan for anything it does not specify.
 *
 * At entry the model owns the trade plan — it can run a wider stop for a volatile
 * name or a tighter one for a tight base. The single rule the bot keeps is the
 * hard risk cap: a stop further from entry than MAX_STOP_DISTANCE_PCT is clamped,
 * because one trade should not be able to cost an unbounded share of the account.
 * Once the position is open the ratchet-only rule takes over and stops never widen.
 */
export function applyEntryPlan(plan: TradePlan, price: number, decision: AiDecision): TradePlan & { notes: string[] } {
  const notes: string[] = [];
  let stop = plan.stop;
  let target = plan.target;

  // The model routinely echoes the levels it was shown; only a real change is
  // worth reporting.
  const differs = (a: number, b: number) => Math.abs(a - b) > Math.max(b * 1e-4, Number.EPSILON);

  if (decision.adjustedStop !== null && Number.isFinite(decision.adjustedStop)) {
    const floor = price * (1 - CONFIG.maxStopDistancePct);
    if (decision.adjustedStop >= price) {
      notes.push(`ignored AI stop ${fmt(decision.adjustedStop)}: not below entry ${fmt(price)}`);
    } else if (decision.adjustedStop < floor) {
      stop = floor;
      notes.push(`AI stop ${fmt(decision.adjustedStop)} clamped to the ${pct(CONFIG.maxStopDistancePct)} risk cap at ${fmt(floor)}`);
    } else {
      stop = decision.adjustedStop;
      if (differs(stop, plan.stop)) notes.push(`AI stop ${fmt(stop)} replaces ${fmt(plan.stop)}`);
    }
  }

  if (decision.adjustedTarget !== null && Number.isFinite(decision.adjustedTarget)) {
    if (decision.adjustedTarget <= price)
      notes.push(`ignored AI target ${fmt(decision.adjustedTarget)}: not above entry ${fmt(price)}`);
    else {
      target = decision.adjustedTarget;
      if (differs(target, plan.target)) notes.push(`AI target ${fmt(target)} replaces ${fmt(plan.target)}`);
    }
  }

  const risk = price - stop;
  if (!(risk > 0)) return { ...plan, notes };
  return { stop, target, rr: (target - price) / risk, riskPct: risk / price, basis: plan.basis, notes };
}

/**
 * Ratchets a stop upward as a trade works: to breakeven once it clears
 * `BREAKEVEN_AT_R`, then trailing `TRAILING_STOP_ATR_MULT` ATR below the highest
 * price seen. Returns null when nothing should move — the stop never widens.
 */
export function trailingStop(
  position: Position, price: number, atr: number | null,
): { stop: number; reason: string } | null {
  const entry = position.entryPrice;
  const initialStop = position.initialStopLoss ?? position.stopLoss;
  const risk = entry - initialStop;
  const high = Math.max(position.highWaterMark ?? entry, price);
  let candidate = position.stopLoss;
  let reason = '';

  // The trail stays parked until the trade has actually earned its keep. Engaging
  // it from the first bar would override the entry stop, which was placed at
  // structure on purpose, and choke positions before they can work.
  const activation = risk > 0 && CONFIG.breakevenAtR > 0 ? entry + CONFIG.breakevenAtR * risk : entry;
  if (high < activation) return null;

  if (CONFIG.breakevenAtR > 0 && risk > 0 && candidate < entry) {
    candidate = entry;
    reason = `locked in breakeven after +${CONFIG.breakevenAtR}R`;
  }
  const trailAtr = atr && atr > 0 ? atr : position.entryAtr && position.entryAtr > 0 ? position.entryAtr : null;
  if (CONFIG.trailingStopAtrMult > 0 && trailAtr !== null) {
    const trail = high - CONFIG.trailingStopAtrMult * trailAtr;
    if (trail > candidate) {
      candidate = trail;
      reason = `trailing ${CONFIG.trailingStopAtrMult}x ATR below high ${fmt(high)}`;
    }
  }
  // Never place a stop at or above the market: that is an instant, unintended exit.
  if (candidate <= position.stopLoss || candidate >= price) return null;
  return { stop: candidate, reason };
}

function updateTradeExtremes(state: BotState, pnl: number): void {
  if (pnl > 0 && (state.bestTrade === null || pnl > state.bestTrade)) state.bestTrade = pnl;
  if (pnl < 0 && (state.worstTrade === null || pnl < state.worstTrade)) state.worstTrade = pnl;
}

interface SetupScore {
  score: number;
  rsiComponent: number;
  supportComponent: number;
  trendComponent: number;
  volumeComponent: number;
  htfComponent: number;
  momentumComponent: number;
  supportDistance: number | null;
}

/**
 * Ranks which setups are worth an AI call. Buying an oversold coin inside a
 * higher-timeframe downtrend is the classic way to catch a falling knife, so the
 * 4x trend and momentum turn now carry real weight alongside RSI and structure.
 */
export function scoreSetup(ta: TechnicalAnalysis): SetupScore {
  const support = ta.supports.find(s => s < ta.currentPrice);
  const supportDistance = support === undefined ? null : (ta.currentPrice - support) / ta.currentPrice;
  const rsiComponent = Math.max(0, Math.min(100, 100 - ta.rsi));
  const supportComponent = supportDistance === null
    ? 0
    : 100 * Math.max(0, 1 - supportDistance / 0.10);
  const trendComponent = ta.trend === 'bullish' ? 100 : ta.trend === 'neutral' ? 60 : 20;
  const volumeComponent = Math.max(0, Math.min(ta.volumeRatio, 2) / 2 * 100);
  const htfComponent = ta.htfTrend === 'bullish' ? 100 : ta.htfTrend === 'neutral' ? 55 : 10;
  // StochRSI %K crossing up through %D from oversold is the actual bounce trigger;
  // a positive MACD histogram confirms it.
  const crossUp = ta.stochRsiK > ta.stochRsiD ? 60 : 25;
  const oversoldBonus = ta.stochRsiK < 20 ? 40 : ta.stochRsiK < 50 ? 20 : 0;
  const macdBonus = ta.macdHistogram !== null && ta.macdHistogram > 0 ? 10 : 0;
  const momentumComponent = Math.max(0, Math.min(100, crossUp + oversoldBonus + macdBonus));
  const score = rsiComponent * 0.30 + supportComponent * 0.20 + trendComponent * 0.15 +
    volumeComponent * 0.10 + htfComponent * 0.15 + momentumComponent * 0.10;
  return {
    score: Math.max(0, Math.min(100, score)),
    rsiComponent, supportComponent, trendComponent, volumeComponent,
    htfComponent, momentumComponent, supportDistance,
  };
}

function reviewUrgency(position: Position): number {
  if (!Number.isFinite(position.currentPrice) || position.currentPrice <= 0) return Number.POSITIVE_INFINITY;
  return Math.min(
    Math.abs(position.currentPrice - position.stopLoss),
    Math.abs(position.takeProfit - position.currentPrice),
  ) / position.currentPrice;
}

function reviewPnlPct(position: Position): number {
  return position.entryPrice > 0
    ? ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100
    : 0;
}

export function rankReviewPositions(positions: Position[]): Position[] {
  return [...positions].sort((a, b) => {
    const urgencyDelta = reviewUrgency(a) - reviewUrgency(b);
    if (urgencyDelta !== 0) return urgencyDelta;
    return Math.abs(reviewPnlPct(b)) - Math.abs(reviewPnlPct(a));
  });
}

// ============================================================
// EXCHANGE CLIENT — Kraken via ccxt (paper or live)
// ============================================================

class Exchange {
  private ex: any;
  readonly paper: boolean;
  private cycleBalance: any = null;
  private balanceLoaded = false;
  private balanceDirty = false;
  private marketsPromise: Promise<void> | null = null;
  private cyclePrices: Record<string, number> = {};
  private cycleTickers: Record<string, { price: number; volume24h: number }> = {};

  constructor(apiKey?: string, apiSecret?: string, paperMode = true) {
    this.paper = paperMode;
    const opts: Record<string, any> = { enableRateLimit: true, timeout: REQUEST_TIMEOUT_MS };
    if (!paperMode) {
      if (!apiKey || !apiSecret) throw new Error('KRAKEN_API_KEY and KRAKEN_API_SECRET required for live mode');
      opts.apiKey = apiKey;
      opts.secret = apiSecret;
    }
    this.ex = new ccxt.kraken(opts);
    console.log(paperMode
      ? '[EXCHANGE] PAPER MODE — real data, simulated trades'
      : '[EXCHANGE] *** LIVE MODE — REAL MONEY ***');
  }

  /**
   * Cached per cycle so a scan does not re-request the same ticker. Pass
   * `fresh` when the price is about to size a real order — a cached quote can be
   * half an hour stale by the time phase 3 runs.
   */
  async getPrice(pair: string, fresh = false): Promise<number | null> {
    if (!fresh && this.cyclePrices[pair] !== undefined) return this.cyclePrices[pair];
    try {
      const t = await withRetry<any>(`ticker ${pair}`, () => this.ex.fetchTicker(pair));
      const price = t.last ?? t.close ?? null;
      if (price !== null) {
        this.cyclePrices[pair] = price;
        this.cycleTickers[pair] = { price, volume24h: t.quoteVolume ?? t.baseVolume ?? 0 };
      }
      return price;
    } catch (e) {
      console.warn(`[EXCHANGE] Price unavailable for ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async getTicker(pair: string): Promise<{ price: number; volume24h: number } | null> {
    if (this.cycleTickers[pair]) return this.cycleTickers[pair];
    try {
      const t = await withRetry<any>(`ticker ${pair}`, () => this.ex.fetchTicker(pair));
      const ticker = { price: t.last ?? t.close ?? 0, volume24h: t.quoteVolume ?? t.baseVolume ?? 0 };
      this.cyclePrices[pair] = ticker.price;
      this.cycleTickers[pair] = ticker;
      return ticker;
    } catch (e) {
      console.warn(`[EXCHANGE] Ticker unavailable for ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async getOhlcv(pair: string, tf = '1h', limit = 200): Promise<OhlcvCandle[]> {
    try {
      const raw = await withRetry<any[]>(`OHLCV ${pair}`, () => this.ex.fetchOHLCV(pair, tf, undefined, limit));
      const candles = raw
        .map((c: any) => ({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
        .filter((c: OhlcvCandle) => [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0));
      return closedCandles(candles, tf);
    } catch (e) {
      console.warn(`[EXCHANGE] OHLCV unavailable for ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async getPricesBatch(pairs: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    try {
      await this.ensureMarkets();
      if (this.ex.has?.fetchTickers) {
        const tickers = await withRetry<any>(`tickers batch`, () => this.ex.fetchTickers(pairs));
        for (const pair of pairs) {
          const t = tickers[pair] || Object.values(tickers).find((value: any) => value?.symbol === pair);
          const price = t?.last ?? t?.close ?? null;
          if (price !== null) {
            const ticker = { price, volume24h: t.quoteVolume ?? t.baseVolume ?? 0 };
            out[pair] = price;
            this.cyclePrices[pair] = price;
            this.cycleTickers[pair] = ticker;
          }
        }
        for (const pair of pairs) {
          if (out[pair] !== undefined) continue;
          const price = await this.getPrice(pair);
          if (price !== null) out[pair] = price;
        }
        return out;
      }
    } catch (e) {
      console.warn(`[EXCHANGE] Bulk tickers unavailable: ${e instanceof Error ? e.message : String(e)}; using per-pair requests`);
    }
    for (const p of pairs) {
      const pr = await this.getPrice(p);
      if (pr !== null) out[p] = pr;
    }
    return out;
  }

  private async getCyclePrice(pair: string): Promise<number | null> {
    if (this.cyclePrices[pair] !== undefined) return this.cyclePrices[pair];
    const price = await this.getPrice(pair);
    if (price !== null) this.cyclePrices[pair] = price;
    return price;
  }

  beginCycle() {
    this.cyclePrices = {};
    this.cycleTickers = {};
    this.balanceDirty = false;
    // The balance snapshot is cycle-scoped too. Leaving it behind let a later
    // cycle size orders against a previous cycle's cash.
    this.cycleBalance = null;
    this.balanceLoaded = false;
  }

  private async ensureMarkets(): Promise<void> {
    // Memoised: parallel scanners would otherwise each kick off their own load.
    if (!this.marketsPromise) {
      this.marketsPromise = withRetry('market loading', () => this.ex.loadMarkets())
        .then(() => undefined)
        .catch(e => { this.marketsPromise = null; throw e; });
    }
    return this.marketsPromise;
  }

  private usdMarketForAsset(asset: string): any | null {
    const normalized = normalizeAsset(asset);
    return Object.values(this.ex.markets || {}).find((market: any) =>
      normalizeAsset(market.base || '') === normalized &&
      normalizeAsset(market.quote || '') === 'USD' &&
      market.active !== false &&
      (market.spot === true || market.type === 'spot')
    ) || null;
  }

  private isIgnoredAsset(asset: string): boolean {
    const normalized = normalizeAsset(asset);
    return normalized === 'KFEE' || normalized.startsWith('KFEE');
  }

  private isCashEquivalent(asset: string): boolean {
    return CASH_EQUIVALENTS.has(normalizeAsset(asset));
  }

  private getBalanceEntries(balance: any): Array<{ asset: string; qty: number }> {
    const source = balance?.total && typeof balance.total === 'object' ? balance.total : balance;
    return Object.entries(source || {}).flatMap(([asset, value]: [string, any]) => {
      if (['free', 'used', 'total', 'info'].includes(asset)) return [];
      const qty = typeof value === 'object' ? Number(value?.total ?? value?.free ?? 0) : Number(value);
      return Number.isFinite(qty) && qty > 0 ? [{ asset, qty }] : [];
    });
  }

  private mapHoldings(balance: any, logUnknown: boolean, includeStaked = false): Record<string, { asset: string; qty: number }> {
    const mapped: Record<string, { asset: string; qty: number }> = {};
    for (const { asset, qty } of this.getBalanceEntries(balance)) {
      if (this.isCashEquivalent(asset) || this.isIgnoredAsset(asset)) continue;
      if (isStakedBalance(asset)) {
        if (!includeStaked && logUnknown)
          console.log(`  [RECONCILE] Excluded staked holding: ${asset} (${qty}); not freely tradable`);
        if (!includeStaked) continue;
      }
      const market = this.usdMarketForAsset(asset);
      if (!market) {
        if (logUnknown && qty >= BALANCE_DUST_USD)
          console.warn(`  [RECONCILE] Unmapped Kraken holding: ${asset} (${qty})`);
        continue;
      }
      const pair = market.symbol;
      if (mapped[pair]) mapped[pair].qty += qty;
      else mapped[pair] = { asset, qty };
    }
    return mapped;
  }

  private getCashValue(balance: any): number {
    return this.getBalanceEntries(balance)
      .filter(({ asset }) => this.isCashEquivalent(asset))
      .reduce((sum, { qty }) => sum + qty, 0);
  }

  private getAssetField(balance: any, assetName: string, field: string): number {
    const wanted = normalizeAsset(assetName);
    let found = false;
    let total = 0;
    for (const [asset, value] of Object.entries(balance || {})) {
      if (['free', 'used', 'total', 'info'].includes(asset) || isStakedBalance(asset) ||
          normalizeAsset(asset) !== wanted || !value || typeof value !== 'object') continue;
      const amount = Number((value as any)[field]);
      if (Number.isFinite(amount)) {
        total += amount;
        found = true;
      }
    }
    if (found) return total;
    const bucket = balance?.[field];
    if (!bucket || typeof bucket !== 'object') return 0;
    total = 0;
    for (const [asset, value] of Object.entries(bucket)) {
      if (isStakedBalance(asset) || normalizeAsset(asset) !== wanted) continue;
      const amount = Number(value);
      if (Number.isFinite(amount)) total += amount;
    }
    return total;
  }

  private async getEntryPrice(pair: string, holdingQty: number, fallback: number): Promise<{ price: number; source: string }> {
    try {
      let records: any[] = [];
      try {
        if (typeof this.ex.fetchMyTrades === 'function')
          records = await withRetry(`trade history ${pair}`, () => this.ex.fetchMyTrades(pair));
      } catch {}
      if (!records.length && typeof this.ex.fetchClosedOrders === 'function') {
        try {
          const orders = await withRetry<any[]>(`closed orders ${pair}`, () => this.ex.fetchClosedOrders(pair));
          records = orders.map((o: any) => ({
            timestamp: o.timestamp, side: o.side, amount: o.filled ?? o.amount,
            price: o.average ?? o.price, cost: o.cost,
          }));
        } catch {}
      }
      const lots: Array<{ qty: number; cost: number }> = [];
      for (const record of records.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))) {
        const qty = Number(record.amount ?? record.filled ?? 0);
        const price = Number(record.price ?? record.average ?? (record.cost && qty ? record.cost / qty : 0));
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) continue;
        if (String(record.side).toLowerCase() === 'buy') {
          lots.push({ qty, cost: qty * price });
        } else if (String(record.side).toLowerCase() === 'sell') {
          let remaining = qty;
          while (remaining > 0 && lots.length > 0) {
            const lot = lots[0];
            const used = Math.min(remaining, lot.qty);
            const originalQty = lot.qty;
            lot.qty -= used;
            lot.cost -= used * (lot.cost / originalQty);
            remaining -= used;
            if (lot.qty <= 1e-12) lots.shift();
          }
        }
      }
      const availableQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
      if (availableQty < holdingQty * 0.99) throw new Error('trade history does not cover current holding');
      let remaining = holdingQty;
      let matchedQty = 0;
      let matchedCost = 0;
      for (const lot of lots) {
        if (remaining <= 0) break;
        const used = Math.min(remaining, lot.qty);
        matchedQty += used;
        matchedCost += used * (lot.cost / lot.qty);
        remaining -= used;
      }
      if (matchedQty < holdingQty * 0.99 || matchedCost <= 0) throw new Error('no usable buy history');
      return { price: matchedCost / matchedQty, source: 'Kraken trade history' };
    } catch {
      console.log(`  [RECONCILE] ${pair} entry history unavailable; using current price for cost basis`);
      return { price: fallback, source: 'current price fallback' };
    }
  }

  private orderFill(order: any, fallbackQty: number, fallbackPrice: number, pair: string): OrderFill {
    const filledQty = Number(order?.filled);
    const orderQty = Number(order?.amount);
    const cost = Number(order?.cost);
    const average = Number(order?.average);
    const orderPrice = Number(order?.price);
    const qty = Number.isFinite(filledQty) && filledQty > 0
      ? filledQty : Number.isFinite(orderQty) && orderQty > 0 ? orderQty : fallbackQty;
    const price = Number.isFinite(average) && average > 0
      ? average : Number.isFinite(orderPrice) && orderPrice > 0
        ? orderPrice : Number.isFinite(cost) && cost > 0 && qty > 0 ? cost / qty : fallbackPrice;
    let market: any = null;
    // Anything thrown from here on would discard the record of an order the
    // exchange has already executed, so failures degrade instead of propagating.
    try { market = this.ex.market(pair); } catch {}
    const fees = Array.isArray(order?.fees) && order.fees.length ? order.fees : order?.fee ? [order.fee] : [];
    const feeUsd = fees.reduce((sum: number, fee: any) => {
      const feeCost = Number(fee?.cost);
      if (!Number.isFinite(feeCost) || feeCost <= 0) return sum;
      const currency = normalizeAsset(String(fee?.currency || ''));
      const base = normalizeAsset(market?.base || '');
      const quote = normalizeAsset(market?.quote || '');
      if (currency === quote || CASH_EQUIVALENTS.has(currency)) return sum + feeCost;
      if (currency === base) return sum + feeCost * price;
      return sum;
    }, 0);
    return { qty, price, feeUsd };
  }

  /**
   * Kraken's create-order response usually carries only a transaction id, so cost
   * basis was previously guessed from the requested quantity and a cached ticker.
   * Poll until the order reports a terminal state and use the real numbers.
   */
  private async resolveOrder(order: any, pair: string): Promise<any> {
    const id = order?.id;
    if (!id || typeof this.ex.fetchOrder !== 'function') return order;
    let latest = order;
    for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
      const filled = Number(latest?.filled);
      const settled = latest?.status === 'closed' && Number.isFinite(filled) && filled > 0;
      if (settled || latest?.status === 'canceled' || latest?.status === 'rejected') return latest;
      await sleep(ORDER_POLL_DELAY_MS);
      try {
        latest = await withRetry(`order status ${pair}`, () => this.ex.fetchOrder(id, pair));
      } catch (e) {
        console.warn(`  [ORDER] ${pair}: could not confirm order ${id} (${e instanceof Error ? e.message : String(e)}); using the create response`);
        return latest;
      }
    }
    console.warn(`  [ORDER] ${pair}: order ${id} still ${latest?.status ?? 'unresolved'} after polling; recording the fill seen so far`);
    return latest;
  }

  /** True when the exchange reports the order ended without trading anything. */
  private isUnfilled(order: any): boolean {
    const filled = Number(order?.filled);
    return (order?.status === 'canceled' || order?.status === 'rejected') &&
      (!Number.isFinite(filled) || filled <= 0);
  }

  // ccxt's amountToPrecision truncates, so an order never exceeds the requested quantity.
  private async normalizeOrderAmount(pair: string, qty: number, price: number): Promise<number | null> {
    try {
      await this.ensureMarkets();
      const market = this.ex.market(pair);
      const amount = Number(this.ex.amountToPrecision(pair, qty));
      const minAmount = Number(market?.limits?.amount?.min || 0);
      const minCost = Number(market?.limits?.cost?.min || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        console.warn(`  [ORDER SKIP] ${pair}: invalid amount after exchange precision`);
        return null;
      }
      if (minAmount > 0 && amount < minAmount) {
        console.warn(`  [ORDER SKIP] ${pair}: amount ${amount} below exchange minimum ${minAmount}`);
        return null;
      }
      if (minCost > 0 && amount * price < minCost) {
        console.warn(`  [ORDER SKIP] ${pair}: cost ${fmt(amount * price)} below exchange minimum ${fmt(minCost)}`);
        return null;
      }
      return amount;
    } catch (e: any) {
      console.error(`  [ORDER SKIP] ${pair}: market metadata unavailable (${e.message})`);
      return null;
    }
  }

  async getMinimumTradeUsd(pair: string, price: number): Promise<number | null> {
    try {
      await this.ensureMarkets();
      const market = this.ex.market(pair);
      const minAmount = Number(market?.limits?.amount?.min || 0);
      const minCost = Number(market?.limits?.cost?.min || 0);
      let requiredUsd = Math.max(CONFIG.minTradeUsd ?? 0, minCost, minAmount * price);
      if (requiredUsd === 0) return 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        const amount = Number(this.ex.amountToPrecision(pair, requiredUsd / price));
        if (Number.isFinite(amount) && amount > 0 &&
            amount >= minAmount && amount * price >= minCost) {
          return Math.max(requiredUsd, amount * price);
        }
        requiredUsd *= 1.01;
      }
      console.warn(`  [SIZE] ${pair}: could not derive a precision-safe exchange minimum`);
      return null;
    } catch (e: any) {
      console.warn(`  [SIZE] ${pair}: market metadata unavailable (${e.message})`);
      return null;
    }
  }

  getAvailableCash(pair: string): number | null {
    if (!this.balanceLoaded || !this.cycleBalance) return null;
    try {
      const market = this.ex.market(pair);
      if (!market?.quote) return null;
      return this.getAssetField(this.cycleBalance, market.quote, 'free');
    } catch {
      // An unknown symbol here used to throw straight out of the trading loop.
      return null;
    }
  }

  /**
   * Free vs total balance of a pair's quote asset. The gap is money the account
   * holds but cannot spend right now — typically reserved against open orders.
   */
  getQuoteBalance(pair: string): { asset: string; free: number; total: number } | null {
    if (!this.balanceLoaded || !this.cycleBalance) return null;
    try {
      const market = this.ex.market(pair);
      if (!market?.quote) return null;
      return {
        asset: normalizeAsset(String(market.quote)),
        free: this.getAssetField(this.cycleBalance, market.quote, 'free'),
        total: this.getAssetField(this.cycleBalance, market.quote, 'total'),
      };
    } catch {
      return null;
    }
  }

  getQuoteAsset(pair: string): string | null {
    try {
      const quote = this.ex.market(pair)?.quote;
      return quote ? normalizeAsset(String(quote)) : null;
    } catch {
      return null;
    }
  }

  getAvailableBase(pair: string): number | null {
    if (!this.balanceLoaded || !this.cycleBalance) return null;
    try {
      const market = this.ex.market(pair);
      if (!market?.base) return null;
      return this.getAssetField(this.cycleBalance, market.base, 'free');
    } catch {
      return null;
    }
  }

  private syncPositionQuantity(mem: Memory, pair: string, qty: number, currentPrice?: number) {
    const pos = mem.positions[pair];
    if (!pos || pos.status !== 'open') return;
    const tolerance = Math.max(pos.qty, qty) * POSITION_QTY_TOLERANCE_PCT;
    if (Math.abs(pos.qty - qty) <= Math.max(tolerance, 1e-12)) return;
    console.log(`  [RECONCILE] Adjusted ${pair} quantity ${pos.qty.toFixed(6)} → ${qty.toFixed(6)}; cost basis ${fmt(pos.costBasisUsd)} → ${fmt(qty * pos.entryPrice)}`);
    pos.qty = qty;
    pos.costBasisUsd = +(qty * pos.entryPrice).toFixed(2);
    if (currentPrice !== undefined) pos.currentPrice = currentPrice;
    mem.savePositions();
  }

  async buy(pair: string, usd: number): Promise<OrderFill | null> {
    try {
      // Sized off a fresh quote: the cycle cache can be an entire scan interval old,
      // which turns a "spend exactly this much cash" order into a rejected one.
      const price = await this.getPrice(pair, !this.paper);
      if (!price) return null;
      const qty = usd / price;
      if (this.paper) {
        console.log(`  [PAPER BUY] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(usd)}`);
        this.balanceDirty = true;
        return { qty, price, feeUsd: 0 };
      }
      const orderQty = await this.normalizeOrderAmount(pair, qty, price);
      if (orderQty === null) return null;
      const placed = await this.ex.createMarketBuyOrder(pair, orderQty);
      const order = await this.resolveOrder(placed, pair);
      if (this.isUnfilled(order)) {
        console.warn(`  [BUY SKIP] ${pair}: order ${order?.status ?? 'ended'} without a fill`);
        return null;
      }
      const fill = this.orderFill(order, orderQty, price, pair);
      // Any fill invalidates the cached balance, not just a sale: a Phase 1 top-up
      // spends cash that Phase 3 would otherwise still believe it has.
      this.balanceDirty = true;
      console.log(`  [LIVE BUY] ${fill.qty.toFixed(6)} ${pair} @ ${fmt(fill.price)} = ${fmt(fill.qty * fill.price)} (fee ${fmt(fill.feeUsd)})`);
      return fill;
    } catch (e: any) { console.error(`  [BUY FAIL] ${pair}: ${e.message}`); return null; }
  }

  async sell(pair: string, qty: number): Promise<OrderFill | null> {
    try {
      const price = await this.getPrice(pair, !this.paper);
      if (!price) return null;
      if (this.paper) {
        console.log(`  [PAPER SELL] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(qty * price)}`);
        this.balanceDirty = true;
        return { qty, price, feeUsd: 0 };
      }
      // A stale or failed balance snapshot must not block an exit; Kraken rejects an
      // oversized sell on its own.
      const availableBase = this.getAvailableBase(pair);
      if (availableBase !== null && availableBase <= 0) {
        console.warn(`  [ORDER SKIP] ${pair}: no free base balance available for sell`);
        return null;
      }
      const sellQty = availableBase === null ? qty : Math.min(qty, availableBase);
      const orderQty = await this.normalizeOrderAmount(pair, sellQty, price);
      if (orderQty === null) {
        // Worth shouting about: an exit blocked by exchange minimums means the stop
        // loss on this position can never actually fire.
        console.error(`  [EXIT BLOCKED] ${pair}: ${fmt(sellQty * price)} cannot be sold under Kraken's minimums; the stop on this position cannot execute until it is topped up or sold manually`);
        return null;
      }
      const placed = await this.ex.createMarketSellOrder(pair, orderQty);
      const order = await this.resolveOrder(placed, pair);
      if (this.isUnfilled(order)) {
        console.warn(`  [SELL SKIP] ${pair}: order ${order?.status ?? 'ended'} without a fill`);
        return null;
      }
      const fill = this.orderFill(order, orderQty, price, pair);
      this.balanceDirty = true;
      console.log(`  [LIVE SELL] ${fill.qty.toFixed(6)} ${pair} @ ${fmt(fill.price)} = ${fmt(fill.qty * fill.price)} (fee ${fmt(fill.feeUsd)})`);
      return fill;
    } catch (e: any) { console.error(`  [SELL FAIL] ${pair}: ${e.message}`); return null; }
  }

  /** ATR-priced stop and target for a holding the bot did not open itself. */
  private async importedPlan(pair: string, price: number): Promise<(TradePlan & { atr: number | null }) | null> {
    try {
      const candles = await this.getOhlcv(pair, '1h', 200);
      if (candles.length < 50) return null;
      const ta = TA.full(candles, price);
      if (!ta) return null;
      const plan = planTrade(ta);
      return plan ? { ...plan, atr: ta.atr } : null;
    } catch (e) {
      console.warn(`  [RECONCILE] ${pair}: could not price risk from history (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  }

  /** Watchlist pairs Kraken does not list, so the scan can never reach them. */
  async listMissingMarkets(pairs: string[]): Promise<string[]> {
    await this.ensureMarkets();
    return pairs.filter(pair => {
      try { return !this.ex.market(pair); } catch { return true; }
    });
  }

  /**
   * The USD needed to lift a holding back over the exchange's minimum sellable
   * size, or null when nothing is required or it cannot be determined. Buying has
   * its own minimum, so the answer is usually "one minimum order".
   */
  async topUpCostToSell(pair: string, qty: number, price: number): Promise<number | null> {
    try {
      await this.ensureMarkets();
      const market = this.ex.market(pair);
      const minAmount = Number(market?.limits?.amount?.min || 0);
      const shortfallQty = minAmount > 0 ? Math.max(0, minAmount - qty) : 0;
      if (shortfallQty <= 0) return null;
      const orderMinimum = await this.getMinimumTradeUsd(pair, price);
      if (orderMinimum === null) return null;
      // A buy must clear the same minimums, so the top-up is the larger of the
      // shortfall and one minimum order.
      return Math.max(shortfallQty * price, orderMinimum);
    } catch (e: any) {
      console.warn(`  [TOPUP] ${pair}: could not size a top-up (${e.message})`);
      return null;
    }
  }

  /**
   * Whether a full exit of `qty` would clear Kraken's amount, cost and precision
   * rules. A position that fails this has a stop loss that can never execute.
   */
  async checkSellable(pair: string, qty: number, price: number): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.ensureMarkets();
      const market = this.ex.market(pair);
      const amount = Number(this.ex.amountToPrecision(pair, qty));
      const minAmount = Number(market?.limits?.amount?.min || 0);
      const minCost = Number(market?.limits?.cost?.min || 0);
      if (!Number.isFinite(amount) || amount <= 0)
        return { ok: false, detail: 'rounds to zero at exchange precision' };
      if (minAmount > 0 && amount < minAmount)
        return { ok: false, detail: `${amount} below minimum amount ${minAmount}` };
      if (minCost > 0 && amount * price < minCost)
        return { ok: false, detail: `${fmt(amount * price)} below minimum cost ${fmt(minCost)}` };
      return { ok: true, detail: `${fmt(amount * price)} clears minimums` };
    } catch (e: any) {
      return { ok: false, detail: `market metadata unavailable (${e.message})` };
    }
  }

  async reconcilePositions(mem: Memory): Promise<void> {
    if (this.paper) return;
    this.balanceLoaded = false;
    this.cyclePrices = {};
    try {
      await this.ensureMarkets();
      this.cycleBalance = await withRetry('balance fetch', () => this.ex.fetchBalance());
      this.balanceLoaded = true;
      const holdings = this.mapHoldings(this.cycleBalance, true);
      const priced: Record<string, { qty: number; price: number; value: number }> = {};
      for (const [pair, holding] of Object.entries(holdings)) {
        const price = await this.getCyclePrice(pair);
        if (price === null) {
          this.syncPositionQuantity(mem, pair, holding.qty);
          console.warn(`  [RECONCILE] ${pair} price unavailable; preserving memory state`);
          continue;
        }
        priced[pair] = { qty: holding.qty, price, value: holding.qty * price };
        if (CONFIG.minTradeUsd !== null && priced[pair].value < CONFIG.minTradeUsd && mem.positions[pair]?.status !== 'open')
          console.log(`  [RECONCILE] ${pair} balance ${fmt(priced[pair].value)} below minimum; not importing`);
      }

      for (const [pair, holding] of Object.entries(priced)) {
        const existing = mem.positions[pair];
        if (existing?.status === 'open') {
          this.syncPositionQuantity(mem, pair, holding.qty, holding.price);
          continue;
        }
        if (CONFIG.minTradeUsd !== null && holding.value < CONFIG.minTradeUsd) continue;
        // Leftover dust from a sale is not a position. Importing it spent a trade
        // history lookup and an OHLCV fetch, then the dust rule below closed it
        // again on the same pass and wrote a meaningless trade to the record.
        if (holding.value < BALANCE_DUST_USD) {
          console.log(`  [RECONCILE] ${pair} dust ${fmt(holding.value)} left over; ignoring`);
          continue;
        }
        const entry = await this.getEntryPrice(pair, holding.qty, holding.price);
        const reason = `Imported from Kraken balance (${entry.source})`;
        // Flat ±5%/±10% bands anchored on the import price meant a holding already
        // far in profit carried a target it could not reach without another 10%,
        // and a stop tight enough for ordinary noise to trigger. Price the levels
        // off this pair's actual volatility instead.
        const plan = await this.importedPlan(pair, holding.price);
        let stopLoss: number;
        let takeProfit: number;
        if (plan) {
          stopLoss = plan.stop;
          takeProfit = plan.target;
        } else {
          const currentStop = holding.price * (1 - IMPORTED_POSITION_STOP_PCT);
          const currentTarget = holding.price * (1 + IMPORTED_POSITION_TARGET_PCT);
          const entryStop = entry.price * (1 - IMPORTED_POSITION_STOP_PCT);
          const entryTarget = entry.price * (1 + IMPORTED_POSITION_TARGET_PCT);
          stopLoss = entryStop < holding.price ? Math.max(entryStop, currentStop) : currentStop;
          takeProfit = entryTarget > holding.price ? Math.min(entryTarget, currentTarget) : currentTarget;
        }
        mem.openPosition(pair, holding.qty, entry.price,
          stopLoss, takeProfit,
          getSector(pair), reason, 'Imported from Kraken balance; not opened by the bot.',
          0, plan?.atr ?? null);
        console.log(`  [RECONCILE] Imported ${pair}: ${holding.qty.toFixed(6)} @ ${fmt(entry.price)} (${entry.source}) | stop ${fmt(stopLoss)} target ${fmt(takeProfit)} (${plan ? plan.basis : 'flat percentage fallback'})`);
      }

      for (const pos of mem.getOpenPositions()) {
        const holding = holdings[pos.pair];
        const price = priced[pos.pair]?.price ?? await this.getCyclePrice(pos.pair);
        if (price === null) {
          console.warn(`  [RECONCILE] ${pos.pair} balance could not be priced; preserving position`);
          continue;
        }
        if (!holding || holding.qty * price < BALANCE_DUST_USD) {
          const reason = `Closed by reconciliation: Kraken balance gone or below dust (${fmt(price)})`;
          const closed = mem.closePosition(pos.pair, price, reason);
          if (closed) mem.logTrade({
            timestamp: new Date().toISOString(), pair: pos.pair, side: 'SELL',
            price, qty: pos.qty, costBasisUsd: pos.costBasisUsd,
            stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
            pnlUsd: closed.pnlUsd ?? 0, pnlPct: closed.pnlPct ?? 0, status: 'closed',
            sector: pos.sector, reason, aiVerdict: 'RECONCILE', aiConfidence: 10,
          });
          console.log(`  [RECONCILE] Closed ${pos.pair}: balance gone or below dust`);
        }
      }
    } catch (e: any) {
      this.cycleBalance = null;
      this.balanceLoaded = true;
      console.warn(`  [RECONCILE] Balance fetch failed (${e.message}); keeping memory positions`);
    }
  }

  /**
   * Values the account, separating what can be traded from what is merely held.
   * LIVE: from the Kraken balance. PAPER: from simulated cash plus positions.
   */
  async getPortfolioValue(mem: Memory): Promise<PortfolioSnapshot> {
    try {
      if (!this.paper) {
        await this.ensureMarkets();
        const balance = this.balanceLoaded && !this.balanceDirty
          ? this.cycleBalance
          : await withRetry('balance refresh', () => this.ex.fetchBalance());
        this.cycleBalance = balance;
        this.balanceLoaded = true;
        this.balanceDirty = false;
        if (!balance) throw new Error('balance unavailable');
        const cashUsd = this.getCashValue(balance);
        const valueOf = async (holdings: Record<string, { asset: string; qty: number }>) => {
          let total = 0;
          for (const [pair, holding] of Object.entries(holdings)) {
            const price = await this.getCyclePrice(pair);
            if (price !== null) total += holding.qty * price;
          }
          return total;
        };
        const tradableCrypto = await valueOf(this.mapHoldings(balance, false, false));
        const allCrypto = await valueOf(this.mapHoldings(balance, false, true));
        const stakedUsd = Math.max(0, allCrypto - tradableCrypto);
        const snapshot: PortfolioSnapshot = {
          totalUsd: cashUsd + allCrypto,
          cashUsd,
          tradableUsd: cashUsd + tradableCrypto,
          stakedUsd,
        };
        console.log(`  [BALANCE] API: ${fmt(cashUsd)} cash + ${fmt(tradableCrypto)} tradable crypto${stakedUsd > 0 ? ` + ${fmt(stakedUsd)} staked (locked)` : ''} = ${fmt(snapshot.totalUsd)}`);
        if (snapshot.totalUsd > 0) return snapshot;
        throw new Error('balance totals zero');
      }
    } catch (e: any) {
      if (!this.paper && this.balanceDirty) {
        this.cycleBalance = null;
        this.balanceLoaded = false;
      }
      console.warn(`  [BALANCE] API call failed (${e.message}), using PORTFOLIO_VALUE fallback`);
    }
    let marketValue = 0;
    for (const position of mem.getOpenPositions()) {
      const price = await this.getCyclePrice(position.pair) ?? position.currentPrice;
      marketValue += position.qty * price;
    }
    if (!this.paper) {
      // Live, but the balance call failed. Paper cash tracks nothing here, so fall
      // back to the configured size floored by what is demonstrably invested.
      const total = Math.max(CONFIG.fallbackPortfolioValue, marketValue);
      console.warn(`  [BALANCE] Falling back to PORTFOLIO_VALUE: ${fmt(total)} (${fmt(marketValue)} in tracked positions)`);
      // Free cash is unknown here, so claim none: an over-optimistic guess would
      // size orders the exchange is going to reject anyway.
      return { totalUsd: total, cashUsd: 0, tradableUsd: total, stakedUsd: 0 };
    }
    // Paper: simulated cash plus positions marked to market. This used to return the
    // configured starting value forever, so paper results never compounded and every
    // size was computed against a fixed, fictional balance.
    const cash = mem.paperCash();
    const total = cash + marketValue;
    console.log(`  [BALANCE] Paper: ${fmt(cash)} cash + ${fmt(marketValue)} positions = ${fmt(total)}`);
    const value = total > 0 ? total : CONFIG.fallbackPortfolioValue;
    if (this.paper) this.balanceDirty = false;
    return { totalUsd: value, cashUsd: cash, tradableUsd: value, stakedUsd: 0 };
  }

  /**
   * Refetches the balance snapshot when a fill has invalidated it.
   *
   * Sells clamp to the free base balance, which is read from this snapshot. After
   * a top-up buy the snapshot still shows the pre-purchase quantity, so a stop
   * firing in the same cycle was clamped back to the size that could not be sold
   * in the first place — the exact situation the top-up had just repaired.
   */
  async refreshBalanceSnapshot(): Promise<boolean> {
    if (this.paper || !this.balanceDirty) return false;
    try {
      this.cycleBalance = await withRetry('balance refresh', () => this.ex.fetchBalance());
      this.balanceLoaded = true;
      this.balanceDirty = false;
      return true;
    } catch (e: any) {
      console.warn(`  [BALANCE] Could not refresh after fill (${e.message}); later sizing this cycle may be stale`);
      return false;
    }
  }

  async refreshAfterPhase1Sales(mem: Memory): Promise<PortfolioSnapshot | null> {
    if (!this.balanceDirty) return null;
    console.log(`  [BALANCE] Refreshing after Phase 1 trades; using settled ${this.paper ? 'paper' : 'Kraken'} balance for Phase 2`);
    const value = await this.getPortfolioValue(mem);
    if (!this.paper && this.balanceDirty)
      console.warn('  [BALANCE] Post-sell refresh failed; live buying power remains unavailable');
    return value;
  }
}

// ============================================================
// MEMORY — Persistent state across restarts (JSON + CSV)
// ============================================================

class Memory {
  positions: Record<string, Position> = {};
  state: BotState;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved = this.loadJson<Partial<BotState>>(STATE_FILE, {});
    this.state = {
      startedAt: new Date().toISOString(), totalTrades: 0, wins: 0, losses: 0,
      totalPnl: 0, bestTrade: null, worstTrade: null,
      lastScan: '', lastAiDecision: '', cycleCount: 0,
      recentTrades: [], sectorStats: {}, riskDay: utcDay(), riskDayPnl: 0, paperCash: null,
      lastStance: null, fundingRequest: null,
      ...saved,
    };
    // A hand-edited or partially written state file must not leave the bot with
    // undefined counters that poison every later arithmetic operation.
    this.state.bestTrade = typeof saved.bestTrade === 'number' ? saved.bestTrade : null;
    this.state.worstTrade = typeof saved.worstTrade === 'number' ? saved.worstTrade : null;
    this.state.recentTrades = Array.isArray(saved.recentTrades) ? saved.recentTrades.slice(-RECENT_TRADE_MEMORY) : [];
    this.state.sectorStats = saved.sectorStats && typeof saved.sectorStats === 'object' ? saved.sectorStats : {};
    this.state.riskDay = typeof saved.riskDay === 'string' && saved.riskDay ? saved.riskDay : utcDay();
    this.state.riskDayPnl = Number.isFinite(saved.riskDayPnl as number) ? Number(saved.riskDayPnl) : 0;
    this.state.paperCash = typeof saved.paperCash === 'number' && Number.isFinite(saved.paperCash) ? saved.paperCash : null;
    this.state.lastStance = saved.lastStance && typeof saved.lastStance === 'object' ? saved.lastStance : null;
    this.state.fundingRequest = saved.fundingRequest && typeof saved.fundingRequest === 'object' ? saved.fundingRequest : null;
    for (const key of ['totalTrades', 'wins', 'losses', 'totalPnl', 'cycleCount'] as const) {
      if (!Number.isFinite(this.state[key] as number)) (this.state[key] as number) = 0;
    }
    this.positions = this.loadJson<Record<string, Position>>(POSITIONS_FILE, {});
  }

  private loadJson<T>(file: string, fallback: T): T {
    if (!fs.existsSync(file)) return fallback;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e: any) {
      console.error(`[STATE] Could not read ${path.basename(file)} (${e.message}); starting from defaults`);
      return fallback;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as T;
      throw new Error('expected a JSON object');
    } catch (e: any) {
      // Silently discarding this file used to wipe live positions on a single bad
      // byte. Keep the evidence so the holdings can be recovered by hand.
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.writeFileSync(backup, raw);
        console.error(`[STATE] ${path.basename(file)} is unreadable (${e.message}); saved a copy to ${path.basename(backup)}`);
      } catch {
        console.error(`[STATE] ${path.basename(file)} is unreadable (${e.message}) and could not be backed up`);
      }
      return fallback;
    }
  }

  private saveAtomic(file: string, value: unknown) {
    const temporary = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
      fs.renameSync(temporary, file);
    } catch (e: any) {
      console.error(`[STATE] Failed to persist ${path.basename(file)}: ${e.message}`);
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }

  savePositions() { this.saveAtomic(POSITIONS_FILE, this.positions); }
  saveState() { this.saveAtomic(STATE_FILE, this.state); }

  /** Wins over decided trades; break-even closes are neither a win nor a loss. */
  winRate(): number {
    const decided = this.state.wins + this.state.losses;
    return decided > 0 ? (this.state.wins / decided) * 100 : 0;
  }

  openPosition(
    pair: string, qty: number, price: number, sl: number, tp: number,
    sector: string, reason: string, aiReason: string, feeUsd = 0, atr: number | null = null,
  ) {
    const pos: Position = {
      pair, status: 'open', sector, entryPrice: price, qty,
      // Full precision: rounding to cents zeroed out sub-cent cost bases and made
      // every downstream percentage NaN or Infinity.
      costBasisUsd: qty * price + feeUsd, stopLoss: sl, takeProfit: tp,
      currentPrice: price, reason, aiReasoning: aiReason, openedAt: new Date().toISOString(),
      initialStopLoss: sl, highWaterMark: price, entryAtr: atr, bookedPnlUsd: 0,
    };
    this.positions[pair] = pos;
    this.savePositions();
  }

  /**
   * Adds to an open position, re-basing the average entry on total cost. Used to
   * lift a holding back over the exchange's minimum sellable size.
   */
  addToPosition(pair: string, qty: number, price: number, feeUsd = 0): boolean {
    const p = this.positions[pair];
    if (!p || p.status !== 'open' || !(qty > 0) || !(price > 0)) return false;
    p.qty += qty;
    p.costBasisUsd += qty * price + feeUsd;
    p.entryPrice = p.costBasisUsd / p.qty;
    this.savePositions();
    return true;
  }

  /**
   * Books a partial exit: the sold share's P/L is realised now and the position
   * stays open with the residual quantity and a proportionally reduced cost basis.
   * Carrying the proceeds forward instead would double-count them against a basis
   * that had already shrunk.
   */
  reducePosition(pair: string, qty: number, exitPrice: number, feeUsd = 0): number | null {
    const p = this.positions[pair];
    if (!p || p.status !== 'open' || qty <= 0 || qty >= p.qty) return null;
    const soldCost = p.costBasisUsd * (qty / p.qty);
    const pnlUsd = +(qty * exitPrice - feeUsd - soldCost).toFixed(6);
    p.costBasisUsd -= soldCost;
    p.qty -= qty;
    p.bookedPnlUsd = +((p.bookedPnlUsd ?? 0) + pnlUsd).toFixed(6);
    // Realised, so it counts toward total and daily P/L — but a partial is not a
    // separate trade, so the trade and win/loss counters stay untouched.
    this.state.totalPnl = +(this.state.totalPnl + pnlUsd).toFixed(6);
    this.addToRiskDay(pnlUsd);
    const stat = this.state.sectorStats[p.sector] ?? { trades: 0, wins: 0, pnlUsd: 0 };
    stat.pnlUsd = +(stat.pnlUsd + pnlUsd).toFixed(6);
    this.state.sectorStats[p.sector] = stat;
    this.savePositions(); this.saveState();
    return pnlUsd;
  }

  /**
   * Closes a position. `exitQty` defaults to the full position, but a partial fill
   * must pass the quantity that actually sold — valuing the untraded remainder at
   * the exit price silently invented P/L that never existed.
   */
  closePosition(pair: string, exitPrice: number, reason: string, feeUsd = 0, exitQty?: number): Position | null {
    const p = this.positions[pair];
    if (!p || p.status !== 'open') return null;
    const soldQty = exitQty === undefined ? p.qty : Math.min(exitQty, p.qty);
    p.exitPrice = exitPrice;
    p.exitValueUsd = +(soldQty * exitPrice - feeUsd).toFixed(6);
    p.pnlUsd = +(p.exitValueUsd - p.costBasisUsd).toFixed(6);
    p.pnlPct = p.costBasisUsd > 0 ? +((p.pnlUsd / p.costBasisUsd) * 100).toFixed(2) : 0;
    p.status = 'closed';
    p.closedAt = new Date().toISOString();
    p.closeReason = reason;
    this.state.totalTrades++;
    this.state.totalPnl = +(this.state.totalPnl + p.pnlUsd).toFixed(6);
    if (p.pnlUsd > 0) this.state.wins++;
    else if (p.pnlUsd < 0) this.state.losses++;
    updateTradeExtremes(this.state, p.pnlUsd);
    this.recordClosedTrade(p);
    this.savePositions(); this.saveState();
    return p;
  }

  private recordClosedTrade(p: Position) {
    const holdDays = (Date.now() - new Date(p.openedAt).getTime()) / 86400000;
    this.state.recentTrades.push({
      pair: p.pair, sector: p.sector, pnlUsd: p.pnlUsd ?? 0, pnlPct: p.pnlPct ?? 0,
      closedAt: p.closedAt ?? new Date().toISOString(),
      closeReason: p.closeReason ?? '', holdDays: +Math.max(0, holdDays).toFixed(2),
    });
    if (this.state.recentTrades.length > RECENT_TRADE_MEMORY)
      this.state.recentTrades = this.state.recentTrades.slice(-RECENT_TRADE_MEMORY);

    const stat = this.state.sectorStats[p.sector] ?? { trades: 0, wins: 0, pnlUsd: 0 };
    stat.trades++;
    if ((p.pnlUsd ?? 0) > 0) stat.wins++;
    stat.pnlUsd = +(stat.pnlUsd + (p.pnlUsd ?? 0)).toFixed(6);
    this.state.sectorStats[p.sector] = stat;

    this.addToRiskDay(p.pnlUsd ?? 0);
  }

  private addToRiskDay(pnlUsd: number) {
    const today = utcDay();
    if (this.state.riskDay !== today) {
      this.state.riskDay = today;
      this.state.riskDayPnl = 0;
    }
    this.state.riskDayPnl = +(this.state.riskDayPnl + pnlUsd).toFixed(6);
  }

  /**
   * Persists the model's market call. A funding request is kept standing until the
   * operator actually adds capital, so it survives restarts and stays visible.
   */
  recordStance(stance: PortfolioStance) {
    this.state.lastStance = stance;
    if (stance.requestedFundsUsd > 0) {
      this.state.fundingRequest = {
        usd: stance.requestedFundsUsd,
        reasoning: stance.reasoning,
        requestedAt: new Date().toISOString(),
      };
    }
    this.saveState();
  }

  /** Clears a standing funding request once that much new cash has arrived. */
  clearFundingRequestIfFunded(cashUsd: number) {
    const request = this.state.fundingRequest;
    if (request && cashUsd >= request.usd) {
      console.log(`  [FUNDING] Request for ${fmt(request.usd)} is covered by ${fmt(cashUsd)} of free cash; clearing it.`);
      this.state.fundingRequest = null;
      this.saveState();
    }
  }

  /** Simulated cash for paper mode, seeded from PORTFOLIO_VALUE on first use. */
  paperCash(): number {
    if (this.state.paperCash === null) {
      const invested = this.getOpenPositions().reduce((sum, p) => sum + p.costBasisUsd, 0);
      this.state.paperCash = Math.max(0, CONFIG.fallbackPortfolioValue - invested);
      this.saveState();
    }
    return this.state.paperCash;
  }

  adjustPaperCash(delta: number) {
    this.state.paperCash = Math.max(0, this.paperCash() + delta);
    this.saveState();
  }

  /** Realised P/L booked today (UTC), used by the daily-loss circuit breaker. */
  realizedPnlToday(): number {
    return this.state.riskDay === utcDay() ? this.state.riskDayPnl : 0;
  }

  updatePrice(pair: string, price: number, persist = true) {
    const pos = this.positions[pair];
    if (pos?.status !== 'open' || !Number.isFinite(price) || price <= 0) return;
    pos.currentPrice = price;
    if (price > (pos.highWaterMark ?? pos.entryPrice)) pos.highWaterMark = price;
    if (persist) this.savePositions();
  }

  /** Batch price refresh — one disk write instead of one per pair. */
  updatePrices(prices: Record<string, number>) {
    for (const [pair, price] of Object.entries(prices)) this.updatePrice(pair, price, false);
    this.savePositions();
  }

  getOpenPositions() { return Object.values(this.positions).filter(p => p.status === 'open'); }

  checkStops(prices: Record<string, number>): Array<{ pair: string; action: string; reason: string }> {
    const alerts: Array<{ pair: string; action: string; reason: string }> = [];
    for (const [pair, pos] of Object.entries(this.positions)) {
      if (pos.status !== 'open') continue;
      const p = prices[pair]; if (p === undefined) continue;
      if (p <= pos.stopLoss) alerts.push({ pair, action: 'STOP_LOSS', reason: `Hit stop at ${fmt(p)} (stop: ${fmt(pos.stopLoss)})` });
      else if (p >= pos.takeProfit) alerts.push({ pair, action: 'TAKE_PROFIT', reason: `Hit target at ${fmt(p)} (target: ${fmt(pos.takeProfit)})` });
    }
    return alerts;
  }

  logTrade(t: TradeRecord) {
    const header = !fs.existsSync(TRADES_FILE);
    const line = [t.timestamp, t.pair, t.side, t.price, t.qty, t.costBasisUsd, t.stopLoss, t.takeProfit,
      t.pnlUsd, t.pnlPct, t.status, t.sector, t.reason, t.aiVerdict, t.aiConfidence].map(csvField).join(',');
    try {
      fs.appendFileSync(TRADES_FILE,
        (header ? 'timestamp,pair,side,price,qty,cost,stop,target,pnl,pct,status,sector,reason,ai_verdict,ai_confidence\n' : '') + line + '\n');
    } catch (e: any) {
      console.error(`[STATE] Could not append to trades.csv: ${e.message}`);
    }
  }

  private performanceLines(): string[] {
    const lines: string[] = [];
    const sectors = Object.entries(this.state.sectorStats)
      .sort((a, b) => b[1].pnlUsd - a[1].pnlUsd);
    if (sectors.length) {
      lines.push('', '=== SECTOR PERFORMANCE (realised) ===');
      for (const [sector, stat] of sectors)
        lines.push(`${sector}: ${stat.trades} trades | ${stat.wins} wins | P/L ${fmt(stat.pnlUsd)}`);
    }
    const recent = this.state.recentTrades.slice(-10).reverse();
    if (recent.length) {
      lines.push('', `=== LAST ${recent.length} CLOSED TRADES (newest first) ===`);
      for (const t of recent)
        lines.push(`${t.pair} (${t.sector}): ${t.pnlUsd >= 0 ? '+' : ''}${fmt(t.pnlUsd)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}%) after ${t.holdDays}d — ${t.closeReason}`);
    }
    return lines;
  }

  getContextSummary(): string {
    const open = this.getOpenPositions();
    const lines = [
      '=== BOT IDENTITY ===',
      `I am an AI crypto trading bot. Running since ${this.state.startedAt}.`,
      `Total trades: ${this.state.totalTrades} | Wins: ${this.state.wins} | Losses: ${this.state.losses}`,
      `Total P/L: ${fmt(this.state.totalPnl)} | Win rate: ${this.winRate().toFixed(0)}%`,
      this.state.bestTrade !== null ? `Best trade: ${fmt(this.state.bestTrade)}` : '',
      this.state.worstTrade !== null ? `Worst trade: ${fmt(this.state.worstTrade)}` : '',
      `Cycles completed: ${this.state.cycleCount}`, '',
    ];
    if (open.length > 0) {
      lines.push(`=== CURRENT POSITIONS (${open.length}) ===`);
      for (const p of open) {
        const pnl = (p.currentPrice - p.entryPrice) * p.qty;
        const percent = p.costBasisUsd > 0 ? ((pnl / p.costBasisUsd) * 100).toFixed(1) : '0.0';
        lines.push(`${p.pair}: Entry ${fmt(p.entryPrice)} | Now ${fmt(p.currentPrice)} | P/L ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${percent}%) | Stop ${fmt(p.stopLoss)} | Target ${fmt(p.takeProfit)} | ${p.sector}`);
        lines.push(`  Why: ${p.reason} | AI said: ${p.aiReasoning}`);
      }
    } else { lines.push('No open positions.'); }
    lines.push(...this.performanceLines());
    return lines.filter(Boolean).join('\n');
  }
}

// ============================================================
// AI BRAIN — GLM 5.2 via OpenRouter
// ============================================================

const SYSTEM_PROMPT = `You are an AI crypto trading bot with real money at stake.

YOUR IDENTITY & GOALS:
- You manage a crypto portfolio on Kraken (balance fetched from API each cycle)
- Your strategy: find oversold coins with strong fundamentals and favorable risk/reward
- Buy near support, sell at resistance. Cut losers fast, let winners run
- Focus sectors (priority): AI tokens, RWA tokenization, DeFi blue chips, L1 infrastructure, DePIN, meme momentum
- You hold 3-7 days typically. NOT a day trader

YOUR DECISION FRAMEWORK:
1. Every watchlist pair with valid technical data may reach you; the shortlist is ranked by a setup score, not pre-filtered as a BUY signal
2. RSI < 40 + neutral/bullish trend + near support = stronger BUY evidence
3. Position hits stop loss = SELL immediately, no questions
4. Position hits take profit = SELL the position
5. Is the narrative/thesis still intact? If not, sell
6. A weak or overbought setup should return HOLD rather than forcing a BUY
7. A bearish higher-timeframe (4h) trend turns an oversold reading into a falling
   knife. Demand a momentum turn (StochRSI K above D, MACD histogram improving)
   before buying against it
8. Size against volatility, not conviction alone: ATR% tells you how far this pair
   routinely moves. A wide-ATR pair deserves a smaller share of the portfolio
9. Your sector and recent-trade records below are real. If a sector keeps losing,
   size it down or skip it

You own position sizing. Request the percentage of the total portfolio you want to allocate.
The bot can only spend available free cash and must obey Kraken's amount, cost, and precision rules.
Any additional limits shown by the bot are optional configuration, not strategy rules.

You also own the trade plan on a NEW entry. The stop and target shown below are the
bot's ATR-based default; set "adjusted_stop" and "adjusted_target" to override them
with your own levels. A stop further than the risk cap from entry is clamped to it.
Once a position is open, stops only ever tighten — you can pull one in, never widen it.

YOUR MEMORY:
You remember all past trades, your win rate, what strategies worked. Learn from mistakes.
If a sector keeps losing money, reduce allocation.

SELLING PART OF A POSITION:
On a SELL you may set "trim_pct" to the percentage of that position to sell, from 1
to 100. Omit it, or use 100, to exit completely. Use a partial trim to take some
profit while staying in a winner, or to raise cash toward the reserve you asked for
in your stance without abandoning a thesis you still believe.

RESPOND WITH JSON ONLY — no markdown, no code fences, no text before or after.
Think briefly. Emit the JSON object as your very first output token.
Keep "reasoning" under 12 words. Do not restate the data you were given.
{"verdict": "BUY" or "HOLD" or "SELL", "confidence": 1-10, "reasoning": "brief why", "position_size_pct": 0 or greater, "adjusted_stop": number or null, "adjusted_target": number or null, "trim_pct": 1-100 or null}`;

type AiParseResult = {
  decision: AiDecision | null;
  kind: 'parsed' | 'salvaged' | 'empty' | 'invalid';
  error?: string;
};

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof (part as any).text === 'string') return (part as any).text;
    return '';
  }).join('');
}

function extractJsonObject(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (start < 0) start = i;
      depth++;
    } else if (char === '}' && start >= 0) {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/** trim_pct arrives as 0-100; anything missing or unusable means a full exit. */
export function normalizeTrimFraction(value: unknown): number {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0) return 1;
  return Math.min(1, percent / 100);
}

function normalizeAiDecision(json: any, salvage = false): AiDecision {
  const verdict = String(json?.verdict || '').toUpperCase();
  const confidenceValue = Number(json?.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.min(10, Math.max(1, Math.round(confidenceValue)))
    : 5;
  const adjustedStop = !salvage && json?.adjusted_stop !== null && json?.adjusted_stop !== undefined &&
    Number.isFinite(Number(json.adjusted_stop)) ? Number(json.adjusted_stop) : null;
  const adjustedTarget = !salvage && json?.adjusted_target !== null && json?.adjusted_target !== undefined &&
    Number.isFinite(Number(json.adjusted_target)) ? Number(json.adjusted_target) : null;
  return {
    verdict: verdict === 'BUY' || verdict === 'SELL' || verdict === 'HOLD' ? verdict : 'HOLD',
    confidence,
    reasoning: typeof json?.reasoning === 'string' && json.reasoning.trim() ? json.reasoning.trim() : 'No reason',
    positionSizePct: salvage ? 0 : Math.max(0, Number(json?.position_size_pct) || 0),
    adjustedStop,
    adjustedTarget,
    // A salvaged reply lost its tail, so assume a full exit rather than guessing
    // at a partial one from an incomplete payload.
    trimFraction: salvage ? 1 : normalizeTrimFraction(json?.trim_pct),
  };
}

export function parseAiResponse(content: unknown, reasoningContent?: unknown): AiParseResult {
  const contentText = textContent(content);
  const text = contentText.trim() ? contentText : textContent(reasoningContent);
  if (!text.trim()) return { decision: null, kind: 'empty' };

  const objectText = extractJsonObject(text);
  if (objectText) {
    try {
      return { decision: normalizeAiDecision(JSON.parse(objectText)), kind: 'parsed' };
    } catch (e: any) {
      const salvaged = salvageAiResponse(text);
      return {
        decision: salvaged,
        kind: salvaged ? 'salvaged' : 'invalid',
        error: e.message,
      };
    }
  }

  const salvaged = salvageAiResponse(text);
  return salvaged
    ? { decision: salvaged, kind: 'salvaged' }
    : { decision: null, kind: 'invalid', error: 'No complete JSON object found' };
}

function isUnsupportedResponseFormat(error: unknown): boolean {
  const value = error as any;
  const message = String(value?.message || error || '').toLowerCase();
  const status = Number(value?.status ?? value?.statusCode ?? value?.response?.status);
  return status === 400 && /(response[_ -]?format|json[_ -]?object|structured output|unsupported|unrecognized)/i.test(message);
}

function isUnsupportedReasoningParam(error: unknown): boolean {
  const value = error as any;
  const message = String(value?.message || error || '').toLowerCase();
  const status = Number(value?.status ?? value?.statusCode ?? value?.response?.status);
  return status === 400 && /reasoning|thinking|effort/.test(message);
}

/** True when the provider stopped generating because the token budget ran out. */
export function isTruncated(finishReason: unknown): boolean {
  const reason = String(finishReason ?? '').toLowerCase();
  return reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens';
}

function salvageAiResponse(text: string): AiDecision | null {
  const verdictMatch = text.match(/["']verdict["']\s*:\s*["'](BUY|HOLD|SELL)["']/i);
  if (!verdictMatch) return null;
  const confidenceMatch = text.match(/["']confidence["']\s*:\s*(-?\d+(?:\.\d+)?)/i);
  const reasoningMatch = text.match(/["']reasoning["']\s*:\s*"([^"]*)/i);
  return normalizeAiDecision({
    verdict: verdictMatch[1],
    confidence: confidenceMatch ? Number(confidenceMatch[1]) : 5,
    reasoning: reasoningMatch?.[1] || 'Salvaged truncated response',
  }, true);
}

const STANCE_SYSTEM_PROMPT = `You are the portfolio manager of a live crypto trading account.

Once per cycle you set the stance for the whole book, before any individual trade is
considered. You are not being asked about one coin. You are being asked: given this
market and this account, should we be deploying capital right now at all?

STANCE:
- RISK_ON — conditions favour putting money to work; take the setups you are offered
- NEUTRAL — trade selectively, nothing forced
- RISK_OFF — do not open new positions. Sit in cash and wait for lower prices.
  Choose this when the market looks extended, breadth is deteriorating, or you expect
  a drawdown you would rather buy into than hold through. Existing stops and exits
  keep running regardless; this only governs NEW entries.

CASH TARGET:
"cash_target_pct" is the share of the portfolio you want held back as dry powder,
from 0 to 100. The bot will not spend below it. Raise it when you want ammunition
for a dip; drop it to 0 when you want to be fully invested.

REQUESTING CAPITAL:
If the opportunity in front of you is larger than the account can fund, set
"requested_funds_usd" to the amount you want added. The operator reads these and
funds them manually. Ask for 0 when the account is adequate. Do not ask every cycle;
ask when it would change what you can actually do.

You own this call. The bot does not second-guess the stance.

RESPOND WITH JSON ONLY — no markdown, no code fences, no text before or after.
Keep "reasoning" under 25 words.
{"stance": "RISK_ON" or "NEUTRAL" or "RISK_OFF", "confidence": 1-10, "reasoning": "brief why", "cash_target_pct": 0-100, "requested_funds_usd": 0 or greater}`;

export function normalizeStance(json: any): PortfolioStance {
  const raw = String(json?.stance || '').toUpperCase().replace(/[\s-]/g, '_');
  const stance: PortfolioStance['stance'] =
    raw === 'RISK_ON' || raw === 'RISK_OFF' || raw === 'NEUTRAL' ? raw : 'NEUTRAL';
  const confidenceValue = Number(json?.confidence);
  const cashValue = Number(json?.cash_target_pct);
  const fundsValue = Number(json?.requested_funds_usd);
  return {
    stance,
    confidence: Number.isFinite(confidenceValue) ? Math.min(10, Math.max(1, Math.round(confidenceValue))) : 5,
    reasoning: typeof json?.reasoning === 'string' && json.reasoning.trim() ? json.reasoning.trim() : 'No reason given',
    cashTargetPct: Number.isFinite(cashValue) ? Math.min(1, Math.max(0, cashValue / 100)) : 0,
    requestedFundsUsd: Number.isFinite(fundsValue) && fundsValue > 0 ? fundsValue : 0,
  };
}

class AiBrain {
  private client: OpenAI;
  private model: string;
  private memory: Memory;
  private responseFormatSupported = true;
  private reasoningParamSupported = true;
  /** Grows for the rest of the run once a model proves it needs more headroom. */
  private tokenBudget = 0;

  constructor(memory: Memory) {
    const provider = process.env.AI_PROVIDER || 'openrouter';
    const model = process.env.AI_MODEL || 'z-ai/glm-5.2';
    const apiKey = process.env.AI_API_KEY!;

    const urls: Record<string, string> = {
      openrouter: 'https://openrouter.ai/api/v1',
      glm: 'https://open.bigmodel.cn/api/paas/v4/',
      groq: 'https://api.groq.com/openai/v1',
      openai: 'https://api.openai.com/v1',
      together: 'https://api.together.xyz/v1',
    };

    const headers: Record<string, string> = {};
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/ai-crypto-bot';
      headers['X-Title'] = 'AI Crypto Bot';
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: CONFIG.aiBaseUrl || urls[provider] || urls.openrouter,
      defaultHeaders: Object.keys(headers).length ? headers : undefined,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
    this.model = model;
    this.tokenBudget = CONFIG.aiMaxTokens;
    this.memory = memory;
    console.log(`[AI] GLM 5.2 via ${provider} (${model}) | budget ${this.tokenBudget} tokens | reasoning ${CONFIG.aiReasoningEffort}`);
  }

  async analyze(
    pair: string, sector: string, ta: TechnicalAnalysis, vol24h: number,
    context?: BuyContext, plan?: TradePlan | null,
  ): Promise<AiDecision> {
    return this.call(`NEW OPPORTUNITY:
${pair} (Sector: ${sector}) | Price: ${fmt(ta.currentPrice)}
24h Volume: ${fmt(vol24h)}

RSI: ${ta.rsi} (oversold<35, overbought>70)
Trend (1h): ${ta.trend} | Trend (4h): ${ta.htfTrend} | MA Score: ${ta.maScore}/3
SMA 5/20/50: ${ta.sma5?.toFixed(4) || 'N/A'} / ${ta.sma20?.toFixed(4) || 'N/A'} / ${ta.sma50?.toFixed(4) || 'N/A'}
Bollinger: ${fmt(ta.bollinger.upper || 0)} / ${fmt(ta.bollinger.middle || 0)} / ${fmt(ta.bollinger.lower || 0)}
Volume: ${ta.volumeRatio}x avg | StochRSI K=${ta.stochRsiK} D=${ta.stochRsiD}
ATR(14): ${ta.atr === null ? 'N/A' : fmt(ta.atr)}${ta.atrPct === null ? '' : ` (${pct(ta.atrPct)} of price)`} | MACD histogram: ${ta.macdHistogram === null ? 'N/A' : ta.macdHistogram.toFixed(6)}
Supports (nearest first): ${ta.supports.join(', ') || 'none'}
Resistances (nearest first): ${ta.resistances.join(', ') || 'none'}

PLANNED RISK (set by the bot, ATR-based):
${plan ? `Stop ${fmt(plan.stop)} (${pct(plan.riskPct)} below entry, ${plan.basis}) | Target ${fmt(plan.target)} | R/R ${plan.rr.toFixed(2)}:1` : 'unavailable'}

ACCOUNT & ORDER CONTEXT:
Total portfolio value: ${fmt(context?.portfolioValueUsd ?? 0)}
Currently invested: ${fmt(context?.exposureUsd ?? 0)} across ${context?.openPositions ?? 0} positions
This sector: ${fmt(context?.sectorExposureUsd ?? 0)} held vs a ${((context?.sectorTargetPct ?? 0) * 100).toFixed(0)}% target allocation
Free cash available for this pair after fee reserve: ${fmt(context?.spendableCashUsd ?? 0)}
Pair minimum order value: ${context?.marketMinimumUsd === null || context?.marketMinimumUsd === undefined ? 'unavailable' : fmt(context.marketMinimumUsd)}
A position percentage that translates below the pair minimum will be raised to that minimum when available cash can cover it.
${context?.concentration ? `\n${context.concentration}\n` : ''}
BUY or HOLD?`, pair);
  }

  async review(pair: string, ta: TechnicalAnalysis, cashNote = '', concentration = ''): Promise<AiDecision> {
    const p = this.memory.positions[pair];
    if (!p) return { verdict: 'HOLD', confidence: 5, reasoning: 'Not found', positionSizePct: 0, adjustedStop: null, adjustedTarget: null, trimFraction: 1 };
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    const percent = p.costBasisUsd > 0 ? (pnl / p.costBasisUsd) * 100 : 0;
    const days = ((Date.now() - new Date(p.openedAt).getTime()) / 86400000).toFixed(1);
    return this.call(`REVIEW POSITION:
${p.pair} (${p.sector}) | Entry ${fmt(p.entryPrice)} | Now ${fmt(ta.currentPrice)}
P/L: ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%) | ${days} days held
Stop: ${fmt(p.stopLoss)}${p.initialStopLoss !== undefined && p.initialStopLoss !== p.stopLoss ? ` (trailed up from ${fmt(p.initialStopLoss)})` : ''} | Target: ${fmt(p.takeProfit)}
High since entry: ${fmt(p.highWaterMark ?? p.entryPrice)} | Open risk: ${fmt(Math.max(0, ta.currentPrice - p.stopLoss) * p.qty)}

RSI: ${ta.rsi} | Trend (1h): ${ta.trend} | Trend (4h): ${ta.htfTrend} | MA: ${ta.maScore}/3 | Vol: ${ta.volumeRatio}x
ATR(14): ${ta.atr === null ? 'N/A' : fmt(ta.atr)}${ta.atrPct === null ? '' : ` (${pct(ta.atrPct)})`} | MACD histogram: ${ta.macdHistogram === null ? 'N/A' : ta.macdHistogram.toFixed(6)}
Supports: ${ta.supports.join(', ') || 'none'} | Resistances: ${ta.resistances.join(', ') || 'none'}

The bot already trails the stop upward on its own; only propose adjusted_stop if you
want it tighter than the value above. Stops are never widened.
${cashNote}
${concentration}

Buy reason: ${p.reason}
AI reasoning at entry: ${p.aiReasoning}

HOLD, SELL, or ADJUST?`, pair);
  }

  private async call(prompt: string, pair: string): Promise<AiDecision> {
    const fallback: AiDecision = { verdict: 'HOLD', confidence: 5, reasoning: 'AI error', positionSizePct: 0, adjustedStop: null, adjustedTarget: null, trimFraction: 1 };
    const messages: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${this.memory.getContextSummary()}\n\n${prompt}` },
    ];
    // A salvaged decision is a last resort, not an answer: it carries no position
    // size and no stop, so accepting it ends the trade's sizing judgement. Hold on
    // to it while there is still a chance of getting a complete reply.
    let salvagedFallback: AiDecision | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const requestMessages = attempt === 0 ? messages : [
        ...messages,
        { role: 'user', content: 'Your previous reply was not valid JSON. Reply with the JSON object only, nothing else.' },
      ];
      try {
        const res = await this.request(requestMessages, pair);
        const choice = res.choices?.[0];
        const finishReason = choice?.finish_reason ?? 'unknown';
        const message = choice?.message;
        const content = textContent(message?.content);
        const reasoning = textContent(message?.reasoning ?? message?.reasoning_content);
        if (!content.trim() && reasoning.trim())
          console.warn(`  [AI] Empty content for ${pair}; trying reasoning text (finish_reason=${finishReason})`);
        const parsed = parseAiResponse(content, reasoning);
        if (parsed.decision && parsed.kind === 'parsed') {
          this.logDecision(pair, parsed.decision);
          return parsed.decision;
        }
        // A reply cut off mid-JSON is not a formatting mistake the model can correct
        // by being asked again — it ran out of room. Reasoning models spend the
        // completion budget before emitting any content, which is exactly how this
        // bot ended up answering HOLD to everything in production.
        const truncated = isTruncated(finishReason);
        if (parsed.decision) {
          salvagedFallback ??= parsed.decision;
          console.warn(`  [AI] Partial decision for ${pair} (finish_reason=${finishReason}); no size or stop until a complete reply arrives`);
        } else {
          console.warn(`  [AI] ${parsed.kind === 'empty' ? 'Empty response' : 'Unparseable response'} for ${pair} (finish_reason=${finishReason}, budget=${this.tokenBudget}${parsed.error ? `; ${parsed.error}` : ''})`);
        }
        if (truncated && this.growTokenBudget(pair)) continue;
        if (parsed.decision) {
          console.warn(`  [AI] Falling back to the salvaged decision for ${pair}; adjusted stop/target discarded`);
          this.logDecision(pair, parsed.decision);
          return parsed.decision;
        }
      } catch (e: any) {
        console.error(`  [AI] Error ${pair}: ${e.message}`);
      }
      if (attempt === 0)
        console.warn(`  [AI] Retrying ${pair} with corrective JSON instruction`);
    }
    if (salvagedFallback) {
      console.warn(`  [AI] Using the salvaged decision for ${pair} after exhausting retries`);
      this.logDecision(pair, salvagedFallback);
      return salvagedFallback;
    }
    console.warn(`  [AI] Falling back to HOLD for ${pair}`);
    return fallback;
  }

  /** Doubles the completion budget, once, up to a ceiling. */
  private growTokenBudget(pair: string): boolean {
    if (this.tokenBudget >= MAX_AI_TOKEN_BUDGET) return false;
    const previous = this.tokenBudget;
    this.tokenBudget = Math.min(MAX_AI_TOKEN_BUDGET, this.tokenBudget * 2);
    console.warn(`  [AI] ${pair}: response was truncated; raising the token budget ${previous} → ${this.tokenBudget} for the rest of this run`);
    return true;
  }

  /**
   * OpenRouter-style reasoning control. Capping reasoning effort leaves the
   * completion budget for the JSON that actually carries the decision.
   */
  private reasoningParam(): Record<string, unknown> {
    if (!this.reasoningParamSupported) return {};
    return CONFIG.aiReasoningEffort === 'off'
      ? { reasoning: { enabled: false } }
      : { reasoning: { effort: CONFIG.aiReasoningEffort } };
  }

  private async request(messages: any[], pair: string): Promise<any> {
    const create = (structured: boolean, reasoning: boolean) => this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.2,
      max_tokens: this.tokenBudget,
      ...(structured ? { response_format: { type: 'json_object' } } : {}),
      ...(reasoning ? this.reasoningParam() : {}),
    } as any);

    // Both extras are best-effort: a provider that rejects either is retried
    // without it, and the capability is remembered so the run stops paying for
    // the discovery.
    for (let attempt = 0; attempt < 3; attempt++) {
      const structured = this.responseFormatSupported;
      const reasoning = this.reasoningParamSupported;
      try {
        return await withRetry(`AI request ${pair}`, () => create(structured, reasoning), RETRY_ATTEMPTS,
          error => isRetryableError(error) &&
            !(structured && isUnsupportedResponseFormat(error)) &&
            !(reasoning && isUnsupportedReasoningParam(error)));
      } catch (e) {
        if (reasoning && isUnsupportedReasoningParam(e)) {
          this.reasoningParamSupported = false;
          console.warn(`  [AI] ${pair}: reasoning control unsupported; retrying without it`);
          continue;
        }
        if (structured && isUnsupportedResponseFormat(e)) {
          this.responseFormatSupported = false;
          console.warn(`  [AI] ${pair}: response_format unsupported; retrying without structured output`);
          continue;
        }
        throw e;
      }
    }
    return create(this.responseFormatSupported, this.reasoningParamSupported);
  }

  /**
   * One JSON object from the model, with the same truncation handling as a trade
   * decision. Returns null when nothing parseable comes back.
   */
  private async requestJsonObject(system: string, prompt: string, label: string): Promise<any | null> {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.request(messages, label);
        const choice = res.choices?.[0];
        const text = textContent(choice?.message?.content).trim() ||
          textContent(choice?.message?.reasoning ?? choice?.message?.reasoning_content);
        const objectText = extractJsonObject(text);
        if (objectText) {
          try { return JSON.parse(objectText); } catch { /* fall through to retry */ }
        }
        if (isTruncated(choice?.finish_reason) && this.growTokenBudget(label)) continue;
      } catch (e: any) {
        console.error(`  [AI] Error ${label}: ${e.message}`);
        if (!isRetryableError(e)) break;
      }
    }
    return null;
  }

  /**
   * Asks the model for its call on the whole book. Falling back to NEUTRAL keeps
   * the bot behaving exactly as it did before this existed when the model is
   * unreachable — it neither forces trades nor freezes the account.
   */
  async reviewPortfolio(
    account: PortfolioSnapshot,
    candidates: Array<{ pair: string; ta: TechnicalAnalysis; score: { score: number } }>,
    concentration = '',
  ): Promise<PortfolioStance> {
    const breadth = candidates.length;
    const bullish = candidates.filter(c => c.ta.htfTrend === 'bullish').length;
    const bearish = candidates.filter(c => c.ta.htfTrend === 'bearish').length;
    const avgRsi = breadth > 0
      ? (candidates.reduce((sum, c) => sum + c.ta.rsi, 0) / breadth).toFixed(1) : 'n/a';
    const overbought = candidates.filter(c => c.ta.rsi > 70).length;
    const oversold = candidates.filter(c => c.ta.rsi < 35).length;
    const best = candidates.slice(0, 5)
      .map(c => `${c.pair} (score ${c.score.score.toFixed(0)}, RSI ${c.ta.rsi}, 4h ${c.ta.htfTrend})`)
      .join('; ') || 'none';
    const standing = this.memory.state.fundingRequest;

    const prompt = `${this.memory.getContextSummary()}

ACCOUNT:
Free cash: ${fmt(account.cashUsd)}
Tradable value (cash + sellable crypto): ${fmt(account.tradableUsd)}
Staked / locked (cannot be traded or sold by the bot): ${fmt(account.stakedUsd)}
Account total: ${fmt(account.totalUsd)}
Cash as a share of tradable value: ${account.tradableUsd > 0 ? pct(account.cashUsd / account.tradableUsd) : 'n/a'}
${standing ? `You already asked for ${fmt(standing.usd)} on ${standing.requestedAt} and it has not been funded yet.` : 'No outstanding funding request.'}

MARKET BREADTH (${breadth} watchlist pairs with usable data):
4h trend: ${bullish} bullish, ${bearish} bearish, ${breadth - bullish - bearish} neutral
Average RSI: ${avgRsi} | ${overbought} overbought (>70) | ${oversold} oversold (<35)
Best-ranked setups: ${best}
${concentration ? `\n${concentration}\n` : ''}
What is the stance for this cycle?`;

    const json = await this.requestJsonObject(STANCE_SYSTEM_PROMPT, prompt, 'PORTFOLIO');
    if (!json) {
      console.warn('  [AI] No usable portfolio stance; defaulting to NEUTRAL for this cycle');
      return { stance: 'NEUTRAL', confidence: 5, reasoning: 'AI unavailable', cashTargetPct: 0, requestedFundsUsd: 0 };
    }
    // Persisting is the caller's job, so the record is kept no matter which
    // implementation produced the stance.
    return normalizeStance(json);
  }

  /**
   * Sends real probe requests and reports how many produced a usable decision.
   * This is the check that would have caught production answering HOLD to
   * everything for days because its replies were being truncated.
   */
  async selfTest(samples: number): Promise<{ valid: number; salvaged: number; total: number; finishReasons: Record<string, number>; avgLatencyMs: number; budget: number; lastError: string }> {
    const finishReasons: Record<string, number> = {};
    let valid = 0;
    let salvaged = 0;
    let latencyTotal = 0;
    let lastError = '';
    const probe = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `NEW OPPORTUNITY:
PROBE/USD (Sector: ai) | Price: $1.00
RSI: 28 | Trend (1h): neutral | Trend (4h): bullish | Volume: 1.4x avg
ATR(14): $0.03 (3.00% of price) | Supports: 0.95 | Resistances: 1.20

This is a connectivity probe. Answer with the JSON object only.
BUY or HOLD?`,
      },
    ];
    for (let i = 0; i < samples; i++) {
      const started = Date.now();
      try {
        const res = await this.request(probe, 'PROBE/USD');
        latencyTotal += Date.now() - started;
        const choice = res.choices?.[0];
        const reason = String(choice?.finish_reason ?? 'unknown');
        finishReasons[reason] = (finishReasons[reason] ?? 0) + 1;
        const parsed = parseAiResponse(
          textContent(choice?.message?.content),
          textContent(choice?.message?.reasoning ?? choice?.message?.reasoning_content),
        );
        if (parsed.kind === 'parsed') valid++;
        else if (parsed.kind === 'salvaged') salvaged++;
        else lastError = parsed.error ?? parsed.kind;
        if (isTruncated(reason)) this.growTokenBudget('PROBE/USD');
      } catch (e: any) {
        latencyTotal += Date.now() - started;
        finishReasons.error = (finishReasons.error ?? 0) + 1;
        lastError = e.message;
      }
    }
    return {
      valid, salvaged, total: samples, finishReasons,
      avgLatencyMs: samples > 0 ? Math.round(latencyTotal / samples) : 0,
      budget: this.tokenBudget, lastError,
    };
  }

  private logDecision(pair: string, d: AiDecision) {
    console.log(`  [AI] ${pair}: ${d.verdict} (${d.confidence}/10) — ${d.reasoning}`);
    this.memory.state.lastAiDecision = `${pair}:${d.verdict}:${d.confidence}`;
    this.memory.saveState();
  }
}

// ============================================================
// PREFLIGHT — Verify the bot against the real world before trading
// ============================================================

interface CheckResult { name: string; ok: boolean; detail: string; critical: boolean }

/**
 * Exercises the live exchange and AI, not stubs. Unit tests prove the maths;
 * this proves the deployment can actually reach Kraken, parse its own balance,
 * exit the positions it holds, and get usable JSON out of the model.
 */
export async function runPreflight(
  exchange: Exchange, mem: Memory, ai: AiBrain, aiSamples: number,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string, critical = false) =>
    checks.push({ name, ok, detail, critical });
  // Always measure against fresh data, never a previous cycle's snapshot.
  exchange.beginCycle();

  // 1. Market coverage — a watchlist pair Kraken does not list is dead weight.
  try {
    const missing = await exchange.listMissingMarkets(ALL_PAIRS);
    add('Kraken markets', missing.length === 0,
      missing.length === 0
        ? `all ${ALL_PAIRS.length} watchlist pairs are listed`
        : `${missing.length} unlisted and permanently unreachable: ${missing.join(', ')}`,
      true);
  } catch (e: any) {
    add('Kraken markets', false, `market load failed: ${e.message}`, true);
  }

  // 2. Market data — enough closed history, on every pair, to compute risk.
  const dataProblems: string[] = [];
  let analysed = 0;
  let freshestAgeMinutes = Number.POSITIVE_INFINITY;
  const prices = await exchange.getPricesBatch(ALL_PAIRS);
  await mapWithConcurrency(ALL_PAIRS, CONFIG.ohlcvConcurrency, async pair => {
    const price = prices[pair];
    if (price === undefined) { dataProblems.push(`${pair}: no price`); return; }
    const candles = await exchange.getOhlcv(pair, '1h', 200);
    if (candles.length < 50) { dataProblems.push(`${pair}: ${candles.length} closed candles`); return; }
    const age = (Date.now() - candles[candles.length - 1].timestamp) / 60_000;
    freshestAgeMinutes = Math.min(freshestAgeMinutes, age);
    // A closed 1h candle is at most ~2h old; older means the feed is stale.
    if (age > 180) { dataProblems.push(`${pair}: newest closed candle is ${Math.round(age)}min old`); return; }
    const ta = TA.full(candles, price);
    if (!ta) { dataProblems.push(`${pair}: analysis returned nothing`); return; }
    if (ta.atr === null) { dataProblems.push(`${pair}: no ATR, risk cannot be priced`); return; }
    if (planTrade(ta) === null) { dataProblems.push(`${pair}: no valid stop/target`); return; }
    analysed++;
  });
  add('Market data', dataProblems.length === 0,
    dataProblems.length === 0
      ? `${analysed}/${ALL_PAIRS.length} pairs analysable, newest closed candle ${Math.round(freshestAgeMinutes)}min old`
      : `${analysed}/${ALL_PAIRS.length} usable; ${dataProblems.join('; ')}`,
    analysed === 0);

  // 3. Account — the numbers the bot sizes and reports against.
  let account: PortfolioSnapshot | null = null;
  try {
    account = await exchange.getPortfolioValue(mem);
    add('Account balance', account.tradableUsd > 0,
      `${fmt(account.cashUsd)} free cash | ${fmt(account.tradableUsd)} tradable | ${fmt(account.stakedUsd)} staked | ${fmt(account.totalUsd)} total`,
      true);
  } catch (e: any) {
    add('Account balance', false, `balance fetch failed: ${e.message}`, true);
  }

  // 4. Can the bot buy anything at all? This must measure the *quote* balance a
  //    USD-quoted order can actually draw on. Totalling every cash equivalent
  //    counts USDC and USDT that no USD pair can spend, which reported $14.60 of
  //    buying power against a real free USD balance of $0.05.
  if (account) {
    let bestFunded: { pair: string; spendable: number; minimum: number } | null = null;
    let cheapest: { pair: string; minimum: number } | null = null;
    let quoteCash = 0;
    for (const pair of ALL_PAIRS) {
      const price = prices[pair];
      if (price === undefined) continue;
      const minimum = await exchange.getMinimumTradeUsd(pair, price);
      if (minimum === null) continue;
      if (!cheapest || minimum < cheapest.minimum) cheapest = { pair, minimum };
      const free = exchange.getAvailableCash(pair);
      if (free === null) continue;
      quoteCash = Math.max(quoteCash, free);
      const spendable = free * (1 - CONFIG.feeReservePct);
      if (spendable >= minimum && (!bestFunded || spendable - minimum > bestFunded.spendable - bestFunded.minimum))
        bestFunded = { pair, spendable, minimum };
    }
    // Say *why* cash is unavailable rather than guessing. Money can be missing
    // because it sits in another stablecoin no USD pair can spend, or because it
    // is reserved against open orders — very different problems.
    const quoteBalance = cheapest ? exchange.getQuoteBalance(cheapest.pair) : null;
    const reserved = quoteBalance ? Math.max(0, quoteBalance.total - quoteBalance.free) : 0;
    const otherCash = Math.max(0, account.cashUsd - (quoteBalance?.total ?? quoteCash));
    const reasons: string[] = [];
    if (reserved > 0.01)
      reasons.push(`${fmt(reserved)} of ${quoteBalance!.asset} is reserved against open orders`);
    if (otherCash > 0.01)
      reasons.push(`${fmt(otherCash)} sits in other stablecoins no ${quoteBalance?.asset ?? 'USD'} pair can spend`);
    const idleNote = reasons.length ? ` (${reasons.join('; ')})` : '';
    add('Buying power', bestFunded !== null,
      cheapest === null
        ? 'could not determine any exchange minimum'
        : bestFunded
          ? `${fmt(bestFunded.spendable)} spendable covers ${bestFunded.pair}'s ${fmt(bestFunded.minimum)} minimum — entries are possible${idleNote}`
          : `${fmt(quoteCash * (1 - CONFIG.feeReservePct))} spendable vs ${fmt(cheapest.minimum)} for the cheapest pair (${cheapest.pair}) — no new entry can be funded${idleNote}`);
  }

  // 5. Exit reachability — a position that cannot be sold has an unenforceable stop.
  const open = mem.getOpenPositions();
  if (open.length > 0) {
    const blocked: string[] = [];
    for (const position of open) {
      const price = prices[position.pair] ?? position.currentPrice;
      const sellable = await exchange.checkSellable(position.pair, position.qty, price);
      if (!sellable.ok) blocked.push(`${position.pair} (${sellable.detail})`);
    }
    add('Exit reachability', blocked.length === 0,
      blocked.length === 0
        ? `all ${open.length} positions can be fully exited`
        : `stops cannot execute on: ${blocked.join(', ')}`,
      blocked.length > 0);
  } else {
    add('Exit reachability', true, 'no open positions');
  }

  // 6. AI — the check that matters most, because a model that cannot return
  //    parseable JSON silently turns every decision into HOLD.
  if (aiSamples > 0) {
    const result = await ai.selfTest(aiSamples);
    const usable = result.valid + result.salvaged;
    const reasons = Object.entries(result.finishReasons).map(([k, v]) => `${k}x${v}`).join(', ') || 'none';
    add('AI decisions', usable === result.total,
      `${result.valid}/${result.total} clean, ${result.salvaged} salvaged | finish: ${reasons} | ${result.avgLatencyMs}ms avg | budget ${result.budget} tokens${result.lastError ? ` | last error: ${result.lastError}` : ''}`,
      usable === 0);
  }

  return checks;
}

function reportPreflight(checks: CheckResult[]): boolean {
  console.log('\n── PREFLIGHT ──');
  for (const check of checks)
    console.log(`  [${check.ok ? 'PASS' : check.critical ? 'FAIL' : 'WARN'}] ${check.name}: ${check.detail}`);
  const failures = checks.filter(c => !c.ok);
  const critical = failures.filter(c => c.critical);
  console.log(`  ${checks.length - failures.length}/${checks.length} checks passed${critical.length ? ` — ${critical.length} CRITICAL` : failures.length ? ` — ${failures.length} warning(s)` : ''}`);
  return critical.length === 0;
}

// ============================================================
// MAIN — The 4-phase loop
// ============================================================

let shutdownRequested = false;
const shutdownWaiters: Array<() => void> = [];

async function main() {
  setConfig(loadConfig());
  const loopMode = CONFIG.loopMode;
  const fastMode = process.argv.includes('--fast');

  // Validate
  if (!process.env.AI_API_KEY) {
    console.error('Missing AI_API_KEY. Get one at https://openrouter.ai/keys');
    console.error('Copy .env.example to .env and fill in your key.');
    process.exit(1);
  }
  if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_API_SECRET) {
    console.error('Missing KRAKEN_API_KEY or KRAKEN_API_SECRET. Required for live trading.');
    console.error('Get them from Kraken > Settings > API > Create Key (Trade permission only).');
    process.exit(1);
  }

  console.log(`
┌──────────────────────────────────────────────┐
│       AI CRYPTO TRADING BOT v2.1             │
│  AI: GLM 5.2 via OpenRouter                  │
│  Exchange: Kraken (${CONFIG.paperMode ? 'PAPER' : 'LIVE'})              │
│  Strategy: AI-Powered Oversold Bounce        │
│  Risk: ATR stops + trailing exits            │
└──────────────────────────────────────────────┘`);
  console.log(`Pairs: ${ALL_PAIRS.length} | Sectors: ${Object.keys(WATCHLIST).length} | Balance: fetched from API each cycle`);
  const limit = (value: number | null, suffix = '') => value === null ? 'off' : `${value}${suffix}`;
  console.log(`[CONFIG] Mode: ${CONFIG.paperMode ? 'paper' : 'live'} | Loop: ${loopMode ? 'on' : 'single'} | Interval: ${fastMode ? '5min' : `${CONFIG.scanIntervalMs / 60000}min`}`);
  console.log(`[CONFIG] AI budget: ${CONFIG.aiDecisionsPerCycle} buys/cycle | ${CONFIG.aiReviewsPerCycle === null ? 'all' : CONFIG.aiReviewsPerCycle} reviews/cycle | Buy confidence: ${limit(CONFIG.aiConfidenceThreshold, '/10')} | Sell confidence: ${limit(CONFIG.aiSellConfidenceThreshold, '/10')} | Position risk: ${limit(CONFIG.maxRiskPerTradePct)}`);
  console.log(`[CONFIG] Exposure: ${limit(CONFIG.maxExposurePct)} | Portfolio risk: ${limit(CONFIG.maxPortfolioRiskPct)} | Min trade: ${limit(CONFIG.minTradeUsd, ' USD')} | Min R/R: ${limit(CONFIG.minRrRatio, ':1')} | Max RSI: ${limit(CONFIG.scanMaxRsi)} | Fee reserve: ${(CONFIG.feeReservePct * 100).toFixed(2)}%`);
  console.log(`[CONFIG] State directory: ${DATA_DIR}`);
  console.log(`[CONFIG] AI max tokens: ${CONFIG.aiMaxTokens} | AI base URL: ${CONFIG.aiBaseUrl ? 'custom' : 'provider default'} | Scan concurrency: ${CONFIG.ohlcvConcurrency}`);
  console.log(`[CONFIG] Risk model: stop ${CONFIG.atrStopMult}x ATR (max ${pct(CONFIG.maxStopDistancePct)} from entry) | target ${CONFIG.atrTargetMult}x ATR | trail ${CONFIG.trailingStopAtrMult > 0 ? `${CONFIG.trailingStopAtrMult}x ATR` : 'off'} | breakeven at ${CONFIG.breakevenAtR > 0 ? `${CONFIG.breakevenAtR}R` : 'off'}`);
  console.log(`[CONFIG] Preferred concurrent positions: ${limit(CONFIG.targetPositionCount)} (guidance, not a cap)`);
  console.log(`[CONFIG] Daily loss breaker: ${limit(CONFIG.maxDailyLossPct)} | Max positions: ${limit(CONFIG.maxOpenPositions)} | Max sector exposure: ${limit(CONFIG.maxSectorExposurePct)}`);

  const exchange = new Exchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET, CONFIG.paperMode);
  const memory = new Memory();
  const ai = new AiBrain(memory);

  // Verify against the real exchange and the real model before risking anything.
  // Trading still proceeds on a non-critical failure: deterministic stop and
  // trailing logic protects open positions even when the AI is unreachable.
  const doctorOnly = process.argv.includes('--doctor');
  if (doctorOnly || CONFIG.preflight) {
    try {
      const checks = await runPreflight(exchange, memory, ai, CONFIG.preflightAiSamples);
      const healthy = reportPreflight(checks);
      if (doctorOnly) {
        console.log(healthy ? '[DOCTOR] Healthy.' : '[DOCTOR] Critical checks failed.');
        process.exit(healthy ? 0 : 1);
      }
      if (!healthy) console.error('[PREFLIGHT] Critical checks failed; managing existing positions only where possible.');
    } catch (e: any) {
      console.error(`[PREFLIGHT] Could not complete: ${e.message}`);
      if (doctorOnly) process.exit(1);
    }
  }
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log('[SHUTDOWN] Signal received; finishing the current operation and saving state.');
    memory.savePositions();
    memory.saveState();
    while (shutdownWaiters.length) shutdownWaiters.shift()?.();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);

  let cycle = 0;
  while (!shutdownRequested) {
    cycle++;
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  CYCLE #${cycle} | ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(50)}`);

    try { await runCycle(exchange, memory, ai); }
    catch (e: any) { console.error(`[CYCLE ERROR] ${e.message}`); }

    memory.state.cycleCount = cycle;
    memory.state.lastScan = new Date().toISOString();
    memory.saveState();

    if (!loopMode || shutdownRequested) break;
    const interval = fastMode ? 300_000 : CONFIG.scanIntervalMs;
    console.log(`\nNext cycle in ${interval / 60000}min... (Ctrl+C to stop)`);
    await Promise.race([
      sleep(interval),
      new Promise<void>(resolve => shutdownWaiters.push(resolve)),
    ]);
  }
  memory.savePositions();
  memory.saveState();
  console.log('[SHUTDOWN] State saved; exiting.');
}

/**
 * Sells a position and books the result.
 *
 * Exits used to assume the whole position sold at the fill price: a partial fill
 * left real coins on the exchange while memory recorded a full, profitable close.
 * A meaningful residual now keeps the position open with a reduced cost basis.
 * Returns true when the position is fully closed.
 */
async function executeExit(
  exchange: Exchange, mem: Memory, pair: string,
  reason: string, aiVerdict: string, aiConfidence: number,
  fraction = 1,
): Promise<boolean> {
  const pos = mem.positions[pair];
  if (!pos || pos.status !== 'open') return false;
  const { stopLoss, takeProfit, costBasisUsd, sector } = pos;
  const positionQty = pos.qty;
  // A deliberate trim and a partial fill land in the same place below: whatever is
  // left over stays open unless it is too small to be worth holding.
  const requestedQty = fraction >= 1 ? positionQty : Math.min(positionQty, positionQty * fraction);
  if (!(requestedQty > 0)) return false;

  const fill = await exchange.sell(pair, requestedQty);
  if (!fill) return false;

  const soldQty = Math.min(fill.qty, requestedQty);
  const residualQty = positionQty - soldQty;
  const residualValue = residualQty * fill.price;
  if (exchange.paper) mem.adjustPaperCash(soldQty * fill.price - fill.feeUsd);

  const dustThreshold = Math.max(BALANCE_DUST_USD, costBasisUsd * PARTIAL_EXIT_DUST_PCT);
  if (residualQty > 0 && residualValue > dustThreshold) {
    const bookedPnl = mem.reducePosition(pair, soldQty, fill.price, fill.feeUsd);
    if (bookedPnl !== null) {
      console.warn(`  [PARTIAL EXIT] ${pair}: sold ${soldQty.toFixed(6)} of ${requestedQty.toFixed(6)} for ${bookedPnl >= 0 ? '+' : ''}${fmt(bookedPnl)}; ${fmt(residualValue)} still open and will be retried next cycle`);
      mem.logTrade({
        timestamp: new Date().toISOString(), pair, side: 'SELL',
        price: fill.price, qty: soldQty, costBasisUsd,
        stopLoss, takeProfit, pnlUsd: bookedPnl, pnlPct: 0, status: 'partial',
        sector, reason: `Partial exit: ${reason}`, aiVerdict, aiConfidence,
      });
      return false;
    }
  }

  const closed = mem.closePosition(pair, fill.price, reason, fill.feeUsd, soldQty);
  if (!closed) return false;
  mem.logTrade({
    timestamp: new Date().toISOString(), pair, side: 'SELL',
    price: fill.price, qty: soldQty, costBasisUsd,
    stopLoss, takeProfit,
    pnlUsd: closed.pnlUsd ?? 0, pnlPct: closed.pnlPct ?? 0, status: 'closed',
    sector, reason, aiVerdict, aiConfidence,
  });
  console.log(`  [CLOSED] ${pair}: ${(closed.pnlUsd ?? 0) >= 0 ? '+' : ''}${fmt(closed.pnlUsd ?? 0)} (${closed.pnlPct ?? 0}%) — ${reason}`);
  return true;
}

/**
 * Lifts positions that have fallen under the exchange's minimum sellable size back
 * over it, so their stops can actually execute.
 *
 * A holding too small to sell is worse than an unprotected one: the bot reports a
 * stop, the operator believes it, and the order would be rejected the moment it
 * mattered. Production found MORPHO/USD sitting at 1.7602 against a 2.5 minimum.
 * The spend is bounded by one exchange minimum order, and is skipped when cash is
 * short or the pair cannot be priced.
 */
async function topUpStrandedPositions(
  exchange: Exchange, mem: Memory, prices: Record<string, number>, portfolioValue: number,
) {
  if (!CONFIG.topUpStrandedPositions) return;
  for (const position of mem.getOpenPositions()) {
    if (shutdownRequested) return;
    const price = prices[position.pair] ?? position.currentPrice;
    if (!(price > 0)) continue;
    const sellable = await exchange.checkSellable(position.pair, position.qty, price);
    if (sellable.ok) continue;

    const cost = await exchange.topUpCostToSell(position.pair, position.qty, price);
    if (cost === null) {
      console.warn(`  [TOPUP] ${position.pair}: stranded (${sellable.detail}) and no top-up size could be derived; the stop cannot execute`);
      continue;
    }
    // Restoring an exit is a defensive act; buying a materially larger position is
    // not. Past the cap this stops being a repair and becomes a discretionary
    // trade the model never asked for, so it is reported instead.
    const cap = portfolioValue * CONFIG.topUpMaxPct;
    if (cost > cap) {
      console.warn(`  [TOPUP] ${position.pair}: stranded (${sellable.detail}); restoring it would cost ${fmt(cost)}, above the ${pct(CONFIG.topUpMaxPct)} cap of ${fmt(cap)} — leaving it alone. The stop cannot execute; sell or top up by hand.`);
      continue;
    }
    const freeCash = exchange.paper ? mem.paperCash() : exchange.getAvailableCash(position.pair) ?? 0;
    const spendable = freeCash * (1 - CONFIG.feeReservePct);
    if (spendable < cost) {
      console.warn(`  [TOPUP] ${position.pair}: stranded (${sellable.detail}); needs ${fmt(cost)} to become sellable but only ${fmt(spendable)} is available — the stop cannot execute until it is topped up or sold by hand`);
      continue;
    }

    console.log(`  [TOPUP] ${position.pair}: ${sellable.detail}; buying ${fmt(cost)} so the stop can execute`);
    const fill = await exchange.buy(position.pair, cost);
    if (!fill) {
      console.warn(`  [TOPUP] ${position.pair}: top-up order did not fill; the stop still cannot execute`);
      continue;
    }
    if (exchange.paper) mem.adjustPaperCash(-(fill.qty * fill.price + fill.feeUsd));
    if (mem.addToPosition(position.pair, fill.qty, fill.price, fill.feeUsd)) {
      const updated = mem.positions[position.pair];
      // The new coins must be visible to a sell placed later in this same cycle,
      // otherwise a stop firing right after the repair is clamped back to the
      // unsellable size the repair just fixed.
      await exchange.refreshBalanceSnapshot();
      console.log(`  [TOPUP] ${position.pair}: now ${updated.qty.toFixed(6)} units at an average ${fmt(updated.entryPrice)}; exit restored`);
      mem.logTrade({
        timestamp: new Date().toISOString(), pair: position.pair, side: 'BUY',
        price: fill.price, qty: fill.qty, costBasisUsd: fill.qty * fill.price + fill.feeUsd,
        stopLoss: updated.stopLoss, takeProfit: updated.takeProfit,
        pnlUsd: 0, pnlPct: 0, status: 'topup', sector: updated.sector,
        reason: 'Top-up to restore exchange-minimum sellable size',
        aiVerdict: 'TOPUP', aiConfidence: 10,
      });
    }
  }
}

/** Technicals for one pair, or null when history or pricing is insufficient. */
async function analysePair(exchange: Exchange, pair: string, price: number): Promise<TechnicalAnalysis | null> {
  const candles = await exchange.getOhlcv(pair, '1h', 200);
  if (candles.length < 50) return null;
  return TA.full(candles, price);
}

async function runCycle(exchange: Exchange, mem: Memory, ai: AiBrain) {
  exchange.beginCycle();
  // ── RECONCILE LIVE BALANCE ──
  if (!exchange.paper) await exchange.reconcilePositions(mem);

  // ── FETCH REAL BALANCE ──
  let account = await exchange.getPortfolioValue(mem);
  mem.clearFundingRequestIfFunded(account.cashUsd);
  // Sizing runs off tradable value: staked balances are real money the bot cannot
  // spend, and counting them inflated every position size the AI was asked for.
  let portfolioValue = account.tradableUsd;

  // ── PHASE 1: CHECK EXISTING POSITIONS ──
  console.log('\n── PHASE 1: Check positions ──');
  const open = mem.getOpenPositions();

  // The cash target the model set last cycle is only half a lever if it can merely
  // block buying. When the account is below that target the only way to reach it is
  // to sell something, so the review is told how far short it is and can trim.
  const standingStance = mem.state.lastStance;
  const cashTargetUsd = standingStance ? account.tradableUsd * standingStance.cashTargetPct : 0;
  const cashShortfallUsd = Math.max(0, cashTargetUsd - account.cashUsd);
  const concentration = concentrationNote(account.tradableUsd, open.length);
  const cashNote = standingStance && cashShortfallUsd > 0
    ? `CASH TARGET: you asked to hold ${pct(standingStance.cashTargetPct)} of the portfolio in cash (${fmt(cashTargetUsd)}). The account holds ${fmt(account.cashUsd)}, so it is ${fmt(cashShortfallUsd)} short. Selling is the only way to close that gap — SELL with a "trim_pct" if you want to raise cash from this position, or HOLD if you would rather stay invested here and raise it elsewhere.`
    : '';
  if (cashShortfallUsd > 0 && open.length > 0)
    console.log(`  [CASH TARGET] ${fmt(account.cashUsd)} held vs ${fmt(cashTargetUsd)} target (${pct(standingStance!.cashTargetPct)}); ${fmt(cashShortfallUsd)} short — trims are available to the AI this cycle`);

  if (open.length > 0) {
    const prices = await exchange.getPricesBatch(open.map(p => p.pair));
    mem.updatePrices(prices);

    // Restore exitability before any stop is evaluated, so a triggered stop is
    // actually fillable rather than rejected for being too small.
    await topUpStrandedPositions(exchange, mem, prices, account.tradableUsd);

    // Stop loss / take profit (non-negotiable)
    for (const alert of mem.checkStops(prices)) {
      if (shutdownRequested) break;
      if (mem.positions[alert.pair]?.status !== 'open') continue;
      console.warn(`  [ALERT] ${alert.action}: ${alert.pair} — ${alert.reason}`);
      await executeExit(exchange, mem, alert.pair, alert.reason, 'STOP/TARGET', 10);
    }

    // Technicals for everything still open, fetched in parallel.
    const stillOpen = mem.getOpenPositions();
    const analyses = await mapWithConcurrency(stillOpen, CONFIG.ohlcvConcurrency, async pos => {
      try {
        return await analysePair(exchange, pos.pair, pos.currentPrice);
      } catch (e) {
        console.warn(`  [PHASE 1] ${pos.pair} analysis failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
    const analysisByPair = new Map(stillOpen.map((pos, index) => [pos.pair, analyses[index]]));
    const rankedReviews = rankReviewPositions(stillOpen);
    const reviewLimit = CONFIG.aiReviewsPerCycle === null
      ? rankedReviews.length
      : Math.min(CONFIG.aiReviewsPerCycle, rankedReviews.length);
    console.log(`  [PHASE 1] AI review budget: ${CONFIG.aiReviewsPerCycle === null ? 'all' : `${reviewLimit}/${rankedReviews.length}`}`);

    for (const [index, pos] of rankedReviews.entries()) {
      const ta = analysisByPair.get(pos.pair);
      if (!ta) continue;
      try {
        // Deterministic risk management runs before the AI gets a say: the trail
        // only ever tightens, so it cannot be argued out of protecting a winner.
        const live = mem.positions[pos.pair];
        if (live?.status === 'open') {
          const trail = trailingStop(live, live.currentPrice, ta.atr);
          if (trail) {
            live.stopLoss = trail.stop;
            mem.savePositions();
            console.log(`  [TRAIL] ${pos.pair} stop → ${fmt(trail.stop)} (${trail.reason})`);
          }
        }

        const urgency = reviewUrgency(pos);
        const pnlPct = reviewPnlPct(pos);
        if (index >= reviewLimit) {
          console.log(`  [PHASE 1] AI review skipped ${pos.pair}: budget (${index + 1}/${rankedReviews.length}) | urgency ${(urgency * 100).toFixed(2)}% | P/L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
          continue;
        }
        console.log(`  [PHASE 1] AI review ${pos.pair}: rank ${index + 1}/${reviewLimit} | urgency ${(urgency * 100).toFixed(2)}% | P/L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
        const d = await ai.review(pos.pair, ta, cashNote, concentration);

        if (!shutdownRequested && d.verdict === 'SELL' &&
            (CONFIG.aiSellConfidenceThreshold === null || d.confidence >= CONFIG.aiSellConfidenceThreshold)) {
          const partial = d.trimFraction < 1;
          console.log(`  [AI ${partial ? `TRIM ${(d.trimFraction * 100).toFixed(0)}%` : 'SELL'}] ${pos.pair}: ${d.reasoning}`);
          await executeExit(exchange, mem, pos.pair,
            `AI${partial ? ` trim ${(d.trimFraction * 100).toFixed(0)}%` : ''}: ${d.reasoning}`,
            d.verdict, d.confidence, d.trimFraction);
        }

        const current = mem.positions[pos.pair];
        if (current?.status === 'open') {
          const adjustments = applyPositionAdjustments(current, d.adjustedStop, d.adjustedTarget);
          for (const rejection of adjustments.rejected)
            console.warn(`  [ADJUST REJECT] ${pos.pair}: ${rejection}`);
          if (adjustments.stop !== null) {
            current.stopLoss = adjustments.stop;
            console.log(`  [ADJUST] ${pos.pair} stop → ${fmt(adjustments.stop)}`);
          }
          if (adjustments.target !== null) {
            current.takeProfit = adjustments.target;
            console.log(`  [ADJUST] ${pos.pair} target → ${fmt(adjustments.target)}`);
          }
          if (adjustments.stop !== null || adjustments.target !== null) mem.savePositions();
        }
      } catch (e) {
        console.warn(`  [PHASE 1] ${pos.pair} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const refreshedPortfolioValue = await exchange.refreshAfterPhase1Sales(mem);
    if (refreshedPortfolioValue !== null) {
      account = refreshedPortfolioValue;
      portfolioValue = account.tradableUsd;
    }
  }

  // ── PHASE 2: SCAN FOR OPPORTUNITIES ──
  console.log('\n── PHASE 2: Scan market ──');
  const holding = new Set(mem.getOpenPositions().map(p => p.pair));
  let exposure = mem.getOpenPositions().reduce((s, p) => s + p.currentPrice * p.qty, 0);
  const sectorExposure: Record<string, number> = {};
  for (const p of mem.getOpenPositions())
    sectorExposure[p.sector] = (sectorExposure[p.sector] ?? 0) + p.currentPrice * p.qty;
  const cycleCashSpent: Record<string, number> = {};

  const blockers: string[] = [];
  if (CONFIG.maxExposurePct !== null && exposure >= portfolioValue * CONFIG.maxExposurePct)
    blockers.push(`exposure ${fmt(exposure)} at the ${pct(CONFIG.maxExposurePct)} cap`);
  if (CONFIG.maxOpenPositions !== null && holding.size >= CONFIG.maxOpenPositions)
    blockers.push(`${holding.size} open positions at the MAX_OPEN_POSITIONS limit`);
  // Circuit breaker: stop opening risk on a day that has already gone badly.
  const realizedToday = mem.realizedPnlToday();
  if (CONFIG.maxDailyLossPct !== null && realizedToday < 0 &&
      Math.abs(realizedToday) >= portfolioValue * CONFIG.maxDailyLossPct)
    blockers.push(`daily realised loss ${fmt(realizedToday)} hit the ${pct(CONFIG.maxDailyLossPct)} circuit breaker`);

  const canOpen = blockers.length === 0;
  if (!canOpen) console.log(`  [PHASE 2] No new entries: ${blockers.join('; ')}.`);

  const scanPairs = canOpen ? ALL_PAIRS.filter(pair => !holding.has(pair)) : [];
  const scanPrices = scanPairs.length > 0 ? await exchange.getPricesBatch(scanPairs) : {};

  const scanned = await mapWithConcurrency(scanPairs, CONFIG.ohlcvConcurrency, async pair => {
    try {
      const price = scanPrices[pair];
      if (price === undefined) return null;
      const ta = await analysePair(exchange, pair, price);
      if (!ta) return null;
      if (CONFIG.scanMaxRsi !== null && ta.rsi > CONFIG.scanMaxRsi) {
        console.log(`  [SCAN SKIP] ${pair}: RSI ${ta.rsi} > max ${CONFIG.scanMaxRsi}`);
        return null;
      }
      const ticker = await exchange.getTicker(pair);
      return {
        pair, sector: getSector(pair), ta,
        vol: ticker?.volume24h ?? 0, score: scoreSetup(ta), plan: planTrade(ta),
      };
    } catch (e) {
      console.warn(`  [PHASE 2] ${pair} skipped: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });

  const candidates = scanned.filter((c): c is NonNullable<typeof c> => c !== null);
  candidates.sort((a, b) => b.score.score - a.score.score || a.ta.rsi - b.ta.rsi);
  for (const c of candidates) {
    const distance = c.score.supportDistance === null ? 'none' : pct(c.score.supportDistance);
    console.log(`  [CANDIDATE] ${c.pair}: score=${c.score.score.toFixed(2)} | RSI=${c.ta.rsi} | 1h=${c.ta.trend} 4h=${c.ta.htfTrend} | volume=${c.ta.volumeRatio}x | ATR=${c.ta.atrPct === null ? 'n/a' : pct(c.ta.atrPct)} | support distance=${distance}`);
  }

  // ── PHASE 3: AI DECISIONS ──
  console.log('\n── PHASE 3: AI analysis ──');

  // The model's call on the whole book comes first. It can decline to deploy
  // capital at all this cycle, reserve dry powder for a dip, or ask for more funds.
  let stance: PortfolioStance = { stance: 'NEUTRAL', confidence: 5, reasoning: 'not evaluated', cashTargetPct: 0, requestedFundsUsd: 0 };
  if (candidates.length > 0 && !shutdownRequested) {
    stance = await ai.reviewPortfolio(account, candidates, concentrationNote(portfolioValue, mem.getOpenPositions().length));
    mem.recordStance(stance);
    console.log(`  [STANCE] ${stance.stance} (${stance.confidence}/10) — ${stance.reasoning}`);
    if (stance.cashTargetPct > 0)
      console.log(`  [STANCE] Holding back ${pct(stance.cashTargetPct)} of the portfolio as dry powder (${fmt(portfolioValue * stance.cashTargetPct)})`);
    if (stance.requestedFundsUsd > 0)
      console.log(`\n  *** FUNDING REQUEST: the model is asking for ${fmt(stance.requestedFundsUsd)} ***\n  Reason: ${stance.reasoning}\n`);
  }
  const cashReserveUsd = portfolioValue * stance.cashTargetPct;
  if (stance.stance === 'RISK_OFF')
    console.log('  [STANCE] RISK_OFF — no new entries this cycle; exits and stops continue as normal.');

  const aiCandidates = stance.stance === 'RISK_OFF' ? [] : candidates.slice(0, CONFIG.aiDecisionsPerCycle);
  if (aiCandidates.length > 0)
    console.log(`  [AI BUDGET] Reached: ${aiCandidates.map(c => `${c.pair} (${c.score.score.toFixed(2)})`).join(', ')}`);
  for (const c of aiCandidates) {
    if (shutdownRequested) break;
    if (CONFIG.maxOpenPositions !== null && mem.getOpenPositions().length >= CONFIG.maxOpenPositions) {
      console.log('  [PASS] MAX_OPEN_POSITIONS reached mid-cycle; stopping new entries.');
      break;
    }
    if (!c.plan) {
      console.log(`  [PASS] ${c.pair}: could not build a valid stop/target from the data`);
      continue;
    }
    const plan = c.plan;
    const quoteAsset = exchange.getQuoteAsset(c.pair);
    const quoteKey = quoteAsset || c.pair;
    const spentThisCycle = cycleCashSpent[quoteKey] || 0;
    const availableCashSnapshot = exchange.getAvailableCash(c.pair);
    if (availableCashSnapshot === null && !exchange.paper)
      console.warn(`  [BUY CASH] ${c.pair}: free quote balance unavailable; buy size will be treated as $0`);
    const availableCash = availableCashSnapshot !== null
      ? Math.max(0, availableCashSnapshot - spentThisCycle)
      : exchange.paper
        ? Math.max(0, mem.paperCash() - spentThisCycle)
        : 0;
    // Dry powder the model asked to keep is off limits to new buys.
    const spendableCash = Math.max(0, availableCash - cashReserveUsd) * (1 - CONFIG.feeReservePct);
    const marketMinimum = await exchange.getMinimumTradeUsd(c.pair, c.ta.currentPrice);
    console.log(`  [BUY CASH] ${c.pair}: ${quoteAsset || 'quote'} available ${fmt(availableCash)} | spendable ${fmt(spendableCash)} | cycle spent ${fmt(spentThisCycle)}`);

    // Affordability is settled before the model is consulted. Asking it to analyse
    // an entry that cannot be funded burns an API call to be told what the balance
    // already said — production was doing this three times a cycle, every cycle.
    if (marketMinimum === null) {
      console.log(`  [PASS] ${c.pair}: exchange minimum unavailable; cannot size a buy safely`);
      continue;
    }
    if (spendableCash < marketMinimum) {
      console.log(`  [PASS] ${c.pair}: needs ${fmt(marketMinimum)} but only ${fmt(spendableCash)} is spendable${cashReserveUsd > 0 ? ` after ${fmt(cashReserveUsd)} dry powder` : ''} (free ${fmt(availableCash)}); not asking the AI`);
      continue;
    }

    const decision = await ai.analyze(c.pair, c.sector, c.ta, c.vol, {
      portfolioValueUsd: portfolioValue,
      spendableCashUsd: spendableCash,
      marketMinimumUsd: marketMinimum,
      openPositions: mem.getOpenPositions().length,
      exposureUsd: exposure,
      sectorExposureUsd: sectorExposure[c.sector] ?? 0,
      sectorTargetPct: SECTOR_WEIGHTS[c.sector] ?? 0.05,
      concentration: concentrationNote(portfolioValue, mem.getOpenPositions().length),
    }, c.plan);

    // The model may set its own entry stop and target. The only rule the bot
    // keeps is the hard risk cap: a stop further than MAX_STOP_DISTANCE_PCT from
    // entry is clamped, never widened past it.
    const entry = applyEntryPlan(plan, c.ta.currentPrice, decision);
    const { stop: sl, target: tp, rr, riskPct } = entry;
    if (entry.notes.length) console.log(`  [PLAN] ${c.pair}: ${entry.notes.join('; ')}`);
    const d = decision;

    if (d.verdict !== 'BUY' ||
        (CONFIG.aiConfidenceThreshold !== null && d.confidence < CONFIG.aiConfidenceThreshold)) {
      console.log(`  [PASS] ${c.pair}: ${d.verdict} (${d.confidence}/10)`);
      continue;
    }

    if (CONFIG.minRrRatio !== null && rr < CONFIG.minRrRatio) {
      console.log(`  [PASS] ${c.pair}: R/R ${rr.toFixed(1)}:1 < ${CONFIG.minRrRatio}:1`);
      continue;
    }

    const aiSize = portfolioValue * d.positionSizePct / 100;

    let configuredLimitSize = Number.POSITIVE_INFINITY;
    if (CONFIG.maxExposurePct !== null)
      configuredLimitSize = Math.min(configuredLimitSize, Math.max(0, portfolioValue * CONFIG.maxExposurePct - exposure));
    if (CONFIG.maxRiskPerTradePct !== null && riskPct > 0)
      configuredLimitSize = Math.min(configuredLimitSize, portfolioValue * CONFIG.maxRiskPerTradePct / riskPct);
    if (CONFIG.maxPortfolioRiskPct !== null && riskPct > 0)
      configuredLimitSize = Math.min(configuredLimitSize, portfolioValue * CONFIG.maxPortfolioRiskPct / riskPct);
    if (CONFIG.maxSectorExposurePct !== null)
      configuredLimitSize = Math.min(configuredLimitSize,
        Math.max(0, portfolioValue * CONFIG.maxSectorExposurePct - (sectorExposure[c.sector] ?? 0)));

    if (configuredLimitSize < marketMinimum) {
      console.log(`  [PASS] ${c.pair}: configured limits leave ${fmt(configuredLimitSize)}, below exchange minimum ${fmt(marketMinimum)}`);
      continue;
    }

    let finalSize = Math.min(aiSize, spendableCash, configuredLimitSize);
    if (aiSize <= 0) {
      finalSize = marketMinimum;
      console.log(`  [MIN SIZE] ${c.pair}: AI requested no position size; using exchange minimum ${fmt(marketMinimum)}`);
    } else if (aiSize < marketMinimum) {
      finalSize = marketMinimum;
      console.log(`  [MIN SIZE] ${c.pair}: raising ${fmt(aiSize)} to exchange minimum ${fmt(marketMinimum)}`);
    }

    const sw = SECTOR_WEIGHTS[c.sector] || 0.05;
    console.log(`
  *** BUY: ${c.pair} ***
  Confidence: ${d.confidence}/10 | ${d.reasoning}
  Entry: ${fmt(c.ta.currentPrice)} | Stop: ${fmt(sl)} (${pct(riskPct)}, ${c.plan.basis}) | Target: ${fmt(tp)}
  R/R: ${rr.toFixed(1)}:1 | Size: ${fmt(finalSize)} | Risk: ${fmt(finalSize * riskPct)} | Sector: ${c.sector} (${(sw * 100).toFixed(0)}%)
  `);

    if (shutdownRequested) break;
    const fill = await exchange.buy(c.pair, finalSize);
    if (fill) {
      const filledCost = fill.qty * fill.price + fill.feeUsd;
      mem.openPosition(c.pair, fill.qty, fill.price, sl, tp, c.sector,
        `RSI=${c.ta.rsi} ${c.ta.trend}/${c.ta.htfTrend} R/R=${rr.toFixed(1)}`, d.reasoning, fill.feeUsd, c.ta.atr);
      if (exchange.paper) mem.adjustPaperCash(-filledCost);
      mem.logTrade({
        timestamp: new Date().toISOString(), pair: c.pair, side: 'BUY',
        price: fill.price, qty: fill.qty, costBasisUsd: filledCost, stopLoss: sl, takeProfit: tp,
        pnlUsd: 0, pnlPct: 0, status: 'open', sector: c.sector,
        reason: `RSI=${c.ta.rsi} R/R=${rr.toFixed(1)}`, aiVerdict: d.verdict, aiConfidence: d.confidence,
      });
      exposure += fill.qty * fill.price;
      sectorExposure[c.sector] = (sectorExposure[c.sector] ?? 0) + fill.qty * fill.price;
      cycleCashSpent[quoteKey] = (cycleCashSpent[quoteKey] || 0) + filledCost;
      console.log(`  [BUY CASH] ${c.pair}: spent ${fmt(filledCost)} ${quoteAsset || 'quote'} including fees | remaining ${fmt(Math.max(0, availableCash - filledCost))}`);
      holding.add(c.pair);
    }
  }

  // ── PHASE 4: SUMMARY ──
  console.log('\n── PORTFOLIO ──');
  const positions = mem.getOpenPositions();
  let totalVal = 0;
  let openRisk = 0;
  for (const p of positions) {
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    const percent = p.costBasisUsd > 0 ? (pnl / p.costBasisUsd) * 100 : 0;
    console.log(`  ${p.pair}: ${fmt(p.costBasisUsd)} | P/L ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%) | stop ${fmt(p.stopLoss)}`);
    totalVal += p.currentPrice * p.qty;
    openRisk += Math.max(0, p.currentPrice - p.stopLoss) * p.qty;
  }
  const untracked = Math.max(0, account.tradableUsd - account.cashUsd - totalVal);
  console.log(`  Cash: ${fmt(account.cashUsd)} | Tracked positions: ${fmt(totalVal)}${untracked > 0.01 ? ` | Untracked holdings: ${fmt(untracked)}` : ''}${account.stakedUsd > 0.01 ? ` | Staked (locked): ${fmt(account.stakedUsd)}` : ''}`);
  console.log(`  Tradable: ${fmt(account.tradableUsd)} | Account total: ${fmt(account.totalUsd)} | Open: ${positions.length}`);
  console.log(`  Open risk to stops: ${fmt(openRisk)}${portfolioValue > 0 ? ` (${pct(openRisk / portfolioValue)} of portfolio)` : ''} | Realised today: ${fmt(mem.realizedPnlToday())}`);
  console.log(`  P/L: ${fmt(mem.state.totalPnl)} | Win rate: ${mem.winRate().toFixed(0)}% over ${mem.state.totalTrades} closes`);
  const funding = mem.state.fundingRequest;
  if (funding)
    console.log(`  [FUNDING] Outstanding request: ${fmt(funding.usd)} since ${funding.requestedAt} — "${funding.reasoning}"`);
}

export { TA, applyPositionAdjustments, updateTradeExtremes, loadConfig, csvField, Memory, fmt, Exchange, runCycle, AiBrain, reportPreflight, normalizeAsset, isStakedBalance };
export type { TradingConfig };

if (require.main === module)
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
