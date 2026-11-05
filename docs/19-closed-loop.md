# 19 — Closed autonomy loop (docs/17 P2)

**Status:** implemented (P2-T1…T7). This note records the loop's states,
bounds and what is recorded. `docs/15` remains the authority on semantics.

## Order inside one Team run

```
plan ─▶ [checkpoint] ─▶ first pass ─▶ [re-plan ≤ maxReplans] ─▶ [fix ≤ maxFixIterations] ─▶ gate ─▶ DoD ─▶ [auto-PR]
```

Single runs: `agent turn ─▶ [--verify ─▶ fix turn ≤ maxFixIterations] ─▶ verification ─▶ DoD ─▶ [auto-PR]`.

## Error codes (P2-T1)

`RunOutcome.errorCode` (provider-level, classified once in `collectRun`) and
`TaskResult.errorCode` (adds Bremio verdicts: `verification_failed`,
`verification_missing`, `review_invalid`, `blocked_by_dependency`,
`missing_artifact`, `setup_failed`, `no_adapter`). Every loop decision switches
on these codes, never on message text.

## Plan checkpoint (P2-T2) — opt-in `--review-plan`

Runs after the lead's plan validates and before any worktree exists.
Approve / reject / edit. An edit is parsed with `PlanSchema` and re-validated
with `validatePlan`. Unanswerable checkpoints fail closed (docs/14 ADR-4): the
daemon auto-denies with no subscriber; the CLI rejects without a terminal.
Recorded as an approval request (target `plan:<runId>`, digest of the plan) and
`report.planCheckpoint` (proposed and executed digests).

## Re-plan (P2-T5) — opt-in `--max-replans` (default 0, max 3)

Trigger: a non-check task failed with `execution_failed`, `unknown`,
`missing_artifact` or `setup_failed`. Never for provider conditions (auth,
quota, rate limit, unavailable, timeout, cancel, session, no adapter). The lead
plans the remaining work only; completed tasks are prior results (inherited,
never re-run). The failed task and everything downstream are *replaced*
(kept in the report, excluded from gate/DoD). New ids may not collide; deps
must be new or completed tasks. Each re-plan is a planning ledger entry.

## Fix loop (P2-T3 Team, P2-T4 Single) — default 2 from CLI/daemon, 0 in the library

Team trigger: a test/review failed with a fixable code, or a review has open
blockers, about a completed implementation. One chain per iteration:
`FIX-n` (inherits the failing checks' dependencies) → `FIX-n-TEST`,
`FIX-n-REVIEW` (copies of the failing/related checks, same agents). The checks
it re-runs are *superseded*. Single: Bremio runs `--verify` via `CommandTool`
(policy-checked, process-supervised); failures go back to the agent in its
resumed session when resumable, else in a fresh turn carrying the original
request. The Bremio-run exit code is authoritative for verification.

Bounds (both modes): iteration cap; optional cost budget that **fails closed**
when any iteration's cost is unreported; cancellation; guard/stop requests;
policy — plan mode never writes, approve mode never lets Bremio run commands
unattended.

Statuses: `not-needed`, `disabled`, `passed`, `exhausted`, `stopped`,
`not-fixable` — every non-success status carries a named reason.

## Definition of done (P2-T6)

`report.definitionOfDone`: each acceptance criterion → `evidenced` (implementation
criteria need **both** a passing test command and a clean independent review
reaching that task), `failed`, or `unknown`. Informational; the quality gate
still decides mergeability.

## Auto-PR (P2-T7) — opt-in `--auto-pr`

Only on green (gate passed / verification passed). Team: completed,
non-superseded implementation branches are merged onto `bremio/pr-<runId>` in a
temporary worktree (the user's checkout is never touched), pushed, and opened
with `gh` through `GitOps.createPullRequest`. Single: only from an isolated
worktree branch. Refused under plan mode, and under approve mode (network needs
approval). Missing/unauthenticated `gh` or no GitHub remote is a named failure.
Known limitation: the branch is pushed before `gh` is checked, so a missing
`gh` leaves a pushed branch without a PR.

## What is recorded

| Where | What |
|---|---|
| `report.fixLoop` | status, reason, iterations (addresses, basedOn, taskIds, reasonsBefore, gateAfter, costUsd), superseded |
| `report.replan` | status, reason, per re-plan: blockers + codes, replaced, kept, added |
| `report.planCheckpoint` | decision, decidedBy, proposed/executed digests |
| `report.definitionOfDone` | criteria with evidence, verifications, summary |
| `report.autoPr` | status, reason, branch, url |
| `report.summary.superseded` | failures replaced by a later attempt (excluded from `failed`) |
| ledger | one task entry per fix/re-plan task; a planning entry per re-plan |
| daemon events | `status` per fix iteration / re-plan; `plan-checkpoint` request and decision |
