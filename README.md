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
**Phase 1 (vertical slice) implemented**, plus a Phase-2/Phase-4 slice
(`bremio merge` + usage ledger / `bremio stats`) — Claude (Agent SDK) + Codex
(`codex exec --json`) as swappable lead/worker, a validator, a sequential
scheduler, git-worktree isolation, review-gated merge, and the CLI. Full design
lives in [`docs/`](docs/); start at [`docs/README.md`](docs/README.md). Still out
of scope (see [`docs/06`](docs/06-roadmap.md)): Antigravity, quota-aware routing,
parallelism, dashboard.

## Quickstart
Prerequisites: **Node 22+**, **pnpm** (via `corepack`), the **`codex`** CLI on
`PATH` and logged in (`codex login`), and Claude auth for the Agent SDK
(`ANTHROPIC_API_KEY` or a Claude Code login).

```sh
corepack pnpm install
corepack pnpm test          # 44 tests (incl. a mock-adapter end-to-end run)
corepack pnpm typecheck

# check adapter health / lead-eligibility
corepack pnpm bremio doctor

# one prompt -> lead plans -> orchestrator hands a task to the OTHER agent,
# which edits code in its own git worktree; results aggregate into one report
corepack pnpm bremio run --lead codex --repo /path/to/repo "add a health endpoint"
corepack pnpm bremio run --lead claude --repo /path/to/repo "fix the failing test"

# review a completed task's diff, then merge it into the base branch
corepack pnpm bremio merge TASK-002 --repo /path/to/repo          # prompts y/N
corepack pnpm bremio merge --run <runId> --repo /path/to/repo --yes

# summarize the usage ledger
corepack pnpm bremio stats --repo /path/to/repo
```

Each task runs in `.<repo>/.bremio/worktrees/<taskId>-<agent>/` on branch
`bremio/<taskId>-<agent>`; per-task logs and `report.json` land in
`<repo>/.bremio/runs/<runId>/`. Press **Ctrl+C** to cancel an in-flight run.

`bremio run` never merges — worktrees are **left for review**. `bremio merge`
shows the diff, asks for confirmation (or `--yes`), then merges into the base
branch (`--no-ff`) and cleans up the worktree + branch; conflicts abort cleanly.
Every task also appends a line to `.bremio/ledger.jsonl` (measurement only, no
routing yet), summarized by `bremio stats [--since <date>]`.

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
