# 03 — Modules & Repo Layout

Monorepo, **pnpm workspaces**, TypeScript. Core has no dependency on any
specific adapter.

```text
bremio/
├── apps/
│   ├── daemon/          # local HTTP + WebSocket, process spawning, worktrees
│   ├── cli/             # `bremio run ...`
│   └── vscode-extension/# UI panel (Phase 5, not the MVP)
├── packages/
│   ├── protocol/        # PlanSchema, TaskSchema, AgentEvent, TaskResult (Zod)
│   ├── orchestrator/    # lead-manager, scheduler, router, result-aggregator
│   ├── quota/           # quota-broker, quota-normalizer (consumes AI-Quota-Tray)
│   ├── workspace/       # worktree-manager, diff-manager, merge-manager
│   ├── adapter-sdk/     # AgentAdapter interface + AgentPluginManifest
│   ├── adapter-claude/
│   ├── adapter-codex/
│   ├── adapter-antigravity/
│   ├── adapter-opencode/   # (later)
│   └── adapter-jan/        # (later)
├── config/  agents.yaml · routing.yaml · policies.yaml
└── data/    bremio.db (SQLite)
```

## Responsibilities per package

**protocol** — the source of truth for data shapes. No logic. Zod schemas +
types. Every other package imports from here. A change here is a breaking
change.

**adapter-sdk** — defines `AgentAdapter` (see `04-adapters.md`) and
`AgentPluginManifest` (id, displayName, adapterFactory, supportedRoles,
configurationSchema). Adding a new provider = adding one package that
implements this interface.

**orchestrator** — `lead-manager` (selects/coordinates the lead),
`scheduler` (runs tasks by dependency order, sequential in Phase 1),
`router` (scoring to pick agent+model), `result-aggregator` (collects
TaskResults → report). **Knows nothing** about specific providers.

**quota** — `quota-broker` (queries quota, normalizes to `QuotaSnapshot`) +
`quota-normalizer`. **Consumes** AI-Quota-Tray instead of reading sources
itself (see 05).

**workspace** — manages git isolation. Details below.

**daemon** — the main process; holds state, spawns child processes (agent
CLI/SDK), streams events over WebSocket, manages worktree lifecycle, kills
on timeout.

## Workspace isolation (git worktree)

No agent is allowed to edit the same folder as another. One worktree per task:

```text
repo/
└── .bremio/worktrees/
    ├── TASK-001-claude/
    ├── TASK-002-codex/
    └── TASK-003-antigravity/
```

A task with dependencies starts from their completed branches. With multiple
dependencies, Bremio integrates those branches inside the new task worktree;
the user's base branch remains untouched. This is what lets test/review tasks
inspect the implementation they gate.

Lifecycle of a task at the workspace layer:

```text
create branch bremio/TASK-002-codex
→ git worktree add
→ run the agent inside that worktree
→ collect diff + test results + logs
→ (review) → merge the branch or cherry-pick each task-owned commit once the
  run clears the quality gate
→ git worktree remove (cleanup)
```

## Task contract & TaskResult (abridged)

```ts
interface TaskResult {
  taskId: string; agentId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  filesChanged: string[]; commandsExecuted: string[];
  tests: { command: string; passed: number; failed: number; exitCode: number }[];
  commitHash?: string; sessionId?: string;
  findings: Finding[];
}
```

Each task is granted `permissions` (`read-only` for analysis, test, and review;
`workspace-write` for implementation) and its own `worktree` path. See
enforcement limits in `04-adapters.md` (Antigravity **cannot** be forced
read-only in `-p` mode).
