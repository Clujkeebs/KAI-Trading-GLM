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

### 2026-08-22 — Devin — Load the trader's charter into every decision prompt
**Changed:** Load `SOUL.md` once at startup, prepend it to per-pair, portfolio-stance and
second-opinion system prompts, and support the `SOUL_FILE` repository-root-relative override.
Missing or unreadable charters warn and leave the original prompts unchanged.
**Why:** `SOUL.md` is the operator's standing mandate for GLM, so it must reach the model
on every call rather than remain documentation-only.
**Verified:** Pure composition and missing-file checks added; build, tests and mock prompt
inspection are pending until the implementation verification pass. No live orders.
**Watch out:** The charter adds its full character count to each decision prompt.

### 2026-08-22 — Devin — Verify charter propagation and fallback
**Verified:** A paper cycle with a local OpenAI-compatible mock recorded charter header and
unique charter text in review, second-opinion, portfolio-stance and per-pair prompts. A
second paper cycle with a nonexistent `SOUL_FILE` logged the warning, used original prompts,
reached shutdown and exited 0. Build, tests and diff check passed. No live orders.

### 2026-08-22 — Devin — SOUL.md is the trader's charter, wired into the prompt

**Changed:** Rewrote `SOUL.md` as the mandate for GLM (the trading model), not for us, and
loaded it into the model's system prompt so it is read every cycle instead of sitting in
the repo. Added `AGENTS.md` (repo rules for us), `CLAUDE.md` (pointer for Claude Code) and
this file.
**Why:** The operator's split is: GLM trades, Devin and Claude write the code. `SOUL.md`
had been written for coding agents, which put it in front of the wrong reader.
**Verified:** Build and the four test suites pass; a paper cycle shows the charter reaching
the model. Live Kraken order paths remain unverified from the dev environment.
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
