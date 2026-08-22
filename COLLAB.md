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
