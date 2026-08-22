# KAI Trading GLM

AI-powered crypto trading bot with persistent memory. Uses GLM 5.2 (via OpenRouter) for trade
decisions and Kraken for market data and execution, with live mode enabled by default.

Risk is managed by the bot, not the model: stops and targets are sized from ATR, stops ratchet
upward as a trade works, and they are never widened — by the AI or by anything else.

Working on this with an AI agent? [SOUL.md](SOUL.md) is the trading model's mandate and
part of its prompt; [PLAYBOOK.md](PLAYBOOK.md) is the operator's additional trading method;
[AGENTS.md](AGENTS.md) contains rules for coding agents; [CLAUDE.md](CLAUDE.md) is the
Claude Code entry point; and [COLLAB.md](COLLAB.md) is the shared change log between Devin
and Claude Code. The complete source archive is [docs/the-crypto-playbook.md](docs/the-crypto-playbook.md).

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
- `AI_MAX_TOKENS` — AI completion token budget (default `4000`). Reasoning models spend this on thinking before emitting content, so too small a value truncates every decision; the bot doubles it automatically, up to 16000, when it detects truncation
- `AI_REASONING_EFFORT` — `off`, `low`, `medium` or `high` (default `low`); caps reasoning so the budget is left for the JSON
- `AI_BASE_URL` — optional OpenAI-compatible API base URL override; blank uses the provider's configured URL
- `SOUL_FILE` — optional path override for the trading model's charter (relative paths use the repository root); loaded once at startup and prepended to every decision prompt. Missing or unreadable files warn and leave existing prompts unchanged
- `PLAYBOOK_FILE` — optional path override for the operator's playbook (relative paths use the repository root); loaded once at startup after the charter. Missing or unreadable files warn and leave existing prompts unchanged
- `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` — required to run (Trade permission only)
- `PAPER_MODE` — `false` by default for real money; set `true` for simulated trades
- `PORTFOLIO_VALUE` — starting balance for paper mode, and the fallback when the Kraken balance is unavailable; live mode fetches portfolio value from Kraken each cycle. Paper mode tracks simulated cash from here on, so paper results compound
- `SCAN_INTERVAL_MINUTES` — scan cadence in loop mode
- `LOOP_MODE` — continuous operation by default; set `false` for one cycle
- `AI_DECISIONS_PER_CYCLE` — maximum affordable new-buy decisions per cycle (default `6`); unaffordable exchange minimums are skipped before spending a model call
- `AI_REVIEWS_PER_CYCLE` — maximum Phase 1 AI position reviews per cycle (default `5`); blank reviews all positions, ranked by stop/target urgency
- `STANCE_MAX_AGE_CYCLES` — maximum age of a saved portfolio stance in cycles (default `4`); blank disables expiry. The stance is evaluated every cycle, including when no pairs are scannable
- `MAX_EXPOSURE_PCT` — optional exposure cap as a portfolio fraction; disabled by default
- `MAX_RISK_PER_TRADE_PCT` — optional per-trade risk cap as a portfolio fraction; disabled by default
- `MAX_PORTFOLIO_RISK_PCT` — optional portfolio-risk cap as a portfolio fraction; disabled by default
- `MIN_TRADE_USD` — optional bot-level minimum order value; disabled by default
- `MIN_RR_RATIO` — optional minimum risk/reward filter; disabled by default
- `AI_CONFIDENCE_THRESHOLD` — optional AI confidence floor for buy decisions from 1–10; disabled by default
- `AI_SELL_CONFIDENCE_THRESHOLD` — optional AI confidence floor for sell decisions from 1–10; disabled by default
- `SCAN_MAX_RSI` — optional hard scan filter for RSI; disabled by default, valid range `0`–`100`
- `SCAN_UNIVERSE` — `auto` (default) discovers active Kraken spot markets quoted in USD, or `watchlist` preserves the legacy 20-pair scan
- `MIN_24H_QUOTE_VOLUME_USD` — Stage 1 24-hour USD quote-volume floor (default `$250,000`); lower-liquidity markets are dropped before TA
- `SCAN_TA_LIMIT` — maximum coarse-ranked markets receiving full TA (default `40`)
- `DAILY_MOVERS_COUNT` — liquid daily gainers and losers forced into Stage 2 (default `3` each)
- `AI_WEB_SEARCH` — enable the optional OpenRouter `:online` loser news check before a mover decision (default `true`; blank or false disables it)
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

### Review budget

`AI_REVIEWS_PER_CYCLE` caps how many open positions the AI reviews each cycle, ranked by how
close each sits to its stop or target. Trailing stops and stop/target exits still run for every
position regardless — only the AI's judgement call is budgeted.

Because that ranking is deterministic, the last slot is reserved for whichever position has gone
longest without a review. Otherwise the same low-urgency names would be skipped every cycle, and
a position that is never reviewed can never be trimmed or closed on judgement — only by its stop.

The portfolio stance is evaluated once every cycle, even when entries are blocked, every
watchlist pair is already held, or no scan produces usable data. A saved stance records its
cycle and timestamp, and the cycle counter resumes from persisted state after restarts.
`STANCE_MAX_AGE_CYCLES` prevents an old cash target from continuing to
reserve cash or create trim pressure indefinitely. Blank disables age expiry, while legacy
stances without metadata are treated as stale. Configured expiry also has a wall-clock
backstop of two times the cycle budget (`STANCE_MAX_AGE_CYCLES` multiplied by the scan
interval), allowing for a slow cycle or delayed restart without leaving a mandate active
indefinitely.

### Trading playbook context

`PLAYBOOK.md` is the operator's method, loaded once at startup and supplied after
`SOUL.md` in the per-pair decision, position-review, portfolio-stance, and related model
prompts. The charter is the standing mandate and outranks the playbook if they disagree.
The full source archive, including its tables, is kept at
`docs/the-crypto-playbook.md`; the archive is not prompt input. The playbook is context for
the model, not a hard filter or automatic trading rule.

Decision prompts also receive two model inputs: each candidate's 24-hour move relative to
the median 24-hour move across the usable Stage 1 ticker universe, and its drawdown from
the highest high in an approximately one-year fetched daily window, including the date and
age of that window high. These are labelled as ticker relative performance and a
window-high drawdown, never as an all-time high, and neither input is an automatic rule.

### Scan funnel

With `SCAN_UNIVERSE=auto`, each cycle discovers active Kraken spot markets quoted in USD,
then excludes stablecoin bases, wrapped or staked/earn-style symbols, configured exclusions,
and holdings already in the account. A single batched ticker stage drops markets below the
`MIN_24H_QUOTE_VOLUME_USD` floor and coarse-ranks the survivors using range position,
24-hour change, and volume. Full OHLCV/TA analysis and `scoreSetup` then run only on the top
`SCAN_TA_LIMIT` markets, plus the configured daily gainers and losers. `SCAN_UNIVERSE=watchlist`
retains the legacy 20-pair universe. Liquid losers may receive a separate OpenRouter
`:online` news check before their trading decision when `AI_WEB_SEARCH=true`; failed
searches are non-blocking, and a hard capability rejection disables further attempts for
the rest of the process. Decisions also receive compact same-pair history from persisted
trade records. Half of the six-decision budget is reserved for movers (losers are
considered before gainers); the remaining slots follow TA score, so a liquid crash cannot
be starved by ordinary setups.
Preflight samples held pairs and the watchlist first, then tops up from the discovered
universe, rather than taking an arbitrary slice. Known watchlist pairs receive sector
allocation guidance. Discovered pairs have no sector metadata: their prompts omit sector
targets and exposure guidance, and the optional `MAX_SECTOR_EXPOSURE_PCT` cap does not
apply to them. Reporting may still aggregate them under `unlisted`, but that bucket cannot
silently block every discovered entry.

### Positions you bought yourself

The bot distinguishes positions it opened from ones it adopted out of your exchange balance,
because it was treating the difference backwards. It sold a holding with the reasoning
*"imported position no thesis"* — reading "I did not choose this" as a reason to sell.

Positions you bought are now handled differently in three ways:

- They are **always reviewed**, regardless of the review budget. A position nobody looks at can
  only ever leave via its stop.
- The prompt states plainly that you bought it for reasons the model cannot see, and that the
  absence of a thesis on file means it lacks information, not that the position lacks merit.
  Overbought, flat, or "not my pick" are explicitly not grounds to sell.
- A proposed sell triggers a **second opinion**: a separate call that must first build the
  strongest case for *keeping* it, and only then confirm. The sell proceeds only if it survives
  being argued against on purpose. If that call fails or returns nothing usable, the position is
  kept — holding is the reversible choice.

Stops and alerts still apply to them, so nothing goes unprotected.

### Reserved assets

`EXCLUDED_ASSETS` names holdings the bot must never touch. Unlike everything else here this is
a hard boundary rather than guidance — it is about ownership, not strategy. Reserved assets are
dropped from the watchlist scan, never adopted as positions, refused at the order layer, and
excluded from the tradable value used for sizing. A position already tracked for one is
*released* rather than closed, so no fictitious exit is written to the history.

Kraken's staking names resolve to the underlying asset, so `SOL` also covers `SOL03.S` and
`AVAX` covers `AVAX.B`. Being staked is not protection by itself: unstaking would otherwise hand
the balance straight to the bot.

### Concentration

`TARGET_POSITION_COUNT` tells the model how concentrated the operator wants the book. It is
**guidance, not a cap**: every decision point — the stance, each position review, and each entry
— is told the preference, the current count, and what a full-size position works out to at that
concentration. The model may still spread wider or concentrate further if it has a reason, and
when it holds more names than preferred it is reminded that trimming the weakest is how it frees
capital to size the best ones properly.

Leave it blank for no preference. The trade-off is real in both directions: spreading a small
account thin loses a disproportionate share to fees and exchange minimums and leaves no winner
big enough to matter, while concentration raises variance — with four positions instead of nine,
a single bad one hurts more than twice as much.

### Alerts instead of automatic stop-outs

A stop that fires on its own answers "is it down?" with "then sell". Every position also
carries an **alert level** between entry and the stop: reaching it does not sell, it forces a
review so the model can ask *why* it is down and answer sell, hold, or **add**. A fall into
support with the thesis intact is not the same as a thesis breaking.

The hard stop still sits underneath and still sells — the alert is the chance to act before it
ever fires. Alerts jump the review budget, are consumed once they fire, and the model can set a
new one via `alert_price`. `ALERT_AT_R` sets the default depth (0.5R); `0` disables it and
leaves the stop alone. `ALLOW_AI_ADD_ONS` governs whether a review may add to a position.

Adding re-bases the average entry on total cost and rescales the recorded entry stop, so 1R —
which breakeven and the trail are measured in — keeps meaning what it says.

### Position size

The size the model asks for is the size it gets, bounded only by available cash and whatever
optional caps are switched on. The bot used to round an undersized request up to the exchange
minimum, which manufactured positions nobody chose — that is where a book of roughly $5
positions came from. An undersized request is now declined outright and the model is told why.

Size is steered by telling rather than fencing: the concentration guidance says what a full-size
position works out to and that tiny positions are not worth holding, and the model decides.
`MIN_TRADE_USD` exists if you want a hard gate instead, but it is unset by default.

### Checking itself

Every decision — each entry, each review, and the portfolio stance — asks the model to argue the
other side first. It states the strongest case against its own call in `counter_case`, then
either keeps the verdict or sets `verdict_holds` to false and withdraws it. A withdrawn verdict
is not traded.

Silence is not a withdrawal: a reply that omits the field stands, so the model is never overruled
by an accident of formatting, and a salvaged fragment never carries a self-check it did not make.

### Keeping exits possible

A position that has fallen under Kraken's minimum sellable size is worse than an unprotected
one: the bot reports a stop, and the order would be rejected the moment it mattered. Preflight
reports these, and the bot lifts them back over the minimum so the stop can execute.

- `TOPUP_STRANDED_POSITIONS` — enabled by default
- `TOPUP_MAX_PCT` — largest repair as a share of tradable value (default `0.05`). Past this the
  position is reported rather than bought: restoring an exit is defensive, buying a much larger
  position is not.

### Optional safety limits (disabled unless set)

These are backstops, not a leash: they bound catastrophe, and leave normal decisions to the model.

- `MAX_DAILY_LOSS_PCT` — stop opening positions once realised losses today reach this share of the portfolio
- `MAX_OPEN_POSITIONS` — ceiling on simultaneously open positions
- `MAX_SECTOR_EXPOSURE_PCT` — cap exposure to any one sector

## What the bot decides vs. what the AI decides

The AI is the decision maker. Each cycle it makes two calls:

**The stance** — one judgement on the whole book, before any individual trade is considered:

- `RISK_ON` / `NEUTRAL` / `RISK_OFF`. `RISK_OFF` means no new entries at all this cycle —
  the model can sit in cash and wait for lower prices rather than being forced to answer
  one pair at a time. Exits, stops and trailing stops keep running regardless.
- `cash_target_pct` — dry powder to hold back for a dip. The bot will not spend below it, and
  when the account is already below the target the position review is told how far short it is
  so the model can trim to get there. A cash target that could only block buying would be half
  a lever: once fully invested, selling is the only route to it.
- `requested_funds_usd` — if the opportunity is bigger than the account can fund, the model
  asks for capital. The request is logged prominently, persisted across restarts, and shown
  in every portfolio summary until that much free cash actually appears.

**The trade** — per pair: buy or not, how much of the portfolio, and its own stop and target,
which override the bot's ATR defaults. On a sell it can set `trim_pct` to close only part of a
position — taking profit while staying in a winner, or raising cash without abandoning a thesis.

The bot keeps exactly three rules, and they are about survival rather than opinion:

1. A stop further than `MAX_STOP_DISTANCE_PCT` from entry is clamped to it. One trade cannot
   cost an unbounded share of the account.
2. Once a position is open, stops only tighten. The AI can pull a stop in; nothing widens it.
3. Orders must satisfy free cash and Kraken's amount, cost and precision rules.

Everything else — how many positions, how concentrated, how aggressive, when to sit out — is
the model's call.

The AI is given real history — the last 25 closed trades, realised P/L per sector, current
exposure and this sector's target weight — so its stated memory of past trades reflects what
actually happened. For the stance call it also gets market breadth across the watchlist and
the split between free cash, tradable value and staked balances it cannot sell.

By default, the bot's self-imposed exposure, R/R, confidence, and minimum-size guardrails are **off**.
Every watchlist pair with valid technical data is ranked and may reach the AI; weak
setups should receive HOLD. The only entry constraints then are available free cash
and Kraken's market amount, cost, and precision rules. An undersized or zero requested
position is declined rather than rounded up to Kraken's minimum (see *Position size*
above). Actual filled quote cost, including fees, is deducted from buying power for later
buys in the same cycle. Set the optional variables above to re-enable a cap or scan filter.
Stop-loss and take-profit remain active exit logic. This permissive configuration can
spend most or all of a tiny account if the AI requests it; use `PAPER_MODE=true` first.

## Deployment

`Procfile` defines a continuous `worker` process running `npm start`, suitable for Railway or other Procfile-based hosts. Live mode reconciles and manages every held asset with an active Kraken `BASE/USD` spot market. In `SCAN_UNIVERSE=auto`, Phase 2 discovers active USD spot markets from Kraken, filters them by stablecoin/exclusion/holding rules and a ticker liquidity floor, then runs full TA only on the coarse top `SCAN_TA_LIMIT`; `watchlist` preserves the legacy scan. State and trade history are persisted under `DATA_DIR` (default `./data`); Railway-style ephemeral filesystems wipe that on redeploy, so either point `DATA_DIR` at a mounted volume or rely on live mode reconciling positions from the Kraken balance each cycle. Unreadable state files are backed up rather than silently discarded.

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
Phase 1 stop-loss and take-profit checks always run for every open position. When
AI reviews are budgeted, positions nearest to either exit level are reviewed first;
lower-urgency positions are logged as skipped. If a Phase 1 sell fills, the bot refreshes
its settled balance before Phase 2 so the freed quote cash can fund a same-cycle buy.

## Model choice and what it costs

`AI_MODEL` picks the model; `AI_MODEL_FALLBACK` names one to fall back to if the provider
rejects it as unknown. Set the fallback before experimenting: a mistyped or retired model id
otherwise fails every call while the bot looks healthy, answering HOLD to everything.

Every cycle reports what it spent, so comparing models is a measurement rather than a guess:

```
AI cost: 9 calls / 24,318 tokens this cycle | 137 calls / 361,204 tokens since start (z-ai/glm-5.2)
```

Preflight reports tokens per call for the model actually serving requests. Run a few cycles on
one model, note the per-cycle tokens, switch, and compare — the token counts are the provider's
own numbers, not an estimate.

## Preflight and the doctor

Unit tests prove the maths. They cannot prove the deployment can reach Kraken, parse its own
balance, or get usable JSON out of the model — so the bot checks that against the real thing
before it trades, and logs the result:

```bash
npm run doctor    # run the checks and exit
```

It verifies market coverage for every watchlist pair, candle freshness and analysability,
the account breakdown, whether free cash can fund the cheapest entry, whether every open
position can actually be sold (a position that cannot be sold has a stop that can never
execute), and how many live AI probes return a usable decision.

The same checks run at startup unless `PREFLIGHT=false`. A failure does not stop the bot:
stops and trailing exits are deterministic and keep protecting open positions even when the
model is unreachable.

## Tests

```bash
npm test
```

Four suites, no network required: indicator and risk math (`logic-check`), position and P/L
accounting (`memory-check`), AI response handling including truncation recovery (`ai-check`),
and full cycles plus preflight driven end to end against a stubbed exchange (`cycle-check`).

## Disclaimer

Trading crypto carries risk. This bot has no edge it can promise you: it is a disciplined way to
execute a strategy, not a reason to believe the strategy is profitable. Backtest and paper-trade
your own configuration before risking anything, and expect losing streaks. Use `PAPER_MODE=true`
until you have validated behavior; live mode uses real money.
