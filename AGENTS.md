# AGENTS.md

Rules for any agent working in this repository. Read `SOUL.md` first — it explains what
this system is for and whose side you are on. This file is the mechanics.

## What this is

A single-process TypeScript worker. Each cycle it reconciles the Kraken account, reviews
open positions, scans the watchlist, and asks the model for decisions. `src/index.ts` holds
the whole bot; `test/` holds four suites. Real money moves when `PAPER_MODE=false`.

## Commands

```bash
npm install
npm run build            # tsc — must pass before you commit
npm test                 # four suites, no network
npm run doctor           # live preflight against Kraken + the model (needs keys)
npm run dev              # single paper cycle
npm run dev:loop         # continuous
```

Run `npm run build` and `npm test` on every change. There is no separate lint step; `tsc`
is the gate. `npm run doctor` needs real credentials — if you do not have them, say the
live path is unverified rather than implying you checked it.

## Verifying a change without credentials

Unit tests prove the maths; they cannot prove a live path executes. For anything touching
orders, sizing, balances or the AI call, run a paper cycle end to end and quote the log
lines that prove the new path ran. A local OpenAI-compatible mock pointed at by
`AI_BASE_URL` is the way to drive specific model responses (valid JSON, truncated JSON,
empty content, provider rejecting `response_format`).

Never place a live order to test something.

## Invariants

Breaking any of these is a defect regardless of what the tests say:

- Stops only ever tighten, and are clamped by `MAX_STOP_DISTANCE_PCT`.
- Orders must satisfy free cash and Kraken's amount, cost and precision rules.
- `EXCLUDED_ASSETS` holdings are never traded, adopted, scanned or counted as tradable.
- Cost basis and P/L come from actual fills, never from the requested quantity.
- Ambiguous live order failures are not retried automatically.
- State writes are atomic; unreadable state is backed up, not discarded.
- Indicators use closed candles only — no repainting between cycles.
- `Procfile` stays `worker: npm start`, and the loop stays continuous by default. Railway
  restarts anything that exits.

## Conventions

- Keep it in `src/index.ts` unless a change genuinely needs a new module. Follow the
  surrounding style: explicit types on exported functions, `null` for "not configured"
  rather than sentinel numbers, `envBoolean`/`envNumber`/`optionalEnvInteger` for config.
- Extract pure logic (ranking, parsing, risk math) into exported functions so it can be
  tested without an exchange. That is what the existing suites do.
- Log lines are the only production debugger. Use the existing `[PHASE 1]`,
  `[BALANCE]`, `[ORDER SKIP]`, `[MIN SIZE]`, `[AI]` style prefixes, and make a skipped
  action state *why* it was skipped — a silent skip is how every expensive bug here hid.
- Comments are rare and describe the code, not the change you made.
- Never modify a test so it passes. Fix the code or explain why the test is wrong.
- `ccxt` is pinned to `4.5.0` on purpose: later releases broke the runtime with
  `ERR_REQUIRE_ESM`. Do not bump it casually.
- New config goes in `.env.example` **and** the README table, with its default.

## Environment and deployment

- Required: `AI_API_KEY`, `KRAKEN_API_KEY`, `KRAKEN_API_SECRET`. Kraken needs Trade
  permission only — never withdrawal.
- `PAPER_MODE=false` means real money. Booleans are case-insensitive (`False`, `0`, `no`).
- The host filesystem is ephemeral (Railway), so `DATA_DIR` state can vanish at any
  redeploy. Exchange reconciliation is the source of truth, never local JSON alone.
- Never commit `.env`, keys, or logs containing account values you were sent privately.

## Working style

- Push to `main` unless a PR is asked for. Small, focused commits with a message that says
  what changed and why.
- Prefer fixing a diagnosed cause over adding a knob. If you cannot name the mechanism,
  you are guessing — go read the code path first.
- When you report back: lead with anything that failed or stayed unverified, then what
  changed. No claim of live-verified behaviour without live logs.
