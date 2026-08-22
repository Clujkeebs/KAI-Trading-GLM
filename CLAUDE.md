# CLAUDE.md

Claude Code reads this file automatically. Read these in order before anything else:

1. **[SOUL.md](SOUL.md)** — the trading model's mandate, supplied as prompt input.
2. **[AGENTS.md](AGENTS.md)** — commands, invariants and conventions for this repo.

The runtime also supplies **[PLAYBOOK.md](PLAYBOOK.md)** as the operator's trading method;
the charter outranks it if they disagree. The full playbook archive is
**[docs/the-crypto-playbook.md](docs/the-crypto-playbook.md)**. **[CLAUDE.md](CLAUDE.md)**
is this Claude Code entry point, and **[COLLAB.md](COLLAB.md)** is the shared change log
between coding agents.

Everything in `AGENTS.md` applies to you as written; this file adds nothing on top of it.

Quick start:

```bash
npm install && npm run build && npm test
```

Real money moves when `PAPER_MODE=false`. Never place a live order to test a change, and
never claim a live path is verified without live logs.
