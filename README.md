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
npm run build && npm start   # compiled build
```

## Configuration

All settings live in `.env` (see `.env.example`):

- `AI_API_KEY` — OpenRouter API key (required)
- `AI_PROVIDER` / `AI_MODEL` — defaults to `openrouter` / `z-ai/glm-5.2`
- `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` — required to run (Trade permission only)
- `PAPER_MODE` — `false` by default for real money; set `true` for simulated trades
- `PORTFOLIO_VALUE` — fallback portfolio size in USD when the Kraken balance is unavailable; live mode fetches portfolio value from Kraken each cycle
- `SCAN_INTERVAL_MINUTES` — scan cadence in loop mode

## Deployment

`Procfile` defines a `worker` process running `npm start`, suitable for Railway or other Procfile-based hosts. State and trade history are persisted as JSON under `data/`.

## Disclaimer

Trading crypto carries risk. Use `PAPER_MODE=true` until you have validated behavior; live mode uses real money.
