# KAI Trading GLM

AI-powered crypto trading bot with persistent memory. Uses GLM 5.2 (via OpenRouter) for trade
decisions and Kraken for market data and execution, with live mode enabled by default.

Risk is managed by the bot, not the model: stops and targets are sized from ATR, stops ratchet
upward as a trade works, and they are never widened — by the AI or by anything else.

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
- `AI_MAX_TOKENS` — AI completion/reasoning token budget (default `1500`, positive integer)
- `AI_BASE_URL` — optional OpenAI-compatible API base URL override; blank uses the provider's configured URL
- `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` — required to run (Trade permission only)
- `PAPER_MODE` — `false` by default for real money; set `true` for simulated trades
- `PORTFOLIO_VALUE` — starting balance for paper mode, and the fallback when the Kraken balance is unavailable; live mode fetches portfolio value from Kraken each cycle. Paper mode tracks simulated cash from here on, so paper results compound
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
- `SCAN_MAX_RSI` — optional hard scan filter for RSI; disabled by default, valid range `0`–`100`
- `FEE_RESERVE_PCT` — cash reserved for buy fees (default `0.01`, or 1%)
- `DATA_DIR` — where positions, state and trade history live (default `./data`)
- `OHLCV_CONCURRENCY` — parallel market-data requests per cycle (default `4`)

### Risk model (active by default)

Stops and targets are derived from ATR, so a pair that routinely swings 8% a day gets a wider
stop than one that swings 1%, instead of both getting the same flat percentage.

- `ATR_STOP_MULT` — stop distance in ATR multiples (default `2`)
- `ATR_TARGET_MULT` — target distance in ATR multiples (default `4`)
- `MAX_STOP_DISTANCE_PCT` — hard cap on stop distance from entry (default `0.15`)
- `TRAILING_STOP_ATR_MULT` — trail this many ATR below the highest price seen (default `2.5`, `0` disables)
- `BREAKEVEN_AT_R` — move the stop to breakeven once up this many R (default `1`, `0` disables)

The stop is placed at whichever is safer of "just under the nearest support" and
"`ATR_STOP_MULT` ATR below price", then capped by `MAX_STOP_DISTANCE_PCT`. The target is the
nearest resistance when that is at least 1.5R away, otherwise the ATR target. The trail stays
parked until the trade reaches `BREAKEVEN_AT_R`, so it never overrides the entry stop; after
that it only ever tightens.

### Optional safety limits (disabled unless set)

- `MAX_DAILY_LOSS_PCT` — stop opening positions once realised losses today reach this share of the portfolio
- `MAX_OPEN_POSITIONS` — ceiling on simultaneously open positions
- `MAX_SECTOR_EXPOSURE_PCT` — cap exposure to any one sector

## What the bot decides vs. what the AI decides

The AI owns *selection and sizing*: whether to buy, and what share of the portfolio to request.
The bot owns *risk*: where the stop goes, where the target goes, when the stop ratchets up, and
what the exchange will actually accept. The AI can tighten a stop; it cannot widen one.

The AI is given real history — the last 25 closed trades, realised P/L per sector, current
exposure and this sector's target weight — so its stated memory of past trades reflects what
actually happened.

By default, the bot's self-imposed exposure, R/R, confidence, and minimum-size guardrails are **off**.
Every watchlist pair with valid technical data is ranked and may reach the AI; weak
setups should receive HOLD. The only entry constraints then are available free cash
and Kraken's market amount, cost, and precision rules. If the AI requests an undersized
or zero position percentage, the bot raises it to Kraken's minimum order value when
free cash covers that minimum; on a tiny account, this can make one order a large
share of the portfolio. Actual filled quote cost, including fees, is deducted from
buying power for later buys in the same cycle. Set the optional variables above to
re-enable a cap or scan filter.
Stop-loss and take-profit remain active exit logic. This permissive configuration can
spend most or all of a tiny account if the AI requests it; use `PAPER_MODE=true` first.

## Deployment

`Procfile` defines a continuous `worker` process running `npm start`, suitable for Railway or other Procfile-based hosts. Live mode reconciles and manages every held asset with an active Kraken `BASE/USD` spot market, while Phase 2 new-buy scanning remains limited to the watchlist. State and trade history are persisted under `DATA_DIR` (default `./data`); Railway-style ephemeral filesystems wipe that on redeploy, so either point `DATA_DIR` at a mounted volume or rely on live mode reconciling positions from the Kraken balance each cycle. Unreadable state files are backed up rather than silently discarded.

Market data is fetched with bounded concurrency; ccxt's rate limiter still serialises the
requests. Errors that cannot succeed on a retry — bad credentials, rejected orders, unknown
symbols, any other 4xx besides 408 and 429 — fail immediately instead of burning attempts.

Orders are placed against a freshly fetched price, then polled until the exchange reports a
terminal state, so cost basis comes from the real fill rather than the requested quantity. A
partial exit keeps the position open with the residual quantity and books the sold share's P/L
straight away.

Indicators are computed on closed candles only, so nothing repaints between cycles.

Exchange and AI calls use bounded retries with backoff. The worker handles SIGINT/SIGTERM,
finishes the current operation, atomically flushes state, and stops between cycles.
AI responses request JSON object output, tolerate surrounding markdown and truncated
payloads, and retry once with a corrective JSON-only instruction before falling back to
HOLD. Truncated responses never supply stop or target adjustments.

## Tests

```bash
npm test
```

Three suites, no network required: indicator and risk math (`logic-check`), position and P/L
accounting (`memory-check`), and a full cycle driven end to end against a stubbed exchange
(`cycle-check`).

## Disclaimer

Trading crypto carries risk. This bot has no edge it can promise you: it is a disciplined way to
execute a strategy, not a reason to believe the strategy is profitable. Backtest and paper-trade
your own configuration before risking anything, and expect losing streaks. Use `PAPER_MODE=true`
until you have validated behavior; live mode uses real money.
