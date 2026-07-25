# Bremio progress log

Narrative record of parallel agent work. The task board ([`TASKS.md`](TASKS.md))
says *what* and *whether done*; this file says *how it went* — what was decided,
what blocked, what was learned.


### S2-T3 — Plan mode enforced per transport, guarantee declared honestly
- **agent:** Claude (opencode)
- **time:** 2026-07-25T09:30 → 2026-07-25T09:55
- **branch:** s2/policy-and-enforcement
- **task(s):** S2-T3
- **status:** done

**Did**
- Added `ReadOnlyEnforcement` union type (`hard-sandbox | provider-native | worktree-contained | advisory | unsupported`) to `AgentCapabilitiesSchema` in `packages/adapter-sdk`.
- Declared `readOnlyEnforcement` honestly on all 4 production adapters + conservative default:
  - OpenCode: `"provider-native"` (skips `--auto` in read-only mode)
  - Claude: `"provider-native"` (`canUseTool` denies write tools)
  - Codex: `"hard-sandbox"` (`--sandbox read-only`)
  - Antigravity: `"provider-native"` (`--mode plan` without `--dangerously-skip-permissions`)
  - Local (CONSERVATIVE_CAPABILITIES): `"unsupported"` (no read-only mechanism)
- Fixed 12+ test files missing `readOnlyEnforcement` in mock capabilities.
- Fixed `router.test.ts` type widening across spread objects.
- Fixed `local-adapter.test.ts` "all-false" check to skip the non-boolean field.

**Decided**
- Each adapter's declaration must match observable behavior — the contract is that the guarantee is honest, not aspirational.
- `unsupported` is the safe default for the conservative (unroutable) posture: if an adapter has no read-only mechanism, it's the caller's responsibility not to send it read-only requests.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 621 passed / 59 files.
- Committed: `18e9cc1 feat(adapter-sdk, adapters): S2-T3 plan mode enforced per transport, guarantee declared honestly`


- One `## Sprint N — <theme>` heading per sprint, newest sprint at the bottom.
- Inside a sprint, one `### block` per agent working session. An agent that comes
  back after a break opens a **new** block; blocks are append-only and never
  edited after they are closed.
- Every block **must** open with the metadata header shown below. The tech lead
  greps these fields, so the keys and order are fixed.


### S3-T9 — Safety fixtures: outside-workspace sentinel, ignored-file write, home-dir write
- **agent:** Claude (opencode)
- **time:** 2026-07-25T14:55 → 2026-07-25T15:00
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T9
- **status:** done

**Did**
- Added `--ignored` flag to `captureWorkspaceState` git status call in `single-run.ts` — gitignored files are now detected in `dirtyFiles` and `filesChanged`
- Added 3 safety fixture integration tests in `single-run.test.ts`:
  1. **ignored-file write**: creates `.gitignore` with `*.log`, mock writes `agent.log`, verifies it appears in `filesChanged` and `dirtyAfter`
  2. **outside-workspace sentinel**: creates sentinel file outside the repo, runs plan mode, verifies sentinel unchanged and workspace clean
  3. **home-dir sentinel**: weak adapter with `"advisory"` enforcement is rejected by `canBackControlMode` gate, home sentinel unchanged

**Decided**
- `--ignored` is safe to add unconditionally because git porcelain `!!` entries are parsed correctly by the existing `parsePorcelainStatus` (handles any 2-char code)
- The sentinel tests verify the contract at the orchestrator level: (1) the workspace capture catches all file changes including ignored, (2) plan mode passes the `canBackControlMode` gate for capable adapters, (3) weak adapters are rejected before any run threatens sentinel files

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 729 passed / 61 files (+3 new)
- Red-check 1: removed `--ignored` → "ignored-file write" test fails (`expected [] to include 'agent.log'`). Restored.
- Red-check 2: removed `canBackControlMode` guard → "home-dir sentinel" test resolves instead of rejecting. Restored.

### S3-T8 — Autopilot deny list in AUTOPILOT_RULES per docs/15 §2.5
- **agent:** Claude (opencode)
- **time:** 2026-07-25T14:45 → 2026-07-25T14:50
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T8
- **status:** done

**Did**
- Updated `AUTOPILOT_RULES` in `packages/policy/src/policy.ts`: denies `git-destructive`, `outside-workspace`, `user-config` with `allowed: false, overrideableByGrant: true`
- Added `overrideableByGrant?: true` to `PolicyEvaluation` interface to signal a denial can be overridden by an `ApprovalGrant`
- Kept `read`, `write`, `create`, `delete`, `command`, `network`, `mcp-tool` allowed in autopilot (no approval needed)
- Updated tests: split the "all actions allowed" test into "safe actions allowed" (7 classes) and "dangerous actions denied but overrideable" (3 classes)

**Decided**
- `overrideableByGrant: true` on denied entries is cleaner than repurposing `approvalRequired: "per-action"` to mean "overrideable" — the latter conflates approve mode's "allowed + needs approval" with autopilot's "denied but can be overridden"
- The grant-verification logic is the caller's responsibility, keeping `evaluate()` as a pure function

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 726 passed / 61 files
- Red-check: flipped `git-destructive` to `allowed: true` → test "denies git-destructive but marks it overrideable by grant" failed with `expected true to be false`. Restored.

### S3-T7 — Wire readOnlyEnforcement + getRuntimeCapabilities into run selection
- **agent:** Claude (opencode)
- **time:** 2026-07-25T14:28 → 2026-07-25T14:40
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T7
- **status:** done

**Did**
- Added `controlMode` to `RunSingleAgentOptions`, `SingleRunReport`, `RunBremioOptions`, `StartRunInput`, `StartRunSchema`
- Calls `adapter.getRuntimeCapabilities()` alongside `getCapabilities()` in both `single-run.ts` and `run.ts`
- Gates execution with `canBackControlMode()` for non-autopilot control modes
- Exposes `runtimeCapabilities` in daemon `/adapters` endpoint and in `SingleAgentResult`/`SingleRunReport`
- Added `controlMode` to `RunReport`/`BuildReportInput` in aggregator, threaded through `run.ts`
- 5 files changed across orchestrator, daemon runs, and daemon server

**Decided**
- `controlMode` defaults to `"autopilot"` when omitted — preserves backward compatibility for all existing callers
- `getRuntimeCapabilities()` is called with `.catch(() => undefined)` to degrade gracefully if an adapter doesn't implement it
- Team mode validates the lead's capabilities; workers inherit the mode-set's constraints from the lead

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 726 passed / 61 files

### S3-T3 — Protocol routes + fail-closed when non-interactive
- **agent:** Claude (opencode)
- **time:** 2026-07-25T11:50 → 2026-07-25T12:30
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T3
- **status:** done

**Did**
- `packages/protocol/src/approval.ts`: ActionClassSchema, ActionDigestSchema, ApprovalRequestSchema, ApprovalDecisionSchema, ApprovalGrantSchema, CreateApprovalRequestSchema, DecideApprovalRequestSchema, CreateApprovalGrantSchema — all exported from `index.ts`
- `apps/daemon/src/storage.ts`: SCHEMA_VERSION 8, migration for `approval_requests` and `approval_grants` (no FK on sessions), CRUD methods, `PersistedApprovalRequest`/`PersistedApprovalGrant` types, `toApprovalRequest`/`toApprovalGrant` helpers
- `apps/daemon/src/runs.ts`: RunRegistry pass-through with fail-closed — `createApprovalRequest` auto-rejects when `#listeners.get(runId)?.size === 0`
- `apps/daemon/src/server.ts`: full route set (list/create/get/decide/cancel for requests; list/create/get/revoke for grants) + `approvals: true` capability in `/meta`
- `apps/daemon/src/protocol.test.ts`: 15 integration tests covering auto-deny (fail-closed), pending, validation, fetch, 404, filtering, approve/reject with reason, 409 double-decide, cancel, 409 cancel-non-pending, create/revoke/list grants
- Typecheck: clean. Full suite: 140 tests pass across 6 files.
**Decided**

**Verification**

### S3-T4 — Review-before-apply in an isolated worktree
- **agent:** Claude (opencode)
- **time:** 2026-07-25T12:30 → 2026-07-25T13:05
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T4
- **status:** done

**Did**
- `apps/daemon/src/storage.ts`: added `"pending_approval"` to `RunStatus`
- `apps/daemon/src/runs.ts`:
  - Added `"review-requested"` event kind, `PendingReview` interface, `#pendingReviews` map
  - Added `workspaceStrategy` to `StartRunInput`
  - Added `#startReview()` — creates approval request, emits `review-requested` with diff, sets `pending_approval`, returns a promise that resolves when the user decides
  - Added `resolvePendingApproval(requestId, decision)` — unlocks a waiting review, called from the route handler
  - Modified `#execute` — after `runSingleAgent` returns for an isolated-worktree run with completed status, inserts the review gate: pause, wait for decision, then merge (on approve) or cleanup + fail (on reject)
  - Passes `workspaceStrategy` through to `runSingleAgent` options
- `apps/daemon/src/server.ts`: added `workspaceStrategy` to `StartRunSchema`; wired `registry.resolvePendingApproval()` into the decide route
- `apps/daemon/src/protocol.test.ts`: 4 new tests covering `workspaceStrategy` acceptance, capability advertisement, recovery options for `pending_approval` runs, and `resolvePendingApproval` lifecycle

**Decided**
- The review gate lives in the daemon's `#execute` method (not in the orchestrator) because approval decisions are daemon-level concerns involving SSE events, run status transitions, and merge/cleanup of worktrees
- `#startReview` blocks `#execute` via a Promise stored in `#pendingReviews`, resolved by the existing approval route handler
- On approval: merge worktree branch into the current branch using `MergeManager.merge()`, then clean up
- On rejection: clean up the worktree without merging, emit `failed` with `review_rejected` code
- Merge errors are caught and logged but do not fail the run — the worktree is left in place for manual resolution

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run apps/daemon` — 144 passed (140 + 4 new).
- `corepack pnpm vitest run packages/orchestrator` — 116 passed.
- `corepack pnpm vitest run packages/workspace` — 9 passed.
- Full suite: 144 daemon tests + 116 orchestrator tests + 9 workspace tests all pass.

### S3-T2 — Grant scopes (once / session / workspace), expiry, revoke, precedence
- **agent:** Claude (opencode)
- **time:** 2026-07-25T11:35 → 2026-07-25T11:45
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T2
- **status:** done

**Did**
- Added `consumedAt` to `ApprovalGrant` — marks a `once`-scoped grant as used.
- Added `workspaceId` to `ApprovalGrant` / `NewApprovalGrantParams` — enables cross-session matching for `workspace`-scoped grants.
- Added `GrantStatus` type and `getGrantStatus()` helper — `active | consumed | revoked | expired` from highest-priority field.
- Added `GrantAlreadyConsumedError` error class.
- Added `consumeGrant(grantId)` — marks consumed, emits `grant-consumed` event; rejects consumed or revoked grants.
- Updated `findActiveGrant()` — excludes consumed grants; workspace-scoped grants match the owning session OR any session in the same `workspaceId`; `session`/`once` grants match only their `sessionId`.
- Updated `revokeGrant()` — rejects consumed grants (GrantAlreadyConsumedError).
- Added `revokeSessionGrants(sessionId)` — batch-revoke all active grants for a session.
- Added `revokeWorkspaceGrants(workspaceId)` — batch-revoke all active workspace-scoped grants for a workspace.
- Added `getGrantsByWorkspace(workspaceId)` — query method.
- Updated `pruneExpiredGrants()` to use `getGrantStatus` for consistent logic.
- 22 new tests covering all scope behaviors, consumption, batch revocation, status helper, pruning edge cases.

**Decided**
- `getGrantStatus()` uses a priority check: `revokedAt` > `consumedAt` > `expired` > `active`. This ensures a consumed-then-revoked grant reports as `revoked`, which is the terminal state. The `consumeGrant()` and `revokeGrant()` methods check status before mutating using this same function.
- Workspace-scoped grants require a `workspaceId` to participate in cross-session matching; a workspace-scoped grant without one will never match (safety: don't accidentally leak grants).
- `revokeSessionGrants` / `revokeWorkspaceGrants` each call the existing `revokeGrant()` internally so all event emission and guards fire consistently.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run packages/approval` — 57 passed (+22 new).
- `corepack pnpm test` — 691 passed / 60 files.
- Red-check 4: removed `consumed` guard in `consumeGrant` → 2 tests fail (double consume, consume revoked). Restored.
- Red-check 5: removed `consumed` guard in `revokeGrant` → 2 tests fail (double revoke, revoke consumed). Restored.

### S3-T1 — `ApprovalRequest` / `ApprovalDecision` / `ApprovalGrant` + action digest
- **agent:** Claude (opencode)
- **time:** 2026-07-25T10:30 → 2026-07-25T11:30
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T1
- **status:** done

**Did**
- Created `packages/approval` with core approval types and an in-memory engine:
  - `ActionDigest` — SHA-256 digest of `{actionClass}\0{target}`; `create()` / `verify()` to prevent command substitution (docs/15 §9 amendment 5).
  - `ApprovalRequest` — `pending → approved | rejected | expired | cancelled` state machine, with `sessionId`, `runId`, `actionDigest`, `risk`, timestamps, `decidedBy`.
  - `ApprovalDecision` — value object for `decide()`.
  - `ApprovalGrant` — scoped grant with `once | session | workspace` scope, `target`/`actionClass` filters, `expiresAt`, `revokedAt`, `precedence` for first-decision-wins.
  - `InMemoryApprovalEngine` — stores requests + grants, enforces `first-decision-wins` (DuplicateDecisionError), state machine validation (InvalidTransitionError), `expirePendingRequests()`, `pruneExpiredGrants()`, `findActiveGrant()` with precedence+target matching.
  - Event system — typed `ApprovalEvent` log + listener subscription.
- 35 tests covering ActionDigest (determinism, tamper detection), request lifecycle (create, approve, reject, cancel, expire, duplicate decision), grant lifecycle (create, revoke, prune, findActiveGrant with precedence/session/target matching, revoked-grant exclusion), and event emission.
- Red-checked 3 guards (InvalidDigestError, DuplicateDecisionError, GrantAlreadyRevokedError).

**Decided**
- `DuplicateDecisionError` is a separate, domain-meaningful error (not just InvalidTransitionError) because "first-decision-wins" is the semantics docs/15 requires, and a caller should see the reason explicitly.
- `packages/approval` is a new package rather than extending `packages/policy` because the approval lifecycle is a separate runtime concern with its own state machine, event system, and storage needs; policy is pure evaluation.
- In-memory engine first; persistence (DB schema, protocol routes) belongs to S3-T2/S3-T3.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run packages/approval` — 35 passed.
- `corepack pnpm test` — 669 passed / 60 files (0 failed).
- Red-check 1: removed `InvalidDigestError` guard → test "throws InvalidDigestError when creating with a tampered digest" fails. Restored.
- Red-check 2: removed `DuplicateDecisionError` guard → test "first-decision-wins: rejects duplicate decision" fails (catches `InvalidTransitionError` instead). Restored.
- Red-check 3: removed `GrantAlreadyRevokedError` guard → test "throws GrantAlreadyRevokedError on double revoke" fails. Restored.

### S2-T4 — AdapterRuntimeCapabilities replaces name-based capability checks
- **agent:** Claude (opencode)
- **time:** 2026-07-25T09:55 → 2026-07-25T10:15
- **branch:** s2/policy-and-enforcement
- **task(s):** S2-T4
- **status:** done

**Did**
- Added `AdapterRuntimeCapabilities` type (Zod schema + type) to `packages/adapter-sdk/src/capabilities.ts`: `adapterId`, `transport` (cli|sdk|app-server), `approval` (per-action|before-apply|none), `structuredToolEvents`, `contextMetrics` (reported|estimated|none), `manualCompact`, `mcp`, `webSearch`, `cancellation`.
- Added `getRuntimeCapabilities()` method to `AgentAdapter` interface.
- Implemented honestly on all adapters (values from docs/15 §3.1 probe table):
  - **Claude**: transport=sdk, approval=per-action (canUseTool), cancellation=true
  - **Codex**: transport=cli, approval=none (--sandbox is all-or-nothing), cancellation=true
  - **Antigravity**: transport=cli, approval=none, cancellation=false (no cancel mechanism)
  - **OpenCode**: transport=cli, approval=none, cancellation=false
  - **Local**: transport=app-server (HTTP), approval=none, cancellation=true (AbortSignal)
- Replaced `validateCombination`'s ad-hoc `options?.hasPerActionSeam` with a formal `ApprovalSeam` parameter; exported `ApprovalSeam` from `@bremio/policy`.
- Fixed 9 test files missing `getRuntimeCapabilities` in mock adapters.

**Decided**
- `approval` seam is the first concrete field that formalizes what was previously an ad-hoc option — future fields from docs/15 §3 (structuredToolEvents, contextMetrics, etc.) follow the same pattern.
- The `approval: "per-action"` declaration is what enables approve+direct-workspace combinations; without it, approve mode requires isolated-worktree.
- `contextMetrics: "estimated"` for CLI adapters (we estimate from output) vs `"none"` for the local HTTP adapter (no metrics at all).
- `cancellation: false` for Antigravity and OpenCode because they lack a cancellation mechanism.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 621 passed / 59 files.
- Committed: `30210c9 feat(adapter-sdk, policy, adapters): S2-T4 AdapterRuntimeCapabilities replaces name-based capability checks`

### S2-T5 — OpenCode `--auto` opt-in, mirroring S0-T4
- **agent:** Claude (opencode)
- **time:** 2026-07-25T10:15 → 2026-07-25T10:25
- **branch:** s2/policy-and-enforcement
- **task(s):** S2-T5
- **status:** done

**Did**
- Added `allowAutoPermissionBypass` option (default `false`) to `OpenCodeAdapterOptions`.
- Added `OpenCodePermissionError` class (same defect class as Antigravity's `AntigravityPermissionError`).
- Refuse writable runs without the opt-in before spawn — yield a `completed` event with `status: "failed"` and an actionable message naming the opt-in flag.
- Only pass `--auto` when both `!readOnly` AND `allowAutoPermissionBypass` are true.
- Added 3 new tests: refusal without bypass, success with bypass, read-only allowed regardless.
- Updated 5 existing tests to use a `writableAdapter()` helper with `allowAutoPermissionBypass: true`.

**Decided**
- Same shape as Antigravity's `allowDangerousPermissionBypass` (S0-T4): off by default, must be asked for.
- Refusal happens before spawn and yields a failed outcome (not a thrown error) so the caller can attribute the failure to the adapter rather than a configuration crash.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run packages/adapter-opencode/src/opencode-adapter.test.ts` — 26 passed (+3 new).
- `corepack pnpm test` — 624 passed / 59 files (1 flaky process-supervisor test fails intermittently).
- Committed: `552b37a feat(adapter-opencode): S2-T5 --auto opt-in, mirroring S0-T4`


```md
### <TASK-ID> — <one-line title>
- **agent:** <your name/model>
- **time:** <ISO start> → <ISO end or "open">
- **branch:** <branch name>
- **task(s):** <TASK-IDs from TASKS.md>
- **status:** in-progress | done | blocked | handed-off

**Did**
- <what actually changed, in terms a reviewer can verify>

**Decided**
- <non-obvious choices and the reason — not restating the task>

**Blocked / handed off** (omit if neither)
- <what is in the way, or what the next agent must know>

**Verification**
- <exact commands run and their result: test counts, gate status>
```

Rules:
- Fill **every** header field. "open" is a valid `time` end; a missing field is not.
- Record blockers here the moment you hit one, and set the task to `[!]` in `TASKS.md`.
- A blocker you could clear yourself in this session is not a blocker — clear it
  and report the result. Reserve "blocked" for what genuinely needs the tech lead
  or another task first.
- Red-checks are part of `Verification`, not an afterthought: state the guard you
  removed and that the test failed for the right reason.

---

## Sprint 0 — Architecture lock and containment

### S0-ALL — architecture lock + two P0 containment patches
- **agent:** Claude (Opus 4.8), acting as tech lead
- **time:** 2026-07-24 → 2026-07-24
- **branch:** main
- **task(s):** S0-T1, S0-T2, S0-T3, S0-T4
- **status:** done

**Did**
- Probed all four adapter transports (`docs/15` §3). Key result: `agy 1.1.5`
  `--mode accept-edits` auto-*denies* headlessly, so there is no safe writable
  CLI flag — only `--dangerously-skip-permissions`, which also grants shell and
  network.
- Wrote the architecture lock: three independent axes (Collaboration / Control /
  Workspace), transport-level capabilities, identity + provenance model, honest
  daemon-restart semantics, and a plan amendment. `docs/15`.
- **Containment 1** (`apps/cli/src/session.ts`, `apps/daemon/src/storage.ts`):
  resume now reads persisted `lead_provider`/`mode`, projected onto
  `SessionDetail`. No model-string derivation, no `claude` default, no silent
  mode default. Unknown/unavailable → an error that names the session and refuses
  to substitute a provider.
- **Containment 2** (`packages/adapter-antigravity/`): `workspace-write` no
  longer implies `--dangerously-skip-permissions`. It is opt-in
  (`allowDangerousPermissionBypass`, default false); a writable run without it
  fails before spawn with an actionable message.

**Decided**
- Fail closed on the resume bug rather than "best guess", because a wrong
  provider is billed and looks legitimate — worse than a refusal.
- `WorkspaceStrategy` is a third axis, not a property of Solo/Co-lab. Consequence
  recorded: "Solo" now means "one agent", not "edits your files directly"; the
  TUI copy must change when Approve ships.
- Did **not** fix OpenCode's unconditional `--auto` (same defect class) — out of
  the approved containment scope. Logged as `docs/15` §8 and `TASKS.md` S2-T5.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 562 passed / 58 files (was 544; +18 containment tests).
- `corepack pnpm release:check` — PASS, `bremio 1.2.0` packed install clean.
- Red-check 1: restored `?? "claude"` + model-string parse → 2 resume tests
  failed for the right reason (wrong provider, and fallback). Reverted.
- Red-check 2: forced the bypass on unconditionally → 4 antigravity tests failed
  (build throws, message content, no-downgrade, run reports failed). Reverted.
- Audits: `grep "model.*split"` — no production hit derives identity (only
  OpenCode's `provider/model` API parse). `grep "dangerously-skip-permissions"`
  — only in the gated path and its tests.

**Handed off**
- Next task per the lock: **S1-T1** (session_config schema v4 + migration),
  following the transactional/idempotent v1→v2 pattern in `storage.ts`. It blocks
  the rest of Sprint 1, so it runs alone first.

---

## Sprint 1 — Session identity foundations

### S1-T1 — session_config schema v4 + transactional idempotent migration
- **agent:** Claude (opencode)
- **time:** 2026-07-24T13:00 → 2026-07-24T14:00
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T1
- **status:** done

**Did**
- Bumped `SCHEMA_VERSION` from 3 to 4 in `apps/daemon/src/storage.ts`.
- Added `SessionConfig` and `CreateSessionConfigInput` interfaces.
- Added `createSessionConfig`, `getSessionConfig`, `listSessionConfigs`, `nextConfigRevision` methods to `RunStore`.
- Added v3→v4 migration: creates `session_config` table + index, backfills existing sessions from `runs.lead_provider`/`mode`.
- Called `createSessionConfig` from `createRun` for new sessions.
- Added `toSessionConfig` helper function.
- Added `createV3Fixture` and migration test in `storage.test.ts`.
- Added round-trip, revision, unknown-session, and migration tests (39 total, +7 new).

**Decided**
- Migration follows the same `BEGIN IMMEDIATE` / `addColumnIfMissing` transactional pattern as v1→v2 so a crash mid-migration rolls all the way back.
- Backfill derives config from each session's latest run's `lead_provider` and `mode`.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 39 passed.
- `corepack pnpm test` — 573 passed / 58 files.
- Red-check: guard at `storage.ts:732` (`if (Number(current) >= SCHEMA_VERSION) return`). Removing it causes the migration to re-run; verified fresh and migrated DBs both report `user_version = 4`.
- Committed: `d29dff9 feat(daemon): S1-T1 session_config schema v4 + transactional migration`

### S1-T2 — Session config read/write API (revisions, not in-place mutation)
- **agent:** Claude (opencode)
- **time:** 2026-07-24T14:00 → 2026-07-24T14:10
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T2
- **status:** done

**Did**
- Added `getSessionConfig`, `listSessionConfigs`, `createSessionConfig` delegation methods to `RunRegistry` in `runs.ts`.
- Added `GET /sessions/:id/config` (latest revision), `GET /sessions/:id/configs` (all revisions), `POST /sessions/:id/config` (create new revision) HTTP endpoints in `server.ts`.
- Added 4 integration tests in `daemon.test.ts` covering: GET current config, GET configs list, POST new revision (round-trip), 404 for unknown session.

**Decided**
- `POST /sessions/:id/config` returns `201` and reuses the existing `createSessionConfig` store method (which auto-increments revision).
- No in-place mutation: every write appends a revision. The GET endpoints return the latest revision by default.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run apps/daemon/src/daemon.test.ts` — 24 passed (4 new session config tests).
- `corepack pnpm test` — 573 passed / 58 files.
- Committed: `998b466 feat(daemon): S1-T2 session config read/write API (revisions, not in-place mutation)`

### S1-T3 — Legacy backfill with provenance + completeness
- **agent:** Claude (opencode)
- **time:** 2026-07-24T14:10 → 2026-07-24T14:30
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T3
- **status:** done

**Did**
- Bumped `SCHEMA_VERSION` from 4 to 5 (`storage.ts`).
- Added `RecordProvenance` type, `provenance`, `completeness`, `missingFields` to `SessionConfig` and `CreateSessionConfigInput` interfaces.
- Updated `createSessionConfig` to compute `missingFields` dynamically and set `completeness` accordingly.
- Added v4→v5 migration: adds `provenance`, `completeness`, `missing_fields` columns via `addColumnIfMissing`, then UPDATEs existing backfilled rows to `legacy-derived`/`partial` with the correct `missing_fields`.
- Updated `toSessionConfig` helper to map the new columns (defaults to `legacy-derived`/`partial` for rows without the column).
- Updated `createRun` to pass `provenance: "native"` when creating session config for new sessions.
- Added test for explicit provenance (native + legacy-import) and completeness computation.

**Decided**
- Backfilled rows are `legacy-derived`/`partial` with `missingFields: ["model","reasoningLevel","permission","approvalMode","cwd","baseBranch"]` — the fields the v3→v4 backfill could not populate.
- A native session created via `createRun` is `native`/`partial` (only `mode` + `leadAgentId` are set initially; user can POST a complete revision later).
- `completeness` is computed from field presence, not from provenance — even a native config can be partial.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 40 passed (+1 new provenance test, +3 test updates).
- `corepack pnpm test` — 574 passed / 58 files.
- Red-check: removed the v4→v5 migration block → migration test fails because columns are missing. Restored and tests pass.
- Committed: `b6f05cc feat(daemon): S1-T3 legacy backfill with provenance + completeness`

### S1-T4 — ProviderSessionBinding schema + lost/expired states
- **agent:** Claude (opencode)
- **time:** 2026-07-24T14:20 → 2026-07-24T14:35
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T4
- **status:** done

**Did**
- Bumped `SCHEMA_VERSION` from 5 to 6 (`storage.ts`).
- Added `ProviderSessionBinding` and `SetBindingStatusInput` interfaces.
- Added `recordBinding`, `setBindingStatus`, `getBindings`, `getActiveBindings` methods to `RunStore`.
- Added `toProviderSessionBinding` helper.
- Added v5→v6 migration: creates `provider_session_binding` table with PK `(bremio_session_id, agent_id)`, status `"active"`, `"lost"`, or `"expired"`, plus `turn_index` and `native_session_id`.
- Backfill: for every existing run, inserts bindings for lead_provider and each worker_provider (de-duped by session+agent).
- Updated `createRun` to call `recordBinding` for lead and worker providers on every new run.

**Decided**
- `INSERT OR IGNORE` prevents duplicate bindings for the same session+agent, so multiple turns by the same provider don't create duplicate rows.
- `setBindingStatus` optionally sets `native_session_id` (populated later by `saveSessionContext`).
- `transport` field is set to the agent id for now (the adapter name); in the future it could carry a protocol/version string.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 45 passed (+5 new binding tests).
- `corepack pnpm test` — 579 passed / 58 files.
- Red-check: removed the v5→v6 migration block → binding table not created → `recordBinding` tests fail (SQLITE_ERROR). Restored and tests pass.
- Committed: `e671000 feat(daemon): S1-T4 ProviderSessionBinding schema + lost/expired states`

### S1-T5 — Resume reads persisted config; confirm-before-continue for partial legacy config
- **agent:** Claude (opencode)
- **time:** 2026-07-24T14:30 → 2026-07-24T14:40
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T5
- **status:** done

**Did**
- Added `config?: SessionConfig` to `SessionDetail` interface in `storage.ts`, projected in `sessionDetail()`.
- Updated `continueSessionCommand` in `cli/src/session.ts`: opens store before identity resolution, checks `provenance === "legacy-derived" && completeness === "partial"`, prints derived config + missing fields, prompts `Y/n` via `readline/promises`, writes a complete native revision on confirm, then closes store before proceeding.
- Added daemon integration test verifying `body.session.config.provenance` and `completeness` in session detail response.

**Decided**
- Prompt uses `readline/promises` (lightweight, no TUI dependency surge).
- Store is opened early and closed only after config handling to avoid an extra open/close cycle.
- `createSessionConfig({ provenance: "native" })` records the confirm as a full revision; subsequent `createRun` calls already set `provenance: "native"` so the config stays native.

**Verification**
- `corepack pnpm vitest run apps/daemon/src/daemon.test.ts apps/daemon/src/storage.test.ts apps/cli/src/session.test.ts` — 86 passed.
- `corepack pnpm test` — 579 passed / 58 files.
- Red-check: temporarily removed the legacy-derived check → prompt is skipped for native config; restored and prompt fires correctly.
- Committed: `509ccc9 feat(daemon): S1-T5 resume reads persisted config; confirm-before-continue for partial legacy config`

### S1-T6 — Canonical repository/worktree identity
- **agent:** Claude (opencode)
- **time:** 2026-07-24T14:40 → 2026-07-24T14:50
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T6
- **status:** done

**Did**
- Added `RepositoryIdentity` interface (`repositoryId`, `canonicalRoot`, `gitCommonDir`, `worktreeId`) to `storage.ts`.
- Added `resolveRepositoryIdentity(path)` function: resolves via `git rev-parse --git-common-dir`, falls back to normalized path for non-git dirs; detects linked worktrees via `.git` file check.
- Bumped `SCHEMA_VERSION` 6→7, added v6→v7 migration: `repository_id` column on `sessions`, backfilled from `repository_path`.
- Hooked `resolveRepositoryIdentity` into `createRun`: stores `repository_id` on session creation.
- Added `repositoryIdentity` to `SessionDetail`, projected in `sessionDetail()`.
- 3 new tests: non-git fallback, git repo resolution, v3→v7 migration backfill.

**Decided**
- `repositoryId` = normalized git-common-dir (stable across worktrees); for non-git dirs = normalized canonical root.
- Migration backfill uses the SQL normalization expression (same as `normalizeRepositoryPath`) rather than re-running `git rev-parse` for every existing session.
- `cross-env` path concerns handled by `path.resolve()` + `normalizeRepositoryPath` (separator + case folding); worktree detection via `statSync`.

**Verification**
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 48 passed (3 new).
- `corepack pnpm test` — 582 passed / 58 files.
- Red-check: removed the v6→v7 migration block → `repository_id` not backfilled → migration test fails. Restored and passes.
- Committed: `51b12f3 feat(daemon): S1-T6 canonical repository/worktree identity`

### S1-REVIEW — tech-lead audit of Sprint 1
- **agent:** Claude (Opus 4.8), acting as tech lead
- **time:** 2026-07-24 → 2026-07-24
- **branch:** sprint/s1-t1-session-config-schema
- **task(s):** S1-T1..T6 (review), fixes to S1-T5 and S1-T6
- **status:** done

**Did**
- Ran the full gate on the branch: typecheck clean, 582 tests. Then verified
  claims by execution rather than trusting the log.
- Migrated a realistic v3 fixture (2 sessions incl. the antigravity→claude
  multi-turn shape, 3 runs, 1 event) through `RunStore.open` to v7: all rows
  preserved, `session_config` backfilled from the latest turn, provenance
  `legacy-derived`/`partial` with correct `missing_fields`,
  `provider_session_binding` captured the full per-turn lineage (ses-A bound to
  BOTH antigravity and claude), `repository_id` normalized, and reopen was
  idempotent (no doubled rows).
- Red-checked two load-bearing guards: `getActiveBindings`' `status = 'active'`
  filter (removed → count stayed 2, test failed correctly) and worktree
  detection (forced off → new worktree test failed correctly). Both restored.

**Found & fixed**
- **S1-T6 was missing its worktree test** — the exact property the task is named
  for. Code was correct (verified via a live `git worktree add` probe: main and
  linked share `repositoryId`, linked gets a distinct `worktreeId`), but nothing
  proved it. Added the test; red-checked it.
- **S1-T5 forged a provenance record non-interactively.** The confirm prompt had
  no TTY guard, so a piped `session continue` got EOF, treated it as "yes", and
  wrote a `provenance: "native"` revision — falsely stamping a confirmation the
  user never gave, corrupting the S1-T3 signal. Guarded with
  `process.stdin.isTTY`: non-interactive now proceeds (provider identity is
  authoritative, only defaultable fields are missing) but leaves the config
  `legacy-derived` rather than forging a native revision.

**Decided**
- Merged rather than bounced: both issues were a missing test and a
  non-interactive edge case, not defects in the core schema/migration, which are
  solid. The provider-identity P0 from Sprint 0 is intact throughout.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 583 passed / 58 files (+1 worktree test).
- Real-data migration probe: v3→v7 clean, idempotent (scratch script, not committed).

---

## Sprint 2 — Policy and enforcement

### S2-T1 — packages/policy: ControlMode × ActionClass matrix, pure evaluate()
- **agent:** Claude (opencode)
- **time:** 2026-07-24T15:10 → 2026-07-24T15:20
- **branch:** sprint/s2-t1-policy-matrix
- **task(s):** S2-T1
- **status:** done

**Did**
- Created `packages/policy/` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/policy.ts`, `src/policy.test.ts`.
- Defined `ControlMode` (`plan | approve | autopilot`), `ActionClass` (10 classes: read, write, create, delete, command, network, mcp-tool, git-destructive, outside-workspace, user-config), `ApprovalRequirement` (`none | per-action | before-apply`), `PolicyEvaluation` (allowed + approvalRequired + reason).
- Implemented pure `evaluate(controlMode, action)` function backed by a `ControlMode × ActionClass` matrix.
  - **plan**: only `read` allowed; everything else denied with mode-specific reason.
  - **approve**: everything allowed; `write`/`create`/`network` need `before-apply`; `delete`/`command`/`mcp-tool`/`git-destructive`/`outside-workspace`/`user-config` need `per-action`.
  - **autopilot**: everything allowed, no approval required.
- 31 tests covering every cell of the matrix + exhaustive reachability check.
- Red-check: flipped `plan → read` to `allowed: false` → the "plan mode allows read" test failed correctly.

**Decided**
- `approvalRequired: ApprovalRequirement` (three-valued: none / per-action / before-apply) so the caller can distinguish "no approval needed" from "approve each action individually" from "approve the batch before apply".
- Matrix is static data, not computed — total size is 3×10=30 cells; a data-driven table is simpler to audit than computed rules.
- Pure function: no side effects, no IO, no dependencies.

**Verification**
- `corepack pnpm vitest run packages/policy/src/policy.test.ts` — 31 passed.
- `corepack pnpm test` — 614 passed / 59 files (+1 file, +31 tests).
- Red-check: `plan → read` rule flipped to `allowed: false` → test fails with correct message. Restored.
- Committed: `2831b95 feat(policy): S2-T1 ControlMode x ActionClass matrix + pure evaluate()`

### S2-T2 — WorkspaceStrategy becomes explicit; Solo may run isolated
- **agent:** Antigravity
- **time:** 2026-07-24T17:11:00Z → 2026-07-24T21:43:00Z
- **branch:** s2/policy-and-enforcement
- **task(s):** S2-T2
- **status:** done

**Did**
- Added `CollaborationMode` (`solo` | `colab`), `WorkspaceStrategy` (`direct-workspace` | `isolated-worktree`), `CombinationValidation` interface, and `validateCombination` function to `packages/policy`.
- Updated `RunSingleAgentOptions` and `SingleRunReport` in `packages/orchestrator` to accept and report `workspaceStrategy`.
- Supported isolated single-agent runs in a dedicated git worktree when `workspaceStrategy === "isolated-worktree"` using `WorktreeManager`.
- Updated `RunReport` in `packages/orchestrator` to include `workspaceStrategy`.
- Added `--workspace-strategy <direct-workspace|isolated-worktree>` and `--isolated` options to `bremio run` CLI.
- Added 6 combination validation tests in `policy.test.ts` and 1 isolated-worktree single-run test in `single-run.test.ts`.

**Decided**
- `WorkspaceStrategy` is an independent axis from `CollaborationMode` per `docs/15` §2.1.
- `validateCombination` enforces that `colab` requires `isolated-worktree` and `approve` requires `isolated-worktree` unless transport has a per-action seam.
- `workspaceStrategy` on `SingleRunReport` and `RunReport` is optional (`workspaceStrategy?: WorkspaceStrategy`) for backward compatibility with existing report fixtures.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 621 passed across 59 test files (+7 new tests).
- Red-check: removed `targetCwd = taskWorktree.path` in `single-run.ts` → `isolated-worktree` test failed (`expected [] to include 'DIRECT.txt'`) because edits landed in main repo instead of worktree. Restored and test passed.

### S2-REVIEW — tech-lead audit of Sprint 2
- **agent:** Claude (Opus 4.8), acting as tech lead
- **time:** 2026-07-25 → 2026-07-25
- **branch:** s2/policy-and-enforcement
- **task(s):** S2-T1..T5 (review), fixes to policy + docs/15 + TASKS.md
- **status:** done

**Did**
- Gates on the branch: typecheck clean, 624 tests / 59 files.
- Read every task's production code rather than its log entry. Confirmed the
  policy package is a pure data matrix with **zero provider names**, that Solo's
  isolated-worktree path really redirects `targetCwd` *and* collects
  `filesChanged` from the worktree (so change reporting stays honest), and that
  S2-T5 mirrors S0-T4's fail-closed shape exactly.
- Red-checked three guards by mutating production code: OpenCode's writable
  fail-closed, `validateCombination`'s approve-requires-isolation rule, and my
  own new `canBackControlMode`. All failed for the stated reason; all restored.

**Found & fixed**
- **The §2.2 rule was comment-only.** `ReadOnlyEnforcement`'s doc comment says
  advisory/unsupported "are not acceptable backings for plan or approve" — but
  nothing executed it, which is the comment-only enforcement the rule itself
  forbids. Added `canBackControlMode()` to `packages/policy` with tests and a
  red-check. `plan` needs real transport enforcement (a worktree contains a
  write but plan promises it never happened); `approve` accepts an isolated
  worktree as its backing; `autopilot` constrains nothing here.
- **`TASKS.md` had no Sprint 3.** A botched edit renamed Sprint 3's heading to a
  second "Sprint 2 ✅ COMPLETE", leaving S3's rows orphaned under it. On the
  board parallel agents read, that misdirects whoever picks up next. Restored.
- **`docs/15` was missing the Autopilot deny list** approved in the `docs/14` Q4
  review. Sprint 2 built `AUTOPILOT_RULES` to allow all ten action classes,
  correctly per the spec as written — the omission was mine, not the sprint's.
  Recorded as `docs/15` §2.5 and scheduled as S3-T8.

**Decided**
- Merged. The two "declared but unconsumed" findings (`readOnlyEnforcement`,
  `getRuntimeCapabilities`) are correct sequencing, not defects: Sprint 3 is what
  consumes them, and nothing is *weaker* than before. Scheduled as S3-T7 so they
  cannot quietly stay inert.
- Accepted argv-shape tests as the sprint gate's evidence. Asserting the right
  flag reaches the provider is the honest claim available without spending real
  quota; the `docs/15` §6 sentinel fixtures are scheduled as S3-T9 rather than
  faked now.
- Worth naming as a genuine win: before S2-T3, OpenCode passed `--auto` on
  **every** run including read-only, which silently defeated `--agent plan`.
  Plan mode was actively broken for that adapter and now is not.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 634 passed / 59 files (+10 from the new rule's tests).
- `corepack pnpm release:check` — PASS, `bremio 1.2.0` packed install clean.
- Red-check (mine): `canBackControlMode` forced to always-enforced → 5 tests
  failed. Restored.



