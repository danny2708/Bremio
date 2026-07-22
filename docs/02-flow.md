# 02 — End-to-End Flow

## Mode selection

The user chooses `--mode single` or `--mode team`. Bremio does not silently
reinterpret Single as a one-task Team plan. `--lead` without `--mode` is kept
only as a backward-compatible spelling of Team; Auto is deferred.

## Single mode

```text
1. User enters one prompt + selects one agent.
2. Bremio records the current workspace state and warns if it is dirty.
3. Bremio calls that adapter exactly once with the original prompt, current
   repo path, workspace-write permission, and optional model/reasoning.
4. The adapter reads, edits, runs commands, and reports normally.
5. Bremio records events, provider identity/usage when reported, changed/dirty
   files, recognizable verification command evidence, and one report.
```

There is no `PlanSchema`, lead, router, scheduler, independent reviewer,
worktree, branch, aggregation model call, or `bremio merge` step in Single.
The selected adapter can still plan internally. Pre-existing dirty files are
reported separately because Bremio cannot attribute them to the run.

## Team mode

```text
1. User enters one prompt + picks a lead.
2. Session Manager creates a Run, picks the repo + base branch.
3. Lead Adapter receives the prompt → returns Plan JSON (PlanSchema).
4. Orchestrator VALIDATES the plan:
     - is the schema valid?
     - per task: is the capability available? permission reasonable?
       any dependency cycle?
     - which agents are eligible + still have quota?
5. Router assigns an agent+model to each task (scoring, see 05).
6. Scheduler runs the tasks (Phase 1: sequential, in dependency order):
     - creates a branch + a dedicated worktree for the task; dependent tasks
       inherit the completed dependency branches
     - calls adapter.startRun(request) → streams AgentEvent
     - collects the diff, test results, logs
7. Quality gate (Phase 2): require shell exit-code test evidence, structured
   findings from a reviewer other than the implementation author, and zero
   open blockers.
8. Result Aggregator collects every TaskResult into one report.
9. User reviews the report; approves the merge (manual in the MVP).
```

## Example Plan JSON (returned by the lead)

```json
{
  "summary": "Implement scheduled sync with retry, no duplicates",
  "leadAgentId": "claude-sonnet",
  "tasks": [
    { "id": "TASK-001", "title": "Analyze sync architecture",
      "kind": "analysis", "requiredCapabilities": ["repository.read"],
      "preferredAgents": ["claude"], "risk": "high", "dependencies": [],
      "acceptanceCriteria": ["Document retry strategy", "Identify dup-record risk"] },
    { "id": "TASK-002", "title": "Implement backend sync",
      "kind": "implementation",
      "requiredCapabilities": ["repository.write", "shell", "test"],
      "preferredAgents": ["codex", "claude"], "risk": "medium",
      "dependencies": ["TASK-001"],
      "acceptanceCriteria": ["Runs on schedule", "Exponential backoff",
        "No duplicate records", "Tests pass"] },
    { "id": "TASK-003", "title": "Run verification",
      "kind": "test", "requiredCapabilities": ["repository.read", "shell", "test"],
      "preferredAgents": ["codex", "claude"], "risk": "medium",
      "dependencies": ["TASK-002"],
      "acceptanceCriteria": ["Relevant test command exits 0"] },
    { "id": "TASK-004", "title": "Independent review",
      "kind": "review", "requiredCapabilities": ["repository.read", "review"],
      "preferredAgents": ["antigravity", "codex"], "risk": "medium",
      "dependencies": ["TASK-003"],
      "acceptanceCriteria": ["Review diff", "Return structured findings", "Report blockers"] }
  ]
}
```

## Router adjusts for quota (at runtime)

`preferredAgents` is only a hint. The router is allowed to change it:

```text
Claude quota high        → Claude does TASK-001 and possibly TASK-002 too
Claude low, Codex high   → Claude only leads; Codex takes TASK-002
Codex nearly exhausted    → Antigravity Flash takes the simple task; Claude
                            handles the important part
All quota data unknown    → apply only a soft penalty; preserve capable agents
```

## Invariant rules of the flow

- **Avoid self-review**: the agent that wrote the code must NOT be the sole
  reviewer of its own change (the router applies a heavy penalty — see 05).
- **Reserve lead quota**: keep some quota in reserve for the lead to do the
  final aggregation.
- **Cancelable**: any running task must be cancellable (Ctrl+C or the
  per-agent `--timeout <seconds>` hard limit); cancellation propagates to the
  active adapter and blocks dependent tasks.
- **Traceable**: every task logs enough to debug why it was assigned and how
  it ran.

## Final result (report)

Aggregated into: task list + agent that ran it + status, files changed,
test pass/fail, review findings (fixed/blocking), commit hash per worktree,
and provider-reported usage when available. Bremio does not estimate per-task
subscription quota consumption.

## Future Auto and escalation

Auto may later compare a calibrated Single baseline with Team and select Team
only when it preserves outcome and produces `net_gain > 0`. Manual Single→Team
escalation must require user approval because Team changes the execution shape
and introduces additional provider calls/worktrees. Neither behavior is part
of the current manual-mode milestone.
