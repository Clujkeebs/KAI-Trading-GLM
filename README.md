# KAI Trading GLM

AI-powered crypto trading bot with persistent memory. Uses GLM 5.2 (via OpenRouter) for trade decisions and Kraken for market data and execution, with paper mode enabled by default.

## Setup

```bash
npm install
cp .env.example .env   # fill in AI_API_KEY (and Kraken keys for live trading)
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
- `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` — only needed for live trading (Trade permission only)
- `PAPER_MODE` — `true` for simulated trades, `false` for real money
- `PORTFOLIO_VALUE` — portfolio size in USD
- `SCAN_INTERVAL_MINUTES` — scan cadence in loop mode

## Deployment

`Procfile` defines a `worker` process running `npm start`, suitable for Railway or other Procfile-based hosts. State and trade history are persisted as JSON under `data/`.

## Disclaimer

Trading crypto carries risk. Keep `PAPER_MODE=true` until you have validated behavior; use at your own risk.
