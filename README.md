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
**Phase 1 (vertical slice) implemented** — Claude (Agent SDK) + Codex
(`codex exec --json`) as swappable lead/worker, a validator, a sequential
scheduler, git-worktree isolation, and the `bremio run` CLI. Full design lives
in [`docs/`](docs/); start at [`docs/README.md`](docs/README.md). Out of scope
for Phase 1 (see [`docs/06`](docs/06-roadmap.md)): Antigravity, quota/routing,
parallelism, auto-merge, quality gates, dashboard.

## Quickstart
Prerequisites: **Node 22+**, **pnpm** (via `corepack`), the **`codex`** CLI on
`PATH` and logged in (`codex login`), and Claude auth for the Agent SDK
(`ANTHROPIC_API_KEY` or a Claude Code login).

```sh
corepack pnpm install
corepack pnpm test          # 32 tests (incl. a mock-adapter end-to-end run)
corepack pnpm typecheck

# check adapter health / lead-eligibility
corepack pnpm bremio doctor

# one prompt -> lead plans -> orchestrator hands a task to the OTHER agent,
# which edits code in its own git worktree; results aggregate into one report
corepack pnpm bremio run --lead codex --repo /path/to/repo "add a health endpoint"
corepack pnpm bremio run --lead claude --repo /path/to/repo "fix the failing test"
```

Each task runs in `.<repo>/.bremio/worktrees/<taskId>-<agent>/` on branch
`bremio/<taskId>-<agent>`; per-task logs and `report.json` land in
`<repo>/.bremio/runs/<runId>/`. Worktrees are **left for manual review — no
auto-merge**. Press **Ctrl+C** to cancel an in-flight run.

## Packages
`protocol` (Zod contracts) · `adapter-sdk` (the `AgentAdapter` interface) ·
`adapter-claude` · `adapter-codex` · `orchestrator` (lead-manager, validator,
router, scheduler, aggregator) · `workspace` (worktrees + logs) · `apps/cli`.

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
