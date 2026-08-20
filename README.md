# KAI Trading GLM

AI-powered crypto trading bot with persistent memory. Uses GLM 5.2 (via OpenRouter) for trade decisions and Kraken for market data and execution, with live mode enabled by default.

## Setup

```bash
npm install
cp .env.example .env   # fill in AI_API_KEY and required Kraken keys
```

## Run

```bash
npm run dev        # single scan cycle
npm run dev:loop   # continuous loop on SCAN_INTERVAL_MINUTES
npm run build && npm start   # compiled worker, continuous by default
```

Use `LOOP_MODE=false` or `--once` for a single compiled/local cycle.

## Configuration

All settings live in `.env` (see `.env.example`):

- `AI_API_KEY` — OpenRouter API key (required)
- `AI_PROVIDER` / `AI_MODEL` — defaults to `openrouter` / `z-ai/glm-5.2`
- `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` — required to run (Trade permission only)
- `PAPER_MODE` — `false` by default for real money; set `true` for simulated trades
- `PORTFOLIO_VALUE` — fallback portfolio size in USD when the Kraken balance is unavailable; live mode fetches portfolio value from Kraken each cycle
- `SCAN_INTERVAL_MINUTES` — scan cadence in loop mode
- `LOOP_MODE` — continuous operation by default; set `false` for one cycle
- `AI_DECISIONS_PER_CYCLE` — maximum new-buy decisions per cycle (default `3`)
- `MAX_EXPOSURE_PCT` — optional exposure cap as a portfolio fraction; disabled by default
- `MAX_RISK_PER_TRADE_PCT` — optional per-trade risk cap as a portfolio fraction; disabled by default
- `MAX_PORTFOLIO_RISK_PCT` — optional portfolio-risk cap as a portfolio fraction; disabled by default
- `MIN_TRADE_USD` — optional bot-level minimum order value; disabled by default
- `MIN_RR_RATIO` — optional minimum risk/reward filter; disabled by default
- `AI_CONFIDENCE_THRESHOLD` — optional AI confidence floor for buy decisions from 1–10; disabled by default
- `AI_SELL_CONFIDENCE_THRESHOLD` — optional AI confidence floor for sell decisions from 1–10; disabled by default

The AI owns position sizing and requests a portfolio percentage. By default, the bot's
self-imposed risk, exposure, R/R, confidence, and minimum-size guardrails are **off**.
The only entry constraints then are available free cash and Kraken's market amount,
cost, and precision rules. Set the optional variables above to re-enable a cap.
Stop-loss and take-profit remain active exit logic. This permissive configuration can
spend most or all of a tiny account if the AI requests it; use `PAPER_MODE=true` first.

## Deployment

`Procfile` defines a continuous `worker` process running `npm start`, suitable for Railway or other Procfile-based hosts. Live mode reconciles and manages every held asset with an active Kraken `BASE/USD` spot market, while Phase 2 new-buy scanning remains limited to the watchlist. State and trade history are persisted as JSON under `data/`; Railway-style ephemeral filesystems can wipe that state, so live mode reconciles positions from the Kraken balance each cycle.

Exchange and AI calls use bounded retries with backoff. The worker handles SIGINT/SIGTERM,
finishes the current operation, atomically flushes state, and stops between cycles.

## Disclaimer

Trading crypto carries risk. Use `PAPER_MODE=true` until you have validated behavior; live mode uses real money.
