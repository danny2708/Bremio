# 06 — Roadmap (by phase)

Principle: **prove the cheap thing before building the expensive one.** No
dashboard/quota/parallelism before the core loop runs.

## Phase 1 — Vertical slice (the real MVP)
Only **Claude (lead) + Codex (worker)**, **sequential**. Both return plan
JSON → enough to prove lead-swapping + delegation. (Antigravity isn't in yet
because it can't produce JSON — see 04.)

**Implementation status (2026-07-18):** shipped. Local typecheck, 54 tests,
and `bremio doctor` pass. A fresh two-provider real-run verification remains
blocked by the Claude session limit reported at runtime; do not mark this phase
fully closed until it is rerun after the reset.

**Done criteria:**
```
✓ a single prompt
✓ can pick Claude OR Codex as lead
✓ lead returns a valid plan JSON (matching PlanSchema)
✓ orchestrator hands off ≥1 task to a DIFFERENT agent
✓ that agent edits code in its own worktree
✓ single-agent path exists (lead does it itself / hands the whole small
  task to one agent)
✓ results are aggregated into one report
✓ a task can be cancelled
✓ logs exist for debugging
```
Not needed yet: dashboard, parallelism, auto-merge, quota, Antigravity,
OpenCode/Jan.

## Phase 1.5 — Antigravity worker
Add the Antigravity adapter: **pty wrapper** (guards against non-TTY
swallowing output), reviewer/implementer runs in a **throwaway worktree**.
Not allowed to be the lead.

## Phase 2 — Lead swap (already possible since P1) + quality gate opens up
Add independent review (avoid-self-review), test gate, conflict detection,
manual approval before merge. Every lead still returns the same PlanSchema.

**Implementation status (2026-07-18):** shipped locally. Dependent task
worktrees inherit upstream branches; test tasks are read-only and expose shell
exit-code evidence; reviews return structured findings and are assigned away
from the implementation author; reports compute a fail-closed gate; and
`bremio merge` refuses missing/failed gates. Fresh Claude+Codex verification is
pending the Claude session reset.

## Phase 3 — Full worktree lifecycle
Diff/merge manager, cherry-pick, worktree cleanup, reliable kill-on-timeout.

**Early slice shipped:** `bremio merge` previews a gate-approved task's diff,
requires confirmation (or `--yes`), merges with `--no-ff`, then removes its
worktree and branch; conflicts abort cleanly. `bremio run --timeout <seconds>`
applies a hard limit to every planning attempt and task, propagates cancellation
to the provider adapter, and blocks downstream tasks. Automatic merge and
cherry-pick remain future work.

## Phase 4 — Quota-aware routing + efficiency (see 05)
Usage ledger → consume AI-Quota-Tray → single-vs-multi decision +
kill-switch → scoring router + calibration gate. Enforce the `net_gain > 0`
invariant.

**Early slice shipped:** a measurement-only ledger and `bremio stats`. No
quota source, cost fields, routing, kill-switch, or `net_gain` enforcement is
implemented yet.

## Phase 5 — Parallel + VS Code extension
Run tasks in parallel (PQueue/BullMQ), panel UI. UI is just a surface; the
value lives in the daemon.

## Phase 6 — Additional providers
OpenCode (HTTP), Jan (local worker = near-free capacity). Each one = one
adapter package.

## First sprint (7 items)
1. pnpm TS monorepo. 2. `AgentAdapter` + `PlanSchema` + `TaskSchema`.
3. Claude adapter. 4. Codex adapter. 5. Sequential scheduler.
6. Worktree manager. 7. CLI `bremio run`.
Checkpoint: review the schemas + AgentAdapter **before** coding the adapters.
