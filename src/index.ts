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

interface OhlcvCandle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
interface TechnicalAnalysis {
  currentPrice: number; rsi: number;
  sma5: number | null; sma20: number | null; sma50: number | null;
  bollinger: { upper: number | null; middle: number | null; lower: number | null };
  supports: number[]; resistances: number[];
  volumeRatio: number; stochRsiK: number; stochRsiD: number;
  trend: 'bullish' | 'bearish' | 'neutral'; maScore: number;
}
interface AiDecision {
  verdict: 'BUY' | 'HOLD' | 'SELL'; confidence: number; reasoning: string;
  positionSizePct: number; adjustedStop: number | null; adjustedTarget: number | null;
}
interface Position {
  pair: string; status: 'open' | 'closed'; sector: string;
  entryPrice: number; qty: number; costBasisUsd: number;
  stopLoss: number; takeProfit: number; currentPrice: number;
  reason: string; aiReasoning: string; openedAt: string;
  closedAt?: string; exitPrice?: number; exitValueUsd?: number;
  pnlUsd?: number; pnlPct?: number; closeReason?: string;
}
interface TradeRecord {
  timestamp: string; pair: string; side: 'BUY' | 'SELL';
  price: number; qty: number; costBasisUsd: number;
  stopLoss: number; takeProfit: number;
  pnlUsd: number; pnlPct: number; status: string;
  sector: string; reason: string; aiVerdict: string; aiConfidence: number;
}
interface OrderFill { qty: number; price: number }
interface BotState {
  startedAt: string; totalTrades: number; wins: number; losses: number;
  totalPnl: number; bestTrade: string; worstTrade: string;
  lastScan: string; lastAiDecision: string; cycleCount: number;
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
  loopMode: boolean;
};
let CONFIG: TradingConfig;

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

function optionalEnvNumber(name: string, min: number, max?: number): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max))
    throw new Error(`${name} must be a number${max === undefined ? ` >= ${min}` : ` between ${min} and ${max}`}; got "${raw}"`);
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
    loopMode,
  };
}

const BALANCE_DUST_USD = 1;
const POSITION_QTY_TOLERANCE_PCT = 0.01;
const IMPORTED_POSITION_STOP_PCT = 0.05;
const IMPORTED_POSITION_TARGET_PCT = 0.10;

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

const DATA_DIR = path.join(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.csv');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// --- HELPERS ---

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const fmt = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
const ASSET_ALIASES: Record<string, string> = {
  XBT: 'BTC', XXBT: 'BTC', XDG: 'DOGE', XXDG: 'DOGE', ZUSD: 'USD', ETH2: 'ETH',
};
const STAKED_BALANCE_SUFFIXES = new Set(['S', 'B', 'F', 'M']);
const CASH_EQUIVALENTS = new Set([
  'USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'TUSD', 'USDP', 'USDD', 'FDUSD',
  'USDS', 'USDE', 'USDA', 'USDG', 'RLUSD', 'GUSD', 'FRAX', 'LUSD',
]);

function normalizeAsset(asset: string): string {
  const base = asset.toUpperCase().split('.')[0];
  return ASSET_ALIASES[base] || base;
}

function isStakedBalance(asset: string): boolean {
  return asset.toUpperCase().split('.').slice(1).some(suffix => STAKED_BALANCE_SUFFIXES.has(suffix));
}

function getSector(pair: string): string {
  for (const [sector, pairs] of Object.entries(WATCHLIST)) {
    if (pairs.includes(pair)) return sector;
  }
  return 'unlisted';
}

async function withRetry<T>(label: string, operation: () => Promise<T>, attempts = RETRY_ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[RETRY] ${label} failed (${attempt}/${attempts}): ${message}`);
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ============================================================
// TECHNICAL ANALYZER — Pure math, no side effects
// ============================================================

const TA = {
  rsi(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    const deltas: number[] = [];
    for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);
    const recent = deltas.slice(-period);
    const avgGain = recent.filter(d => d > 0).reduce((a, b) => a + b, 0) / period;
    const avgLoss = recent.filter(x => x < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
    if (avgLoss === 0) return 100;
    return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
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
    const out: number[] = [];
    for (const s of [...new Set(hits)].sort((a, b) => a - b)) {
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

  volRatio(volumes: number[]): number {
    if (volumes.length < 21) return 1;
    const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    return avg === 0 ? 1 : +(volumes[volumes.length - 1] / avg).toFixed(2);
  },

  stochRsi(closes: number[], rsiP = 14, stochP = 14): [number, number] {
    if (closes.length < rsiP + stochP) return [50, 50];
    const vals: number[] = [];
    for (let i = rsiP; i <= closes.length; i++) vals.push(this.rsi(closes.slice(0, i), rsiP));
    const recent = vals.slice(-stochP);
    const min = Math.min(...recent), max = Math.max(...recent);
    const k = max === min ? 50 : ((vals[vals.length - 1] - min) / (max - min)) * 100;
    const d3 = recent.slice(-3);
    return [+k.toFixed(2), +(d3.length >= 3 ? d3.reduce((a, b) => a + b, 0) / 3 : k).toFixed(2)];
  },

  trend(closes: number[]): 'bullish' | 'bearish' | 'neutral' {
    if (closes.length < 50) return 'neutral';
    const s5 = this.sma(closes, 5), s20 = this.sma(closes, 20), s50 = this.sma(closes, 50);
    if (s5 && s20 && s50) {
      if (s5 > s20 && s20 > s50) return 'bullish';
      if (s5 < s20 && s20 < s50) return 'bearish';
    }
    return 'neutral';
  },

  full(candles: OhlcvCandle[], price: number): TechnicalAnalysis | null {
    if (candles.length < 50) return null;
    const c = candles.map(x => x.close), h = candles.map(x => x.high);
    const l = candles.map(x => x.low), v = candles.map(x => x.volume);
    const s5 = this.sma(c, 5), s20 = this.sma(c, 20), s50 = this.sma(c, 50);
    let maScore = 0;
    if (s5 !== null) maScore += price > s5 ? 1 : -1;
    if (s20 !== null) maScore += price > s20 ? 1 : -1;
    if (s50 !== null) maScore += price > s50 ? 1 : -1;
    const [stochK, stochD] = this.stochRsi(c);
    return {
      currentPrice: price, rsi: this.rsi(c), sma5: s5, sma20: s20, sma50: s50,
      bollinger: this.bollinger(c), supports: this.supports(l, price),
      resistances: this.resistances(h, price), volumeRatio: this.volRatio(v),
      stochRsiK: stochK, stochRsiD: stochD, trend: this.trend(c), maScore,
    };
  },
};

// ============================================================
// EXCHANGE CLIENT — Kraken via ccxt (paper or live)
// ============================================================

class Exchange {
  private ex: any;
  readonly paper: boolean;
  private cycleBalance: any = null;
  private balanceLoaded = false;
  private marketsLoaded = false;
  private cyclePrices: Record<string, number> = {};

  constructor(apiKey?: string, apiSecret?: string, paperMode = true) {
    this.paper = paperMode;
    const opts: Record<string, any> = { enableRateLimit: true };
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

  async getPrice(pair: string): Promise<number | null> {
    try {
      const t = await withRetry<any>(`ticker ${pair}`, () => this.ex.fetchTicker(pair));
      return t.last ?? t.close ?? null;
    } catch (e) {
      console.warn(`[EXCHANGE] Price unavailable for ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async getTicker(pair: string): Promise<{ price: number; volume24h: number } | null> {
    try {
      const t = await withRetry<any>(`ticker ${pair}`, () => this.ex.fetchTicker(pair));
      return { price: t.last ?? t.close ?? 0, volume24h: t.quoteVolume ?? t.baseVolume ?? 0 };
    } catch (e) {
      console.warn(`[EXCHANGE] Ticker unavailable for ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async getOhlcv(pair: string, tf = '1h', limit = 200): Promise<OhlcvCandle[]> {
    try {
      const raw = await withRetry<any[]>(`OHLCV ${pair}`, () => this.ex.fetchOHLCV(pair, tf, undefined, limit));
      return raw.map((c: any) => ({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
    } catch (e) {
      console.warn(`[EXCHANGE] OHLCV unavailable for ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async getPricesBatch(pairs: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
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

  private async ensureMarkets(): Promise<void> {
    if (!this.marketsLoaded) {
      await withRetry('market loading', () => this.ex.loadMarkets());
      this.marketsLoaded = true;
    }
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

  private getCashField(balance: any, field: string): number {
    let found = false;
    let total = 0;
    for (const [asset, value] of Object.entries(balance || {})) {
      if (!this.isCashEquivalent(asset) || !value || typeof value !== 'object') continue;
      const amount = Number((value as any)[field]);
      if (Number.isFinite(amount)) { total += amount; found = true; }
    }
    if (found) return total;
    const bucket = balance?.[field];
    if (!bucket || typeof bucket !== 'object') return 0;
    for (const [asset, value] of Object.entries(bucket)) {
      if (!this.isCashEquivalent(asset)) continue;
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
      console.warn(`  [RECONCILE] ${pair} entry history unavailable; using current price`);
      return { price: fallback, source: 'current price fallback' };
    }
  }

  private orderFill(order: any, fallbackQty: number, fallbackPrice: number): OrderFill {
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
    return { qty, price };
  }

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

  getAvailableCash(): number | null {
    if (!this.balanceLoaded || !this.cycleBalance) return null;
    return this.getCashField(this.cycleBalance, 'free');
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
      const price = await this.getPrice(pair);
      if (!price) return null;
      const qty = usd / price;
      if (this.paper) {
        console.log(`  [PAPER BUY] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(usd)}`);
        return { qty, price };
      }
      const orderQty = await this.normalizeOrderAmount(pair, qty, price);
      if (orderQty === null) return null;
      const order = await this.ex.createMarketBuyOrder(pair, orderQty);
      const fill = this.orderFill(order, orderQty, price);
      console.log(`  [LIVE BUY] ${fill.qty.toFixed(6)} ${pair} @ ${fmt(fill.price)} = ${fmt(fill.qty * fill.price)}`);
      return fill;
    } catch (e: any) { console.error(`  [BUY FAIL] ${pair}: ${e.message}`); return null; }
  }

  async sell(pair: string, qty: number): Promise<OrderFill | null> {
    try {
      const price = await this.getPrice(pair);
      if (!price) return null;
      if (this.paper) {
        console.log(`  [PAPER SELL] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(qty * price)}`);
        return { qty, price };
      }
      const orderQty = await this.normalizeOrderAmount(pair, qty, price);
      if (orderQty === null) return null;
      const order = await this.ex.createMarketSellOrder(pair, orderQty);
      const fill = this.orderFill(order, orderQty, price);
      console.log(`  [LIVE SELL] ${fill.qty.toFixed(6)} ${pair} @ ${fmt(fill.price)} = ${fmt(fill.qty * fill.price)}`);
      return fill;
    } catch (e: any) { console.error(`  [SELL FAIL] ${pair}: ${e.message}`); return null; }
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
        const entry = await this.getEntryPrice(pair, holding.qty, holding.price);
        const reason = `Imported from Kraken balance (${entry.source})`;
        const entryStop = entry.price * (1 - IMPORTED_POSITION_STOP_PCT);
        const entryTarget = entry.price * (1 + IMPORTED_POSITION_TARGET_PCT);
        const currentStop = holding.price * (1 - IMPORTED_POSITION_STOP_PCT);
        const currentTarget = holding.price * (1 + IMPORTED_POSITION_TARGET_PCT);
        const stopLoss = entryStop < holding.price ? Math.max(entryStop, currentStop) : currentStop;
        const takeProfit = entryTarget > holding.price ? Math.min(entryTarget, currentTarget) : currentTarget;
        mem.openPosition(pair, holding.qty, entry.price,
          stopLoss, takeProfit,
          getSector(pair), reason, 'Imported from Kraken balance; not opened by the bot.');
        console.log(`  [RECONCILE] Imported ${pair}: ${holding.qty.toFixed(6)} @ ${fmt(entry.price)} (${entry.source}) | stop ${fmt(stopLoss)} target ${fmt(takeProfit)}`);
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
   * Get total portfolio value in USD.
   * LIVE: fetches real USD + ZUSD balance from Kraken API.
   * PAPER: calculates from memory (invested + remaining cash).
   */
  async getPortfolioValue(mem: Memory): Promise<number> {
    try {
      if (!this.paper) {
        await this.ensureMarkets();
        const balance = this.balanceLoaded ? this.cycleBalance : await withRetry('balance fetch', () => this.ex.fetchBalance());
        this.cycleBalance = balance;
        this.balanceLoaded = true;
        if (!balance) throw new Error('balance unavailable');
        const usd = this.getCashValue(balance);
        let cryptoValue = 0;
        for (const [pair, holding] of Object.entries(this.mapHoldings(balance, false, true))) {
          const price = await this.getCyclePrice(pair);
          if (price !== null) cryptoValue += holding.qty * price;
        }
        const total = usd + cryptoValue;
        console.log(`  [BALANCE] API: ${fmt(usd)} cash + ${fmt(cryptoValue)} crypto = ${fmt(total)}`);
        return total > 0 ? total : CONFIG.fallbackPortfolioValue;
      }
    } catch (e: any) {
      console.warn(`  [BALANCE] API call failed (${e.message}), using PORTFOLIO_VALUE fallback`);
    }
    // Paper mode (or API fallback): calculate from memory
    const invested = mem.getOpenPositions().reduce((s, p) => s + p.costBasisUsd, 0);
    const cash = CONFIG.fallbackPortfolioValue - invested;
    console.log(`  [BALANCE] Paper: ${fmt(cash)} cash + ${fmt(invested)} invested = ${fmt(CONFIG.fallbackPortfolioValue)}`);
    return CONFIG.fallbackPortfolioValue;
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
    this.state = this.loadJson<BotState>(STATE_FILE, {
      startedAt: new Date().toISOString(), totalTrades: 0, wins: 0, losses: 0,
      totalPnl: 0, bestTrade: '', worstTrade: '',
      lastScan: '', lastAiDecision: '', cycleCount: 0,
    });
    this.positions = this.loadJson<Record<string, Position>>(POSITIONS_FILE, {});
  }

  private loadJson<T>(file: string, fallback: T): T {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    return fallback;
  }

  private saveAtomic(file: string, value: unknown) {
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  }

  savePositions() { this.saveAtomic(POSITIONS_FILE, this.positions); }
  saveState() { this.saveAtomic(STATE_FILE, this.state); }

  openPosition(pair: string, qty: number, price: number, sl: number, tp: number, sector: string, reason: string, aiReason: string) {
    const pos: Position = {
      pair, status: 'open', sector, entryPrice: price, qty,
      costBasisUsd: +(qty * price).toFixed(2), stopLoss: sl, takeProfit: tp,
      currentPrice: price, reason, aiReasoning: aiReason, openedAt: new Date().toISOString(),
    };
    this.positions[pair] = pos;
    this.savePositions();
  }

  closePosition(pair: string, exitPrice: number, reason: string): Position | null {
    const p = this.positions[pair];
    if (!p || p.status !== 'open') return null;
    p.exitPrice = exitPrice;
    p.exitValueUsd = +(p.qty * exitPrice).toFixed(2);
    p.pnlUsd = +(p.exitValueUsd - p.costBasisUsd).toFixed(2);
    p.pnlPct = +((p.pnlUsd / p.costBasisUsd) * 100).toFixed(2);
    p.status = 'closed';
    p.closedAt = new Date().toISOString();
    p.closeReason = reason;
    this.state.totalTrades++;
    this.state.totalPnl += p.pnlUsd;
    if (p.pnlUsd > 0) {
      this.state.wins++;
      if (!this.state.bestTrade || p.pnlUsd > parseFloat(this.state.bestTrade.split(':')[1]))
        this.state.bestTrade = `${pair}:+$${p.pnlUsd}`;
    } else {
      this.state.losses++;
      if (!this.state.worstTrade || p.pnlUsd < -parseFloat(this.state.worstTrade.split(':')[1]))
        this.state.worstTrade = `${pair}:-$${Math.abs(p.pnlUsd)}`;
    }
    this.savePositions(); this.saveState();
    return p;
  }

  updatePrice(pair: string, price: number) {
    if (this.positions[pair]?.status === 'open') { this.positions[pair].currentPrice = price; this.savePositions(); }
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
      t.pnlUsd, t.pnlPct, t.status, t.sector, t.reason, t.aiVerdict, t.aiConfidence].join(',');
    fs.appendFileSync(TRADES_FILE,
      (header ? 'timestamp,pair,side,price,qty,cost,stop,target,pnl,pct,status,sector,reason,ai_verdict,ai_confidence\n' : '') + line + '\n');
  }

  getContextSummary(): string {
    const open = this.getOpenPositions();
    const wr = this.state.totalTrades > 0 ? ((this.state.wins / this.state.totalTrades) * 100).toFixed(0) : '0';
    const lines = [
      '=== BOT IDENTITY ===',
      `I am an AI crypto trading bot. Running since ${this.state.startedAt}.`,
      `Total trades: ${this.state.totalTrades} | Wins: ${this.state.wins} | Losses: ${this.state.losses}`,
      `Total P/L: ${fmt(this.state.totalPnl)} | Win rate: ${wr}%`,
      this.state.bestTrade ? `Best trade: ${this.state.bestTrade}` : '',
      this.state.worstTrade ? `Worst trade: ${this.state.worstTrade}` : '',
      `Cycles completed: ${this.state.cycleCount}`, '',
    ];
    if (open.length > 0) {
      lines.push(`=== CURRENT POSITIONS (${open.length}) ===`);
      for (const p of open) {
        const pnl = (p.currentPrice - p.entryPrice) * p.qty;
        const pct = ((pnl / p.costBasisUsd) * 100).toFixed(1);
        lines.push(`${p.pair}: Entry ${fmt(p.entryPrice)} | Now ${fmt(p.currentPrice)} | P/L ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${pct}%) | Stop ${fmt(p.stopLoss)} | Target ${fmt(p.takeProfit)} | ${p.sector}`);
        lines.push(`  Why: ${p.reason} | AI said: ${p.aiReasoning}`);
      }
    } else { lines.push('No open positions.'); }
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
1. RSI < 40 + neutral/bullish trend + near support = BUY candidate
2. RSI > 75 and overbought = DO NOT BUY, wait for pullback
3. Position hits stop loss = SELL immediately, no questions
4. Position hits take profit = SELL the position
5. Is the narrative/thesis still intact? If not, sell

You own position sizing. Request the percentage of the total portfolio you want to allocate.
The bot can only spend available free cash and must obey Kraken's amount, cost, and precision rules.
Any additional limits shown by the bot are optional configuration, not strategy rules.

YOUR MEMORY:
You remember all past trades, your win rate, what strategies worked. Learn from mistakes.
If a sector keeps losing money, reduce allocation.

RESPOND WITH EXACTLY THIS FORMAT (JSON only, no markdown):
{"verdict": "BUY" or "HOLD" or "SELL", "confidence": 1-10, "reasoning": "why", "position_size_pct": 0 or greater, "adjusted_stop": number or null, "adjusted_target": number or null}`;

class AiBrain {
  private client: OpenAI;
  private model: string;
  private memory: Memory;

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
      baseURL: urls[provider] || urls.openrouter,
      defaultHeaders: Object.keys(headers).length ? headers : undefined,
    });
    this.model = model;
    this.memory = memory;
    console.log(`[AI] GLM 5.2 via ${provider} (${model})`);
  }

  async analyze(pair: string, sector: string, ta: TechnicalAnalysis, vol24h: number): Promise<AiDecision> {
    return this.call(`NEW OPPORTUNITY:
${pair} (Sector: ${sector}) | Price: ${fmt(ta.currentPrice)}
24h Volume: ${fmt(vol24h)}

RSI: ${ta.rsi} (oversold<35, overbought>70)
Trend: ${ta.trend} | MA Score: ${ta.maScore}/3
SMA 5/20/50: ${ta.sma5?.toFixed(4) || 'N/A'} / ${ta.sma20?.toFixed(4) || 'N/A'} / ${ta.sma50?.toFixed(4) || 'N/A'}
Bollinger: ${fmt(ta.bollinger.upper || 0)} / ${fmt(ta.bollinger.middle || 0)} / ${fmt(ta.bollinger.lower || 0)}
Volume: ${ta.volumeRatio}x avg | StochRSI K=${ta.stochRsiK} D=${ta.stochRsiD}
Supports: ${ta.supports.join(', ') || 'none'}
Resistances: ${ta.resistances.join(', ') || 'none'}

BUY, HOLD, or AVOID?`, pair);
  }

  async review(pair: string, ta: TechnicalAnalysis): Promise<AiDecision> {
    const p = this.memory.positions[pair];
    if (!p) return { verdict: 'HOLD', confidence: 5, reasoning: 'Not found', positionSizePct: 0, adjustedStop: null, adjustedTarget: null };
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    const pct = (pnl / p.costBasisUsd) * 100;
    const days = ((Date.now() - new Date(p.openedAt).getTime()) / 86400000).toFixed(1);
    return this.call(`REVIEW POSITION:
${p.pair} (${p.sector}) | Entry ${fmt(p.entryPrice)} | Now ${fmt(ta.currentPrice)}
P/L: ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) | ${days} days held
Stop: ${fmt(p.stopLoss)} | Target: ${fmt(p.takeProfit)}

RSI: ${ta.rsi} | Trend: ${ta.trend} | MA: ${ta.maScore}/3 | Vol: ${ta.volumeRatio}x
Supports: ${ta.supports.join(', ') || 'none'} | Resistances: ${ta.resistances.join(', ') || 'none'}

Buy reason: ${p.reason}
AI reasoning at entry: ${p.aiReasoning}

HOLD, SELL, or ADJUST?`, pair);
  }

  private async call(prompt: string, pair: string): Promise<AiDecision> {
    const fallback: AiDecision = { verdict: 'HOLD', confidence: 5, reasoning: 'AI error', positionSizePct: 0, adjustedStop: null, adjustedTarget: null };
    try {
      const res = await withRetry(`AI request ${pair}`, () => this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${this.memory.getContextSummary()}\n\n${prompt}` },
        ],
        temperature: 0.2, max_tokens: 300,
      }));
      const raw = res.choices[0]?.message?.content?.trim();
      if (!raw) { console.warn(`[AI] Empty response for ${pair}`); return fallback; }
      const json = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      const d: AiDecision = {
        verdict: json.verdict?.toUpperCase() || 'HOLD',
        confidence: Math.min(10, Math.max(1, parseInt(json.confidence) || 5)),
        reasoning: json.reasoning || 'No reason',
        positionSizePct: Math.max(0, Number(json.position_size_pct) || 0),
        adjustedStop: json.adjusted_stop ? +json.adjusted_stop : null,
        adjustedTarget: json.adjusted_target ? +json.adjusted_target : null,
      };
      console.log(`  [AI] ${pair}: ${d.verdict} (${d.confidence}/10) — ${d.reasoning}`);
      this.memory.state.lastAiDecision = `${pair}:${d.verdict}:${d.confidence}`;
      this.memory.saveState();
      return d;
    } catch (e: any) {
      console.error(`  [AI] Error ${pair}: ${e.message}`);
      return fallback;
    }
  }
}

// ============================================================
// MAIN — The 4-phase loop
// ============================================================

let shutdownRequested = false;
const shutdownWaiters: Array<() => void> = [];

async function main() {
  CONFIG = loadConfig();
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
│  Limits: optional; exchange rules + cash     │
└──────────────────────────────────────────────┘`);
  console.log(`Pairs: ${ALL_PAIRS.length} | Sectors: ${Object.keys(WATCHLIST).length} | Balance: fetched from API each cycle`);
  const limit = (value: number | null, suffix = '') => value === null ? 'off' : `${value}${suffix}`;
  console.log(`[CONFIG] Mode: ${CONFIG.paperMode ? 'paper' : 'live'} | Loop: ${loopMode ? 'on' : 'single'} | Interval: ${fastMode ? '5min' : `${CONFIG.scanIntervalMs / 60000}min`}`);
  console.log(`[CONFIG] AI budget: ${CONFIG.aiDecisionsPerCycle}/cycle | Buy confidence: ${limit(CONFIG.aiConfidenceThreshold, '/10')} | Sell confidence: ${limit(CONFIG.aiSellConfidenceThreshold, '/10')} | Position risk: ${limit(CONFIG.maxRiskPerTradePct)}`);
  console.log(`[CONFIG] Exposure: ${limit(CONFIG.maxExposurePct)} | Portfolio risk: ${limit(CONFIG.maxPortfolioRiskPct)} | Min trade: ${limit(CONFIG.minTradeUsd, ' USD')} | Min R/R: ${limit(CONFIG.minRrRatio, ':1')}`);

  const exchange = new Exchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET, CONFIG.paperMode);
  const memory = new Memory();
  const ai = new AiBrain(memory);
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

async function runCycle(exchange: Exchange, mem: Memory, ai: AiBrain) {
  // ── RECONCILE LIVE BALANCE ──
  if (!exchange.paper) await exchange.reconcilePositions(mem);

  // ── FETCH REAL BALANCE ──
  const portfolioValue = await exchange.getPortfolioValue(mem);

  // ── PHASE 1: CHECK EXISTING POSITIONS ──
  console.log('\n── PHASE 1: Check positions ──');
  const open = mem.getOpenPositions();

  if (open.length > 0) {
    const prices = await exchange.getPricesBatch(open.map(p => p.pair));
    for (const [pair, price] of Object.entries(prices)) mem.updatePrice(pair, price);

    // Stop loss / take profit (non-negotiable)
    for (const alert of mem.checkStops(prices)) {
      const pos = mem.positions[alert.pair];
      if (!pos || shutdownRequested) continue;
      console.warn(`  [ALERT] ${alert.action}: ${alert.pair} — ${alert.reason}`);
      const fill = await exchange.sell(alert.pair, pos.qty);
      if (fill) {
        const closed = mem.closePosition(alert.pair, fill.price, alert.reason);
        if (closed) mem.logTrade({
          timestamp: new Date().toISOString(), pair: alert.pair, side: 'SELL',
          price: fill.price, qty: fill.qty, costBasisUsd: pos.costBasisUsd,
          stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
          pnlUsd: closed.pnlUsd ?? 0, pnlPct: closed.pnlPct ?? 0, status: 'closed',
          sector: pos.sector, reason: alert.reason, aiVerdict: 'STOP/TARGET', aiConfidence: 10,
        });
      }
    }

    // AI reviews remaining positions
    const stillOpen = mem.getOpenPositions();
    for (const pos of stillOpen) {
      try {
        const candles = await exchange.getOhlcv(pos.pair, '1h', 200);
        if (candles.length < 50) continue;
        const ta = TA.full(candles, pos.currentPrice);
        if (!ta) continue;
        const d = await ai.review(pos.pair, ta);

        if (!shutdownRequested && d.verdict === 'SELL' &&
            (CONFIG.aiSellConfidenceThreshold === null || d.confidence >= CONFIG.aiSellConfidenceThreshold)) {
          console.log(`  [AI SELL] ${pos.pair}: ${d.reasoning}`);
          const price = await exchange.getPrice(pos.pair);
          if (price) {
            const fill = await exchange.sell(pos.pair, pos.qty);
            if (fill) {
              const reason = `AI: ${d.reasoning}`;
              const closed = mem.closePosition(pos.pair, fill.price, reason);
              if (closed) mem.logTrade({
                timestamp: new Date().toISOString(), pair: pos.pair, side: 'SELL',
                price: fill.price, qty: fill.qty, costBasisUsd: pos.costBasisUsd,
                stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
                pnlUsd: closed.pnlUsd ?? 0, pnlPct: closed.pnlPct ?? 0, status: 'closed',
                sector: pos.sector, reason, aiVerdict: d.verdict, aiConfidence: d.confidence,
              });
            }
          }
        }
        if (mem.positions[pos.pair]?.status === 'open') {
          if (d.adjustedStop) { pos.stopLoss = d.adjustedStop; mem.savePositions(); console.log(`  [ADJUST] ${pos.pair} stop → ${fmt(d.adjustedStop)}`); }
          if (d.adjustedTarget) { pos.takeProfit = d.adjustedTarget; mem.savePositions(); console.log(`  [ADJUST] ${pos.pair} target → ${fmt(d.adjustedTarget)}`); }
        }
      } catch (e) {
        console.warn(`  [PHASE 1] ${pos.pair} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ── PHASE 2: SCAN FOR OPPORTUNITIES ──
  console.log('\n── PHASE 2: Scan market ──');
  const holding = new Set(mem.getOpenPositions().map(p => p.pair));
  let exposure = mem.getOpenPositions().reduce((s, p) => s + p.currentPrice * p.qty, 0);
  const canOpen = CONFIG.maxExposurePct === null || exposure < portfolioValue * CONFIG.maxExposurePct;

  if (!canOpen) console.log('  [PHASE 2] Exposure cap reached, skipping scan.');

  let aiBudget = CONFIG.aiDecisionsPerCycle;
  const candidates: Array<{ pair: string; sector: string; ta: TechnicalAnalysis; vol: number }> = [];

  for (const pair of canOpen ? ALL_PAIRS : []) {
    try {
      if (holding.has(pair)) continue;
      const price = await exchange.getPrice(pair);
      if (price === null) continue;
      const candles = await exchange.getOhlcv(pair, '1h', 200);
      if (candles.length < 50) continue;
      const ta = TA.full(candles, price);
      if (!ta) continue;

      const nearSupport = ta.supports.length > 0 && (price - ta.supports[0]) / price < 0.05;
      if (ta.rsi > 50 && !nearSupport) continue;

      const ticker = await exchange.getTicker(pair);
      candidates.push({ pair, sector: getSector(pair), ta, vol: ticker?.volume24h ?? 0 });
      console.log(`  [CANDIDATE] ${pair}: RSI=${ta.rsi} | ${ta.trend} | ${ta.volumeRatio}x vol | ${ta.supports.length} supports`);
    } catch (e) {
      console.warn(`  [PHASE 2] ${pair} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  candidates.sort((a, b) => a.ta.rsi - b.ta.rsi);

  // ── PHASE 3: AI DECISIONS ──
  console.log('\n── PHASE 3: AI analysis ──');

  for (const c of candidates) {
    if (aiBudget <= 0) break;
    const d = await ai.analyze(c.pair, c.sector, c.ta, c.vol);
    aiBudget--;

    if (d.verdict !== 'BUY' ||
        (CONFIG.aiConfidenceThreshold !== null && d.confidence < CONFIG.aiConfidenceThreshold)) {
      console.log(`  [PASS] ${c.pair}: ${d.verdict} (${d.confidence}/10)`);
      continue;
    }

    const support = c.ta.supports[0] || c.ta.bollinger.lower || c.ta.currentPrice * 0.95;
    const sl = support * 0.97;
    const tp = c.ta.resistances[0] || c.ta.currentPrice * 1.20;
    const risk = c.ta.currentPrice - sl;
    const reward = tp - c.ta.currentPrice;
    const rr = risk > 0 ? reward / risk : 0;

    if (CONFIG.minRrRatio !== null && rr < CONFIG.minRrRatio) {
      console.log(`  [PASS] ${c.pair}: R/R ${rr.toFixed(1)}:1 < ${CONFIG.minRrRatio}:1`);
      continue;
    }

    const riskPct = risk > 0 ? risk / c.ta.currentPrice : 0;
    const aiSize = portfolioValue * d.positionSizePct / 100;
    const availableCash = exchange.getAvailableCash() ?? (exchange.paper ? Math.max(0, portfolioValue - exposure) : 0);
    const exposureRoom = CONFIG.maxExposurePct === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, portfolioValue * CONFIG.maxExposurePct - exposure);
    const marketMinimum = await exchange.getMinimumTradeUsd(c.pair, c.ta.currentPrice);
    if (marketMinimum === null) continue;

    let maxAllowedSize = Math.min(availableCash, exposureRoom);
    if (CONFIG.maxRiskPerTradePct !== null && riskPct > 0)
      maxAllowedSize = Math.min(maxAllowedSize, portfolioValue * CONFIG.maxRiskPerTradePct / riskPct);
    if (CONFIG.maxPortfolioRiskPct !== null && riskPct > 0)
      maxAllowedSize = Math.min(maxAllowedSize, portfolioValue * CONFIG.maxPortfolioRiskPct / riskPct);
    const finalSize = Math.min(aiSize, maxAllowedSize);
    if (aiSize <= 0) {
      console.log(`  [PASS] ${c.pair}: AI requested zero position size`);
      continue;
    }
    if (availableCash < marketMinimum) {
      console.log(`  [PASS] ${c.pair}: exchange minimum ${fmt(marketMinimum)} exceeds available cash ${fmt(availableCash)}`);
      continue;
    }
    if (finalSize < marketMinimum) {
      console.log(`  [PASS] ${c.pair}: configured limits leave ${fmt(finalSize)}, below exchange minimum ${fmt(marketMinimum)}`);
      continue;
    }

    const sw = SECTOR_WEIGHTS[c.sector] || 0.05;
    console.log(`
  *** BUY: ${c.pair} ***
  Confidence: ${d.confidence}/10 | ${d.reasoning}
  Entry: ${fmt(c.ta.currentPrice)} | Stop: ${fmt(sl)} | Target: ${fmt(tp)}
  R/R: ${rr.toFixed(1)}:1 | Size: ${fmt(finalSize)} | Sector: ${c.sector} (${(sw * 100).toFixed(0)}%)
  `);

    if (shutdownRequested) break;
    const fill = await exchange.buy(c.pair, finalSize);
    if (fill) {
      const costBasisUsd = +(fill.qty * fill.price).toFixed(2);
      mem.openPosition(c.pair, fill.qty, fill.price, sl, tp, c.sector,
        `RSI=${c.ta.rsi} ${c.ta.trend} R/R=${rr.toFixed(1)}`, d.reasoning);
      mem.logTrade({
        timestamp: new Date().toISOString(), pair: c.pair, side: 'BUY',
        price: fill.price, qty: fill.qty, costBasisUsd, stopLoss: sl, takeProfit: tp,
        pnlUsd: 0, pnlPct: 0, status: 'open', sector: c.sector,
        reason: `RSI=${c.ta.rsi} R/R=${rr.toFixed(1)}`, aiVerdict: d.verdict, aiConfidence: d.confidence,
      });
      exposure += fill.qty * fill.price;
      holding.add(c.pair);
    }
  }

  // ── PHASE 4: SUMMARY ──
  console.log('\n── PORTFOLIO ──');
  const positions = mem.getOpenPositions();
  let totalVal = 0;
  for (const p of positions) {
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    const pct = (pnl / p.costBasisUsd) * 100;
    console.log(`  ${p.pair}: ${fmt(p.costBasisUsd)} | P/L ${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
    totalVal += p.currentPrice * p.qty;
  }
  const cash = portfolioValue - totalVal;
  console.log(`  Cash: ${fmt(cash)} | Invested: ${fmt(totalVal)} | Total: ${fmt(portfolioValue)} | Open: ${positions.length}`);
  console.log(`  P/L: ${fmt(mem.state.totalPnl)} | Win rate: ${mem.state.totalTrades > 0 ? ((mem.state.wins / mem.state.totalTrades) * 100).toFixed(0) : 0}%`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
