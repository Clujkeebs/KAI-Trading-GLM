# COLLAB.md — shared log between Devin and Claude Code

Two agents write code in this repo, sometimes at the same time, and neither sees the
other's chat. This file is how we stay on the same page. Read it before you start; append
to it before you finish.

Be generous with each other: assume the other agent had a reason, ask in writing rather
than reverting silently, and leave the repo in a state the other can pick up cold.

## Rules

1. **Read the newest entries first.** They tell you what just changed and what is in
   flight, which is usually why the code does not look like you expect.
2. **Append, never rewrite** someone else's entry. Newest entry goes at the top of the log.
3. **Log before you push**, in the same commit as the change where possible.
4. **Never silently revert or rewrite the other agent's work.** If you think it is wrong,
   say so in an entry — what you think is broken, what you did about it — and keep the
   behaviour unless it is actively losing money or unsafe.
5. **Pull before you start and merge, do not force.** We have both pushed to `main` within
   minutes of each other. `git pull` and merge; never force-push, never reset shared history.
6. **Flag anything unverified.** Say plainly what you could not test (live Kraken orders,
   real model responses) so the other agent does not treat it as proven.
7. **One source of truth per fact.** If you change behaviour, update `README.md` in the
   same commit. If prompts or the trader's mandate change, that is `SOUL.md`.

## Entry format

```
### YYYY-MM-DD — <agent> — <short title>
**Changed:** what actually changed, in behaviour terms.
**Why:** the cause or the ask, not the diff.
**Verified:** what you ran, and what stayed unverified.
**Watch out:** anything the other agent would trip over.
```

---

## Log

### 2026-08-22 — Claude — Stop trimming positions at a loss to fund a new idea

**Changed:** Three prompt-guidance edits, no new code gate:
- `concentrationNote()`'s "holding more names than preferred" line now says "weakest means
  lowest conviction, not automatically a loser," and explicitly: don't sell at a loss to fund a
  different idea, a loss gets realised only because its own thesis broke.
- The `CASH TARGET` note in Phase 1 reviews (told when the account is short of the stance's
  self-set cash target) previously said "selling is the only way to close that gap" with no
  caveat. Now: selling only helps if the position is flat or in profit; a position at a loss is
  not a source of cash, and falling short of the target (or asking for funds, or waiting) beats
  manufacturing a loss to hit it.
- `SOUL.md`'s "Trim to fund" bullet gained the same caveat directly in the charter.
**Why:** Direct operator complaint: "I am buying good things... managing and finding net
invest[ments] means it is just selling my investment for a loss when I buy good things. I need
it to find things to buy." Traced to the cash-target and concentration-trim prompts, which
pushed toward selling *any* position — including operator-bought ones — to fund reallocation,
with no distinction between a flat/winning trim and realising a loss. The existing
`reconsiderSell()` second opinion (tuned in an earlier entry today) still applies on top of
this for operator-bought positions specifically; this fix addresses the root prompt that was
proposing the loss-realizing sell/trim in the first place, for bot-owned positions too.
**Verified:** `npm run build` and `npm test` clean; no test asserts the changed prompt strings
verbatim (same as the earlier `reconsiderSell()` wording change), since this is AI judgment
guidance, not new deterministic code — the existing `trim`/`cycle` test suites (which use a
fake AI that ignores prompt content) still pass unchanged.
**Watch out:** This is guidance, not a gate — deliberately, per the operator's own earlier
explicit instruction against hard rules on trading judgment. It has not been observed against
a real cash-target-shortfall cycle with a losing position in play; watch real logs for a
`[CASH TARGET]`/trim on a position that's underwater to confirm the model actually follows it.

### 2026-08-22 — Claude — Trade-ledger export + portfolio correlation note

**Changed:** Continuing the "what's missing" pass:
- `Memory.readTradesCsv()` reads the full `trades.csv` (every fill this process has ever
  logged, not just the bounded in-memory `recentTrades`). Dashboard route `GET
  /export/trades.csv` (same auth, `Content-Disposition: attachment`) and a link under "Recent
  closes"; CLI `npm run cli -- export` writes it to stdout for `> trades.csv`.
- New pure functions `dailyReturns()`, `correlateReturns()` (Pearson, needs 10+ overlapping
  days, null on zero variance), and `portfolioCorrelationNote()` — reports the single most
  correlated (or most inversely correlated) pair among open positions when |correlation| clears
  0.6, otherwise nothing. Wired into `reviewPortfolio()`'s prompt as a new optional 5th
  parameter. Deliberately reads only whatever daily candle history is already in
  `dailyWindowCache` from Phase 1's reviews this cycle (or a prior one, within its 6h
  freshness window) — never triggers its own fetch, so it costs nothing extra and just says
  less on a cycle with less cached history. Informational only, same as the spread context
  from the last entry: nothing caps or blocks holding two correlated positions.
**Why:** Continuing the operator's "top 10 things this bot doesn't have" ask from earlier
today; a downloadable trade ledger (tax/accounting) and correlation awareness were both on
that list.
**Verified:** `npm run build` and `npm test` clean, including new coverage: `logic-check.ts`
(`dailyReturns` correctness, `correlateReturns` on perfectly-correlated/-anticorrelated/
too-short/zero-variance series, `portfolioCorrelationNote` picking the right pair out of three
and respecting a threshold), `memory-check.ts` (`readTradesCsv()` empty-before-any-trade,
matches the file on disk, survives a restart), `dashboard-check.ts` (export route auth-gated,
correct content-type/disposition/body). Manually smoke-tested `src/cli.ts export` end to end
against a throwaway local dashboard.
**Watch out:** The correlation note has never fired against real cached daily candles in
production — it depends on `dailyWindowCache` already holding 2+ open positions' daily
history, which needs at least two positions to have gone through a Phase 1 review recently.

### 2026-08-22 — Claude — Equity/drawdown, spread context, webhooks, kill switch

**Changed:** Several additions from a "what's the bot missing" pass:
- `Memory.recordAccountSnapshot()` now also appends to a bounded `equityHistory` (2000 points,
  ~20 days at the default interval); new `maxDrawdown()`/`Memory.maxDrawdownPct()` compute the
  largest peak-to-trough decline. The dashboard renders it as an inline-SVG sparkline plus a
  stat tile.
- `ScanTicker` gained `spreadPct` (bid/ask spread as a fraction of price), computed in a new
  exported `tickerFromRawTicker()` (the old private `Exchange.tickerFromRaw` now delegates to
  it). It reaches the AI's BUY prompt as an informational line next to volume — guidance, not a
  gate; nothing in code refuses a wide-spread pair.
- New `notifyWebhook(event, text)`: a generic opt-in POST (`{text, content, event, at}`, so
  Slack/Discord/ntfy/custom receivers all work off one `WEBHOOK_URL`) on a new funding request,
  the daily-loss breaker tripping (deduped to once per UTC day via a module-level
  `dailyLossNotifiedDay`), a critical preflight failure, and the kill switch firing. Failures
  are logged and swallowed — never load-bearing for a cycle.
- A kill switch: `Memory.triggerKillSwitch(reason)` sets `tradingPaused`, `pauseReason`, and a
  one-shot `flattenRequested` flag (all persisted). `runCycle()` consumes the flatten flag right
  after the account snapshot, before Phase 1, selling every open position via the existing
  `executeExit()`; `tradingPaused` becomes a new Phase-2 blocker (existing stops/exits are never
  affected — only new entries are blocked). `resumeTrading()` clears the pause without reopening
  anything. Reachable from the dashboard (`POST /kill-switch` needs an exact `confirm=FLATTEN`
  body field — a click alone can't fire it — plus `POST /resume`) and from the CLI (`npm run
  cli -- kill|resume`, single-prompt confirmation).
- `AI_MODEL`'s code default changed from `z-ai/glm-5.2` to `z-ai/glm-5-turbo` to match what was
  already set on Railway, so the code and `.env.example` stop disagreeing with the live config.
- Tuned the operator-position protection per direct operator feedback ("respect my positions
  but not too much... I need it to manage my positions and portfolio"): `reconsiderSell()`'s
  prompt previously said "if the case for holding is even close, hold," which tilted every close
  call toward never selling. Replaced with: decide honestly, manage it like any other position
  (hold/sell/add), the second opinion raises the bar on the *reason* to sell rather than biasing
  the outcome. Mirrored the same clarification into `SOUL.md`'s "Who you work for" section.
**Why:** Operator asked for a "top 10 things this bot doesn't have" pass, memorable dashboard
credentials (set directly: username `kai`), a max login-attempt limit (separate entry below),
and then separately flagged that operator-bought positions were being protected too heavily
and that `AI_MODEL`'s code default was stale.
**Verified:** `npm run build` and `npm test` clean throughout, including new coverage in
`test/logic-check.ts` (ticker spread parsing incl. crossed-book rejection, `maxDrawdown`,
`notifyWebhook` against a real local `http.Server` — success, blank-URL no-op, and an
unreachable endpoint not throwing), `test/memory-check.ts` (`recordStance`'s new-request
detection, equity history bounding/restart survival, kill-switch/resume state persistence),
`test/dashboard-check.ts` (sparkline/drawdown rendering, kill-switch confirmation exactness,
paused-state UI), and a full `test/cycle-check.ts` integration scenario (two open positions,
`triggerKillSwitch`, a `BUY`-verdict AI that must still open nothing, both positions closed,
flag consumed once, pause persists until `resumeTrading()`). Also manually smoke-tested
`src/cli.ts kill`/`resume` end to end against a throwaway local dashboard and, doing so, found
and fixed a real bug: a second sequential `rl.question()` never resolves once piped/non-TTY
stdin has hit EOF, silently dropping the confirmation — collapsed to one prompt instead.
**Watch out:** `WEBHOOK_URL` is not set on the live deploy (nothing was configured); the kill
switch and the reconsiderSell prompt change are new behavior on a live-money bot, not yet
observed against a real production cycle or a real sell decision.

### 2026-08-22 — Claude — Dashboard login lockout

**Changed:** `src/dashboard.ts` now locks an address out after `DASHBOARD_MAX_LOGIN_ATTEMPTS`
(default 8) failed logins within `DASHBOARD_LOCKOUT_MINUTES` (default 15): further requests
get `429` with a `Retry-After` header, even with the correct password, until the lockout
expires. Tracking is an in-memory `Map` keyed on `X-Forwarded-For` (falling back to the
socket address), reset on any successful login, capped at 500 tracked addresses with FIFO
eviction so a flood of distinct source IPs can't grow it unbounded. `/health` stays exempt,
same as it's exempt from auth.
**Why:** Operator asked for a max sign-in attempt limit on the live-money dashboard.
**Verified:** `npm run build` and `npm test` clean, including new lockout tests in
`test/dashboard-check.ts` (3 failures lock an address out, a locked address gets 429 even
with the right password, `/health` stays reachable throughout, a success before the threshold
resets the failure count).
**Watch out:** Also checked live production logs on this deploy: sleeper detection is
confirmed firing for real (`[SCAN] Sleepers forced into TA: SKY/USD +0.1%, ETH/USD +0.1%,
AUT/USD -0.1%`), win rate is 71% over 14 closes with +$7.15 realised P/L, and a RISK_OFF
stance correctly parked ~60% of tradable cash and skipped new entries in an overbought
market — the charter working as intended, not a bug. Nothing else looked wrong; no code
change followed from the log review.

### 2026-08-22 — Claude — Wake-on-message loop + terminal CLI

**Changed:** An operator chat message now wakes the trading loop immediately instead of
waiting out `SCAN_INTERVAL_MINUTES`: `main()` gained a module-level `wakeRequested` flag and
`wakeWaiters` array (same shape as the existing `shutdownWaiters`), and the dashboard's
`onOperatorMessage` calls `requestWake()` after posting. The inter-cycle sleep races against
a wake waiter the same way it already races against shutdown; a wake mid-cycle (waiter queue
empty) is caught by the flag check right before the *next* sleep, so it is never lost. Also
added `src/cli.ts` (`npm run cli -- balance` / `npm run cli -- chat`) — a terminal client of
the dashboard's existing `/api/state` and `/message` HTTP routes, run locally against the
deployed URL via `DASHBOARD_URL`/`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`. It is a second
door onto the same API the web dashboard uses, not a new surface: no direct exchange, config,
or state-file access. Generated a Railway service domain
(`kai-trading-glm-production.up.railway.app`) and set `DASHBOARD_PASSWORD`/
`DASHBOARD_USERNAME` on the live service.
**Why:** Operator asked for the AI to scan right after a chat reply rather than waiting for
the clock, and for both chat and balance-checking to work from a terminal.
**Verified:** `npm run build` and `npm test` clean. Manually smoke-tested `src/cli.ts` end to
end against a throwaway local dashboard instance (not committed) — `balance` renders account/
positions/stance correctly, `chat` posts a message and the server-side `onOperatorMessage`
callback receives it, output ordering fixed so the "(sent — ...)" confirmation always prints
before the process exits even when stdin closes right after (piped input). The wake-loop
control flow itself has no automated test — same as the pre-existing `shutdownWaiters`
mechanism it mirrors — because exercising it needs the real `main()` loop timing, not a fake;
reasoned through by hand instead. Not verified: an actual message sent through the deployed
Railway dashboard reaching a live cycle (this sandbox cannot reach `*.up.railway.app` — its
egress proxy allowlists specific hosts only, confirmed via `403 connect_rejected`).
**Watch out:** `src/cli.ts` needed adding to `tsconfig.json`'s `include` (previously only
`src/index.ts`) since it's a second entry point, not something `index.ts` imports.

### 2026-08-22 — Claude — Two-way chat channel + read-only dashboard

**Changed:** Added a `ChatMessage` log to `Memory` (`postOperatorMessage`/`postAiMessage`/
`unreadOperatorMessages`, bounded to 40, index-based unread tracking so same-millisecond
posts can't collide). `PortfolioStance` gained `messageToOperator` and `charterSuggestion`
fields; `reviewPortfolio()` now feeds the model any unread operator messages and posts its
reply/funding-request/charter-suggestion back to the log automatically. Added
`Memory.recordAccountSnapshot()`, called once per cycle in `runCycle()`, so a viewer never
needs its own exchange call. New `src/dashboard.ts` (zero new deps, plain `http` module) is
started from `main()` when `DASHBOARD_PASSWORD` is set — HTTP Basic Auth (timing-safe
compare), `/health` unauthenticated for Railway, `GET /` renders account/positions/closed
trades/stance/chat as a self-contained dark HTML page with a plain `<form>` (no client JS),
`GET /api/state` for JSON, `POST /message` appends to the chat log. It only reads state and
queues a message — it cannot place an order, change a stop, or touch config.
**Why:** Operator asked for the model to be able to ask questions, request funding, or
suggest charter changes, and for a Railway-hosted page showing portfolio/staked/trade-log
state.
**Verified:** `npm run build` and `npm test` both clean end to end, including a new
`test/dashboard-check.ts` that spins up a real `http.Server` on an ephemeral port and checks
401/200 auth behavior, `/health`, the message POST → chat-log flow, and live vs. paper
rendering). Not yet verified against a real Railway deploy or with a real GLM stance reply —
the `message_to_operator`/`charter_suggestion` prompt fields are new and unexercised against
the live model.
**Watch out:** `charterSuggestion` is surfaced only; nothing applies it to `SOUL.md`
automatically, on purpose. The staked/reserved dashboard figure is the cached aggregate from
the last cycle's account fetch, not a live per-asset breakdown.

### 2026-08-22 — Claude — Hunt quiet sleeper markets, not just movers

**Changed:** `selectSleepers` forces the `SLEEPER_COUNT` (default 3) liquid tickers with the
smallest 24h move — not already claimed by the coarse rank or the movers list — into full
TA every cycle, tagged `[SLEEPER]` in the candidate log. `prioritizeMoverCandidates` gained
an optional fourth `sleeperSlots` parameter (default 0, so the existing two- and
three-argument call sites are unchanged) reserving up to a third of the decision budget for
them after movers, never consuming the whole budget. The per-pair prompt tells the model a
sleeper surfaced from quiet, not from a catalyst, and to judge it purely on the technicals.
Added two short bullets to `SOUL.md` — hunt the quiet ones, and a steadier core plus a real
speculative sleeve are not in conflict — matching the operator's ask to find things "under
the radar in a bull market" and to size both safe and speculative positions.
**Why:** The coarse rank rewards range position, 24h change and volume; the movers list is
explicitly the biggest 24h moves. Both structurally exclude a market that is simply quiet —
exactly the profile of something basing before the rest of the market notices it — so it
never got a technical look at all.
**Verified:** `npm run build` and `npm test` clean (16 suites, including a new one covering
selection, the liquidity tiebreak, budget backward-compatibility, and that a reserved
mover+sleeper slot never consumes the entire decision budget). Not yet verified against a
live cycle; the operator's Railway service has `SLEEPER_COUNT` unset so it will run on the
default of 3 once deployed.
**Watch out:** This adds up to `SLEEPER_COUNT` extra full-TA (OHLCV) fetches per cycle,
plus up to a third of the AI decision budget when a strong sleeper setup appears — same cost
shape as movers, additive to it.

### 2026-08-22 — Claude — Reviewed and pulled the universe/charter work; raised the decision budget

**Changed:** Nothing in `src/index.ts`. Fast-forwarded onto this branch's `4b67ce3` after
tracing the `EXCLUDED_ASSETS` boundary through the new code end to end — `getScanUniverse`
for both `auto` and `watchlist` modes, `filterDiscoveredMarkets`, and the mover selection
path all resolve back to `CONFIG.excludedAssets` before a pair can reach a candidate list —
and confirming `SOUL.md`/`PLAYBOOK.md` reach exactly the four call sites this file's log
says they do (`DECISION_SYSTEM_PROMPT`, `CHARTERED_STANCE_SYSTEM_PROMPT`, `reconsiderSell`,
`selfTest`). On Railway: raised `AI_DECISIONS_PER_CYCLE` from 3 to this repo's own default
of 6, since the new reserved mover slots (loser-first, up to 3) were leaving as little as
one slot for ordinary top-ranked candidates, which fights the operator's stated preference
for something closer to ten open positions.
**Why:** Ten commits landed on `main` while I was mid-task on the operator's own asks
(reserved assets, position-origin protection, model fallback). Live money, so I read the
diff rather than trusting the commit messages, then watched an actual production cycle.
**Verified:** `npm run build` and `npm test` clean (15 suites). Live: the 02:50 UTC cycle on
`e0021ec7` shows the `auto` universe surfacing pairs the watchlist never would (TRUMP, CRV,
XRP, DASH…), zero `SOL`/`AVAX` anywhere in candidates or orders, a real `:online` news
result on `BLESS/USD` (200% rally, 50x leverage buildup, team token sales — not a
hallucination), and `counter_case` firing on the stance and every decision. Did not place or
alter any order myself.
**Watch out:** `AI_WEB_SEARCH=true` and the charter/playbook prefix together push real token
cost — that cycle spent 37,631 tokens on 8 calls (~4.7k/call). The operator asked for both
"really research it" and lower credit use in the same conversation; those pull against each
other and I have not tried to referee it beyond the budget bump above. `AI_MODEL_FALLBACK`
is still pinned to `z-ai/glm-5.2` — if either of us changes `AI_MODEL`, check it still points
at something that exists.

### 2026-08-21 — Devin — Preserve cycle continuity and add wall-clock stance expiry

**Changed:** Cycle numbering now resumes from the persisted nonnegative counter across
restarts, with corrupt values safely starting at zero. Stance freshness now also checks a
wall-clock budget of two times `STANCE_MAX_AGE_CYCLES` times the configured scan interval.
The two-interval slack allows for a slow cycle or delayed restart without leaving a mandate
active indefinitely.
**Why:** Restarting at cycle one made saved stances appear newly recorded forever, while a
long outage could leave a counter-fresh stance applying an old cash target.
**Verified:** `npm run build`, `npm test`, and `git diff --check` passed. Pure tests cover
restart counter continuity, invalid counter fallback, and a timestamp-expired stance whose
cycle age remains within budget. The prior empty-candidate paper smoke was not rerun because
these changes do not alter its no-candidate request path.
**Watch out:** Live Kraken balances, orders, and production model behavior remain unverified.

### 2026-08-21 — Devin — Refresh portfolio stance on empty scans and expire old mandates

**Changed:** The portfolio stance is now requested on every non-shutdown cycle, including
blocked or empty scans, with a short explanation of the blocker or missing setup in the
prompt. Saved stances now persist their ISO timestamp and cycle; `STANCE_MAX_AGE_CYCLES`
defaults to four cycles, can be disabled with a blank value, and stale or legacy stances
no longer apply cash-target trim pressure or reserve cash.
**Why:** Gating stance evaluation on candidates left whole-book judgement, funding requests,
and cash targets frozen exactly when no new entry could be made.
**Verified:** `npm run build`, `npm test`, and `git diff --check`; a paper single-cycle run
with every watchlist asset excluded produced no candidates, still sent a `PORTFOLIO`
request, and persisted stance metadata at `/home/ubuntu/kai-stance-smoke-state/state.json`.
Live Kraken balances, orders, and production model behaviour remain unverified.
**Watch out:** The smoke log is `/home/ubuntu/kai-stance-empty-candidates.log`; it used
dummy credentials and the local mock provider at `AI_BASE_URL`.

### 2026-08-22 — Devin — SOUL.md is the trader's charter, wired into the prompt

**Changed:** Rewrote `SOUL.md` as the mandate for GLM (the trading model), not for us, and
load it once at startup into the system prompt of every decision call — per-pair, portfolio
stance, second opinion and the AI self-test — behind a header saying it outranks convenience
or habit. `SOUL_FILE` overrides the path (relative paths resolve from the repo root); a
missing or unreadable charter warns once and leaves the existing prompts untouched. Added
`AGENTS.md` (rules for coding agents), `CLAUDE.md` (Claude Code entry point) and this file.
**Why:** The operator's split is: GLM trades, Devin and Claude write the code. `SOUL.md`
had been written for coding agents, which put it in front of the wrong reader — and as
documentation it never reached the model that needed it.
**Verified:** Build, all suites, and a paper cycle against a local mock provider showing the
charter present in all four call types; a second run with a nonexistent `SOUL_FILE` warned
and ran on the original prompts, exit 0. Live Kraken order paths remain unverified here.
**Watch out:** `SOUL.md` is now prompt input, so its length costs tokens on every call, and
editing it changes trading behaviour. Treat it as code: keep it tight, and note edits here.

### 2026-08-21 — Devin — Phase 1 sell proceeds fund same-cycle buys

**Changed:** The balance snapshot is refreshed after any Phase 1 exit, so cash freed by a
sell can fund a buy in the same cycle. Phase 1 AI reviews are budgeted
(`AI_REVIEWS_PER_CYCLE`, ranked by stop/target urgency); stops and targets still check
every position.
**Why:** Buys were sized against pre-sell cash ($0.05 free in production), so the bot
could only ever sell. Reviews were one AI call per holding per cycle, which also made the
cycle sell-biased and expensive.
**Verified:** Paper cycle with a mock provider: sell → refresh → same-cycle buy.
**Watch out:** Claude's concurrent work landed in the same window; that merge is
`0d3a44c`, and no upstream behaviour was dropped.

### 2026-08-22 — Devin — Broad ticker funnel, daily movers, and pair memory

**Changed:** `SCAN_UNIVERSE=auto` now discovers active USD spot markets from Kraken, removes
reserved/stablecoin/wrapped/held assets, applies a `$250,000` 24-hour quote-volume floor,
coarse-ranks the survivors, and runs full TA on `SCAN_TA_LIMIT=40` markets. The legacy
watchlist remains available. Liquid daily gainers and losers are selected from the same
ticker batch (`DAILY_MOVERS_COUNT=3` each) and forced into TA, with category and mover tags
in the scan logs. `AI_DECISIONS_PER_CYCLE` remains six affordable decisions, and candidates
below the exchange minimum are skipped before an AI call. Loser movers can request a separate
OpenRouter `:online` news check when `AI_WEB_SEARCH=true`; failures continue without news.
Compact same-pair closed-trade history is included in decision context, including entry
verdict, thesis and realised outcome.
**Why:** The fixed 20-pair list starved the buy funnel and gave the model too few affordable
opportunities; movers and prior outcomes add breadth and context without TA on every market.
The `$250,000` floor is intentionally in the low hundreds of thousands to avoid obvious
illiquidity while preserving broad category coverage. Movers add to, rather than replace, the
coarse TA limit.
**Verified:** Pure universe, liquidity, ranking, affordability, mover, news-gate and history
checks; build; all test suites; and diff whitespace checks. Existing paper cycle tests exercised
auto discovery and category/mover logging. No live Kraken calls, authenticated OpenRouter
web-search call, or live order was performed; the `:online` capability and account entitlement
remain unverified, and the news path is safely non-blocking.

### 2026-08-22 — Devin — Reserve mover decisions and fail fast on unavailable news

**Changed:** Loser/gainer movers now receive up to three dedicated slots from the default
six-decision budget, with losers ordered before gainers; the remaining slots follow the
normal TA score. Affordability checks still happen before a decision is spent. The
`:online` loser-news request now makes one attempt only. A hard provider capability
rejection is memoised for the process and disables later web-search attempts; transient
failures simply continue without news. The production call uses the typed `AiBrain`
method directly.

Discovered markets no longer receive the misleading 5% sector target or sector exposure
guidance. `MAX_SECTOR_EXPOSURE_PCT`, when enabled, does not block `unlisted` discovered
entries, although reporting continues to aggregate them under that label. Preflight now
prioritises held pairs and the watchlist, topping up from the exchange universe within
the same bounded sample.

**Why:** A low-scoring crash could be excluded from the AI budget before its news context
was considered, while an unavailable `:online` capability was being retried repeatedly.
Kraken supplies no sector metadata for newly discovered assets, so pretending they share a
5% target could silently block the entire broad universe.

**Verified:** Unit checks cover mover ordering and the unsupported-news capability gate;
`npm run build`, `npm test`, and `git diff --check` pass. Paper mover/news success and
failure smokes were rerun with the local mock provider. The failure path now makes one
news attempt rather than the previous repeated sequence.

**Watch out:** Live Kraken behavior, authenticated OpenRouter `:online` entitlement,
real sector metadata, and live order execution remain unverified.

### 2026-08-22 — Devin — Supply the operator playbook and window context to decisions

**Changed:** Archived the supplied seven-chapter Crypto Playbook at
`docs/the-crypto-playbook.md`, preserving its source text and all table rows as Markdown;
the source `.docx` is not tracked. `PLAYBOOK.md` is loaded once at startup through the
existing charter path pattern, with `PLAYBOOK_FILE` as an override. Prompts place the
operator's charter first and the playbook second, explicitly stating that the charter wins
conflicts; an unavailable playbook warns once and leaves the existing prompt unchanged.
The charter and playbook currently contain 2,788 and 2,884 characters respectively;
their headers and separators bring the combined prompt prefix to 5,877 characters on each
applicable system prompt.

Candidate decisions now receive the Stage 1 universe median 24-hour ticker move and each
pair's delta from it, plus the drawdown and age of the highest high in a fetched one-year
daily window. The latter is labelled as a high over the fetched window, not an all-time
high. These are model context, not hard filters or automatic rules. Position reviews
receive the window-high context when daily data is available; a daily-data failure remains
isolated to that pair.

**Why:** The playbook's relative-performance and recovery categories need explicit market
comparison and long-window context that the existing hourly technical snapshot did not
provide, without changing the operator-authored prompt text or broadening API calls to the
whole TA set.

**Verified:** Added pure tests for prompt ordering and fallback, ticker median and relative
strength, and window-high/drawdown edge cases. Build, all test suites, and whitespace checks
are run before shipment; a local paper/mock request-body smoke will verify charter/playbook
presence and the new fields. No live Kraken candles, authenticated model behavior, or live
orders are verified.

### 2026-08-22 — Devin — Playbook integration verification

**Verified:** `npm run build`, `npm test`, and `git diff --check` passed. The local paper
smoke at `/home/ubuntu/kai-playbook-smoke.log` used a mocked exchange and
`AI_BASE_URL`; its captured request bodies are in
`/home/ubuntu/playbook-prompt-requests.jsonl`. The stance and per-pair requests contained
the charter and playbook in that order, and per-pair requests contained both the 24-hour
relative-strength fields and fetched-window-high drawdown fields. The smoke made no live
orders and used no real credentials.

**Unverified:** Live Kraken market/candle responses, authenticated provider behavior, and
production model interpretation of the archived playbook remain unverified.

### 2026-08-22 — Devin — Supply market context to Phase 1 reviews

**Changed:** The Stage 1 universe discovery, batched ticker fetch, liquidity filtering,
and universe-median calculation now run before Phase 1. The single ticker batch includes
both the held pairs needed for review context and the separate held-free buy universe;
Phase 2 reuses that result without a second ticker fetch in the normal path. If Stage 1
fails, reviews omit relative strength and the existing price fallback remains available.
Position reviews now receive each held pair's 24-hour move versus the Stage 1 universe
median.

Successful one-year daily windows are cached per pair for six hours and reused across
cycles. At the default five-review budget, the first cycle can add up to five daily-candle
requests; while cached, later cycles add zero, with a refetch after the TTL.

**Why:** The playbook's dead-money sell test requires market-relative performance during
Phase 1, not only during new-entry decisions. Caching prevents the review budget from
turning into five repeated daily-history requests every cycle.

**Verified:** Unit coverage includes the held-plus-universe ticker batch set and cache TTL
freshness boundaries. `npm run build`, `npm test`, and `git diff --check` pass. The paper
mock smoke at `/home/ubuntu/kai-review-context-smoke.log` captures a held-position review
with both relative-strength and fetched-window-high context; request bodies are in
`/home/ubuntu/review-context-requests.jsonl`.

**Unverified:** Live Kraken ticker batching, live daily-candle responses, and production
provider/model behavior remain unverified. The fallback-only ticker failure branch was
covered by code inspection and existing exchange error handling, not a live failure.
