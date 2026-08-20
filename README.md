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
- `MAX_PORTFOLIO_RISK_PCT` — risk ceiling for minimum-sized trades (default `0.05`)

## Deployment

`Procfile` defines a continuous `worker` process running `npm start`, suitable for Railway or other Procfile-based hosts. Live mode reconciles and manages every held asset with an active Kraken `BASE/USD` spot market, while Phase 2 new-buy scanning remains limited to the watchlist. State and trade history are persisted as JSON under `data/`; Railway-style ephemeral filesystems can wipe that state, so live mode reconciles positions from the Kraken balance each cycle.

## Disclaimer

Trading crypto carries risk. Use `PAPER_MODE=true` until you have validated behavior; live mode uses real money.
