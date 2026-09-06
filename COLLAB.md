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

### 2026-09-06 — Claude — Standing liquidation orders (LIQUIDATE_ON_UNSTAKE)

**Changed:** New `LIQUIDATE_ON_UNSTAKE` (production: `AVAX`). Sells a listed asset in full the
moment it has free balance. New `liquidateOnUnstake(exchange, mem)` runs at the **top of
`runCycle`**, after reconcile but before the balance snapshot the rest of the cycle sizes against —
so before Phase 1 reviews anything, before the stance, before any decision budget. A tracked
position exits via `executeExit` so P/L is booked; leftover free balance is then swept via
`sellReserved`. Also `excludeAssetsFromBuckets`, `activeStrategyBuckets()`, `activeStrategyPairs()`;
`strategyBucketFor`/`isStrategyPair` now resolve against the active (filtered) buckets, and
`getScanUniverse` unions the liquidation list into its exclusion set.

**Why:** Operator: *"my Avax position, I want to be liquidated the second it is unstaked."* That is
an ownership instruction with no market judgement in it, so it is one of the few genuine hard rules
in this bot — the model is never asked and cannot argue to keep it. The filtering half is the part
that is easy to miss: **AVAX was in the rotational bucket**, so without it the framework would have
told the model to buy AVAX and the liquidation would have sold it next cycle, paying both spreads
forever. Striking it out of the buckets also stops it counting toward the rotational target — a
holding on its way out is not allocation, and counting it would read the sleeve as full and starve
the names actually meant to fill it.

**Verified:** `npm run build` + `npm test` clean, **33 suites**. Unit: a struck asset leaves the
eligible list while its bucket-mates and the bucket's target weight stay, weights still sum to 1,
the `AVAX.B` staked alias strikes the same asset, an empty list is a no-op, and drift counts 938 →
0 for a struck holding so the sleeve correctly reads underweight. Integration, against the real
`Exchange` and a fake Kraken: **staked AVAX places no order**; unstaked AVAX is sold **in full in
one cycle** (whole 9.38 balance, nothing left behind); sub-minimum dust is reported and **not**
thrown at the exchange; and AVAX is absent from both `getScanUniverse` and `isStrategyPair` while
SOL remains in both.

**Watch out:**
- `EXCLUDED_ASSETS` is now blank *and* AVAX is on the liquidation list. These are opposites and
  both are intended: nothing is protected, and AVAX is actively unwanted. Do not "tidy" AVAX back
  into `EXCLUDED_ASSETS` — that would silently cancel the standing order.
- The order is a no-op today: `AVAX.B` is staked, so there is no free balance to sell. It fires on
  the first cycle after the operator unstakes. Untested against a real Kraken fill.
- `liquidateOnUnstake` is a hard rule by design. If a future change routes it through the model or
  a confidence threshold, that breaks the operator's instruction — it is not a trade to be judged.

### 2026-09-06 — Claude — Reserved list emptied: staking is now the only thing holding the line

**Changed:** `EXCLUDED_ASSETS` is now **blank** in production (was `SOL,AVAX`, then `AVAX`). The
operator's instruction, in their words: *"The AI can sell and buy as long as it is making me more
money."* No code change — `isExcludedAsset` simply matches nothing now. Added an integration case
covering the configuration that results.

**Why:** The operator has loosened this three times across one session (hard rule → $500 SOL
allowance → unstaked SOL fully managed → nothing reserved) and reaffirmed each time. Treating that
as settled rather than re-litigating it.

**Verified:** `npm run build` + `npm test` clean, 32 suites. The new case pins the live account's
exact shape ($0.01 cash, `SOL03.S` 9.47, `AVAX.B` 9.38) with **nothing reserved** and asserts that
staked value still counts toward `totalUsd`, is absent from `tradableUsd`, appears in `lockedUsd`,
is **never adopted as a position**, and that both `sell` and `sellReserved` place **zero orders**
against it. It then unstakes SOL in the fixture and asserts it becomes ordinary tradable capital
with `lockedUsd.SOL === 0`.

**Watch out — read this before touching balance handling:**
- `isStakedBalance` is now the *only* thing between the bot and ~$1,885 of the operator's SOL and
  AVAX. It was previously a backstop behind `EXCLUDED_ASSETS`; it is now load-bearing on its own.
  `AGENTS.md` already warns that being staked is not the same as being protected — that warning is
  now the whole story. Any change to `STAKED_BALANCE_SUFFIXES`, `normalizeAsset`, `mapHoldings` or
  `getAssetField` can hand that balance to the bot. Do not touch them without re-running
  `test/integration-check.ts`.
- The protection is *mechanical*, not a policy: it holds because Kraken will not sell a bonded
  balance through a spot order. If the operator unstakes, the bot may deploy all of it. They said
  they want to keep *some* SOL; there is no floor enforcing that, and adding one would need their
  say-so since they explicitly removed the caps.
- Nothing about this makes the bot trade today. Free cash is $0.01.

### 2026-09-06 — Claude — Simulate the framework instead of trusting it: two real bugs

**Changed:** New `test/integration-check.ts` (wired into `npm test`, 32 suites total) driving the
*real* `Exchange`, `AiBrain` and `runCycle` against a fake Kraken and a scripted model — no live
order, no spend. It found two defects that unit tests could not:

1. **`lockedUsd` marked every reserved holding as locked.** `getPortfolioValue` accrued
   `reservedHoldings` with `locked: true`, but `reservedHoldings` (like `mapHoldings`) collapses
   `SOL` and `SOL03.S` onto one `SOL/USD` entry, so the free/staked split was already gone. A
   reserved-but-unstaked balance therefore reported as unsellable, and `reservedAllowanceNote`
   would have told the model "$0 reachable" while $1,000 of free SOL sat there. Now computed by
   walking `getBalanceEntries` directly, with locked ≡ `isStakedBalance(asset)` — a property of
   the balance name, not of whether the operator reserved the asset.
2. **The framework got the coins right and the weights wrong.** A 5-cycle paper run of the
   operator's own $1,000 allocation put ETH at **12%** of the book against its 50% target, purely
   because ETH is one name and the large-cap sleeve is six, and every position was sized alike.
   `candidateAllocationNote` now carries a BUCKET SIZE line — `targetUsd / eligible names`, plus
   what is already held in the bucket and the room left. Same run now lands ETH at **50.0%**, and
   the model is handed ETH $500 / large caps $55 / rotational $21.25, which is exactly the
   framework's $500-$330-$170 split.

**Why:** I had told the operator the reserved-sell path and the 403 fix were "unverified against a
live order", which was true and not good enough — `AGENTS.md` forbids a test order, but it does not
forbid simulating everything short of one. Both bugs were live in `main` and neither is visible
from a unit test: the first needs a real balance payload with a staked alias, the second only shows
up over several cycles of real sizing.

**Verified:** `npm run build` + `npm test` clean, 32 suites. The integration suite asserts:
a fully staked holding sells nothing *and places no order*; an unlocked one sells exactly the
dollar amount asked and never reaches past the free balance into the staked one; an oversized
request caps at unlocked value; a sub-minimum request is refused before it reaches the exchange;
`Exchange.sell` still refuses reserved pairs; a **partial fill** consumes only realised proceeds
($200 of a $400 request, leaving $300 of a $500 allowance); the cap persists across a restart and
cannot be re-opened via the `SOL03.S` alias. Plus the exact production 403 sequence end to end
(402 → catalog → gated id tried **once** → working id → real BUY), a regression guard proving the
same error still fails loudly without the walk-past, and a preflight run asserting the AI is the
*only* critical failure while the framework check stays non-critical.

**Watch out:**
- Live preflight against real Kraken reports `14/15 framework pairs listed; unreachable here:
  CANTON/USD`. CANTON is not on Kraken; it stays in `STRATEGY_BUCKETS` deliberately so the gap is
  reported rather than silently forgotten if Kraken ever lists it.
- The paper sim's model sizes by parsing the BUCKET SIZE line out of the prompt. That is the point
  — it tests the guidance — but it is a *cooperative* reader. A real model may weight it
  differently; the framework is guidance and is meant to be arguable.
- Still unverified by a live order, and will stay that way: `sellReserved` against real Kraken.
  Everything up to `createMarketSellOrder` is now exercised; the exchange's own response is not.

### 2026-09-06 — Claude — Allocation framework, and the three faults that had production halted

**Changed:** Four things, in the order they mattered.

1. `isModelUnavailable` now classifies HTTP **403** refusals ("`<id>` is only available on agentic
   harnesses", "no endpoints", "restricted") as *try another model*, and the switch guard no longer
   requires `switchedToFreeTier` — a gated model is walked past once the named fallback has had its
   turn. `switchToFreeModel(reason)` logs why it moved.
2. An **AI-only critical preflight failure no longer blocks entries for the life of the process.**
   `newEntriesBlockedByAiOnly` is set when the AI check was the only critical failure, and the block
   lifts on the first cycle where `ai.health.lastSuccessAt` is set.
3. **Allocation framework** (new, `STRATEGY_ALLOCATION`, default on): `STRATEGY_BUCKETS` (ETH 50% /
   large caps 33% / rotational 17%), `allocationDrift`, `underweightBuckets`, `allocationNote`,
   `candidateAllocationNote`, all pure and exported. `PortfolioSnapshot` gained `holdingsUsd` and
   `lockedUsd` so drift is measured on the whole account with locked value called out separately.
   Framework pairs are forced into TA next to movers/sleepers, `prioritizeMoverCandidates` gained a
   `strategySlots` reserve ranked by `strategyPriority` (most underweight first), and both the stance
   and each entry prompt carry the gap. A framework pair Kraken does not list is a **non-critical**
   preflight finding — deliberately, since making it critical would halt trading over one dead pair.
4. **`RESERVED_SELL_ALLOWANCE_USD`** (`ASSET:USD`): bounded, one-way, cumulative-for-life exceptions
   to the reserved boundary. `parseSellAllowances`, `remainingSellAllowance`, `approveReservedSale`,
   `reservedAllowanceNote`, `Memory.recordReservedSale`, and a **separate** `Exchange.sellReserved`.
   `Exchange.sell` still refuses reserved pairs outright and must keep doing so.

**Why:** The account had not opened a position in four days and the cause was stacked. The
free-model walk latched onto `thinkingmachines/inkling-small:free`, which OpenRouter lists but
403s; unclassified, that read as an ordinary error, so it never moved on — 409 consecutive AI
failures on one dead slug. Preflight had failed on that same model at boot and latched the entry
block permanently, so even a recovered AI would not have traded. And ~$1,050 of the $1,080 account
is staked (`SOL03.S`, `AVAX.B`), leaving ~$30 deployable. The framework is the operator's own
strategy; the allowance exists because they authorised selling part of their reserved SOL.

**Verified:** `npm run build` and `npm test` clean, 30 suites (new `test/strategy-check.ts`, wired
into `npm test`). Covers: bucket weights summing to 1 and no asset in two buckets; drift on an empty
book, on the live account's all-staked-SOL shape, on Kraken staking names (`SOL03.S` → `SOL`), on a
zero denominator and on negative/NaN holdings; guidance-not-gate wording in both prompt builders;
all three allowance ceilings binding independently plus each refusal reason; framework slots
out-ranking a higher raw score; `strategySlots: 0` reproducing the old ordering exactly; a pair that
is both framework and mover not consuming two slots; and the exact production 403 string
classifying, while 401/403-auth/429 do not.

**Watch out:**
- **The SOL allowance is worth $0 today.** The whole holding is `SOL03.S`; Kraken will not sell a
  staked balance through a spot order. Per the operator, unstaked SOL should be fully managed rather
  than capped, so `EXCLUDED_ASSETS` is now **`AVAX` only** and `RESERVED_SELL_ALLOWANCE_USD` is
  blank. The staked pile stays unreachable by construction (`mapHoldings` skips staked balances, so
  it is never adopted and never counted as tradable) — but that is a mechanical property, not a
  guard. If SOL is ever fully unstaked the bot may deploy all of it; the operator wants *some* SOL
  held, so a floor may be worth adding.
- `AI_FREE_MODEL` cleared on Railway so runtime discovery is authoritative rather than trying stale
  slugs first.
- The 403 fix, the block-lifting fix and `sellReserved` are **unverified against a live order** —
  AGENTS.md forbids placing one to test. The 403 classification is verified against the exact
  production error string only. This sandbox still has no egress to openrouter.ai or
  `*.up.railway.app`, so everything live is read through Railway logs.

### 2026-08-23 — Claude — Discover free models from the provider instead of guessing

**Changed:** New exported `freeModelsFromCatalog(payload)` (pure: keeps only models where BOTH
prompt and completion price are zero, orders by context length as the one capability signal the
payload carries) and `AiBrain.discoverFreeModels()`, which GETs `<baseUrl>/models` once per run
when the paid balance is spent and queues what it finds behind anything the operator configured.
`AI_FREE_MODEL` is now documented as "usually leave blank".
**Why:** Three hard-coded free slugs were tried in production and all three were already dead
(`404 No endpoints found`, `unavailable for free`). Guessing a fourth would repeat the failure,
and this environment cannot reach openrouter.ai to check (`curl` → `403 CONNECT tunnel failed`).
The bot *can* reach it, so it now looks the list up at the moment it needs one. The operator has
only OpenRouter and no paid balance, so this is the only remaining path to a working decision.
**Verified:** `npm run build` and `npm test` clean (23 suites). `logic-check.ts` covers the
parser: fully-free only (a free-prompt/paid-completion model is excluded — it still fails on a
spent balance), longest-context-first ordering, the limit, numeric and string zeros, and junk
payloads (null / `{}` / non-array / missing pricing / non-numeric price) returning `[]` rather
than throwing. `ai-check.ts` covers the path end to end with a stubbed `fetch`: a 402 with no
configured list consults `/models`, authenticates with a Bearer token, switches to the
discovered free model, lands a real BUY, and never queues a paid id; plus a catalog fetch that
throws, asserting an honest HOLD instead of a crashed cycle.
**Watch out:** Whether OpenRouter currently exposes ANY zero-price model to this account is still
unverified from here — that is now a question the bot answers at runtime rather than one I have
to guess. If the catalog returns no free models the bot falls back to HOLD and preflight blocks
new entries, which is safe but still not trading; the real fix remains a paid balance. Free tiers
are heavily rate limited, so expect 429s and slower cycles even on success.

### 2026-08-23 — Claude — Attempt budget must cover walking the free-model list

**Changed:** The retry loop in `AiBrain.request()` was a fixed `attempt < 3`. With five free
candidates configured it stopped after the third, so a live slug further down the list was never
reached. The bound is now `3 + freeModelCandidates.length`.
**Why:** Caught in production immediately after deploying the list: the log shows it correctly
walking `deepseek/deepseek-chat-v3-0324:free` → `meta-llama/llama-3.3-70b-instruct:free` →
`google/gemma-2-9b-it:free` and then stopping with two candidates still untried, because the
loop budget was spent. My own defect in the previous entry.
**Verified:** `npm run build` and `npm test` clean (22 suites). New `ai-check.ts` case with five
candidates where only the fifth is live, asserting it is still reached and becomes the active
model.
**Watch out:** All three slugs tried in production were dead (`404 No endpoints found` /
`unavailable for free`). The remaining two are equally unverified — this sandbox cannot reach
openrouter.ai to check. The mechanism is now correct and well tested; whether *any* free slug in
the list is live is unknown, and I have stopped guessing rather than burn more deploys on it.
The real fix remains topping up the paid balance. Preflight correctly marks the AI check CRITICAL
and blocks new entries while this is unresolved, so the failure is safe, just unproductive.

### 2026-08-23 — Claude — Free-model fallback takes a LIST, not one id

**Changed:** `AI_FREE_MODEL` is now comma-separated and tried in order. New exported
`isModelUnavailable()` (broader than `isUnknownModel`: also matches "unavailable" / "no longer"
/ "deprecated" / "use this slug", which name no unknown model) advances to the next candidate
when a free slug has been withdrawn, and is excluded from `withRetry` so a dead slug is not
retried three times first.
**Why:** The single-id version from the previous entry deployed and worked *mechanically* — it
switched on credit exhaustion exactly as designed — but the id itself was dead:
`[FAIL] AI decisions: 0/2 clean | model z-ai/glm-4.5-air:free | last error: 404 This model is
unavailable for free. The paid version is available now - use this slug instead: z-ai/glm-4.5-air`.
That is the risk flagged in the previous entry, realised within minutes. Guessing a better
single id would just repeat it, and this sandbox has no egress to openrouter.ai to look up the
live list (`curl` → `403 CONNECT tunnel failed`), so the design changed instead of the guess.
**Verified:** `npm run build` and `npm test` clean (22 suites). New `ai-check.ts` coverage
reproducing the production sequence: 402 → first free slug → 404 "unavailable for free" →
second slug → real BUY, asserting each model id in order; plus an all-candidates-withdrawn case
asserting an honest HOLD without spinning.
**Watch out:** **The four slugs now in `.env.example` and on Railway are still unverified from
here** — same egress limitation. The list makes a wrong guess survivable rather than fatal, but
if *all four* are dead the bot falls back to HOLD and preflight correctly blocks new entries.
Confirm against https://openrouter.ai/models?max_price=0. Free tiers are heavily rate limited,
so expect 429s. This is a stopgap for a spent balance, not a substitute for topping up.

### 2026-08-23 — Claude — Fall back to a free model when the paid balance is spent

**Changed:** New `AI_FREE_MODEL` config and `AiBrain.switchToFreeModel()`. When a credit
refusal cannot be solved by shrinking the token budget (the balance affords less than
`MIN_AI_TOKEN_BUDGET`), the run switches once to the configured no-cost model, resets the token
budget (the shrunken one was fitted to a paid balance that no longer applies), logs it loudly,
and fires a `ai_free_model_fallback` webhook.
**Why:** The operator has ruled out unstaking SOL/AVAX, so ~$63 is the working capital and the
instruction is simply "make it work". Live logs showed the shrink bottoming out — `requested up
to 1052 tokens, but can only afford 794` — every cycle for four hours, so every decision was a
fallback HOLD. The paid balance is effectively zero and no budget fits. A free-tier model is
slower, rate limited and a weaker trader, but a worse decision that happens beats a better one
that never runs.
**Verified:** `npm run build` and `npm test` clean (22 suites). New `ai-check.ts` coverage: an
unaffordable 402 switches to the free model, lands a real BUY, uses that model id, and resets
`max_tokens`; with no `AI_FREE_MODEL` configured it still falls back to HOLD honestly and sets
`creditExhausted` rather than pretending.
**Watch out:** **The `z-ai/glm-4.5-air:free` id is NOT verified from here** — this sandbox has no
egress to openrouter.ai. It is the id this repo's own `.env.example` already documented, but
free-tier ids change and are withdrawn. If it is wrong the existing unknown-model handling
catches it and `AI_MODEL_FALLBACK` applies, so the failure is graceful, but the free tier will
not actually engage. Confirm against https://openrouter.ai/models?max_price=0 and correct the
Railway variable if needed. Free tiers are also aggressively rate limited, so expect 429s and
slower cycles.

### 2026-08-23 — Claude — Size the position count to the capital that can fund it

**Changed:** New `fundablePositionCount(portfolioValue, preferredCount)` narrows the preferred
concentration to what the tradable balance can actually fund at a viable size (a new
`VIABLE_POSITION_USD = 20`, floored at 1, never above the operator's preference).
`concentrationNote()` uses it, and when it narrows says so explicitly — naming the standing
preference and why it cannot be met — so the model does not read it as the operator changing
their mind.
**Why:** With the AI restored (previous entry) it immediately produced a real, correct refusal:
`[STANCE] RISK_OFF (7/10) — Recent edge unproven—7 of last 10 lost. $6.37 positions get eaten
by fees.` $63.66 tradable across the configured `TARGET_POSITION_COUNT=10` is $6.37 a position.
The model was right, and was applying `SOUL.md`'s own rung table ("Under ~$500 → nine $5
positions is a fee grinder"). But the preference was stated as a flat number regardless of
balance, so correct reasoning presented to the operator as the bot refusing to trade. The count
now bends to the capital: ~3 meaningful positions at $21 rather than 10 unviable ones at $6.
**Verified:** `npm run build` and `npm test` clean (22 suites). New coverage in
`logic-check.ts` for `fundablePositionCount` (ample capital keeps the full preference; $63.66
yields 3; never below 1; never above the preference; a zero/negative/NaN balance falls back
rather than collapsing to 1) and for `concentrationNote` both narrowing with an explanation and
leaving the note untouched when the preference fits.
**Watch out:** `VIABLE_POSITION_USD` is a judgement call, not a measured figure — $20 is roughly
where Kraken minimums plus round-trip fees stop dominating, but it is worth revisiting against
real fill data. This only reshapes *guidance*; nothing here forces a trade, so the model can
still legitimately answer RISK_OFF.

### 2026-08-23 — Claude — ROOT CAUSE of "not trading": the AI was out of credit

**The bug:** The operator reported for several turns that the bot "isn't trading" and is "just
sitting still." Earlier explanations (small tradable capital, cash-target conservatism, fiat
pairs crowding the scan) were all real but were *not* the cause. Pulling the live logs and
grouping the errors found it immediately:

```
402 This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens,
but can only afford 3755. To increase, visit https://openrouter.ai/settings/credits
```

Every single AI call was failing. Every decision was the `HOLD (5/10)` fallback; every stance
read `NEUTRAL (5/10) — AI unavailable`. The bot was brain-dead, not indecisive — and looked
completely healthy doing it. This is the same class of silent failure the preflight self-test
was built for, except preflight only runs at startup and the balance drained mid-run.

**Changed:**
- `isCreditExhausted(error)` — recognises a 402 / "requires more credits" / "insufficient
  balance" refusal, deliberately narrow so a 429 or 401 is not swallowed by it.
- `affordableTokensFromError(error)` — parses the "can only afford N" figure the provider
  helpfully includes.
- `AiBrain.shrinkTokenBudgetToAfford()` — on a credit refusal, refits `max_tokens` to 90% of
  what the balance still affords (floored at a new `MIN_AI_TOKEN_BUDGET = 900`, below which a
  reasoning model cannot emit the decision JSON anyway) and retries. A nearly-empty balance now
  keeps deciding instead of going dark on the way to zero.
- A 402 is excluded from `withRetry`'s retry predicate: the balance will not refill mid-loop,
  so retrying unchanged just burns attempts.
- `AiBrain.health` — `consecutiveFailures`, `lastError`, `creditExhausted`, `lastSuccessAt`.
  Surfaced in the cycle summary (`[AI HEALTH] *** NOT TRADING ***`), as a red dashboard banner,
  in `npm run cli -- balance`, and once per process through `notifyWebhook`. A dead AI can
  never again look like a calm book.

**Verified:** `npm run build` and `npm test` clean. New coverage in `logic-check.ts` (the exact
production 402 string parsed; 429/401/404/network errors explicitly NOT treated as credit
exhaustion; missing/zero/comma-separated figures), `ai-check.ts` (a shrinkable 402 recovers and
lands a real BUY at `max_tokens` 990 with health cleared; an unaffordable 402 falls back, is not
retried to death, and sets `creditExhausted`), and `dashboard-check.ts` (banner for credit
exhaustion, banner for ≥3 consecutive failures, and NO banner at 2 — it must not cry wolf).
**Regression-checked properly:** temporarily disabled the shrink-and-retry line and confirmed
`ai-check.ts` fails with `actual: 1000, expected: 990`, then restored it and confirmed green.

**Watch out:**
- The code fix makes the bot *survive* a low balance; it cannot conjure credit. The operator
  must top up OpenRouter or nothing trades regardless.
- Noticed while working: `tsconfig.json` only includes `src/`, so **test files are never
  typechecked** (tsx transpiles without checking). A `tsconfig.test.json` over `src/ + test/`
  reports ~11 pre-existing errors — test fixtures passing partial object literals where
  `PortfolioStance` / `AiDecision` are expected. Harmless at runtime (the code under test reads
  only the fields present) but it means a test can silently drift from a changed interface —
  my own `aiHealth` addition slipped through untypechecked this way. Not fixed here to keep this
  change focused; worth a dedicated pass.

### 2026-08-22 — Claude — Exclude fiat currency pairs from the scan universe

**Changed:** `filterDiscoveredMarkets()` now also excludes a new `FIAT_BASES` set (EUR, GBP,
CHF, AUD, CAD, JPY) alongside the existing `STABLECOIN_BASES`/`WRAPPED_EARN_BASES` checks;
`EURC` (Circle's EUR stablecoin) added to `STABLECOIN_BASES` itself.
**Why:** Operator reported the bot "just sitting still," not investing. Traced through live
logs (cycles 51-53): repeated `NEUTRAL` stances with reasoning like "top setups are
stablecoins and a meme — no compelling catalyst to deploy into," and the candidate list
showing `EUR/USD`, `GBP/USD`, `EURC/USD`, `AUD/USD` scoring 60-72 and repeatedly filling
`[SLEEPER]` slots. These are forex/fiat-stablecoin pairs, not crypto — Kraken lists them as
USD spot markets, but they have near-zero ATR against USD by definition and no "oversold
bounce" to ever find. Worse, their flat 24h change is exactly the sleeper heuristic's
"quiet, under the radar" profile, so they were winning sleeper slots meant for real quiet
crypto setups. With `AI_DECISIONS_PER_CYCLE=6` and ~2 sleeper slots reserved, 1-2 of six
decisions per cycle were plausibly being spent on pairs that can never produce a real trade
idea — a real, structural drag on "finding things to buy," not just the small-tradable-
capital and cash-target-conservatism explanation given earlier today.
**Verified:** `npm run build` and `npm test` clean; extended the existing
`filterDiscoveredMarkets` test in `logic-check.ts` with `EUR/USD`, `GBP/USD`, `EURC/USD`
fixtures, confirmed excluded the same way a USD stablecoin already was.
**Watch out:** Not yet observed on a live cycle post-deploy — the fiat pairs were present in
every cycle sampled before this fix; watch the next few `[SCAN]`/`[CANDIDATE]` log lines to
confirm they stop appearing, and whether real crypto candidates now occupy the slots they
were taking.

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
