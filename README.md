# Bremio

> A provider-agnostic orchestrator that turns AI coding agents
> (Claude Code, Codex, Antigravity, …) into one coordinated team.
>
> **Different minds. One team.**

You prompt from **one place**; a **lead** (Claude by default, swappable)
analyzes the request and proposes a plan; a **provider-agnostic orchestrator**
assigns tasks to the right agents, isolates them via git worktrees, and
aggregates the results back into one place. ROI goal: **get the most out of
the models with the least quota.**

## Status
**Design phase** — no code yet. Full design lives in [`docs/`](docs/).
Start at [`docs/README.md`](docs/README.md); read
[`docs/99`](docs/99-risks-and-open-questions.md) before writing any code.

## Core principles
- Orchestrator is provider-agnostic — Claude is only the *default lead*.
- Lead **proposes** the plan; the orchestrator **executes** it (swapping the
  lead doesn't require rewriting the core).
- Single-agent is a valid flow; multi-agent is chosen only when
  `outcome ≥ single-agent baseline` and `net_gain > 0`.
- Don't rebuild the quota reader — consume `AI-Quota-Tray`.
- No UI-extension scraping; use official programmatic surfaces.

## MVP (Phase 1)
Claude (lead) + Codex (worker), sequential. See
[`docs/06-roadmap.md`](docs/06-roadmap.md).

## Stack (planned)
Node 22 · TypeScript · pnpm workspaces · Zod · SQLite · simple-git · Pino · Vitest.
Adapters: Claude Agent SDK · Codex app-server/exec · Antigravity `agy -p` (pty).
