# 03 — Modules & Repo Layout

Monorepo, **pnpm workspaces**, TypeScript. Core has no dependency on any
specific adapter.

```text
bremio/
├── apps/
│   ├── daemon/          # local HTTP + SSE, run state, process spawning
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
│   └── adapter-opencode/
├── config/  routing.yaml
└── ~/.bremio/bremio.db     # daemon state (SQLite, outside the repo)
```

## Responsibilities per package

**protocol** — the source of truth for data shapes, including the explicit
`single | team` execution-mode discriminator. No logic. Zod schemas + types.
Every other package imports from here. A change here is a breaking change.

**adapter-sdk** — defines `AgentAdapter` (see `04-adapters.md`) and
`AgentPluginManifest` (id, displayName, adapterFactory, supportedRoles,
configurationSchema). Adding a new provider = adding one package that
implements this interface.

**orchestrator** — `single-run` (one direct adapter pass-through in the current
workspace), `lead-manager` (selects/coordinates the Team lead),
`scheduler` (runs dependency-ready tasks concurrently while serializing git),
`router` (scoring to pick agent+model), `result-aggregator` (collects
TaskResults → report). **Knows nothing** about specific providers.

**quota** — asks AI-Quota-Tray to refresh through its authenticated loopback
API, then reads AQT's schema-v1 SQLite cache read-only and normalizes
provider/bucket freshness for `bremio capacity`. It **consumes** AI-Quota-Tray
instead of reading provider sources itself (see 05); scored routing is explicit
opt-in while automatic mode remains gated on calibration. Its canonical `QuotaProvider`
contract supports multiple account windows, per-model windows, source age, and
confidence. Quota is intentionally separate from `AgentAdapter`.

**workspace** — manages Team git isolation and shared durable logs. Single uses
the current workspace and only reuses the logging primitive. Details below.

**daemon** — the main process; holds state, spawns child processes (agent
CLI/SDK), streams events, manages worktree lifecycle, kills on timeout.

**Implemented 2026-07-18.** `apps/daemon` binds `127.0.0.1` on an ephemeral
port and publishes the port plus a per-launch token to `~/.bremio/daemon.json`,
the same trust model Bremio already uses for AI-Quota-Tray. Endpoints:
`GET /health`, `/ready`, `/meta`, `/adapters`, `/capacity`, `/runs`,
`/runs/:id`, `/diff`; `POST /runs`, `/runs/:id/cancel`, `/runs/:id/retry`,
`/merge`, `/shutdown`.

Lifecycle: `bremio daemon [start|status|stop|restart]`.

### Single instance

Two daemons publishing to the same discovery file would hand clients a port and
token that disagree, so exactly one runs per user. The lock is an exclusive
file create at `~/.bremio/daemon.lock`, which two simultaneous starts cannot
both win.

**A PID is not evidence of ownership.** The operating system reuses PIDs, so a
lock left by a crashed daemon can point at an unrelated process that started
later. Liveness is proven by an authenticated request to the advertised port —
only a real daemon answers it. Anything else is stale and the lock is
reclaimed, and **no process is ever signalled**: `daemon stop` asks through
`/shutdown` rather than killing a PID it cannot prove is Bremio's.

### Durable state

Runs, events and artifact pointers live in SQLite at `~/.bremio/bremio.db`,
never inside a target repository. Sequence numbers are allocated inside the
same transaction as the row insert, with a `(run_id, seq)` primary key, and
continue across a restart rather than resetting. Event payloads are redacted of
anything credential-shaped and capped before they touch disk.

The daemon holds only live plumbing in memory: cancellation handles and current
subscribers. A UI attaching mid-run replays from the store, and a reconnect
resumes from its last sequence number instead of losing or duplicating events.

Terminal runs older than 30 days are pruned at startup, always keeping the 50
newest. Active and interrupted runs are never pruned — interrupted still needs
a decision from the user.

### Recovery

Startup marks anything left `queued`/`running` as `interrupted`, not `failed`:
the daemon dying says nothing about whether the task would have succeeded.
Retry creates a new run linked by `retryOfRunId` and never modifies the
original, whose events are the record of what went wrong.

`GET /runs/:id` reports `recovery: { canRetry, canResume, canOpenWorkspace }`.
`canResume` is always false because no adapter can resume mid-run; offering it
would silently start over.

### Protocol

`/meta` advertises `protocolVersion`, `minimumClientProtocol` and a capability
set so a version mismatch is reported in words instead of a generic failure.
`/ready` is separate from `/health`: the port accepts connections before
storage is open, so clients wait on readiness.

SSE ids are `<runId>:<seq>` with a named `event:` type. An id from another run
is ignored rather than trusted. A stream over an already-terminal run closes
instead of hanging.

**Streaming is Server-Sent Events.** docs originally specified a WebSocket; the only
streaming direction is server to client; every command is a plain POST. SSE
covers that on `node:http` with no added dependency. Revisit if a genuinely
bidirectional feature arrives.

Merge goes through the daemon with the CLI's invariants intact: the quality
gate must have passed, the repo must be on the base branch, and tracked changes
block it. A GUI button is not a reason to skip the checks that protect the
working tree.

**vscode-extension** — a client of the daemon, never an owner of the
orchestrator. It depends on no `@bremio/*` package: the extension host is shared
with the rest of the editor, so a hung provider must not be able to take VS Code
down with it. It spawns `bremio daemon` when one is not already reachable.

## Workspace behavior by mode

Single uses the current repo path directly, warns on pre-existing dirty files,
and creates no Bremio branch/worktree. Team uses git worktree isolation:

No Team agent is allowed to edit the same folder as another. One worktree per task:

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
  requestedModel?: string; actualModel?: string;
  requestedReasoningLevel?: string; actualReasoningLevel?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  commitHash?: string; sessionId?: string;
  findings: Finding[];
}
```

Each task is granted `permissions` (`read-only` for analysis, test, and review;
`workspace-write` for implementation) and its own `worktree` path. See
per-provider enforcement in `04-adapters.md` (Antigravity enforces read-only
through `agy --mode plan`).

## Known limitations (updated 2026-07-22)

Stated plainly rather than left to be discovered:

- **Windows tree termination is confirmed but is not a Job Object guarantee.**
  `ProcessSupervisor` centrally owns spawned children, snapshots descendants,
  uses `taskkill /T` with forced escalation, and verifies every known PID is
  gone. Daemon-wide shutdown terminates runs sequentially to avoid WMI/taskkill
  contention. A descendant created during the taskkill walk can still escape;
  closing that gap requires a Job Object or an equivalent stronger mechanism.
- **SDK cancellation is cooperative.** Claude has no child process Bremio can
  kill. The supervisor aborts the SDK call and reports success only after the
  in-process work settles; otherwise the run becomes `cancellation_failed`.
- **A run in flight does not resume after a daemon crash.** It is marked
  `interrupted` and can be retried, which starts fresh. No adapter exposes a
  safe mid-run resume, so `capabilities.resume` is advertised as false.
- **A process still alive after a hard crash is handled best-effort.** The lock
  is reclaimed because ownership cannot be proven, but nothing is signalled.
- **Retry policy is deliberately unintelligent.** Bounded attempts, no adaptive
  backoff, no provider reputation. Those need evidence Bremio does not have,
  and a wrong guess spends real quota.
- **The extension panel is dark-only.** A light variant is a CSS block away but
  is not implemented.
- **POSIX verification needs a real Linux/WSL environment.** The repository has
  `pnpm posix:verify` for process groups, lock/discovery permissions, SQLite,
  SSE, and cancellation. It cannot run through a Windows-only Node process;
  the latest local audit was blocked because no WSL distribution was installed.
