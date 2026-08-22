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
