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
