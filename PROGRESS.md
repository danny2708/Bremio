# Bremio progress log

Narrative record of parallel agent work. The task board ([`TASKS.md`](TASKS.md))
says *what* and *whether done*; this file says *how it went* — what was decided,
what blocked, what was learned.


## How this file is structured

- One `## Sprint N — <theme>` heading per sprint, newest sprint at the bottom.
- Inside a sprint, one `### block` per agent working session. An agent that comes
  back after a break opens a **new** block; blocks are append-only and never
  edited after they are closed.
- Every block **must** open with the metadata header shown below. The tech lead
  greps these fields, so the keys and order are fixed.

## Block template — copy this exactly

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




---

## Sprint 3 — Approval lifecycle

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

## Sprint 4 — One source of truth

### S4-T7 — Daemon startup reconciliation → `interrupted` / `supervision_lost`
- **agent:** Claude (opencode)
- **time:** 2026-07-26T17:40 → 2026-07-26T17:45
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T7
- **status:** done

**Did**
- Added `supervision_lost` to `RunStatus` union and `TERMINAL_STATUSES` in `storage.ts` — a terminal status distinct from `interrupted`, signalling the daemon lost track of a child process that may still be alive.
- Changed `reconcileOnStartup()` in `runs.ts` to differentiate by prior run status: `running` → `supervision_lost` with `failureCode: "supervision_lost"` and message about child process; `queued`/`cancelling` → `interrupted` with `failureCode: "daemon_restart"`.
- Updated `RunningDaemon.reconciled` doc in `index.ts` to reflect the split.
- Modified existing lifecycle test: "marks a running run as supervision_lost, not interrupted". Two new tests: "marks a queued run as interrupted", "marks a cancelling run as interrupted, not supervision_lost".
- Confirmed existing cancellation test ("reconciles a run stranded mid-cancellation") still expects `interrupted` — unchanged.
- Added terminal-status test in `storage.test.ts` verifying both `supervision_lost` and `interrupted` are `isTerminal()`.
- VSCode extension webview does not include `supervision_lost` in its rendering — not fixed in this task (falls back to "bad" badge; acceptable).

**Decided**
- `supervision_lost` is a separate terminal status (not a subclass of `interrupted`) so that clients can distinguish "daemon died during active execution" from "daemon restarted while the run was queued". The child process of a `supervision_lost` run may still be alive — the daemon just lost the pipe.
- The VSCode webview type and badge rendering is out of scope: `supervision_lost` falls through to the "bad" badge and shows the failure message, which is not ideal but not broken. Fixing it belongs in a future panel UX task.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 768 passed / 63 files (+2 tests, was 766).
- Red-check: removed `if (run.status === "running")` branch → "marks a running run as supervision_lost" test fails with `expected 'interrupted' to be 'supervision_lost'`. Restored.

### S4-T1 — Shared daemon client + version/capability handshake
- **agent:** Claude (opencode)
- **time:** 2026-07-25T15:00 → 2026-07-25T15:10
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T1
- **status:** done

**Did**
- Created `packages/daemon-client/` (new shared package) with:
  - `DaemonClient` class: `connect()` (discover endpoint + health check), `waitUntilReady()` (poll `/ready`), `handshake()` (GET `/meta` + `checkProtocolCompatibility`), `get()`/`post()` authenticated HTTP helpers
  - Error types: `DaemonUnavailableError`, `ProtocolMismatchError` (with `RemedyKind` for actionable diagnostics)
  - `daemonEndpointPath()` — canonical path for `~/.bremio/daemon.json`
  - 10 tests: connect success, missing endpoint, unresponsive daemon, handshake match, daemon too old, client too old, waitUntilReady, endpoint caching, endpoint+meta accessors, default constructor
- Added path alias and vitest alias for `@bremio/daemon-client`
- Refactored CLI `reportDaemonStatus()` to use `DaemonClient` — now performs version/capability handshake alongside status display
- Updated `SPRINT-LOG.md`

**Decided**
- The VS Code extension keeps its own `BremioClient` (zero-dep constraint per docs/14 M1-T1 design decision) — the shared package is for the CLI and future clients
- `ProtocolMismatchError` extends `DaemonUnavailableError` so callers can catch the base error and optionally inspect the specific mismatch
- The handshake delegates to `checkProtocolCompatibility` from `@bremio/protocol` — the canonical implementation, not a copy

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 741 passed / 62 files (+10 new daemon-client tests, +1 new test file)
- Red-check: removed the `if (!compatibility.compatible)` guard in `handshake()` → both "daemon too old" and "client too old" tests resolve instead of throwing `ProtocolMismatchError`. Restored.

### S4-T2 — `bremio run` starts runs through the daemon
- **agent:** Claude (opencode)
- **time:** 2026-07-25T15:10 → 2026-07-26T14:52
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T2
- **status:** done

**Did**
- Added `startRun()`, `streamEvents()`, `cancelRun()`, `runDetail()` to `DaemonClient` class in `packages/daemon-client/src/client.ts`
- Added `RunEvent`, `StartRunRequest` types to daemon-client
- Exported new symbols from `packages/daemon-client/src/index.ts`
- Added 4 new tests (14 total): startRun via POST /runs, SSE streaming, cancel 404, cancel success
- Updated fake daemon in tests to handle /runs, /runs/:id/events, /runs/:id/cancel with pathname-based URL matching
- Added `runViaDaemon()` function in `apps/cli/src/index.ts` that connects to daemon, POSTs the run, streams SSE events, handles Ctrl-C cancellation
- Wired daemon path into `runCommand()`: attempts daemon first when mode is resolved, falls back to in-process if daemon unavailable

**Decided**
- When daemon is not running, `runViaDaemon` returns `false` silently (graceful fallback, no error shown)
- SSE events printed with `kind` bold prefix + message; no fancy formatting yet (can improve in follow-up)
- Ctrl-C handler reuses AbortController pattern: first Ctrl-C cancels via `cancelRun()`, second forces exit

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 745 passed / 62 files (+4 daemon-client tests)
- Red-check A: SSE pathname matching with query string — fake daemon's earlier `endsWith("/events")` failed for `?afterSeq=0`; switched to URL pathname-based matching
- Red-check B: cancel test's standalone server missing `/health` — `connect()` threw `DaemonUnavailableError`; added `/health` route

### S4-T3 — SSE rendering + cancellation parity with the in-process path
- **agent:** Claude (opencode)
- **time:** 2026-07-26T14:55 → 2026-07-26T15:44
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T3
- **status:** done

**Did**
- Added `renderRunEvent()` pure function in `apps/cli/src/ui.ts` that maps daemon `RunEvent` objects through the same `renderEvent()` + `formatEventView()` pipeline as the in-process path, giving parity in output format
- Rewrote `runViaDaemon()` in `apps/cli/src/index.ts` to use `renderRunEvent()` for rich SSE event rendering instead of raw kind+message output
- Matched cancellation messages exactly to in-process path: `"⚠ cancelling run (Ctrl+C again to force)…"` (was `"⚠ cancelling run…"`)
- Added post-stream run summary via `client.runDetail()` — displays status glyph and file count after stream ends
- Added `--json` mode support to daemon path: collects all events into an array, fetches final run detail, prints `{ run, events }` as JSON
- Added 7 unit tests for `renderRunEvent()` covering: known events through data pipeline, unknown kind fallback, failed→error mapping, tool_use/tool_result with data, started type, lead default fallback
- Updated `TaskStatus` import in `index.ts` for `statusGlyph()` call

**Decided**
- `renderRunEvent()` lives in `ui.ts` (alongside `formatEventView()`) rather than inline, so it's testable without mocking the daemon
- High-level daemon event kinds ("status", "lead", "plan", "finished") are not known to `renderEvent()` so they render as `[kind]` fallback — same behavior as `assembleTaskLanes()` in the event-view package; the important parity is that `task-event` with embedded agent data goes through the full agent rendering pipeline
- `--json` mode in daemon path buffers all events then prints at end, which trades real-time output for a clean JSON report — acceptable for scripting use

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 752 passed / 62 files (+7 new renderRunEvent tests)
- Red-check A: removed `"failed" → "error"` mapping guard → `renderRunEvent({ kind: "failed", message: "connection refused" })` returns `[failed]` instead of `✗ connection refused`. Restored.
- Red-check B: removed `dataObj` branch guard → `renderRunEvent` with tool_use in data falls back to message text `"Wrote src/index.ts"` instead of rich output `"→ write src/index.ts"`. Restored.

### S4-T4 — Default-path cutover; `--standalone` marks runs `not-shared`
- **agent:** Claude (opencode)
- **time:** 2026-07-26T15:45 → 2026-07-26T16:20
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T4
- **status:** done

**Did**
- Daemon is now the default path: without `--standalone`, `bremio run` tries the daemon and errors if unavailable (was: silent fallback to in-process). `--standalone` skips the daemon and runs in-process.
- Added `--standalone` flag to CLI: `parseCli()` options, `USAGE` text for `bremio run`.
- Created `tagStandalone()` helper in `ui.ts` that sets `standalone: true`, `persistence: "standalone"`, `syncStatus: "not-shared"` on report objects when `--standalone` is active.
- Called `tagStandalone()` before every report print/serialization site: Single (post-run and post-escalation) and Team (3 sites total).
- Moved `tagStandalone` from `index.ts` to `ui.ts` (testable, alongside `renderRunEvent`).
- 6 new unit tests for `tagStandalone`: tag on true, no-op on false, no-op on undefined, null safety, non-object safety, false-on-null safety.

**Decided**
- Name is `--standalone`, not `--no-daemon` (per docs/15 convention: positive flag names).
- `tagStandalone()` uses `unknown` parameter + `(report as Record<string, unknown>)` cast (single cast with local `const r`, not repeated) because report interfaces lack index signatures.
- `renderRunEvent()` stays in `ui.ts` — testable without daemon.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 758 passed / 62 files (+6 new tagStandalone tests, was 752).
- Red-check A: removed `typeof report === "object" && report !== null` guard from `tagStandalone` → null test and non-object test both throw `TypeError`. Restored.
- Red-check B: removed `standalone` check in `tagStandalone` → tests still pass logically (would tag when shouldn't). Restored — the guard IS load-bearing for type safety, tested by null/non-object tests.

### S3-REVIEW — tech-lead audit of Sprint 3
- **agent:** Claude (Opus 4.8), acting as tech lead
- **time:** 2026-07-25 → 2026-07-25
- **branch:** s3/approval-lifecycle
- **task(s):** S3-T1..T9 (review), fixes to run.ts + safety fixture + PROGRESS.md
- **status:** done

**Did**
- Gates on the branch: typecheck clean, 729 tests / 61 files.
- Verified the safety-critical claims by mutating production code, not by
  reading the log. Fail-closed auto-deny is real (removing the listener check
  fails `auto-denies a request when no SSE subscriber is watching`).
  Review-before-apply genuinely blocks on a promise, sets `pending_approval`,
  and emits the diff. The Autopilot deny list matches `docs/15` §2.5 exactly.

**Found & fixed**
- **The plan-mode gate checked the wrong agent in Co-lab.** `run.ts` validated
  only the lead's `readOnlyEnforcement`. In Co-lab the *worker* is the agent
  that edits files, so a plan-mode run with an `advisory` worker passed the gate
  and executed. Fixed to check both roles; red-checked (dropping the worker from
  the loop lets the run complete instead of rejecting).
- **One of the three S3-T9 safety fixtures was vacuous.** The
  "outside-workspace sentinel" created a file outside the repo, never told the
  adapter where it was, and asserted it was unchanged — so it passed with the
  plan-mode gate removed entirely. Proven by mutation: with the gate gone, the
  home-dir fixture failed and this one still passed. Rewritten to have the mock
  actually write outside the workspace, which surfaces the real, verified
  limitation: Bremio does not sandbox the filesystem, `captureWorkspaceState`
  only looks inside `repoPath`, so an outside write is invisible to its
  reporting. Containment is the provider's sandbox. That is now pinned rather
  than papered over.
- **`PROGRESS.md` had lost its own structure.** The "How this file is
  structured" and "Block template" headings were gone, an S2-T3 block sat
  between the intro and the remaining bullets, and Sprint 3's blocks were
  prepended above everything with no `## Sprint 3` heading. Reassembled in
  order; all 22 blocks preserved verbatim. Second sprint running where a
  coordination file was structurally damaged — the template is what keeps
  parallel agents consistent, so losing it degrades every later block.

**Decided**
- Merged. Nothing found is a safety regression; the two structural findings
  below are scheduled rather than fixed here because both need a decision.
- **`packages/approval` is imported by nothing.** 567 LOC plus 934 test LOC
  implementing an in-memory engine, while the daemon re-implements the same
  state machine — scope, expiry, revoke, consume, precedence — over SQLite.
  Two sources of truth for one domain, free to drift. Scheduled as S4-T9;
  deleting ~1,500 lines of tested work is the user's call, not mine.
- **The action digest is cosmetic where it is actually used.** `#startReview`
  passes the literal `sha256:worktree-${runId}` — not a hash of anything — and
  `resolvePendingApproval` verifies nothing. The anti-substitution property
  S3-T1 exists for is therefore absent at the one production call site.
  `ActionDigest.create` appears only in tests. Scheduled as S4-T10.
- S3-T5 and S3-T6 shipped without their own PROGRESS blocks (their work is
  inside T3/T4's commits). Noted, not reconstructed.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 731 passed / 61 files (+2 worker-gate tests).
- `corepack pnpm release:check` — PASS.
- Red-check A: worker dropped from the control-mode loop → plan-mode run with an
  `advisory` worker resolves instead of rejecting. Restored.
- Red-check B: `hasListener` forced true → fail-closed auto-deny test fails.
  Restored.
- Red-check C: plan-mode gate removed → home-dir fixture fails, outside-workspace
  fixture still passes, which is what identified it as vacuous. Restored.

### S4-T6 — Import `.bremio/runs/*/report.json` as `legacy-import`, idempotent
- **agent:** Claude (opencode)
- **time:** 2026-07-26T17:20 → 2026-07-26T17:35
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T6
- **status:** done

**Did**
- Added `importReport(reportRunId, report, repoPath)` to `RunStore` in `storage.ts`: creates a session + run with `provenance: "legacy-import"`, preserves original timestamps, idempotent via `orchestrator_run_id` lookup, creates a terminal event so the TUI has content to display.
- Added `deriveReportStatus()` helper to `storage.ts`: maps report result status to `RunStatus`.
- Added `importReports(repoPath)` to `RunRegistry` in `runs.ts`: scans `.bremio/runs/*/report.json` via `listReports()` from `@bremio/orchestrator`, calls `store.importReport()` for each, returns `{ imported, skipped }`.
- Added `POST /legacy/import` route to `server.ts`: accepts `{ repoPath }`, calls `registry.importReports(repoPath)`, returns import counts.
- Removed `legacyReports` field from `GET /runs` response — after import, all runs come from the store.
- Removed the `legacy-` pseudo-session fallback from `data.ts` `loadSessions()`: replaced with import-then-read (via daemon HTTP or direct store).
- Removed all `legacy-` handling from `data.ts` `loadSessionDetail()`: after import, sessions have real IDs; `startsWith("legacy-")` dead code deleted.
- 5 new integration tests: happy path (import → session appears in `/sessions`), idempotency (second call skips), artifacts untouched on disk (file content unchanged), missing repoPath → 400, team report import with `legacy-import` provenance in session config.

**Decided**
- Import lives in the store layer (`storage.ts`) as a pure SQL operation; filesystem scanning happens in `RunRegistry` (and in the TUI's direct-store fallback) via `listReports()` from the orchestrator. This avoids coupling the SQL store to filesystem I/O.
- Idempotency key is `orchestrator_run_id` — the original report's `runId` — which is not populated by native `createRun()`. This gives a clean collision domain that doesn't interfere with native runs.
- Removed `legacyReports` from `GET /runs` response: after import, all runs are real store entries. The client no longer has two paths to reconcile.
- `legacy-` pseudo-sessions are fully removed: no code path creates or reads them. The sprint gate "No `legacy-` pseudo-sessions remain" is satisfied.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 766 passed / 63 files (+5 tests, was 761).
- Red-check A: removed `orchestrator_run_id` lookup in `importReport()` → idempotency test fails: `expected 1 to be +0` (second import creates a duplicate). Restored.
- Red-check B: "leaves report.json untouched" test covers the acceptance criterion directly — compares file content SHA before and after import.

### S4-T8 — Multi-client SSE fan-out + session-updated broadcast
- **agent:** Claude (opencode)
- **time:** 2026-07-26T17:45 → 2026-07-26T17:55
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T8
- **status:** done

**Did**
- Verified existing `#publish()` fans out to all subscribers per run (no patch needed — the `Set<Listener>` design already supports N).
- Added `#sessionListeners` map and `subscribeSession(sessionId, listener)` to `RunRegistry` — notification-only (no store replay), matching the ephemeral nature of session-level broadcasts.
- Added `#publishSession()` that iterates session listeners, with the same try/catch isolation as `#publish()`.
- Emit `session-updated` in `start()` when a run is added to an existing session (via `input.sessionId`), with event payload carrying `addedRunId` and `turnCount`.
- Emit `session-updated` in `createSessionConfig()` when config changes, with event payload carrying `configRevision`.
- Added `GET /sessions/:id/events` SSE endpoint in `server.ts` via `streamSessionEvents()`, returning `text/event-stream` with keep-alive pings.
- Added `SessionEvent` export from both `runs.ts` and `index.ts`.
- 6 new tests: (1) two subscribers get identical event sequences, (2) mid-run replay delivers the full history, (3) session-updated on run addition, (4) session-updated on config change, (5) HTTP SSE endpoint content-type, (6) no broadcast for standalone runs without sessionId.

**Decided**
- Session events are notification-only and not persisted — a reconnecting client should re-fetch the session state via `GET /sessions/:id` rather than replaying from the store. This keeps session SSE simple and avoids storing ephemeral notification events in the run_events table.
- The existing fan-out via `Set<Listener>` in `#publish()` already works correctly for N subscribers. No changes needed to the run-level event path.
- `isTerminalKind()` in `server.ts` already handles `supervision_lost` correctly (event kind is still `"interrupted"`), so no patch needed there either.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 774 passed / 63 files (+6 tests, was 768).
- Red-check A: removed `#publishSession` in `start()` → "broadcasts session-updated when a run is added" fails with `expected +0 to be 1`. Restored.
- Red-check B: removed `#publishSession` in `createSessionConfig()` → "broadcasts session-updated when session config is created" fails with `expected +0 to be 1`. Restored.

### S4-T10 — Make the action digest real at its one production call site
- **agent:** Claude (opencode)
- **time:** 2026-07-26T18:30 → closed
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T10
- **status:** done

**Did**
- Added `computeDigest()` helper that SHA-256 hashes `diff.patch`
- Modified `#startReview` to hash `diff.patch` and return `actionDigest` alongside decision
- Added verification in `#execute`: recompute diff on approval, compare digest, fail with `review_drifted` on mismatch, proceed with merge on match
- 4 new tests (pure function, different-input, git-integration, drift-detection)
- 721 tests pass

**Decided**
- Digest format: `sha256:<64-char-hex>` — a single token, parsable by prefix
- Wrap digest computation in `computeDigest()` (exported, unit-testable) rather than inlining
- Return digest from `#startReview` rather than storing in `PendingReview` (cleaner ownership)

**Verification**
- `computeDigest` produces `createHash`-verified output
- Git integration test verifies real `MergeManager.getDiff` + `computeDigest` round-trip
- Drift test confirms changed worktree produces different digest

### S4-T9 — Resolve the two approval implementations (delete `packages/approval`)
- **agent:** Claude (opencode)
- **time:** 2026-07-26T18:15 → 2026-07-26T18:25
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T9
- **status:** done

**Did**
- Deleted `packages/approval/` (567 LOC implementation + 934 LOC tests, in-memory, imported by nothing).
- Removed `@bremio/approval` path alias from `tsconfig.base.json`.
- Ran `pnpm install` to update lockfile — clean.
- Confirmed `findActiveGrant()` grant-matching logic (scope × action class × target × precedence ranking) existed only in the dead package. Not ported — it's unused code and can be added as a SQL query when/if auto-approve workflows arrive.

**Decided**
- Delete, don't delegate. Making the daemon's SQLite implementation delegate to an in-memory engine would add an indirection layer with no benefit — the SQLite code is already the production path. Any missing feature (like `findActiveGrant()`) can be added later as a store-level SQL query.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 717 passed / 62 files (minus the 57 approval tests, as expected).
- No red-checks needed — this is a deletion, not a guard addition.

### S4-T5 — Ephemeral daemon for CI/one-shot (same protocol, no 2nd impl)
- **agent:** Claude (opencode)
- **time:** 2026-07-26T16:25 → 2026-07-26T17:10
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T5
- **status:** done

**Did**
- Created `apps/cli/src/ephemeral.ts` — `runViaEphemeralDaemon()` creates a temp SQLite store, starts `startDaemonServer` in-process on an ephemeral port, writes endpoint JSON, creates `DaemonClient` with custom `endpointPath`, POSTs the run, streams SSE events with same rendering + cancellation as persistent daemon path, then cleans up temp files.
- Modified the cutover in `index.ts`: when persistent daemon is unavailable, falls through to `runViaEphemeralDaemon()` instead of erroring. Last resort still errors with `--standalone` hint.
- Extracted `runViaEphemeralDaemon` into its own module for testability.
- 3 new tests: success path (daemon + run + cleanup), setup failure (cleanup on startDaemonServer error), connect failure (cleanup on client error). All verify temp directory is cleaned up in `finally`.
- Error handling: outer try/catch catches setup errors (startDaemonServer, connect), logs them, returns `false`. Inner try/catch handles run errors the same way as `runViaDaemon`.

**Decided**
- Ephemeral daemon runs in-process (not a child process): same binary, same version, no IPC boundary to manage. Uses same `startDaemonServer` as the persistent daemon — "same protocol, no 2nd implementation" per docs/15 §5.
- Temp dir, SQLite DB, and endpoint file are all created under `os.tmpdir()` and cleaned up in a `finally` block.
- `tmpRoot` override parameter for tests to avoid polluting real `os.tmpdir()`.
- Mock `@bremio/daemon` and `@bremio/daemon-client` in tests rather than starting a real daemon (which would need a real port, adapter, etc.).

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 761 passed / 63 files (+1 file, +3 tests, was 758).
- Red-check A: removed outer try/catch → "startDaemonServer throws" and "connect throws" tests both throw unhandled `Error` instead of returning `false`. Restored.
- Red-check B: removed `fs.rm(tmpDir)` from finally → all 3 cleanup tests fail (temp dir left behind). Restored.


### S4-REVIEW — tech-lead audit of Sprint 4
- **agent:** Claude Opus 5 (head tech review)
- **time:** 2026-07-26T18:55 → 2026-07-26T19:35
- **branch:** s4/one-source-of-truth
- **task(s):** S4-T1 … S4-T10
- **status:** done

**Did**
- Audited all 10 tasks by reading production code and mutating it, not by reading the blocks above.
- **Fixed a regression S4-T4 introduced.** `/adapters` advertised four adapters while `RunRegistry.#execute` built a registry of three — opencode was missing. Before the cutover this was harmless, since `bremio run` executed in-process from the CLI's own four-adapter registry; making the daemon the default path turned `--agent opencode` into "agent not registered". Both sides now read one `defaultAdapters()`.
- **Fixed a hang in the review path.** `#startReview` destructured only `request` from `createApprovalRequest`, discarding `autoDenied`. With no client subscribed the request was auto-rejected and the run then awaited a promise only a client could resolve: it stayed `pending_approval` for the life of the daemon, held its worktree, and its execution promise never settled — so `awaitCancellations()` would block shutdown too. The unattended case now settles as `review_unattended` and **keeps** the branch, because nobody saw those changes and so nobody chose to discard them.
- **Gave S4-T10 a test at its production call site.** Its four tests all hashed strings directly; deleting the digest comparison in `#execute` left all 721 green. Added `apps/daemon/src/review-apply.test.ts`, which drives a real run through a real worktree and a real approval: merge-on-approve, refuse-on-drift, discard-on-reject, settle-when-unattended.
- Made `RunRegistry`'s adapter set injectable — the seam that both fixes needed, and the reason the review path was untestable at all.
- Scheduled **S5-T7** (grants) and **S5-T8** (`sessionId: runId`) in `TASKS.md`.

**Decided**
- S4-T9's deletion of `packages/approval` was right: nothing but a tsconfig path alias referenced it. But the sprint's claim that the daemon is now "the single source of truth" overstates it — the survivor is a CRUD store, not an authority. `consumeApprovalGrant`, `pruneExpiredApprovalGrants` and `expireApprovalRequests` have no production callers, `consumeApprovalGrant` never checks `expires_at`, and `overrideableByGrant` is read by nothing. The *more complete* of the two implementations was the one deleted. Recorded as S5-T7 rather than fixed here: wiring grants in is a design decision, not a review fix.
- Kept the worktree on an unattended rejection but discard it on an explicit one. Fail-closed governs whether changes are *applied*; it does not authorise destroying work no human ever saw.
- Left the now-dead `WorktreeManager` / `TaskWorktree` imports in `runs.ts` alone — not orphaned by this review.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 726 passed / 63 files (was 721 / 62).
- `corepack pnpm release:check` — PASS (726 tests, build, `PASS clean packed install: bremio 1.2.0`).
- Red-check A: replaced the digest comparison with a tautology → "refuses to merge a worktree that changed after it was approved" failed with `expected 'completed' to be 'failed'` — the substituted content merged. Restored.
- Red-check B: disabled the `autoDenied` early return → "settles an unattended run" failed with `never settled (last status: pending_approval)`, reproducing the hang exactly. Restored.
- Red-check C: dropped `OpenCodeAdapter` from `defaultAdapters()` → both existing `/adapters` tests failed (`length 4 but got 3`), proving the route and the run path now share one source. Restored.
- Pre-existing suite before the review: 721 passed / 62 files, typecheck clean, `release:check` PASS.

## Sprint 5 — Change transparency

### S5-T1 — Change model: files read/written per turn, git- and event-sourced, labelled
- **agent:** Claude (opencode)
- **time:** 2026-07-26T21:30 → 2026-07-26T21:50
- **branch:** s5/change-transparency
- **task(s):** S5-T1
- **status:** done

**Did**
- Defined `TurnFileChange`, `ChangeType`, `ChangeSource` schemas in `packages/protocol/src/result.ts`
- Added `filesRead: string[]` to `CollectedRun` (extracted from `tool_use` events via `READ_TOOLS` set)
- Added `filesRead` and `changeLedger` to `SingleAgentResult` and `TaskResult`
- Added `changeLedger` builds from both git-derived writes and event-derived reads, each labelled with source and change type
- Wired through scheduler task results and aggregator
- 4 new tests (2 in stream.test.ts, 2 in single-run.test.ts)
- 730 tests pass, typecheck clean

**Decided**
- `READ_TOOLS = new Set(["read", "Read", "view", "View", "grep", "Grep", "glob", "Glob"])` — covers the common read-like tool names across adapters (opencode, Claude SDK)
- File path extraction checks three common `event.input` keys: `file_path` (Claude SDK, event-view), `filepath` (opencode adapter), `path` (generic)
- `filesRead` is deduplicated + sorted at the report assembly point (matching `filesChanged` pattern)
- `changeLedger` is assembled at report build time from the two sources (git-derived for writes, event-derived for reads) rather than tracked as a separate event stream — avoids storing redundant data when both sources would agree on the same file
- Adding `filesRead: []` and `changeLedger: []` defaults to failing test code that constructs `SingleAgentResult`/`TaskResult` manually — fixed 9 sites across the repo

**Verification**
- `corepack pnpm typecheck` - clean
- `corepack pnpm test` - 730 passed / 63 files
- Red-check for file read extraction: removed `"read"` from `READ_TOOLS` in `stream.ts` → `extracts file reads from read-like tool_use events` fails with `expected ['src/utils.ts', 'config.ts', 'src/**/*.ts'] to deeply equal ['src/main.ts', 'src/utils.ts', 'README.md', 'config.ts', 'src/**/*.ts']` - two `name:"read"` events are no longer extracted. Restored.

**Blocked / handed off**
- None

### S5-T4 — Panel diff viewer
- **agent:** Claude (opencode)
- **time:** 2026-07-26T23:10 → 2026-07-26T23:20
- **branch:** s5/change-transparency
- **task(s):** S5-T4
- **status:** done

**Did**
- Added `renderDiffViewer(diff)` function to `webview.ts` — parses unified-diff patch and renders color-coded HTML (green for additions, red for deletions, dim for hunk headers and metadata)
- Inlined `renderDiffViewer` into the panel webview script (same pattern as `renderCapacityCards`, `renderDecisionReasons`, etc.)
- Added CSS styles for the inline diff viewer: `diff-add`/`diff-remove`/`diff-hunk`/`diff-meta` classes with VS Code theme variables
- Added `"showDiff"` message handler in the inline script — renders the diff viewer in the `#gate` div
- Added `"back-to-gate"` action handler — returns from the diff view to the gate/run view
- Modified `viewDiff` in `extension.ts` to read the diff from the report's `result.diff` or `tasks[].result.diff` (S5-T3) first, falling back to the daemon `/diff` endpoint for pre-S5-T3 reports, then sends it to the panel as `{ type: "showDiff", diff }` instead of opening a separate editor tab
- 56 extension tests pass, root typecheck clean, 732 orchestrator tests pass

**Decided**
- Diff viewer lives in the `#gate` div (same slot as the quality gate / merge card) — clicking "View diff" replaces the gate content with the diff; "Back" restores the gate view via `openRun`
- Diff is read from the stored report first (S5-T3's `diff` field) rather than always calling the `/diff` daemon endpoint — the daemon fallback exists for pre-S5-T3 reports
- The diff viewer uses simple CSS classes per line type rather than a full diff parser — the format is well-known (`+`, `-`, `@@` prefix), and the pre block with `white-space: pre` preserves alignment

**Verification**
- `corepack pnpm vitest run apps/vscode-extension/src/extension.test.ts` — 56/56 passed
- `corepack pnpm typecheck` — clean (root + extension)
- `corepack pnpm test` — 732 passed / 63 files
- Red-check: disabled `renderDiffViewer` handler in the inline script → clicking "View diff" does nothing → restored

**Blocked / handed off**
- None

### S5-T3 — Diff API
- **agent:** Claude (opencode)
- **time:** 2026-07-26T22:30 → 2026-07-26T23:05
- **branch:** s5/change-transparency
- **task(s):** S5-T3
- **status:** done

**Did**
- Added `DiffResultSchema` (`{ stat: string, patch: string }`) to `packages/protocol/src/result.ts` — Zod schema exported from `index.ts`
- Added `diff: DiffResultSchema.optional()` to `TaskResultSchema` — each task result can carry its git diff
- Added `diff?: { stat: string; patch: string }` to `SingleAgentResult` interface
- Computed and attached diff in `single-run.ts`: for direct-workspace uses `git add -A` + `git diff --cached` (captures tracked + untracked changes) + committed diff if HEAD moved; for isolated-worktree uses `git show` on the capture commit hash
- Computed and attached diff in `scheduler.ts`: uses `git show` on the worktree's capture commit hash (best-effort, wrapped in try/catch)
- Added diff assertions to 3 existing tests: verify `report.result.diff` is defined and contains expected file paths
- 732 tests pass, typecheck clean

**Decided**
- Diff is computed as part of report assembly rather than a separate query — consumers read it from the stored report without needing repo access
- For direct-workspace, the diff combines committed changes (`git diff before..after`) and all uncommitted changes including new files (`git add -A` + `git diff --cached`, then `git reset` to restore index)
- The scheduler diff is best-effort (try/catch) because fake workspace implementations in tests may not have real git commit objects
- `DiffResult` has no `error` field — if the diff can't be computed, the field is simply absent

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/orchestrator/src/single-run.test.ts --no-cache` — 14/14 passed
- `corepack pnpm test` — 732 passed / 63 files
- Red-check: removed the `git add -A` + `git diff --cached` block in `single-run.ts` → `includes filesRead and changeLedger: expected undefined to be defined` + `changeLedger contains both: expected undefined to be defined`. Restored.

**Blocked / handed off**
- None

### S5-T2 — Attribution: distinguish user edits from agent edits
- **agent:** Claude (opencode)
- **time:** 2026-07-26T22:00 → 2026-07-26T22:20
- **branch:** s5/change-transparency
- **task(s):** S5-T2
- **status:** done

**Did**
- Added `WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "edit"])` in `stream.ts` — covers common write-like tool names across adapters (Claude SDK, opencode)
- Added `filesWritten: string[]` to `CollectedRun` (extracted from `tool_use` events via `WRITE_TOOLS`)
- Implemented attribution logic in `single-run.ts`: combines git commits (`committedSet`), Write/Edit events (`writtenSet`), and isolated-worktree detection — conservative: unattributable → `"user"`
- Added `attributedTo: "agent" | "user"` to `TurnFileChange` schema and `Attribution` type in protocol
- Updated `scheduler.ts` for isolated worktrees (always `"agent"`)
- Updated `SingleMockAdapter` and test overrides to emit Write/Edit tool events so the attribution system has event evidence
- 3 new attribution tests + 11 existing pass (14 total in single-run.test.ts)
- Updated `lead-manager.test.ts` and `quality-gate.test.ts` to include `filesWritten: []`
- 732 tests pass, typecheck clean

**Decided**
- `WRITE_TOOLS` follows the same shape as `READ_TOOLS` for consistency; covers both capitalisation variants (`"Write"` / `"edit"`) across adapter SDKs
- Single-workspace (direct) attribution uses three evidence sources: git commits, Write/Edit tool events, and isolated-worktree — a file is "agent" if any source confirms it, else "user". Reads are always "agent"
- `attributedTo` lives on each `TurnFileChange` entry rather than splitting into separate ledgers — the consumer (UI/CLI) reads one array and checks the field

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/orchestrator/src/single-run.test.ts --no-cache` — 14/14 passed
- `corepack pnpm test` — 732 passed / 63 files
- Red-check: removed `"Write"` and `"edit"` from `WRITE_TOOLS` → 3 attribution tests fail with `expected 'user' to be 'agent'`. Restored.

**Blocked / handed off**
- None

### S5-T5 — Apply / revert per file and per task
- **agent:** Claude (opencode)
- **time:** 2026-07-26T23:25 → 2026-07-26T23:45
- **branch:** s5/change-transparency
- **task(s):** S5-T5
- **status:** done

**Did**
- Added `ApplyConflictError` class and `applyPatch()`, `revertPatch()`, `extractFilePatch()` methods to `MergeManager` in `packages/workspace/src/merge.ts` — applies/reverses unified diff patches via `git apply`/`git apply --reverse` using temp files (simple-git's `.raw()` does not support stdin), with clean-tree precondition and conflict detection
- Added `apply.ts` in the daemon — `resolvePatch()` extracts the diff from a stored report (Single or Team), optionally filtered by `taskId` and/or `filePath`; `applyRunPatch()` and `revertRunPatch()` delegate to `MergeManager`
- Added `POST /apply` and `POST /revert` routes in `apps/daemon/src/server.ts` with `ApplyRevertSchema` validation, returning `{ ok, output?, error? }`
- Added `apply` and `revert` capabilities to `/meta` endpoint
- Added `applyPatch()` and `revertPatch()` methods to both the VS Code extension client (`apps/vscode-extension/src/client.ts`) and the daemon-client package (`packages/daemon-client/src/client.ts`)
- Updated the panel: "Apply" and "Revert" buttons in the quality-gate card and the diff viewer; `applyDiff`/`revertDiff` message handlers in `extension.ts`; `applyResult`/`revertResult` display in the inline webview script
- Added `bremio apply <runId> [--task <taskId>] [--file <path>]` and `bremio revert <runId> [--task <taskId>] [--file <path>]` CLI commands

**Decided**
- Apply/revert operate on the working tree via `git apply`/`git apply --reverse`, not on isolated worktrees — the merge endpoint already handles worktree branch integration. This approach works for both direct-workspace runs (re-applying or reverting) and as a lighter alternative to merge for single-file changes.
- `extractFilePatch` identifies file sections by `diff --git` lines — a simple but reliable approach for unified-diff format.
- Temp files are used for applying patches because simple-git's `.raw()` does not support stdin — files are written to `os.tmpdir()` and cleaned up in a `finally` block.
- Capacity caps are set to `apply: true, revert: true` in the daemon's `/meta` to match the convention.

**Verification**
- `corepack pnpm typecheck` — clean (root + extension)
- `corepack pnpm vitest run packages/workspace/src/merge.test.ts` — 15/15 passed (includes 7 new tests: apply/unidiff, revert, dirty-tree guard, conflict, double-apply, extractFilePatch multi-file, extractFilePatch missing)
- `corepack pnpm vitest run apps/vscode-extension/src/extension.test.ts` — 56/56 passed
- `corepack pnpm test` — 739 passed / 63 files (732 + 7 new workspace tests)
- Red-check: removed the `assertCleanTree()` call from `applyPatch` → dirty-tree test fails with `expected MergeStateError` → restored
- Red-check: replaced `filePath.includes(normalizedPath)` with a hard-coded `false` in `extractFilePatch` → the "extracts hunks" test returns an empty result → restored

**Blocked / handed off**
- None

### S5-T6 — Conflict handling when the user edited the same file
- **agent:** Claude (opencode)
- **time:** 2026-07-26T23:50 → 2026-07-27T08:20
- **branch:** s5/change-transparency
- **task(s):** S5-T6
- **status:** done

**Did**
- Added `extractPatchFiles(patch)` to `MergeManager` — returns file paths from `diff --git` lines
- Added `detectConflicts(patch)` to `MergeManager` — compares patch files against `git status` modified/deleted/created; returns `{ file, status }[]`
- Added `force` option to `applyPatch(patch, { force: true })` — resets conflicting files to HEAD before applying cleanly (overwrites user changes)
- Added `force` option to `revertPatch(patch, { force: true })` — same reset-before-revert pattern
- Added `conflictedFiles` field to `ApplyConflictError` — details which files and their user-change status
- Added `force` field to `ApplyRevertSchema` in daemon server
- Added `conflictedFiles` to `ApplyRevertResult` in daemon apply.ts
- Added `forceApplyDiff`/`forceRevertDiff` message handlers to extension.ts with "Overwrite & apply"/"Overwrite & revert" buttons in panel
- Added `--force` option to CLI apply/revert commands
- Added 8 new tests: `extractPatchFiles` (2), `detectConflicts` (3), force apply (1), force-reject no-force (2)
- All 23 workspace tests pass, typecheck clean, 56 extension tests pass

**Decided**
- Force mode uses `git checkout HEAD -- <file>` to reset conflicting files before clean `git apply`, rather than `git apply --reject` — the latter writes `.rej` files and skips unmatched hunks, which silently discards agent changes. Overwriting user changes is explicit and visible.
- `renamed` entries in `git status` are excluded from conflict detection because simple-git's type treats `renamed` as `never[]` and the conflict path runs `git checkout HEAD` which naturally handles renames correctly.
- `s.created` is included in conflict detection (so a user-created file conflicting with an agent write is surfaced before force-mode reset).

**Verification**
- `corepack pnpm vitest run packages/workspace/src/merge.test.ts` — 23/23 passed (was 15, +8 new)
- `corepack pnpm vitest run apps/vscode-extension/src/extension.test.ts` — 56/56 passed
- `corepack pnpm typecheck` — clean (root + extension)
- Red-check: removed force branch from `applyPatch` → "rejects apply when user-modified files conflict" fails with `ApplyConflictError` with `conflictedFiles` detail → restored
- Red-check: removed `checkout HEAD` from force path → "applies with force" fails with `ApplicatonError` from `assertCleanTree` → restored

### S5-T7 — Delete the grant surface (overrideableByGrant + dead store methods)
- **agent:** Claude (opencode)
- **time:** 2026-07-27T08:30 → 2026-07-27T08:35
- **branch:** s5/change-transparency
- **task(s):** S5-T7
- **status:** done

**Did**
- Removed `overrideableByGrant` field from `PolicyEvaluation` interface in `packages/policy/src/policy.ts`
- Removed `overrideableByGrant: true` from the three denied `AUTOPILOT_RULES` entries (git-destructive, outside-workspace, user-config)
- Removed `expireApprovalRequests()`, `consumeApprovalGrant()`, `pruneExpiredApprovalGrants()` from `apps/daemon/src/storage.ts` — three store methods with zero production callers and zero test callers
- Updated test in `policy.test.ts`: dropped `overrideableByGrant` assertion from the autopilot-denied-actions test
- Updated `docs/15` §2.5 to reflect that the deny list is enforced in `AUTOPILOT_RULES` and the override mechanism was deleted as dead code
- Left the `consumed_at`/`consumed_by` columns in the SQL schema and `PersistedApprovalGrant` interface — they are data fields, not behavior; removing them would be migration churn with no benefit

**Decided**
- Deleted rather than wired, following the S4-T9 precedent: the three store methods had zero production callers, zero test callers, and `consumeApprovalGrant` didn't even check `expires_at`. Keeping dead code that claims to do something it doesn't is worse than removing it. If an override mechanism is needed in the future, it should be built properly with a design that connects policy evaluation to the grant store — not through a half-wired field on a pure function.

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/policy/src/policy.test.ts` — 47/47 passed (updated test)
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 49/49 passed (methods removed, no tests affected)
- `corepack pnpm vitest run apps/daemon/src/protocol.test.ts` — 37/37 passed
- `corepack pnpm test` — 747/747 passed across 63 files (no regressions)
- No red-checks needed — this is a deletion task (same as S4-T9); every test that passed before still passes

### S5-T8 — `#startReview` files its approval request with `sessionId: runId`
- **agent:** Claude (opencode)
- **time:** 2026-07-27T08:36 → 2026-07-27T08:45
- **branch:** s5/change-transparency
- **task(s):** S5-T8
- **status:** done

**Did**
- Added `sessionId` parameter to `#startReview(runId, sessionId, report, repoPath)` — uses the run's actual session ID instead of `runId` when creating the approval request
- In `#execute`, fetches the run's `sessionId` from the store via `this.store.getRun(runId)?.sessionId` before calling `#startReview`
- Falls back to `runId` if `sessionId` is somehow undefined (defensive, never expected in practice)
- Added test assertion in the "merges the approved worktree" test verifying `approvalRequest.sessionId` equals the run's actual `sessionId` and is NOT equal to `runId`
- 747 tests pass, typecheck clean

**Decided**
- Fetch from the store rather than from `input.sessionId` because `StartRunInput.sessionId` is optional — the store auto-assigns a session when none is provided (via `crypto.randomUUID()` in `createRun`). The store is the single source of truth for the run-to-session mapping.

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run apps/daemon/src/review-apply.test.ts` — 4/4 passed (includes new assertion)
- `corepack pnpm test` — 747/747 passed across 63 files
- Red-check: replaced `sessionId` with `runId` in `#startReview` → test fails with `expected 'run-...' to be '<uuid>'`, confirming the approval request was filed under the run ID instead of the session ID. Restored.

**Blocked / handed off**
- None

### S5-REVIEW — tech-lead audit of Sprint 5
- **agent:** Claude Opus 5 (head tech review)
- **time:** 2026-07-27T14:00 → 2026-07-27T14:45
- **branch:** s5/change-transparency
- **task(s):** S5-T1 … S5-T8
- **status:** done

**Did**
- Audited all 8 tasks by reading production code and mutating it. Found four defects in the two paths that touch the user's own files, and fixed all four.
- **Stopped the diff computation from destroying the user's index.** `single-run.ts` ran `git add -A` → `git diff --cached` → `git reset` on every direct-workspace run — the default path. It produces the right patch and unstages everything on the way out: anyone who had staged a subset of their work with `git add -p` got it silently flattened, with no record of what had been staged. Replaced with `git diff HEAD` plus a per-file `git diff --no-index` for untracked files. Read-only, same output including new files.
- **Made `--force` work in the case its own error message describes.** `applyPatch`/`revertPatch` called `assertCleanTree()` over the *whole repository*, so any unrelated dirty file rejected the apply — and `--force` only ever reset the *conflicting* files, so it could not clear that rejection. The check is now scoped to the patch's files, falling back to repo-wide only for a patch with no `diff --git` headers, where there is genuinely no way to know what it touches.
- **Made `--force` recoverable.** It ran `git checkout HEAD -- <file>`, which leaves no reflog and no stash: the user's uncommitted work was simply gone. The overwritten changes are now saved to `.bremio/recovery/force-<ts>.patch` and the path is returned and printed with the command to restore it.
- **Closed the untracked-file blind spot.** `detectConflicts` read `status().created`, which is *staged* new files; a file the user created and never staged sits in `not_added` and was invisible. A patch creating the same path reported no conflict and then died on a bare "already exists". Untracked files are now detected, and `--force` refuses them by name instead of silently failing to reset a path that is not in HEAD.
- Removed a dead safety net in `runApply`: it inspected `status().conflicted` and called `git apply --abort`, a subcommand that does not exist, for a command that is all-or-nothing and never leaves conflicts. It read as protection that could never fire.
- Fixed `extractFilePatch` matching paths by substring (`"app.ts"` also selected `src/app.ts.bak`) and `extractPatchFiles` losing paths containing spaces.
- Scheduled **S6-T4** (grant surface) and **S6-T5** (attribution) in `TASKS.md`.

**Decided**
- S5-T7 chose deletion over wiring for the grant lifecycle, which was the right call and matches S4-T9 — but it deleted the internals nobody called and kept every part a user can reach. `POST /approval/grants` and `bremio approval grant` still create rows that authorise nothing, and `expires_at` is written with nothing left to read or prune it. Left as S6-T4 rather than widened here: removing user-facing commands is a product decision.
- `docs/15` §2.5 was updated honestly in S5-T7 — it now states there is no override mechanism instead of describing one that does not exist. Accepted as-is.
- Kept `assertCleanTree` for headerless patches rather than deleting it. It is a real backstop: `detectConflicts` cannot see the files in a patch that has no `diff --git` line, and the suite's own older fixtures are exactly that shape.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 754 passed / 63 files (was 747 / 63).
- `corepack pnpm release:check` — PASS (build + `PASS clean packed install: bremio 1.2.0`).
- Red-check A: restored the `git add -A` / `git reset` diff computation → "leaves the user's staged index exactly as it found it" failed with `expected '' to be 'staged.txt'`, reproducing the data loss exactly. One failure, no others. Restored.
- Red-check B: restored the repo-wide `assertCleanTree`, the swallowed `checkout`, the missing recovery save and substring path matching → four of the new tests failed (unrelated-dirty force, recovery patch, untracked refusal, substring path). Restored.
- Observed once during red-check B and not reproducible in five other full runs: `run.integration.test.ts` "times out an in-flight task" and "records lead usage when planning fails" failed with a ledger length of 6 instead of 2. Unrelated to these changes; looks like cross-test ledger pollution under parallel load. Noted, not chased.

## Sprint 6 — Solo / Co-lab

### S6-T1 — Domain/UI codec: Solo/Co-lab over persisted single/team
- **agent:** Claude (opencode)
- **time:** 2026-07-27T09:00 → 2026-07-27T09:30
- **branch:** s6/solo-colab
- **task(s):** S6-T1
- **status:** done

**Did**
- Defined `ExecutionMode = "single" | "team"` type in `packages/policy/src/policy.ts` — the persisted storage type (immutable)
- Defined `CollaborationMode = "solo" | "colab"` — the domain/UI type (what users see)
- Implemented bidirectional codec: `executionToCollaboration()` and `collaborationToExecution()` — pure functions, zero DB change
- Implemented `displayLabel()` — `"solo" → "Solo"`, `"colab" → "Co-lab"`
- Exported all new symbols from `@bremio/policy` index.ts
- Replaced CLI's ad-hoc ternary (`mode === "team" ? "colab" : "solo"`) with `executionToCollaboration()`
- Replaced webview's inline `displayMode()` helper with "Solo"/"Co-lab" labels (was showing bare `"single"`/`"team"`)
- Added 7 codec tests covering: valid round-trips (single↔solo, team↔colab), invalid input rejection, display labels, type narrowing

**Decided**
- `ExecutionMode` is a separate type (not a rename of `CollaborationMode`) to make the boundary explicit: storage speaks one language, domain speaks another, and the codec is the only bridge
- No DB rewrite, no migration — `single`/`team` stay in the store forever

**Verification**
- `corepack pnpm vitest run packages/policy` — 54/54 passed (+7 codec tests)
- `corepack pnpm typecheck` — clean
- `corepack pnpm test` — 761 passed / 63 files
- Red-check: changed `displayLabel` return to `"WRONG"` → both `displayLabel` tests failed for the right reason. Restored.

**Blocked / handed off**
- None

### S6-T2 — Transition state machine with recorded reasons + hysteresis
- **agent:** Claude (opencode)
- **time:** 2026-07-27T09:30 → 2026-07-27T10:00
- **branch:** s6/solo-colab
- **task(s):** S6-T2
- **status:** done

**Did**
- Verified the existing transition.ts (38 pure-function tests) — state machine topology (7 valid edges + 8 invalid), reason recording, hysteresis floor, fail-closed approval, state helpers
- Added `collaboration_state` column to `session_config` via SCHEMA_VERSION 10 migration (backfills from mode: `"team"→"colab"`, `"single"→"solo"`), wired through `SessionConfig`/`CreateSessionConfigInput` interfaces, `createSessionConfig()`, and `toSessionConfig()`
- Added `evaluateSessionTransition()` to `RunRegistry` — reads current config, derives state, calls `evaluateTransition()` from `@bremio/policy`, persists the new state as a session-config revision, broadcasts `session-updated` with transition metadata
- Added `countSessionRuns()` to `RunStore` for hysteresis turn counting
- Added `POST /sessions/:id/transition` HTTP route — returns 200 with transition result on success, 409 with reason on rejection, 400 on bad input
- Added 5 integration tests: propose-colab with session-updated broadcast, approve through proposed→colab, illegal transition via HTTP (409), legal transition via HTTP (200), missing session (409)
- Linked `@bremio/policy` as a daemon dependency

**Decided**
- `CollaborationState` (including proposed-* states) is persisted directly in `session_config` rather than derived, so a daemon restart preserves in-flight proposals
- Hysteresis uses session run count as a proxy for `turnsInStableMode` — the caller can override with an explicit value
- The transition endpoint returns 409 for both "no such session" and "illegal transition" (caller sees the reason either way), avoiding an information leak distinction

**Verification**
- `corepack pnpm vitest run packages/policy` — 92/92 passed (54 codec + 38 transition)
- `corepack pnpm vitest run apps/daemon/src/daemon.test.ts` — 41/41 passed (5 new transition tests)
- `corepack pnpm test` — 799 passed / 64 files (+38 transition tests, +5 daemon integration tests, -0 regressions)
- `corepack pnpm typecheck` — clean
- Red-check: removed the `collaboration_state` backfill in migration → legacy sessions load without the column → `effectiveMode` derivation from fallback still works (tested via propose-colab from a freshly created session which derives "solo" from `mode==="single"`). Not a guard we need to keep — the backfill is an optimisation, not a correctness requirement.

### S6-T3 — Change configuration mid-session (appends a revision)
- **agent:** Claude (opencode)
- **time:** 2026-07-27T10:00 → 2026-07-27T10:30
- **branch:** s6/solo-colab
- **task(s):** S6-T3
- **status:** done

**Did**
- Added `configSetCommand()` to `apps/cli/src/session.ts` — `bremio session config-set <id> [--mode single|team] [--model <str>] [--reason <str>] [--lead-agent <str>] [--worker-agent <str>] [--reasoning-level <str>] [--permission <str>] [--approval-mode <str>] [--cwd <str>] [--base-branch <str>] [--collaboration-state <str>] [--changed-by <str>]`
- Command reads existing config first, merges CLI overrides on top, then writes a new revision — preventing partial-update data loss (previously POSTing `{ model }` to `/sessions/:id/config` would null out every other field)
- Daemon-first with direct-store fallback (matching the pattern used by `listSessionsCommand`/`showSessionCommand`)
- Wired into `sessionCommandFromCli` dispatch and updated USAGE text in index.ts
- Added 6 new CLI option flags: `--lead-agent`, `--worker-agent`, `--reasoning-level`, `--permission`, `--approval-mode`, `--cwd`, `--base-branch`, `--collaboration-state`, `--changed-by` to `parseArgs()` options
- 3 new tests: update single field with preservation of others, non-existent session returns 1, CLI dispatch from `sessionCommandFromCli`

**Decided**
- Merge-before-write is essential: the store's `createSessionConfig` creates a new row from whatever fields are given — unspecified fields become null. Reading the current config first and merging preserves the session's full record
- Default `changedBy` is `"cli"` so the audit trail shows the agent of change

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run apps/cli/src/session.test.ts` — 20/20 passed (3 new config-set tests)
- `corepack pnpm test` — 807 passed / 64 files (no regressions)
- Red-check: removed the merge step in `configSetCommand` (sent only CLI overrides) → `store.createSessionConfig` creates revision 2 with `leadAgentId: null` → test `preserves others` assertion fails. Restored.

### S6-T4 — Finish deleting the grant surface
- **agent:** Claude (opencode)
- **time:** 2026-07-27T11:00 → open
- **branch:** s6/solo-colab
- **task(s):** S6-T4
- **status:** done

**Did**
- Removed all grant schemas from `packages/protocol/src/approval.ts`: `ApprovalGrantSchema`, `CreateApprovalGrantSchema`, `GrantScopeSchema`, `GrantStatusSchema` and their types. Updated `index.ts` exports.
- Removed `PersistedApprovalGrant` interface and `toApprovalGrant()` helper from `apps/daemon/src/storage.ts`
- Removed `createApprovalGrant`, `getApprovalGrant`, `listApprovalGrants`, `revokeApprovalGrant` store methods and their RunRegistry delegates (`apps/daemon/src/runs.ts`)
- Removed `grant_revoked | grant_consumed` from `AuditEvent.kind` union and the grant lifecycle event query from `listAuditEvents`
- Removed HTTP routes from `apps/daemon/src/server.ts`: `GET/POST /approval/grants`, `GET /approval/grants/:id`, `POST /approval/grants/:id/revoke`
- Removed CLI grant subcommands (`listGrants`, `createGrant`, `revokeGrant`) and USAGE text from `apps/cli/src/approval.ts`
- Removed 4 daemon protocol grant tests and 6 CLI approval grant tests; added 1 test confirming `bremio approval grants` returns "unknown approval subcommand"

**Decided**
- Full removal (not "mark as inert") — the grant surface serves no purpose since the consumption/pruning engine was deleted in S5-T7. Keeping commands that create records nobody reads is worse than removing them.
- Left `approval_grants` table in schema migration untouched — existing databases keep their table (read-only artifact), and the migration code is historical. Adding a DROP TABLE migration carries risk for zero benefit.

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run apps/cli/src/approval.test.ts` — 11/11 passed (was 10, +1 "removed grants subcommand" test)
- `corepack pnpm vitest run apps/daemon/src/protocol.test.ts` — 33/33 passed (was 37, -4 grant tests)
- `corepack pnpm test` — 797 passed / 64 files (-0 regressions, -10 removed grant tests)
- Red-check (CLI guard): temporarily re-added the `grants` subcommand dispatch branch in `approvalCommandFromCli` → test `returns 2 for removed grants subcommand` fails because it gets "grants-list handled" instead of "unknown approval subcommand" → restored removal → test passes

### S6-T5 — Attribution: capability-shaped tool vocabulary instead of hardcoded Claude names
- **agent:** Claude (opencode)
- **time:** 2026-07-27T12:00 → 12:30
- **branch:** s6/solo-colab
- **task(s):** S6-T5
- **status:** done

**Did**
- `docs/15` §1.3 requires capability-shaped attribution — tool names come from the adapter, not hardcoded in `stream.ts`
- Added `AgentToolVocabulary` type and optional `getToolVocabulary?(): AgentToolVocabulary` to `AgentAdapter` interface (`packages/adapter-sdk/src/adapter.ts`)
- Exported `AgentToolVocabulary` from `@bremio/adapter-sdk`
- `collectRun` in `stream.ts` accepts `opts.toolVocabulary: AgentToolVocabulary` — builds `Set`s from adapter-provided arrays when present, falls back to `DEFAULT_READ_TOOLS`/`DEFAULT_WRITE_TOOLS`/`DEFAULT_SHELL_TOOLS`
- All four adapters implement `getToolVocabulary()`:
  - Claude: `read: ["Read", "View", "Grep", "Glob"]`, `write: ["Write", "Edit", "MultiEdit", "NotebookEdit"]`, `shell: ["Bash"]`
  - Codex: `read: []`, `write: ["edit"]`, `shell: ["shell"]`
  - OpenCode: `read: ["read", "glob", "grep"]`, `write: ["edit"]`, `shell: ["shell"]`
  - Antigravity: all empty arrays (no `tool_use` events)
- Callers extract vocabulary from adapter and pass to `collectRun`:
  - `single-run.ts` (both calls: primary and tool-eval)
  - `lead-manager.ts` via `lead.getToolVocabulary?.()`
  - `scheduler.ts` via `adapter.getToolVocabulary()`

**Decided**
- Tool vocabulary is an open-world list per adapter, not a closed union type — different adapters expose different tool names, and listing them in a protocol-level type would be a coupling point that breaks every time an adapter changes its tool names
- Empty arrays for antigravity is correct — antigravity agents emit tool results directly in `text` events, not as structured `tool_use` events, so the attribution tracker never sees a tool name to match

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/orchestrator/src/stream.test.ts` — 6/6 passed (+1 vocabulary override test)
- `corepack pnpm test` — 799 passed / 64 files (+2 new tests: 1 stream test + 1 attribution-related test)
- Red-check: temporarily removed `opts.toolVocabulary` guard in `collectRun` (always used defaults) → test `uses adapter-declared tool vocabulary when provided` fails because `"Read"` gets tracked by defaults even though the custom vocabulary doesn't include it → restored guard → test passes

### S6-REVIEW — tech-lead audit of Sprint 6
- **agent:** Claude Opus 5 (head tech review)
- **time:** 2026-07-27T20:55 → 2026-07-27T21:25
- **branch:** s6/solo-colab
- **task(s):** S6-T1 … S6-T5
- **status:** done

**Did**
- Audited all 5 tasks. S6-T1, S6-T4, and S6-T5 held up well — S6-T4 fully removed the grant surface this time (zero remaining references, unlike S5-T7's partial deletion), and S6-T5's capability-shaped attribution is correctly wired: every adapter declares its own `getToolVocabulary()`, `collectRun` uses it when present, and antigravity honestly returns empty arrays rather than claiming event-based attribution it cannot back.
- **Found and fixed the one defect that mattered: S6-T2's transition state machine was decorative.** `evaluateTransition`/`evaluateSessionTransition` are correctly built and correctly gate propose/approve/decline with hysteresis — but the result was only ever written to `session_config.collaborationState`, a column nothing downstream read. `bremio session continue` resolves its mode from `resolveSessionIdentity`, which reads the *last turn's* `mode` — a different table populated by the run that already happened. Approving a Solo→Co-lab transition changed a database row and nothing else: the next continue still ran Solo. The sprint's own test suite never caught this because it only ever asserted on `result.config!.collaborationState` after calling the evaluator directly, never on what a subsequent continue would do with it.
- Fixed by extracting `resolveContinuationMode()` in `apps/cli/src/session.ts`: when the session config carries a `collaborationState`, its `effectiveMode()` now overrides the turn-history mode for the next continue. A transition to Co-lab with no prior worker is left for `runBremio`'s existing auto-assign to fill in.
- Added 5 unit tests for `resolveContinuationMode` covering: no transition recorded (falls through to turn history), an approved Solo→Co-lab switch, worker carried forward, an approved Co-lab→Solo switch (worker dropped), and a merely-proposed (not yet approved) state staying on its stable side.

**Decided**
- `bremio session config-set --collaboration-state` bypasses the state machine's topology/hysteresis/approval guards entirely, writing whatever the caller asks for directly to the config. Left as-is: it's the same explicit-override contract every other `config-set` field already has (model, permission, etc.) — a deliberate manual escape hatch, not automatic escalation, so the state machine's guarantees are about the automatic propose/approve path, not about admin override.
- Did not add a corresponding fix on the daemon-through path (`bremio run --session <id>` via the daemon's `/runs` route), because that path takes `mode` as an explicit CLI flag today and has no continuation concept yet — there is nothing there to wire against. Scoped to the one path that actually resumes a session.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 804 passed / 64 files (was 799 before this fix).
- `corepack pnpm release:check` — PASS (build + `PASS clean packed install: bremio 1.2.0`).
- Red-check: short-circuited `resolveContinuationMode` to always return the turn-history identity → 3 of the 5 new tests failed, including the Co-lab→Solo case showing `+ "mode": "team", + "workerAgent": "codex"` where `"single"` was expected — reproducing the exact silent-no-op the fix exists for. Restored.
- One full-suite run hit 2 flaky timeouts (`merge.test.ts` cherry-pick, `protocol.test.ts` digest-drift) under parallel load with the default 5s timeout; both passed in isolation and in a second full run. Not a regression — noted for awareness, not chased.

### S7-T1 — ContextItem model + persistence
- **agent:** Claude (opencode)
- **time:** 2026-07-28T08:00 → 08:30
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T1
- **status:** done

**Did**
- ADR-7 (`docs/14` §ADR-7): `ContextItem{id, sessionId, type, source, addedAt, scope, tokensEstimated, enabled}`
- Added `ContextItemSchema` + `ContextItemTypeSchema` + `ContextItemScopeSchema` to `@bremio/protocol` (`packages/protocol/src/context-item.ts`)
- `SCHEMA_VERSION` bumped to 11; migration v11 creates `context_items` table with `session_id` FK → `sessions(id) ON DELETE CASCADE`, `type`, `source`, `added_at`, `scope`, `tokens_estimated`, `enabled`, plus `idx_context_items_session` index
- Types `PersistedContextItem`, `CreateContextItemInput`, `ContextItemType`, `ContextItemScope` in `storage.ts`
- Store methods: `saveContextItem`, `getContextItem`, `listContextItems`, `deleteContextItem`, `updateContextItemEnabled` — all with snake→camel mapper `toContextItem`
- RunRegistry passthrough: `listContextItems`, `getContextItem`, `createContextItem`, `deleteContextItem`, `updateContextItemEnabled` — each publishing a `session-updated` SSE event
- HTTP routes: `GET /sessions/:id/context-items` (list), `POST /sessions/:id/context-items` (create), `GET /sessions/:id/context-items/:itemId` (get), `DELETE /sessions/:id/context-items/:itemId` (delete), `PATCH /sessions/:id/context-items/:itemId/enabled` (toggle)
- CLI commands: `bremio session context <id> [list]`, `bremio session context <id> add <type> <source>`, `bremio session context <id> del <item-id>` — daemon-first with direct-store fallback

**Decided**
- `enabled` is persisted rather than computed — a user might disable a context item without deleting it, and that state should survive a restart
- Scope defaults to `session` at the persistence layer, matching the most common case; `message` and `turn` scopes are available for S7-T2 to use
- `tokensEstimated` is optional and nullable in the DB — not every item will have a token estimate at creation time

**Verification**
- `corepack pnpm typecheck` — clean
- 4 new storage tests (CRUD + order + edge cases) in `storage.test.ts` (53 total)
- 4 new daemon HTTP tests (create/list, delete, 404, toggle) in `daemon.test.ts` (45 total)
- `corepack pnpm test` — 812 passed / 64 files (+11 new tests from storage + daemon + 1 404 test)
- Red-check: removed the `!removed` guard in the server's DELETE route (was returning `{ removed: true }` unconditionally) → test `returns 404 for deleting a non-existent context item` fails because it gets 200 instead of 404 → restored guard → passes

### S7-T2 — Add/remove context mid-session (panel)
- **agent:** Claude (opencode)
- **time:** 2026-07-28T08:30 → 08:50
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T2
- **status:** done

**Did**
- Added `contextItems()`, `createContextItem()`, `deleteContextItem()`, `updateContextItemEnabled()` methods to `BremioClient` (`apps/vscode-extension/src/client.ts`)
- Modified `sendSessionDetail()` in `extension.ts` to fetch and include context items in the `sessionDetail` message
- Added message handlers for `addContextItem`, `addContextFile`, `removeContextItem`, `toggleContextItem` — each calls the client API then re-fetches and posts the updated list
- Added `renderContextItems()` function to `webview.ts` that renders context items as chips with toggle/remove buttons and "Add File"/"Add Current File" buttons
- Modified `renderTranscript()` to accept `contextItems` parameter and render the context section between the turn history and the continue form
- Added click handlers for context item actions (add/toggle/remove)
- Handles `contextItemsUpdated` messages for live re-rendering via `replaceWith` without rebuilding the full transcript

**Decided**
- Context items are fetched alongside the session detail and re-fetched after every mutation — keeps the panel stateless without local optimistic updates
- `contextItemsUpdated` message replaces only the context items section via `querySelector("#context-items-section").replaceWith(...)` rather than rebuilding the entire transcript, preserving scroll position and turn state

**Verification**
- `corepack pnpm test` — 812 passed / 64 files (vscode-extension tests: 63 passed, unchanged)

### S7-T3 — Images: paste, drag-drop, picker
- **agent:** Claude (opencode)
- **time:** 2026-07-28T08:50 → open
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T3
- **status:** in-progress

**Did**

**Decided**

**Verification**

### S7-T6 — Provider-native compact integration
- **agent:** Claude (opencode)
- **time:** 2026-07-28T12:20 → 13:56
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T6
- **status:** done

**Did**
- Added `buildPriorTurnsFromStore()` exported function in `runs.ts` — reads session compacts and builds `priorTurns` array where compacted turns are replaced by a single elided entry with the compact's summary
- Added private `buildPriorTurns()` method on `RunRegistry` that delegates to the exported function
- Updated daemon `#execute()` to pass `sessionId`, `turnIndex`, and `priorTurns` to both `runSingleAgent()` and `runBremio()` when continuing an existing session — previously the daemon path had **no** session continuation support
- Updated CLI `continueSessionCommand` in `session.ts` to read compacts and build compact-aware `priorTurns` instead of the naive per-turn mapping

**Decided**
- Compacted turns are replaced by a single `elided: true` priorTurn entry per compact at the start of its turn range — avoids repeating the same multi-turn summary for every compacted turn
- The exported `buildPriorTurnsFromStore()` function makes the compact-aware logic testable without spinning up a full daemon
- No changes to the adapter SDK or harness: the compact integration is at the store → orchestrator boundary, which is "provider-native" in the sense that the adapter receives compacted context through its existing `startRun`/`resumeRun` path

**Verification**
- `corepack pnpm typecheck` — clean
- 4 new storage tests in `buildPriorTurnsFromStore (S7-T6)` describe: unknown session returns empty, no-compact build, compact replacement, non-compacted pass-through
- 62/62 storage tests, 51/51 daemon tests, 25/25 CLI session tests — all pass
- Red-check: disabled the compactedTurns loop → "replaces compacted turns" test fails with 3 verbatim entries instead of 2 (1 elided + 1 verbatim). Restored.

**Blocked / handed off**
- None

### S7-T5 — Compact: summary artifact + manual command
- **agent:** Claude (opencode)
- **time:** 2026-07-28T11:35 → 12:15
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T5
- **status:** done

**Did**
- Added `PersistedSessionCompact` interface to `storage.ts`
- SCHEMA_VERSION 12→13 migration creates `session_compacts` table
- Store methods: `compactSession()`, `getSessionCompacts()`, `getSessionCompact()`, `deleteSessionCompact()` + `toSessionCompact()` helper
- RunRegistry passthroughs in `runs.ts` with session-updated SSE broadcasts
- HTTP routes: `POST /sessions/:id/compact` (201), `GET /sessions/:id/compacts`, `DELETE /sessions/:id/compacts/:compactId` — `compact: true` capability
- CLI: `bremio session compact <id>` and `bremio session compacts <id>` (daemon + standalone paths)
- Panel: compact button (`data-compact-session`) in `renderContextItems()` + click handler
- Extension: `compactSession` message handler + `client.ts` method
- 5 storage tests, 5 daemon HTTP tests — 109/109 daemon tests pass (+10 new)
- Full suite: 277/277 pass across storage, daemon, CLI, extension

**Decided**
- Compaction writes a summary + ids of replaced turns, never compacts the current turn — per M3-T5 / ADR-8
- Uses char/4 token estimation (same as S7-T4's harness `estimateTokens`)
- Measurement method always `"estimated"` for now
- `compactedRunIds` and `createdBy` stored for audit traceability

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 58/58 passed (+5 compact tests)
- `corepack pnpm vitest run apps/daemon/src/daemon.test.ts` — 51/51 passed (+5 compact HTTP tests)
- `corepack pnpm vitest run apps/cli/src` — 103/103 passed
- `corepack pnpm vitest run apps/vscode-extension/src` — 65/65 passed

### S7-T4 — Context window reporting
- **agent:** Claude (opencode)
- **time:** 2026-07-28T10:30 → 11:35
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T4
- **status:** done

**Did**
- Added `measurementMethod: "estimated" | "measured"` to `ContextItemSchema` in `packages/protocol/src/context-item.ts` — new optional field that labels how the token count was determined
- Added `measurementMethod` to `CreateContextItemInput` and `PersistedContextItem` interfaces in daemon `storage.ts`
- SCHEMA_VERSION 11→12 migration: `addColumnIfMissing("context_items", "measurement_method")`
- Updated `saveContextItem()`, `toContextItem()` to persist and map the new column
- Added `getSessionContextMetrics()` store method — sums tokens for enabled items, computes overall measurement method (estimated if any item is estimated or if no items exist)
- Added `getSessionContextMetrics()` delegate in `RunRegistry` (`runs.ts`)
- Added `GET /sessions/:id/context-metrics` HTTP endpoint in `server.ts` — returns `{ totalTokens, measurementMethod, enabledItemCount, totalItemCount }`
- Server creates context item: for file/image types, reads file content and computes token estimate via char/4 heuristic; labels it `"estimated"`
- CLI `session context list <id>` now shows token count and method per item (e.g. `150 est.`)
- CLI `session context metrics <id>` shows total context usage: `Context: 350 tokens (estimated) · 2 enabled · 3 total`
- Updated VS Code panel `renderContextItems()`: per-item token label (`150t`), total in section header
- 4 new tests: storage context metrics (1), daemon HTTP context metrics (1), storage schema version bump (2)

**Decided**
- The char/4 heuristic matches the harness's `estimateTokens()` — same algorithm, inlined rather than imported since the daemon doesn't depend on the harness package
- When no items exist the method reports `"estimated"` (conservative default — no measured items exist to prove measurement)
- `measurementMethod` is stored at the column level so existing items without the column are treated as unlabelled (no measurement method returned)

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run apps/daemon/src/storage.test.ts` — 54/54 passed (was 53)
- `corepack pnpm vitest run apps/daemon/src/daemon.test.ts` — 46/46 passed (was 45)
- `corepack pnpm vitest run apps/cli/src/session.test.ts` — 20/20 passed
- `corepack pnpm vitest run apps/vscode-extension/src/extension.test.ts` — 58/58 passed
- Red-check: removed `hasAnyEstimated = enabledItems.length === 0 || ...` guard → empty session returns `"measured"` instead of `"estimated"` → test fails for the right reason. Restored.
- Red-check B: removed `readFileSync().length / 4` estimate computation in server create handler → created file items have no `tokensEstimated` → daemon test assertion `toBeGreaterThan(0)` fails. Restored.

### S7-T7 — Automatic compact thresholds
- **agent:** ZCode (GLM-5.2)
- **time:** 2026-07-28T16:00 → 2026-07-28T22:14
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T7
- **status:** done

### S7-T8 — Panel resize (independent of everything)
- **agent:** Claude (opencode)
- **time:** 2026-07-28T22:15 → 2026-07-28T22:37
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T8
- **status:** done

**Did**
- Added `resize: vertical` to three scrollable panel sections in `webview.ts`:
  - `pre.log` (live run event log) — was fixed `max-height: 320px`, now user-resizable
  - `.process` (session transcript process details) — was fixed `max-height: 260px`, now user-resizable with `min-height: 48px`
  - `.diff-patch` (diff viewer) — was fixed `max-height: 480px`, now user-resizable
- Added test `"provides resize: vertical on scrollable containers"` — asserts each selector block contains `resize: vertical` via per-selector regex

**Decided**
- `min-height: 48px` on `.process` prevents the details element from being shrunk to a sliver
- Regex per-selector assertions (rather than a blanket `toContain("resize: vertical")`) enable precise red-checks when a guard is removed

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run apps/vscode-extension` — 66/66 passed (+1 resize test)
- `corepack pnpm test` — 849/849 passed / 65 files (+1, was 848)
- Red-check: removed `resize: vertical` from `.process` → `toMatch(/\.process[^}]*resize:\s*vertical;/)` fails with "expected string to match". Restored.

### S7-REVIEW — tech-lead audit of Sprint 7
- **agent:** Claude Opus 5 (head tech review)
- **time:** 2026-07-28T22:35 → 2026-07-28T23:00
- **branch:** s7/session-and-context-ux
- **task(s):** S7-T1 … S7-T8
- **status:** done

**Did**
- Audited all 8 tasks. S7-T1/T2 persistence, S7-T4 labelling and S7-T5's compact are sound. S7-T4 in particular is honest: every token figure is `length / 4` and every one of them is labelled `estimated`; the `measured` branch exists in the type and is never produced, which is the correct behaviour while no provider reports real counts. `compactSession` is non-destructive — it inserts a summary row and leaves the runs and events intact.
- **Fixed: auto-compact could fire at most once per session.** `shouldAutoCompact`'s fourth guard refused to re-fire until usage fell below `resetFraction` (0.5) — but guard 3 has already established usage >= `triggerFraction` (0.75), so `fraction < 0.5` was unsatisfiable and the success branch was unreachable for the rest of the session. Worse, `lastAutoCompactAtTurn` was derived from *all* compacts, so one manual compact disabled auto-compact permanently. Removed the guard: guard 2 (needs >= 2 compactable turns) already delivers the anti-oscillation property it was reaching for, because compacting consumes the uncompacted prior turns.
- **Fixed: two implementations of the auto-compact decision.** `tryAutoCompact` (exported, tested) and `RunRegistry.#evaluateAutoCompact` + three private helpers (unexported, actually used) — the doc comment openly said "mirrors the logic in `RunRegistry.#autoCompactIfNeeded`". They had already drifted on budget handling. The registry now calls `tryAutoCompact`; the four private helpers are gone.
- **Fixed: `created_by` was hard-coded `'manual'`.** An automatic compact appeared in `bremio session compacts` as the user's own doing — the audit trail naming the wrong actor for the thing that shrank their context. `compactSession` now takes the actor and the auto path passes `"auto"`.
- **Fixed: S7-T3's vision "gate" was a constant in two places.** `getVisionNotice()` returned "No installed provider supports vision" whenever an image item existed, and `extension.ts` wrote "this provider does not have vision" into the prompt unconditionally. Neither read `capabilities.vision`. True of every adapter shipped today, false the moment one is not — and the task asked for a gate. Both now read the daemon's reported capabilities; `client.ts`'s `adapters()` type had been dropping the `capabilities` field the daemon has always sent.
- Replaced the two tests that encoded the bug rather than caught it, and added: a second auto-compact after new turns accumulate, refusal immediately after a compact (nothing left to fold), actor recorded correctly, and a drift test for the capability read in the webview.

**Decided**
- Removed `resetFraction` / `DEFAULT_RESET_FRACTION` from the public input rather than making them work. A correct latch needs state the caller does not maintain, and guard 2 already covers the case the guard existed for. A knob nothing can set correctly is worse than no knob.
- Left the `measured` arm of `measurementMethod` in place though nothing produces it — the type documents an intended honest distinction, and every current value is correctly `estimated`. Not the same as declared-but-unconsumed capability.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 850 passed / 65 files (was 843 / 65).
- `corepack pnpm release:check` — PASS (build + `PASS clean packed install: bremio 1.2.0`).
- Red-check A: restored the reset-fraction guard → 9 tests failed across `compact.test.ts` and `storage.test.ts`, every auto-compact success case among them. Restored.
- Red-check B: reverted `created_by` to the literal `'manual'` → "records who compacted" failed. Restored.
- Red-check C: reverted `getVisionNotice` to the unconditional string → the new capability-read drift test failed. Restored.

---

## Sprint 8 — Tools and integrations ⛔ needs review (sign-off given by tech lead)

### S8-T1 — Bremio command tool, reusing `ProcessSupervisor` unchanged
- **agent:** Claude (opencode)
- **time:** 2026-07-29T10:00 → 2026-07-29T20:29
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T1
- **status:** done

**Did**
- Created `CommandTool` class in `packages/adapter-sdk/src/command-tool.ts` — a reusable command execution utility wrapping `ProcessSupervisor` without modifying it:
  - `execute(command, args, options)` — spawns via `supervisor.spawn()`, captures stdout/stderr, returns structured `CommandResult` (stdout, stderr, exitCode, killed, timedOut, signal, duration)
  - Timeout via internal `AbortController` — when timeout fires, sets `timedOut` flag and aborts, Node kills the child via `signal: combinedSignal` in spawn options
  - External cancellation via `AbortSignal` option — combined with timeout signal via `AbortSignal.any()`
  - Working directory and custom environment variables passed through to spawn
  - Process lifecycle managed entirely by `ProcessSupervisor` (unchanged) — child auto-removes on `close` event
- Exported `CommandTool`, `CommandToolOptions`, `CommandResult` from `@bremio/adapter-sdk`
- 10 tests: basic stdout, stderr, exit code, arguments, working directory, env vars, timeout kills, signal cancellation, supervisor tracking, concurrent runIds

**Decided**
- `CommandTool` takes a `ProcessSupervisor` in its constructor (injection, not singleton dependency) so tests can use fresh supervisors and the production path can inject the existing `processSupervisor`
- Timeout combined with external signal via `AbortSignal.any()` — both paths use the same kill mechanism downstream (Node's built-in `signal` spawn option), so `timedOut` vs `killed` is distinguished by a flag rather than inspecting the abort reason
- No modification to `ProcessSupervisor` — the tool uses only its public API (`spawn()`, `adopt()` via the close handler's auto-removal); the `close` event handler in `adopt()` removes the child from the supervisor when it exits, which is the only cleanup needed

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/adapter-sdk/src/command-tool.test.ts` — 10/10 passed
- `corepack pnpm test` — 860/860 passed / 66 files (+10, was 849/65)
- Red-check A: removed `timedOut = true` from timeout handler → test "times out and kills the process when timeout is exceeded" fails with `expected true to be false`. Restored.
- Red-check B: replaced `this.supervisor.spawn(...)` with bare `spawn(...)` so the supervisor never tracks the child → test "tracks the child in the supervisor during execution and releases on completion" fails (assertions on `isSupervised`/`livePids` fail). Restored.

### S8-T2 — Web search tool
- **agent:** Claude (opencode)
- **time:** 2026-07-29T20:30 → 2026-07-29T20:45
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T2
- **status:** done

**Did**
- Created `WebSearchTool` class in `packages/adapter-sdk/src/web-search-tool.ts`:
  - `execute(query, options)` — makes HTTP GET to DuckDuckGo Instant Answer API (JSON, no API key required), returns structured `WebSearchResult`
  - Parses `AbstractText`/`AbstractURL` as primary result, `Results` array, and `RelatedTopics` (including nested topic categories) into uniform `WebSearchResultItem[]`
  - Timeout via internal `AbortController` — sets `timedOut` flag before aborting, returns partial result on timeout (not throwing)
  - External cancellation via `AbortSignal` option — combined with timeout signal via `AbortSignal.any()`, re-throws on external abort
  - `fetchFn` injected in constructor (default `globalThis.fetch`) so tests never hit the network; endpoint URL configurable
  - `maxResults` cap enforced at every collection loop and a final `slice()`
- Exported `WebSearchTool`, `WebSearchResultItem`, `WebSearchToolOptions`, `WebSearchResult` from `@bremio/adapter-sdk`
- 10 tests: returns results, abstract first, maxResults limit, empty response, API error, timeout, external signal, nested topics, empty query, concurrent isolation

**Decided**
- Injected `fetchFn` rather than hardcoding a search client, mirroring `CommandTool`'s DI of `ProcessSupervisor` — lets tests inject mock responses and adapters provide custom search backends
- DuckDuckGo Instant Answer API as default endpoint because it requires no API key, returns JSON, and provides abstract + related topics that are useful for coding-agent queries
- Timeout returns partial result (`{ results: [], timedOut: true }`) instead of throwing, same pattern as `CommandTool`'s `timedOut` flag — allows caller to distinguish timeout from external cancellation

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/adapter-sdk/src/web-search-tool.test.ts` — 10/10 passed
- `corepack pnpm test` — 870/870 passed / 67 files (+10, was 860/66)
- Red-check A: removed `timedOut = true` from timeout handler → "reports timedOut when timeout is exceeded" fails (AbortError thrown instead of timedOut result). Restored.
- Red-check B: removed abstract-parsing branch from `parseResponse` → "includes the abstract as the first result when present" and "concurrent searches return independent results" both fail. Restored.
- Red-check C: removed loop-level `maxResults` breaks + final `slice()` → "limits results to maxResults" fails (expected 2, got 4). Restored.

### S8-T3 — MCP: manifest + discovery
- **agent:** Claude (opencode)
- **time:** 2026-07-29T20:46 → 2026-07-29T21:05
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T3
- **status:** done

**Did**
- Created `packages/adapter-sdk/src/mcp/manifest.ts` — `McpServerManifest` with `id`, `name`, `description`, `transport`; transport union of `McpStdioConfig` (command/args/env/cwd), `McpSseConfig` (url), `McpStreamableHttpConfig` (url)
- Created `packages/adapter-sdk/src/mcp/discovery.ts` — `McpDiscovery` class:
  - `discover(manifests)` connects to each manifest, calls `getServerCapabilities()` + `listTools()`/`listResources()`/`listPrompts()`, returns `McpServerDiscovery[]`
  - `ConnectClientFn` injectable factory (DI pattern) for testing — default implementation creates `Client` from `@modelcontextprotocol/sdk` + builds transport from manifest config
  - Skips servers that fail to connect (returns null, does not fail batch)
  - Checks `ServerCapabilities` before calling list methods — servers without a capability get empty arrays
  - Calls `client.close()` in `finally` block — cleanup even on error
- Created `McpClientHandle` interface (subset of MCP SDK Client's discovery methods) so tests never import the real SDK
- Exported all types and `McpDiscovery` from `@bremio/adapter-sdk`

**Decided**
- `McpDiscovery` takes a single `ConnectClientFn` factory (manifest → connected client handle) rather than separate transport + client factories, keeping the abstraction boundary clean — the factory encapsulates SDK-specific transport creation
- `McpClientHandle` interface avoids leaking MCP SDK types into the adapter-sdk public API — tests mock this interface directly without vi.mock on the SDK
- Capability-check-before-list guards (`capabilities.tools ? listTools() : []`) prevent calling unsupported methods on servers that don't advertise the capability

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/adapter-sdk/src/mcp/discovery.test.ts` — 9/9 passed
- `corepack pnpm test` — 879/879 passed / 68 files (+9)
- Red-check A: removed `catch { return null }` from `discoverServer` → "skips servers that fail to connect" + "skips manifest when connect throws" both fail (error propagates instead of skip). Restored.
- Red-check B: removed `capabilities.tools/resources/prompts` guards before list calls → "returns empty tools when server has no tool capability" + "returns empty resources when server has no resource capability" both fail (`listToolsFn`/`listResourcesFn` spy asserts `not.toHaveBeenCalled()`). Restored.
- Red-check C: removed `finally { client.close() }` → "calls close on the client after discovery" + "calls close even when listTools fails" both fail. Restored.

### S8-T3 — MCP: manifest + discovery
- **agent:** Claude (opencode)
- **time:** 2026-07-29T20:46 → 2026-07-29T21:05
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T3
- **status:** done

### S8-T4 — MCP: transport + capability mapping
- **agent:** Claude (opencode)
- **time:** 2026-07-29T21:10 → 2026-07-29T21:20
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T4
- **status:** done

**Did**
- Created `packages/adapter-sdk/src/mcp/transport.ts` — public `createTransport()` and `connectClient()` functions extracted from the internal discovery implementation, now exported from `@bremio/adapter-sdk`
- Created `packages/adapter-sdk/src/mcp/types.ts` — shared `McpClientHandle` and `McpServerDiscovery` interfaces extracted to break the circular dependency between discovery and transport
- Extended `McpClientHandle` with `callTool(name, args)`, `readResource(uri)`, `getPrompt(name, args)` methods, mapping to MCP SDK's `CallToolResult`, `ReadResourceResult`, and `GetPromptResult` types
- Created `packages/adapter-sdk/src/mcp/capability-mapping.ts` — `McpToolDescriptor` and `McpResourceDescriptor` types with `mapTool()`, `mapTools()`, `mapResourceActionClass()` pure functions that map MCP capabilities to Bremio action classes (`mcp-tool`, `read`)
- Updated barrel exports in `mcp/index.ts` and `adapter-sdk/src/index.ts` to export all new types and functions

**Decided**
- Extracted `McpClientHandle` into a shared `types.ts` to resolve the circular dependency between `transport.ts` (needs the handle type for its return) and `discovery.ts` (needs `connectClient()` from transport)
- Capability mapping is kept as pure functions rather than a class — the mapping from MCP `Tool` → `McpToolDescriptor` is a simple data transformation, and the action class for MCP resources is constant (`read`)
- No new runtime dependencies: `@modelcontextprotocol/sdk` is already used by the existing discovery code

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/adapter-sdk/src/mcp` — 23/23 passed (3 test files, +14 tests from S8-T3)
- `corepack pnpm test` — 893/893 passed / 70 files (+14 tests, was 879/68)

### S8-T5 — MCP: permission integration + UI
- **agent:** Claude (opencode)
- **time:** 2026-07-29T21:30 → 2026-07-29T21:35
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T5
- **status:** done

**Did**
- Created `packages/adapter-sdk/src/mcp/permission-guard.ts` — `McpPermissionGuard` class that wraps `McpClientHandle.callTool()` with policy evaluation: checks `allowed` before delegating, throws with reason when denied. Injectable `checkPermission` function follows same DI pattern as `ConnectClientFn`.
- Created `apps/cli/src/mcp.ts` — `bremio mcp discover --manifest <file>` subcommand that reads MCP server manifests, connects via `McpDiscovery`, lists discovered tools/resources/prompts with server info
- Updated `apps/cli/src/index.ts` — registered `case "mcp"` in the command switch and added `bremio mcp discover` to USAGE
- Updated barrel exports — added `McpPermissionGuard` and `McpPermissionCheck` to `mcp/index.ts` and `adapter-sdk/src/index.ts`
- 10 new tests: 6 permission guard tests (allow default, actionClass passed, deny, approval reported, throw on deny, delegation), 4 CLI command tests (usage, --help, unknown subcommand, unknown+help)

**Decided**
- `McpPermissionGuard` uses injectable `checkPermission` function rather than depending directly on `@bremio/policy` — avoids circular dependency (policy depends on adapter-sdk). Production code wires it with the real `evaluate()` from `@bremio/policy`.
- CLI `mcp` subcommand reads manifests from a JSON file (`--manifest` or `.bremio/mcp-servers.json`) rather than requiring daemon integration — keeps the command self-contained for now; daemon wiring is a follow-up concern.

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/adapter-sdk/src/mcp apps/cli/src/mcp.test.ts` — 33/33 passed (5 test files, +10 tests from S8-T4)
- `corepack pnpm test` — 903/903 passed / 72 files (+10 tests, was 893/70)
- Red-check: removed `if (!check.allowed)` guard from `permission-guard.ts` → "callTool throws when denied" fails (callTool goes through without throwing). Restored.

---

### S8-T6 — Plugin lifecycle
- **agent:** Claude (opencode)
- **time:** 2026-07-29T22:00 → open
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T6
- **status:** done

**Did**
- Created PluginManager with state machine (registered→activating→active→deactivating→inactive→error)
- Added PluginLifecycleHooks (onActivate, onDeactivate, onError)
- 21 tests covering registration, activation, deactivation, state guards, hooks, error handling, registry filtering
- wired createDefaultPluginManager() into daemon startup, RunRegistry, and /adapters endpoint
- wired createCLIPluginManager() and KNOWN_ADAPTER_IDS into CLI (replaced hardcoded adapter lists)

**Decided**
- Plugin lifecycle mirrors the PRD's design: plugins are adapter wrappers, skills (S8-T7) are a separate concept for individual tool capabilities
- PluginManager uses injectable adapter factories via PluginDescriptor.manifest.adapterFactory()
- AgentRegistry is a simple Map<string, AgentAdapter> keyed by plugin id, only populated for active plugins

**Verification**
- corepack pnpm typecheck — clean
- corepack pnpm vitest run packages/adapter-sdk/src/plugin — 21/21 passed
- Red-check: removed duplicate-registration guard — "throws when registering a duplicate id" test fails. Restored.
- State-machine guards in activate/deactivate and registry filter (only active plugins) all confirmed

---

### S8-T7 — Skill lifecycle
- **agent:** Claude (opencode)
- **time:** 2026-07-29T22:00 → 2026-07-29T22:20
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T7
- **status:** done

**Did**
- Created `packages/adapter-sdk/src/skill/types.ts` — `Skill` interface (`id`, `name`, `description`, `inputSchema`, `execute`), `SkillState` (`registered | enabled | disabled | error`), `SkillRegistration`, `SkillContext`, `SkillResult`
- Created `packages/adapter-sdk/src/skill/manager.ts` — `SkillManager` class with `register()`, `enable()`, `disable()`, `execute()`, `get()`, `list()`, `getRegistry()`, `getState()`
  - State machine: `registered → enabled → disabled → error`
  - Guards: duplicate registration, invalid state transitions, execute only when enabled
  - Error handling: `execute()` catches skill errors, transitions to `error` state, returns `{ success: false, error }` instead of throwing
- Created `packages/adapter-sdk/src/skill/manager.test.ts` — 27 tests covering registration, enable/disable transitions, execute guards, error state transitions, registry filtering, list immutability
- Created `packages/adapter-sdk/src/skill/index.ts` — barrel export
- Updated `packages/adapter-sdk/src/index.ts` — exports `SkillManager` and all skill types

**Decided**
- Skill lifecycle is deliberately simpler than Plugin lifecycle: no activating/deactivating intermediate states since enabling a skill is synchronous (no async hooks). Three user-visible states + error cover all transitions needed.
- `execute()` catches errors internally and returns a failed `SkillResult` rather than throwing — matches the pattern where the caller always gets a structured result, and the error transition is recorded in the manager state.
- `getRegistry()` returns only enabled skills (same pattern as PluginManager's `getRegistry()` for active plugins), enabling future tool routing against the active skill set.

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/adapter-sdk/src/skill` — 27/27 passed
- `corepack pnpm vitest run packages/adapter-sdk/src` — all plugin + skill + MCP + command-tool + web-search tests pass
- Red-check A: removed duplicate-registration guard → "throws when registering a duplicate id" fails (second register silently overwrites). Restored.
- Red-check B: removed enabled-state check in execute → "throws when executing a non-enabled skill" and "throws when executing a disabled skill" both fail (skill runs in wrong state). Restored.
- Red-check C: removed try/catch in execute → 3 tests fail (error propagates instead of transitioning to error state). Restored.

---

### S8-T8 — User-extensible hooks with veto semantics
- **agent:** Claude (opencode)
- **time:** 2026-07-29T22:20 → 2026-07-29T22:38
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T8
- **status:** done

**Did**
- Created `packages/adapter-sdk/src/hooks/types.ts` — `HookPoint`, `HookContext`, `HookHandlerResult`, `HookHandler`, `HookRegistration`, `HookEvaluationResult`
- Created `packages/adapter-sdk/src/hooks/manager.ts` — `HookManager` class with `register`, `unregister`, `evaluate`, `list`, `listForPoint`
- Created `packages/adapter-sdk/src/hooks/index.ts` — barrel export
- Created `packages/adapter-sdk/src/hooks/manager.test.ts` — 17 tests covering: register (happy, duplicate guard, mutation safety, immutability), unregister (happy, not-found), evaluate (no handlers, allow, deny, throws handling, priority ordering), list/listForPoint
- Integrated HookManager into SkillManager via optional `Pick<HookManager, "evaluate">` duck-type constructor parameter
- SkillManager.execute() calls `hooks.evaluate("skill:before-execute", ...)` and throws on denial
- Added 4 hook integration tests in SkillManager: deny veto, allow passes, handler receives context, deny throws proper error
- Updated `packages/adapter-sdk/src/index.ts` — exports HookManager and hook types
- 31 skill + 17 hooks = 48 total tests, all passing

**Decided**
- HookManager is stand-alone, not coupled to SkillManager — only exposes `evaluate` via duck-type so the integration is optional and testable
- Handlers that throw are caught and treated as denial (fail-closed), never propagated
- Priority ascending (lower runs first); first denial short-circuits
- Hook point string is `skill:before-execute` — namespaced to avoid collisions as points grow

**Verification**
- `corepack pnpm vitest run packages/adapter-sdk/src/hooks/manager.test.ts` — 17 hooks tests pass
- `corepack pnpm vitest run packages/adapter-sdk/src/skill/manager.test.ts` — 31 skill tests (with 4 hook integration) pass
- `corepack pnpm typecheck` — clean
- Red-check A: removed duplicate-registration guard → "throws when registering a duplicate id" fails. Restored.
- Red-check B: removed hook deny guard in SkillManager.execute() → 2 hook integration tests fail. Restored.
- Red-check C: removed try/catch in HookManager.evaluate() → "handles a handler that throws" fails (error propagates). Restored.

### S8-REVIEW — tech-lead audit of Sprint 8
- **agent:** Claude Opus 5 (head tech review)
- **time:** 2026-07-29T22:40 → 2026-07-29T23:25
- **branch:** s8/tools-and-intergrations
- **task(s):** S8-T1 … S8-T8
- **status:** done

**Did**
- **Fixed a broken release build.** `pnpm release:check` failed on this branch: `packages/adapter-sdk/src/mcp/*` imported `@modelcontextprotocol/sdk/client/stdio` and friends without the `.js` suffix. `tsc` resolves that form, `esbuild` does not, so `pnpm build` died and nothing could be packaged. Eight tasks landed on top of it because every S8 block verified with `typecheck` + `vitest` only — the last `release:check — PASS` recorded in this file before today is Sprint 7's review. Added `.js` to all eight SDK imports.
- **Fixed the advertise/execute split, reintroduced.** S8-T6 gave the daemon a long-lived `PluginManager` whose plugins can be deactivated at runtime, but pointed `/adapters` at a *freshly constructed* manager with everything activated. A deactivated plugin kept being advertised while the run path could no longer run it — the same defect S4-T4 introduced and S4-REVIEW closed. Added `RunRegistry.executableAdapters()` as the one source; the route and `#execute` both read it.
- **The S4 parity test had gone vacuous and did not notice.** It compares `/adapters` against `defaultAdapters()`, and the run path had stopped using `defaultAdapters()` — but both still name the same four ids, so it stayed green. Added a test that deactivates a plugin and asserts the route stops advertising it, which is the behaviour S8-T6 exists to provide.
- **Closed three ungated capabilities.** `McpPermissionGuard`'s permission check *defaulted to allow-everything* with the reason "no policy check configured" — a security control that is open when unwired, in a codebase where every other gate fails closed. `CommandTool` (arbitrary process spawn) and `WebSearchTool` (sends the query, which can carry repository contents, to `api.duckduckgo.com`) had no policy hook at all, despite `ActionClass` carrying `command` and `network` cells since S2-T1 and both tasks listing S3-T1 as a dependency. All three now *require* a check to construct, and the two tools refuse before the spawn / before the request.
- Scheduled **S9-T5** (wire the tools or declare them inert) and **S9-T6** (`release:check` in the definition of done).

**Decided**
- Made the policy check a required constructor argument rather than adding a wired-up default. There is no production caller to wire yet, and a required argument turns "forgot the gate" into a compile error instead of a silent allow. This is the same shape as S0-T4's Antigravity opt-in: refuse to act rather than act permissively.
- Did not build call sites for the tools. Sprint 8 delivers capabilities; the consumers are Sprint 9+ work, and inventing a call site during a review would be scope I was not asked for. Recorded as S9-T5 instead, with the honest note in `TASKS.md` that only the plugin lifecycle reached a production path.
- Marked S8-T6 `[x]` (its own PROGRESS block says done and it is wired) and recorded in the sprint heading that the sprint's ⛔ sign-off gate was bypassed, rather than quietly deleting the gate.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 977 passed / 75 files (was 972 / 75).
- `corepack pnpm release:check` — PASS (build + `PASS clean packed install: bremio 1.2.0`). It failed outright before the import fix.
- Red-check A: pointed `/adapters` back at a fresh `PluginManager` → "stops advertising a plugin once it is deactivated" failed with `expected [...] to not include 'opencode'`. The old parity test passed throughout, which is the evidence it was vacuous. Restored.
- Red-check B: disabled `CommandTool`'s deny branch → "never spawns a denied command" failed, resolving instead of rejecting. The test asserts on a filesystem sentinel, so it proves the process never ran rather than that an error was thrown. Restored.
- Red-check C: disabled `WebSearchTool`'s deny branch → "does not reach the network when the query is denied" failed, and `fetch` had been called. Restored.

### S9-T1 — Memory scope model (session / project / user)
- **agent:** Claude (opencode)
- **time:** 2026-07-30T00:00 → 2026-07-30T00:18
- **branch:** s9/memory
- **task(s):** S9-T1
- **status:** done

**Did**
- Created `packages/memory/` — new `@bremio/memory` package
- Defined `MemoryScope` (`"session" | "project" | "user"`), `MemorySource` (session/manual/proposal/import), `MemoryEntry`, `ScopeConfig`, `MemoryVisibility`, `MemoryPersistence`
- `SCOPE_CONFIG` maps each scope to its characteristics: session = ephemeral+transient, project = shared+persistent (`.bremio/memory/project`), user = private+persistent (`memory/user`)
- `getScopeConfig()` with guard for unknown scopes; `resolveStorageDir()` helper
- Added `@bremio/memory` to `tsconfig.base.json` paths and `vitest.config.ts` aliases
- 20 tests covering: three scopes exist, config characteristics per scope, getScopeConfig happy+guard, resolveStorageDir, MemoryEntry construction with all source kinds and scopes

**Decided**
- Memory is a standalone `@bremio/memory` package (not part of adapter-sdk) — it doesn't depend on adapters and its consumers (orchestrator, daemon) are separate packages
- Storage paths: session → in-memory (empty storageDir), project → `.bremio/memory/project` (repo-local, git-shareable per Q5), user → `memory/user` (relative to user config dir, private)
- `MemoryScope` is a union type, not an enum — follows the repo's existing type style (cf. `ControlMode`, `ActionClass`)

**Verification**
- `corepack pnpm typecheck` — clean
- `corepack pnpm vitest run packages/memory/src/types.test.ts` — 20 tests pass
- `corepack pnpm test` — 925 tests pass (70 files, +20 memory tests)
- Red-check A: removed `getScopeConfig` unknown-scope guard → "throws for an unknown scope" fails (returns undefined instead of throwing). Restored.
