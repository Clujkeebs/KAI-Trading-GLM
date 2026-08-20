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
interface BotState {
  startedAt: string; totalTrades: number; wins: number; losses: number;
  totalPnl: number; bestTrade: string; worstTrade: string;
  lastScan: string; lastAiDecision: string; cycleCount: number;
}

// --- CONFIG ---

const PAPER_MODE = process.env.PAPER_MODE === 'true';
const FALLBACK_PORTFOLIO_VALUE = parseFloat(process.env.PORTFOLIO_VALUE || '200');
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MINUTES || '30') * 60 * 1000;
const MAX_POSITIONS = 10;
const MAX_EXPOSURE_PCT = 0.85;
const MAX_RISK_PER_TRADE = 0.02;
const MIN_RR_RATIO = 2.0;
const MIN_TRADE_USD = 5;
const AI_CONFIDENCE_THRESHOLD = 6;

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
const fmt = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;

function getSector(pair: string): string {
  for (const [sector, pairs] of Object.entries(WATCHLIST)) {
    if (pairs.includes(pair)) return sector;
  }
  return 'unknown';
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
    try { const t = await this.ex.fetchTicker(pair); return t.last ?? t.close ?? null; }
    catch { return null; }
  }

  async getTicker(pair: string): Promise<{ price: number; volume24h: number } | null> {
    try {
      const t = await this.ex.fetchTicker(pair);
      return { price: t.last ?? t.close ?? 0, volume24h: t.quoteVolume ?? t.baseVolume ?? 0 };
    } catch { return null; }
  }

  async getOhlcv(pair: string, tf = '1h', limit = 200): Promise<OhlcvCandle[]> {
    try {
      const raw = await this.ex.fetchOHLCV(pair, tf, undefined, limit);
      return raw.map((c: any) => ({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
    } catch { return []; }
  }

  async getPricesBatch(pairs: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of pairs) { const pr = await this.getPrice(p); if (pr !== null) out[p] = pr; await sleep(250); }
    return out;
  }

  async buy(pair: string, usd: number): Promise<boolean> {
    try {
      const price = await this.getPrice(pair);
      if (!price) return false;
      const qty = usd / price;
      if (this.paper) {
        console.log(`  [PAPER BUY] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(usd)}`);
        return true;
      }
      await this.ex.createMarketBuyOrder(pair, qty);
      console.log(`  [LIVE BUY] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(usd)}`);
      return true;
    } catch (e: any) { console.error(`  [BUY FAIL] ${pair}: ${e.message}`); return false; }
  }

  async sell(pair: string, qty: number): Promise<boolean> {
    try {
      const price = await this.getPrice(pair);
      if (!price) return false;
      if (this.paper) {
        console.log(`  [PAPER SELL] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(qty * price)}`);
        return true;
      }
      await this.ex.createMarketSellOrder(pair, qty);
      console.log(`  [LIVE SELL] ${qty.toFixed(6)} ${pair} @ ${fmt(price)} = ${fmt(qty * price)}`);
      return true;
    } catch (e: any) { console.error(`  [SELL FAIL] ${pair}: ${e.message}`); return false; }
  }

  /**
   * Get total portfolio value in USD.
   * LIVE: fetches real USD + ZUSD balance from Kraken API.
   * PAPER: calculates from memory (invested + remaining cash).
   */
  async getPortfolioValue(mem: Memory): Promise<number> {
    try {
      if (!this.paper) {
        // Live mode: ask Kraken for real balance
        const balance = await this.ex.fetchBalance();
        // Kraken returns USD as 'USD' or 'ZUSD'
        const usd = (balance['USD']?.free || 0) + (balance['ZUSD']?.free || 0);
        // Also add market value of any crypto holdings
        let cryptoValue = 0;
        for (const pos of mem.getOpenPositions()) {
          const coin = pos.pair.replace('/USD', '');
          const holdings = (balance[coin]?.total || 0);
          if (holdings > 0) cryptoValue += holdings * pos.currentPrice;
        }
        const total = usd + cryptoValue;
        console.log(`  [BALANCE] API: ${fmt(usd)} cash + ${fmt(cryptoValue)} crypto = ${fmt(total)}`);
        return total > 0 ? total : FALLBACK_PORTFOLIO_VALUE;
      }
    } catch (e: any) {
      console.warn(`  [BALANCE] API call failed (${e.message}), using calculated value`);
    }
    // Paper mode (or API fallback): calculate from memory
    const invested = mem.getOpenPositions().reduce((s, p) => s + p.costBasisUsd, 0);
    const cash = FALLBACK_PORTFOLIO_VALUE - invested;
    console.log(`  [BALANCE] Paper: ${fmt(cash)} cash + ${fmt(invested)} invested = ${fmt(FALLBACK_PORTFOLIO_VALUE)}`);
    return FALLBACK_PORTFOLIO_VALUE;
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

  savePositions() { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(this.positions, null, 2)); }
  saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2)); }

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
- Your strategy: find oversold coins with strong fundamentals and 2:1+ risk/reward
- Buy near support, sell at resistance. Cut losers fast, let winners run
- Focus sectors (priority): AI tokens, RWA tokenization, DeFi blue chips, L1 infrastructure, DePIN, meme momentum
- You hold 3-7 days typically. NOT a day trader
- Max 10 positions, max 85% exposure, 2% risk per trade

YOUR DECISION FRAMEWORK:
1. RSI < 40 + neutral/bullish trend + near support = BUY candidate
2. RSI > 75 and overbought = DO NOT BUY, wait for pullback
3. Position hits stop loss = SELL immediately, no questions
4. Position hits take profit = SELL 50%, move stop to breakeven on rest
5. Is the narrative/thesis still intact? If not, sell

YOUR MEMORY:
You remember all past trades, your win rate, what strategies worked. Learn from mistakes.
If a sector keeps losing money, reduce allocation.

RESPOND WITH EXACTLY THIS FORMAT (JSON only, no markdown):
{"verdict": "BUY" or "HOLD" or "SELL", "confidence": 1-10, "reasoning": "why", "position_size_pct": 0-12, "adjusted_stop": number or null, "adjusted_target": number or null}`;

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
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${this.memory.getContextSummary()}\n\n${prompt}` },
        ],
        temperature: 0.2, max_tokens: 300,
      });
      const raw = res.choices[0]?.message?.content?.trim();
      if (!raw) { console.warn(`[AI] Empty response for ${pair}`); return fallback; }
      const json = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      const d: AiDecision = {
        verdict: json.verdict?.toUpperCase() || 'HOLD',
        confidence: Math.min(10, Math.max(1, parseInt(json.confidence) || 5)),
        reasoning: json.reasoning || 'No reason',
        positionSizePct: Math.min(12, Math.max(0, parseFloat(json.position_size_pct) || 0)),
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

async function main() {
  const loopMode = process.argv.includes('--loop');
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
│  Exchange: Kraken (${PAPER_MODE ? 'PAPER' : 'LIVE'})              │
│  Strategy: AI-Powered Oversold Bounce        │
│  Risk: 2%/trade | 85% max | 2:1 min R/R     │
└──────────────────────────────────────────────┘`);
  console.log(`Pairs: ${ALL_PAIRS.length} | Sectors: ${Object.keys(WATCHLIST).length} | Balance: fetched from API each cycle`);
  console.log(`AI threshold: ${AI_CONFIDENCE_THRESHOLD}/10 | Loop: ${loopMode ? 'ON' : 'single'} | Interval: ${fastMode ? '5min' : `${SCAN_INTERVAL / 60000}min`}`);

  const exchange = new Exchange(process.env.KRAKEN_API_KEY, process.env.KRAKEN_API_SECRET, PAPER_MODE);
  const memory = new Memory();
  const ai = new AiBrain(memory);

  let cycle = 0;
  while (true) {
    cycle++;
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  CYCLE #${cycle} | ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(50)}`);

    try { await runCycle(exchange, memory, ai); }
    catch (e: any) { console.error(`[CYCLE ERROR] ${e.message}`); }

    memory.state.cycleCount = cycle;
    memory.state.lastScan = new Date().toISOString();
    memory.saveState();

    if (!loopMode) break;
    const interval = fastMode ? 300_000 : SCAN_INTERVAL;
    console.log(`\nNext cycle in ${interval / 60000}min... (Ctrl+C to stop)`);
    await sleep(interval);
  }
}

async function runCycle(exchange: Exchange, mem: Memory, ai: AiBrain) {
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
      console.warn(`  [ALERT] ${alert.action}: ${alert.pair} — ${alert.reason}`);
      const ok = await exchange.sell(alert.pair, pos.qty);
      if (ok) {
        const closed = mem.closePosition(alert.pair, prices[alert.pair], alert.reason);
        if (closed) mem.logTrade({
          timestamp: new Date().toISOString(), pair: alert.pair, side: 'SELL',
          price: prices[alert.pair], qty: pos.qty, costBasisUsd: pos.costBasisUsd,
          stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
          pnlUsd: closed.pnlUsd ?? 0, pnlPct: closed.pnlPct ?? 0, status: 'closed',
          sector: pos.sector, reason: alert.reason, aiVerdict: 'STOP/TARGET', aiConfidence: 10,
        });
      }
    }

    // AI reviews remaining positions
    const stillOpen = mem.getOpenPositions();
    for (const pos of stillOpen) {
      const candles = await exchange.getOhlcv(pos.pair, '1h', 200);
      if (candles.length < 50) continue;
      const ta = TA.full(candles, pos.currentPrice);
      if (!ta) continue;
      const d = await ai.review(pos.pair, ta);

      if (d.verdict === 'SELL' && d.confidence >= 7) {
        console.log(`  [AI SELL] ${pos.pair}: ${d.reasoning}`);
        const price = await exchange.getPrice(pos.pair);
        if (price) {
          await exchange.sell(pos.pair, pos.qty);
          mem.closePosition(pos.pair, price, `AI: ${d.reasoning}`);
        }
      }
      if (d.adjustedStop) { pos.stopLoss = d.adjustedStop; mem.savePositions(); console.log(`  [ADJUST] ${pos.pair} stop → ${fmt(d.adjustedStop)}`); }
      if (d.adjustedTarget) { pos.takeProfit = d.adjustedTarget; mem.savePositions(); console.log(`  [ADJUST] ${pos.pair} target → ${fmt(d.adjustedTarget)}`); }
    }
  }

  // ── PHASE 2: SCAN FOR OPPORTUNITIES ──
  console.log('\n── PHASE 2: Scan market ──');
  const holding = new Set(mem.getOpenPositions().map(p => p.pair));
  const exposure = mem.getOpenPositions().reduce((s, p) => s + p.costBasisUsd, 0);
  const canOpen = mem.getOpenPositions().length < MAX_POSITIONS && exposure < portfolioValue * MAX_EXPOSURE_PCT;

  if (!canOpen) { console.log('  Max positions/exposure reached, skipping scan.'); return; }

  let aiBudget = 3;
  const candidates: Array<{ pair: string; sector: string; ta: TechnicalAnalysis; vol: number }> = [];

  for (const pair of ALL_PAIRS) {
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
  }

  candidates.sort((a, b) => a.ta.rsi - b.ta.rsi);

  // ── PHASE 3: AI DECISIONS ──
  console.log('\n── PHASE 3: AI analysis ──');

  for (const c of candidates) {
    if (aiBudget <= 0 || mem.getOpenPositions().length >= MAX_POSITIONS) break;
    const d = await ai.analyze(c.pair, c.sector, c.ta, c.vol);
    aiBudget--;

    if (d.verdict !== 'BUY' || d.confidence < AI_CONFIDENCE_THRESHOLD) {
      console.log(`  [PASS] ${c.pair}: ${d.verdict} (${d.confidence}/10)`);
      continue;
    }

    const support = c.ta.supports[0] || c.ta.bollinger.lower || c.ta.currentPrice * 0.95;
    const sl = support * 0.97;
    const tp = c.ta.resistances[0] || c.ta.currentPrice * 1.20;
    const risk = c.ta.currentPrice - sl;
    const reward = tp - c.ta.currentPrice;
    const rr = risk > 0 ? reward / risk : 0;

    if (rr < MIN_RR_RATIO) { console.log(`  [PASS] ${c.pair}: R/R ${rr.toFixed(1)}:1 < ${MIN_RR_RATIO}:1`); continue; }

    const riskUsd = portfolioValue * MAX_RISK_PER_TRADE;
    const sizeByRisk = risk > 0 ? riskUsd / risk : 0;
    const sizeByAi = portfolioValue * (d.positionSizePct / 100 || 0.10);
    const finalSize = Math.min(sizeByRisk, sizeByAi);

    if (finalSize < MIN_TRADE_USD) { console.log(`  [PASS] ${c.pair}: size ${fmt(finalSize)} < min`); continue; }

    const sw = SECTOR_WEIGHTS[c.sector] || 0.05;
    console.log(`
  *** BUY: ${c.pair} ***
  Confidence: ${d.confidence}/10 | ${d.reasoning}
  Entry: ${fmt(c.ta.currentPrice)} | Stop: ${fmt(sl)} | Target: ${fmt(tp)}
  R/R: ${rr.toFixed(1)}:1 | Size: ${fmt(finalSize)} | Sector: ${c.sector} (${(sw * 100).toFixed(0)}%)
  `);

    const ok = await exchange.buy(c.pair, finalSize);
    if (ok) {
      const qty = finalSize / c.ta.currentPrice;
      mem.openPosition(c.pair, qty, c.ta.currentPrice, sl, tp, c.sector,
        `RSI=${c.ta.rsi} ${c.ta.trend} R/R=${rr.toFixed(1)}`, d.reasoning);
      mem.logTrade({
        timestamp: new Date().toISOString(), pair: c.pair, side: 'BUY',
        price: c.ta.currentPrice, qty, costBasisUsd: finalSize, stopLoss: sl, takeProfit: tp,
        pnlUsd: 0, pnlPct: 0, status: 'open', sector: c.sector,
        reason: `RSI=${c.ta.rsi} R/R=${rr.toFixed(1)}`, aiVerdict: d.verdict, aiConfidence: d.confidence,
      });
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
    totalVal += p.costBasisUsd;
  }
  const cash = portfolioValue - totalVal;
  console.log(`  Cash: ${fmt(cash)} | Invested: ${fmt(totalVal)} | Total: ${fmt(portfolioValue)} | Open: ${positions.length}/${MAX_POSITIONS}`);
  console.log(`  P/L: ${fmt(mem.state.totalPnl)} | Win rate: ${mem.state.totalTrades > 0 ? ((mem.state.wins / mem.state.totalTrades) * 100).toFixed(0) : 0}%`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
