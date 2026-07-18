# 01 — Architecture & Core Concepts

## Principle #1

**The orchestrator is independent of every provider.** Claude is only the
*default lead*, not "the core system." If Codex/Antigravity/OpenCode/Jan
becomes the lead later, the core must not need to be rewritten.

## Layer diagram

The entry layer dispatches explicit manual modes. Single calls one adapter
directly; Team enters the orchestration stack shown below. Auto is not yet an
execution path.

```text
                    ONE PROMPT UI
          VS Code panel / CLI / Antigravity
                        │
                        ▼
┌──────────────────────────────────────────────────────┐
│                  TEAM ORCHESTRATOR                    │
│  Session Mgr   Lead Mgr    Scheduler                  │
│  Quota Broker  Router      Policy Engine              │
│  Worktree Mgr  Event Stream Result Aggregator         │
└───────────────────────────┬──────────────────────────┘
                            │  provider-agnostic AgentAdapter protocol
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                     ▼
  Claude Adapter      Codex Adapter       Antigravity Adapter
  (Agent SDK)         (app-server/exec)   (Python SDK sidecar)
        └───────────────────┼────────────────────┘
                            ▼
                  Future adapters (OpenCode / Jan)
```

## Core concept 1 — Lead is a ROLE, not a separate adapter

Wrong: `class ClaudeLead`, `class CodexLead`. Right: one shared `AgentAdapter`
contract; any adapter with `capabilities.planning === true` and
`structuredOutput === true` is **eligible to be the lead**.

One `Agent Profile` (e.g. Claude Sonnet) can hold multiple `Role assignments`
within the same run: `lead`/`planner` in one moment, `implementer` of
TASK-002 in another.

## Core concept 2 — Lead only PROPOSES, the Orchestrator EXECUTES

```text
prompt → lead produces a normalized Plan JSON
       → orchestrator checks: quota, capability, permission,
         dependencies, conflicts, model availability
       → only then does the scheduler assign tasks
```

The lead **never** directly runs Codex/Antigravity, never reads quota
itself, never merges itself. This means swapping the lead only changes who
creates the plan, not the execution layer.

## Core concept 3 — Capabilities decide the role, not the provider name

```ts
interface AgentCapabilities {
  planning: boolean; structuredOutput: boolean;
  repositoryRead: boolean; repositoryWrite: boolean;
  shell: boolean; testing: boolean;
  browser: boolean; vision: boolean; resumableSessions: boolean;
}
```

The router maps *task needs* → *capability* → *actual agent+model*. Model
names (sonnet, gpt-5.6-sol, gemini-flash) are **never hardcoded in core** —
each adapter maps them internally.

## Core concept 4 — Isolation is mode-specific

Single intentionally modifies the selected current workspace directly and
warns when that workspace is already dirty. Team tasks run in their **own git
worktrees**, returning diffs/commits for quality-gated review before merging.
Details in `03-modules.md` §workspace.

## The three backbone schemas

`PlanSchema` (what the lead returns) · `TaskSchema` (unit of work handed
off) · `TaskResult` (what an agent returns). Defined in `packages/protocol`.
Every lead must return the **same** `PlanSchema` — this is what makes
lead-swapping possible.
