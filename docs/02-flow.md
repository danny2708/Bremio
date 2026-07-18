# 02 — End-to-End Flow

## Flow of a single run (a "Run")

```text
1. User enters one prompt + picks a lead (or Auto).
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
All cloud agents low      → local (Jan) reads code / builds a test skeleton
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
estimated quota spent.

## The single-agent branch (decided at steps 4–5)

Before decomposing, the orchestrator asks: is this task **simple enough**
for one agent to complete end-to-end? If so → **zero-delegation**: the lead
does it itself, or hands it entirely to one agent (no multi-task plan, no
extra worktrees). This is the default for small tasks and the baseline
against which every multi-agent flow is compared (see `05` §Efficiency).
Multi-agent is only chosen when it beats the baseline **and** `net_gain > 0`.
