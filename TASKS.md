# Bremio task board

Single source of truth for **what is left to do and who owns it**. One line per
task. Tick a box only when the task's acceptance criteria are met *and* its
commit has landed on its branch.

- Design authority: [`docs/14`](docs/14-architecture-review-and-plan.md) (plan)
  and [`docs/15`](docs/15-architecture-lock.md) (locked semantics). The
  [Munder integration plan](docs/16-munder-difflin-integration-plan.md) is
  **proposed** until S11-T1 promotes its accepted invariants into `docs/15`.
  **If a task line and a locked doc disagree, the doc wins** — fix the line,
  not the code.
- Working agreement: [`docs/10-delegation-contract.md`](docs/10-delegation-contract.md).
- Write-up rules: [`AGENT-WORKFLOW.md`](AGENT-WORKFLOW.md) §"How to record your work".
- Narrative log: [`PROGRESS.md`](PROGRESS.md) — one block per agent per sprint.

## Status legend

| Mark | Meaning |
|---|---|
| `[ ]` | not started |
| `[~]` | in progress — **claim it in `PROGRESS.md` first** |
| `[x]` | done, committed, acceptance criteria met |
| `[!]` | blocked — a `PROGRESS.md` block must say why |

## Claiming rules

1. Never start a task whose **Depends on** column is unticked.
2. Claim by opening a `PROGRESS.md` block *before* your first edit, and set `[~]`.
3. One task per commit. Commit subject must start with the task id.
4. Tasks marked **⛔ needs review** must not be started without an explicit
   go-ahead from the tech lead.

---

## Sprint 0 — Architecture lock and containment ✅ COMPLETE

Landed together; see `docs/15` and `PROGRESS.md` Sprint 0.

| ✓ | ID | Task | Size | Depends on |
|---|---|---|---|---|
| [x] | S0-T1 | Probe adapter transport capabilities (`docs/15` §3) | M | — |
| [x] | S0-T2 | Write the architecture lock (`docs/15`) | L | S0-T1 |
| [x] | S0-T3 | Containment: resume fails closed, no provider substitution | M | — |
| [x] | S0-T4 | Containment: Antigravity dangerous-permission opt-in | M | S0-T1 |

---

## Sprint 1 — Session identity foundations

Everything downstream depends on this sprint. **Do S1-T1 first and alone** — the
other three read the schema it creates.

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S1-T1 | `session_config` schema v4 + transactional idempotent migration | M | — | no — blocks the rest |
| [x] | S1-T2 | Session config read/write API (revisions, not in-place mutation) | M | S1-T1 | — |
| [x] | S1-T3 | Legacy backfill with `provenance` + `completeness` (`docs/15` §4.4) | M | S1-T1 | ‖ S1-T4 |
| [x] | S1-T4 | `ProviderSessionBinding` schema + lost/expired states (`docs/15` §4.3) | M | S1-T1 | ‖ S1-T3 |
| [x] | S1-T5 | Resume reads persisted config; confirm-before-continue for partial legacy config | M | S1-T2, S1-T3 | — |
| [x] | S1-T6 | Canonical repository/worktree identity (`docs/15` §4.5) | L | — | ‖ everything |

**Sprint gate:** a session created on any provider resumes on that provider with
its recorded mode, model and reasoning; a legacy session asks before continuing;
`corepack pnpm release:check` green.

---

## Sprint 2 — Policy and enforcement ✅ COMPLETE

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S2-T1 | `packages/policy`: `ControlMode` × `ActionClass` matrix, pure `evaluate()` | M | — | ‖ S1 |
| [x] | S2-T2 | `WorkspaceStrategy` becomes explicit; Solo may run isolated | L | S2-T1 | — |
| [x] | S2-T3 | Plan mode enforced per transport, guarantee declared honestly (`docs/15` §2.2) | L | S2-T1, S2-T2 | — |
| [x] | S2-T4 | `AdapterRuntimeCapabilities` replaces name-based capability checks | M | S2-T1 | ‖ S2-T2 |
| [x] | S2-T5 | OpenCode `--auto` opt-in, mirroring S0-T4 (`docs/15` §1.5, §8) | S | — | ‖ everything |

**Sprint gate:** a Plan-mode run cannot modify the workspace, proven per adapter
by the safety fixtures in `docs/15` §6 — **not** by `git status` alone.

---

## Sprint 3 — Approval lifecycle ✅ COMPLETE

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S3-T1 | `ApprovalRequest` / `ApprovalDecision` / `ApprovalGrant` + action digest | L | S2-T1 | — |
| [x] | S3-T2 | Grant scopes (once / session / workspace), expiry, revoke, precedence | M | S3-T1 | — |
| [x] | S3-T3 | Protocol routes + fail-closed when non-interactive | M | S3-T1 | — |
| [x] | S3-T4 | Review-before-apply in an isolated worktree | L | S2-T2, S3-T1 | — |
| [x] | S3-T5 | Approval UX — CLI and panel share one decision surface | M | S3-T3 | — |
| [x] | S3-T6 | Audit log: every decision and mode transition, queryable | S | S3-T1 | ‖ S3-T5 |
| [x] | S3-T7 | Wire `readOnlyEnforcement` + `getRuntimeCapabilities` into run selection — Sprint 2 declared both, nothing consumes them (`canBackControlMode` is ready) | M | S2-T3, S2-T4 | ‖ S3-T1 |
| [x] | S3-T8 | Autopilot deny list in `AUTOPILOT_RULES` per `docs/15` §2.5, with `ApprovalGrant` as the only override | M | S3-T2 | — |
| [x] | S3-T9 | Safety fixtures from `docs/15` §6: outside-workspace sentinel, ignored-file write, home-dir write — the sprint-2 gate accepted argv-shape tests instead | M | S3-T7 | ‖ S3-T8 |

---

## Sprint 4 — One source of truth ✅ COMPLETE

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S4-T1 | Shared daemon client + version/capability handshake | M | S1-T1 | — |
| [x] | S4-T2 | `bremio run` starts runs through the daemon | L | S4-T1 | — |
| [x] | S4-T3 | SSE rendering + cancellation parity with the in-process path | M | S4-T2 | — |
| [x] | S4-T4 | Default-path cutover; `--standalone` marks runs `not-shared` | M | S4-T3 | — |
| [x] | S4-T5 | Ephemeral daemon for CI/one-shot (same protocol, no 2nd impl) | M | S4-T2 | — |
| [x] | S4-T6 | Import `.bremio/runs/*/report.json` as `legacy-import`, idempotent | M | S4-T2 | ‖ S4-T5 |
| [x] | S4-T7 | Daemon startup reconciliation → `interrupted` / `supervision_lost` | M | S4-T1 | ‖ S4-T5 |
| [x] | S4-T8 | Multi-client SSE fan-out + replay | M | S4-T1 | ‖ S4-T7 |
| [x] | S4-T9 | **Resolve the two approval implementations.** Deleted `packages/approval` (dead, in-memory, imported by nothing). The daemon's SQLite implementation is the single source of truth. | L | — | ‖ everything |
| [x] | S4-T10 | Make the action digest real at its one production call site. `runs.ts` `#startReview` passes the literal `sha256:worktree-<runId>`, so nothing is bound and nothing is verified on apply — the anti-substitution property S3-T1 exists for is not delivered where approvals actually happen. Bind the diff, and verify before merging the worktree. | M | S4-T9 | — |

**Sprint gate:** a run started in the CLI appears live in the panel with the same
run id, and vice versa. No `legacy-` pseudo-sessions remain.

---

## Sprint 5 — Change transparency ✅ COMPLETE

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S5-T1 | Change model: files read/written per turn, git- and event-sourced, labelled | M | S4-T2 | — |
| [x] | S5-T2 | Attribution: distinguish user edits from agent edits | M | S5-T1 | — |
| [x] | S5-T3 | Diff API | S | S5-T1 | — |
| [x] | S5-T4 | Panel diff viewer | M | S5-T3 | — |
| [x] | S5-T5 | Apply / revert per file and per task | M | S5-T3 | — |
| [x] | S5-T6 | Conflict handling when the user edited the same file | M | S5-T2, S5-T5 | — |
| [x] | S5-T7 | **Delete the grant surface.** `overrideableByGrant` removed from `PolicyEvaluation` and `AUTOPILOT_RULES`; `consumeApprovalGrant`, `pruneExpiredApprovalGrants`, `expireApprovalRequests` deleted from `storage.ts`. Chose deletion over wiring (same shape as S4-T9). | L | — | ‖ everything |
| [x] | S5-T8 | `#startReview` files its approval request with `sessionId: runId`, so review approvals are grouped under a session id that is really a run id. `/approval/requests?sessionId=` and the audit log both inherit the mistake. Fixed: passes the run's actual session ID from the store. | S | — | ‖ everything |

---

## Sprint 6 — Solo / Co-lab ✅ COMPLETE

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S6-T1 | Domain/UI codec: Solo/Co-lab over persisted `single`/`team` — **no DB rewrite** | M | S1-T1 | — |
| [x] | S6-T2 | Transition state machine with recorded reasons + hysteresis | L | S6-T1, S3-T1 | — |
| [x] | S6-T3 | Change configuration mid-session (appends a revision) | M | S1-T2 | ‖ S6-T2 |
| [x] | S6-T4 | **Finish deleting the grant surface.** S5-T7 removed the internals nobody called but kept everything a user can reach: `POST/GET /approval/grants`, `/revoke`, the `bremio approval grant` commands, `CreateApprovalGrantSchema`, and `createApprovalGrant`/`listApprovalGrants`/`revokeApprovalGrant`. A user can still create a grant that authorises nothing, and `expires_at` is now stored with nothing that reads or prunes it. Either remove the surface or say plainly in `--help` that grants are inert. | M | — | ‖ everything |
| [x] | S6-T5 | Attribution's `READ_TOOLS` / `WRITE_TOOLS` in `stream.ts` list Claude's tool names (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `Glob`). A codex or antigravity write in direct-workspace matches none of them, so unless the agent commits, its change is attributed to the **user**. Attribution is provider-shaped where `docs/15` §1.3 requires capability-shaped — derive it from the adapter's declared tool vocabulary. | M | S5-T2 | ‖ everything |

---

## Sprint 7 — Session and context UX ✅ COMPLETE

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S7-T1 | `ContextItem` model + persistence | M | S1-T1 | — |
| [x] | S7-T2 | Add/remove context mid-session (CLI + panel) | M | S7-T1 | — |
| [x] | S7-T3 | Images: paste, drag-drop, picker — gated on `vision`, honest fallback | M | S7-T1 | ‖ S7-T2 |
| [x] | S7-T4 | Context measurement surfaced, keeping `estimated`/`measured` labels | M | — | ‖ S7-T1 |
| [x] | S7-T5 | Compact: summary artifact + manual command | L | S7-T4 | — |
| [x] | S7-T6 | Provider-native compact integration | M | S7-T5 | — |
| [x] | S7-T7 | Automatic compact thresholds | M | S7-T5 | — |
| [x] | S7-T8 | Panel resize (independent of everything) | S | — | ‖ everything |

---

## Sprint 8 — Tools and integrations ✅ COMPLETE (built ungated — see S8-REVIEW)

Was marked **⛔ needs review — do not start without sign-off**, and was built
anyway. The sign-off happened retroactively at S8-REVIEW. Everything below
exists and is tested; only the plugin lifecycle is wired to a production path.
The tools themselves are dormant, and their consumers are Sprint 9+ work.

| ✓ | ID | Task | Size | Depends on |
|---|---|---|---|---|
| [x] | S8-T1 | Bremio command tool, reusing `ProcessSupervisor` unchanged | L | S3-T1 |
| [x] | S8-T2 | Web search tool | M | S3-T1 |
| [x] | S8-T3 | MCP: manifest + discovery | M | S8-T1 |
| [x] | S8-T4 | MCP: transport + capability mapping | L | S8-T3 |
| [x] | S8-T5 | MCP: permission integration + UI | M | S8-T4 |
| [x] | S8-T6 | Plugin lifecycle (distinct from skills — `docs/14` §2.14) | L | S8-T3 |
| [x] | S8-T7 | Skill lifecycle | M | S8-T6 |
| [x] | S8-T8 | User-extensible hooks with veto semantics | L | S3-T1 |

---

## Sprint 9 — Memory ✅ COMPLETE (built ungated — see S9-REVIEW)

Was marked **⛔ needs review**, and was built anyway — the second sprint running.
The sign-off happened retroactively at S9-REVIEW. `packages/memory` is complete
and tested but has no importer outside its own tests; the Sprint 8 toolset is
policy-bound per S9-T5 and still has no consumer. Both are honest about it.

| ✓ | ID | Task | Size | Depends on |
|---|---|---|---|---|
| [x] | S9-T1 | Memory scope model (session / project / user) | S | — |
| [x] | S9-T2 | Storage + retrieval with provenance | M | S9-T1 |
| [x] | S9-T3 | Proposal → review → store lifecycle | L | S9-T2 |
| [x] | S9-T4 | Injection under a token budget | M | S9-T3 |
| [x] | S9-T5 | **Wire Sprint 8's tools to a run, or say plainly that they are inert.** `CommandTool`, `WebSearchTool`, `McpPermissionGuard`, `SkillManager` and `HookManager` have no production caller — only `PluginManager` reached a run path. Each now *requires* a policy check to construct (S8-REVIEW), so whoever wires them must supply one; the remaining work is passing the real `evaluate(controlMode, actionClass)` and the S3 approval lifecycle rather than a permissive stub. | L | S8-T1…T8 | — |
| [x] | S9-T6 | Add `release:check` to the per-task definition of done in `AGENT-WORKFLOW.md`. Sprint 8 shipped 8 tasks with a broken `pnpm build` because every block verified with `typecheck` + `vitest` only, and `tsc` resolves extensionless ESM subpaths that `esbuild` cannot. | S | — | ‖ everything |
| [ ] | S9-T7 | **Give `packages/memory` a production consumer.** The proposed decision in `docs/16` is daemon SQLite as the durable authority, with existing proposal/provenance/token-budget rules retained. Implementation is split into S12-T2 (store/API) and S12-T3 (real prompt injection); tick this row only when both land. | L | S9-T1…T4, S12-T2, S12-T3 | — |
| [ ] | S9-T8 | `SCOPE_CONFIG.session` declares `transient`/`ephemeral` with `storageDir: ""`, so a session-scoped entry handed to `FsMemoryStore` is written to the store root and is then invisible to `get`/`query`/`delete`, which only scan `project` and `user`. `createMemoryStore` routes session scope to `InMemoryStore`, so the path is unreachable today — but the class accepts the write. Refuse a transient scope in `FsMemoryStore` rather than persisting it where nothing can read it. | S | — | ‖ everything |

---

## Sprint 10 — Concurrency, history and git

Requested 2026-07-30 after dogfooding 1.3.0. Three of the ten asks were already
built or nearly so — see the notes — so this sprint is smaller than the list
looks, except for three genuinely new pieces: the prompt queue, session forking
and multiple workers.

**Do S10-T1 first and alone.** It amends `docs/15`; T7 and T10…T13 are built to
whatever it says, and starting them first means rewriting them.

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S10-T1 | **Lock the new semantics in `docs/15` before any code.** Landed as §2.4.1 (git operations classified), §2.6 (Co-lab with N workers) and §4.3.1 (a fork gets its own bindings). Part (b) is also executable in `packages/policy/src/git-actions.ts` — `gitActionClasses()` / `isAutopilotDenied()` — so T10…T13 consume one table instead of each re-reading the doc. (a) Co-lab with *N* workers: what `workerProviders` means when it holds more than one id, how the S3 control-mode gate iterates every worker (the S3 review fixed a gate that checked only the lead — with N workers that loop must cover all of them), and what happens when workers disagree. (b) Which `ActionClass` each git operation is: commit is `write`, branch switch is `write`, push is `network`, force-push and history rewriting are `git-destructive` and therefore **denied under autopilot with no override left** (grants were deleted in S5-T7/S6-T4), PR creation is `network`. (c) Whether a forked session may reuse the parent's `ProviderSessionBinding` — it must not, and the doc should say why. | M | — | — |
| [x] | S10-T2 | **Prompt queue per session.** A prompt sent while a turn is running is accepted and executed when that turn ends, in order, instead of being refused. `queued` already exists as a `RunStatus` and nothing ever queues; `start()` executes immediately. Must preserve turn ordering, survive a daemon restart (S4-T7 reconciliation marks stranded runs — a queued prompt is not stranded, it never started), and interact correctly with cancellation: cancelling the running turn must not silently run the queued one. Show the queue in the panel with the ability to remove an entry before it starts. | L | S10-T1 | — |
| [x] | S10-T3 | **The lead's plan as a live checklist.** Plan tasks already exist with status and already stream (`assembleTaskLanes` renders lanes for a live run); this surfaces them per turn as a checklist that persists into the transcript — pending / running / done / failed, with the agent each is assigned to. Read-only: these are the agent's items, not the user's, and must not be presented as editable. | M | — | ‖ S10-T2 |
| [x] | S10-T4 | **Which workers are running, right now.** The daemon knows (`#controllers`, `activeCount`) but exposes only a count. Add a route reporting active runs with their lead, workers and current task, and show it in the panel so a Co-lab run is legible while it happens. | M | — | ‖ S10-T2 |
| [x] | S10-T5 | **Per-file apply / revert in the panel.** The daemon and CLI already take a `filePath` (S5-T5); the panel only ever sends `{ repoPath, runId }`, so its Apply/Revert are whole-run only. Wire the diff viewer's per-file rows to the parameter that already exists. Keep the recovery-patch notice from the S5 review visible when `--force` overwrites user edits. | S | — | ‖ everything |
| [x] | S10-T6 | **Turn inspector: what this turn actually did.** Click a turn to see its diff, files changed, commands run and worktree path. The data is already persisted per run (S5-T1 change ledger, S5-T3 diff); this is a read path plus UI, not new capture. | M | S5-T3 | ‖ S10-T5 |
| [x] | S10-T7 | **Multiple workers instead of one.** `runs.worker_providers` is already a JSON array, so **no migration** — but `RunBremioOptions.workerId` is a single string, `assignAgents(plan, leadId, workerId, …)` takes one, and `retry()` reads `workerProviders?.[0]`. Make the worker set plural end to end: orchestrator, daemon `StartRunInput`, daemon-client, CLI `--worker` (repeatable), panel multi-select. The control-mode gate must check **every** worker, not the first. | L | S10-T1 | — |
| [x] | S10-T8 | **Sessions grouped by project.** `listSessions(repositoryPath)` is single-repo by design; there is no cross-repo view, so the panel can only ever show the open folder's sessions. Add a grouped listing keyed by the canonical repository identity from S1-T6 (`resolveRepositoryIdentity`, so a worktree and its main checkout group together rather than appearing as two projects), and group the panel's session list by it. | M | S1-T6 | ‖ S10-T2 |
| [x] | S10-T9 | **Surface the current git branch.** `MergeManager.currentBranch()` exists and is used server-side only. Report it to the panel and CLI, and keep it fresh when it changes underneath a session — a stale branch label is worse than none, because apply and merge both act relative to it. | S | — | ‖ everything |
| [x] | S10-T10 | **Git: stage and commit.** Review changed files, stage a selection, commit with a message. `write` per S10-T1, so it is gated like any other write and must not run under plan mode. Never `git add -A`: the S5 review removed exactly that call for flattening a user's partial index, and this feature is where it would be most tempting to reintroduce. | M | S10-T1 | — |
| [x] | S10-T11 | **Git: create and switch branches.** Includes refusing to switch with a dirty tree rather than carrying changes across, and telling the user which files block it. | M | S10-T1, S10-T9 | ‖ S10-T10 |
| [x] | S10-T12 | **Git: push and pull.** `network`, so policy-gated. Force-push is `git-destructive`: denied under autopilot per S10-T1(b), and there is no grant mechanism to override it — so it must be refused with a named reason, not quietly downgraded to a normal push. Credentials come from the user's existing git config; Bremio must not store or prompt for them. | M | S10-T1 | — |
| [x] | S10-T13 | **Git: open a pull request.** Via `gh` if it is installed and authenticated, refusing with an actionable message if not — the same shape as the CLI-not-found handling in `cli-launcher`. Requires a GitHub remote; say so plainly when there isn't one instead of failing obscurely. | M | S10-T12 | — |
| [x] | S10-T14 | **Fork a session from one of its turns.** Sessions are linear today (`turnIndex`, one parent). Forking needs lineage in the schema (parent session + the turn forked from), the forked session's history truncated at that turn, and a **fresh** `ProviderSessionBinding` — reusing the parent's would make two sessions write to one provider-side conversation, which is the silent-crosstalk failure S1-T4 exists to prevent. Session config revisions carry over; run history does not. | L | S10-T1 | — |

**Sprint gate:** a Co-lab run with two workers, started from the panel, shows
both workers live with the lead's plan as a checklist; a second prompt sent
mid-run queues and then executes; the turn inspector shows that turn's diff; and
the resulting change can be committed and pushed from the panel without ever
running `git add -A`.

---

## Sprint 11 — Runtime guard

Selective Munder integration starts with the highest-ROI mechanism: an
evidence-only circuit breaker over Bremio's existing normalized events. This is
not the S3 planning-cost fallback and must not claim generic live steering.
Design and acceptance criteria: [`docs/16`](docs/16-munder-difflin-integration-plan.md).

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S11-T1 | **Lock guard and collaboration invariants.** Promote the approved MD-1…MD-6 decisions from `docs/16` into `docs/15`: daemon/orchestrator authority, task-boundary delivery, evidence-only guard signals, unknown-is-inert, reviewed memory, and bounded expansion. Distinguish observe, boundary restriction, cancellation, and verified live input. | S | — | — |
| [x] | S11-T2 | **Build the pure runtime-guard evaluator.** Add a provider-agnostic state machine for repeated structured tool calls, error storms, provider-reported token velocity, debounced no-progress, one-level recovery, and compaction grace. No side effects; missing/estimated inputs stay inert. | M | S11-T1 | — |
| [x] | S11-T3 | **Persist observe-only guard decisions.** Feed normalized task events into the evaluator and append state changes to `run_events` with reason and evidence quality. Preserve store-then-publish/SSE replay, and do not pretend in-memory counters survive daemon restart. | M | S11-T2 | — |
| [ ] | S11-T4 | **Surface guard state and reasons.** Render the same canonical event in CLI/TUI and panel: level, proposed action, evidence quality, reason and update time. Observe-only must be labelled; unknown must not render as healthy. | M | S11-T3 | — |
| [ ] | S11-T5 | **Enforce opt-in boundary actions.** Default remains observe-only. A constrained run may suppress future retry/escalation/new work at task boundaries; hard stop may request cancellation only when the adapter declares and proves it. Never restart completed work or silently change flow mode. | M | S11-T3, S11-T4 | — |

**Sprint gate:** guard decisions replay once and are visible on every surface;
unknown usage/unstructured tools/unsupported cancellation never trigger action;
opt-in enforcement preserves reports, cancellation state and ledger coherence;
`corepack pnpm release:check` passes.

---

## Sprint 12 — Reviewed memory and run blackboard

Reuse `packages/memory`; do not create a second knowledge subsystem. Daemon
SQLite is the proposed durable authority, while run context stays distinct from
cross-run reviewed memory.

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [ ] | S12-T1 | **Reject transient scope in `FsMemoryStore` (closes S9-T8).** A session-scoped write must fail before disk; project/user behaviour stays unchanged. Tick S9-T8 with this task. | S | — | ‖ S11-T2…T5 |
| [ ] | S12-T2 | **Add daemon-backed durable memory.** Store project memory by canonical repository identity and user memory privately; keep session memory transient/fork-safe. Provenance, review state, expiry and visibility must round-trip without guessed defaults. | M | S11-T1, S12-T1 | — |
| [ ] | S12-T3 | **Inject approved memory into real runs (closes S9-T7).** Use the existing token-budget selector in Single and Team prompt assembly. Pending/rejected/expired entries never reach a provider; unavailable memory degrades to no injection. Tick S9-T7 with this task after S12-T2 lands. | M | S12-T2 | — |
| [ ] | S12-T4 | **Expose proposal review end to end.** List/accept/reject through the daemon and one user surface. Accept still requires explicit provenance; duplicate/concurrent review has deterministic first-result semantics and audit data. | M | S12-T2 | ‖ S12-T3 |
| [ ] | S12-T5 | **Add immutable run-context entries.** Persist attributable facts, decisions, blockers, questions and artifact metadata; derive the current blackboard snapshot instead of overwriting a shared file. Forks do not inherit post-fork context. | M | S12-T2 | — |
| [ ] | S12-T6 | **Hand artifacts to dependent tasks.** Resolve bounded artifact references into later prompts with producer provenance and context-budget accounting. Missing artifacts become named blockers; never scrape another worker's worktree implicitly. | M | S12-T3, S12-T5 | — |
| [ ] | S12-T7 | **Show memory, context and artifacts.** CLI and panel read daemon records and show scope, provenance, review state and source task; list routes do not load large artifact bodies by default. | M | S12-T4, S12-T5 | ‖ S12-T6 |

**Sprint gate:** an approved project fact reaches a later Single and Team prompt;
pending/rejected memory never does; two tasks exchange one artifact through
daemon-owned context; fork and repository-identity tests pass;
`corepack pnpm release:check` passes.

---

## Sprint 13 — Bounded collaboration and optional expansion ⛔ needs review

Do not claim this sprint until Sprint 12 passes and the tech lead confirms that
the additional coordination surface is worth its measured cost. V1 delivery is
at task boundaries; no provider-independent live chat is promised.

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [ ] | S13-T1 | **Define task-scoped messages.** Persist unique, redacted, capped envelopes addressed to task/lead/orchestrator with conversation/reply ids, handled state and hop count. Durable provider personas and broadcast are out of scope. | M | S12-T5 | — |
| [ ] | S13-T2 | **Route messages at task boundaries.** Drain validated requests after a task settles and make responses available to a later start/resume. Only request-artifact/blocker require replies; message/hop budgets end ping-pong with a named escalation. | M | S12-T6, S13-T1 | — |
| [ ] | S13-T3 | **Resolve artifact requests.** Return only policy-approved artifacts from the run index, or a named unresolved blocker. Unknown ownership fails closed; request/reply overhead is coordination evidence. | M | S13-T2 | — |
| [ ] | S13-T4 | **Show task conversation threads.** CLI and panel render daemon-owned request/reply/blocker records with task ownership and terminal state; this is not a general-purpose agent chat UI. | M | S13-T1, S13-T2 | ‖ S13-T3 |
| [ ] | S13-T5 | **Probe live-input capabilities.** Verify each provider with real surfaces/fixtures: in-flight input, delivery acknowledgement, cancellation and resume composition. Unsupported stays default; this task may conclude that no live path should be built. | S | S11-T1, Sprint 12 gate | — |
| [ ] | S13-T6 | **Validate dynamic microtask proposals.** Purely reject duplicate ids, cycles, excessive depth/children/total, invalid dependencies/modes, exhausted reserve and guard-constrained runs. This task does not execute added work. | M | S11-T5, S13-T2 | — |
| [ ] | S13-T7 | **Execute microtasks behind a feature flag.** Apply accepted proposals only at scheduler boundaries; default off. Preserve worktree isolation, deterministic results, ordinary policy/capability checks, restart/cancel semantics and coordination attribution. | M | S13-T3, S13-T6 | — |
| [ ] | S13-T8 | **Gate promotion on paired evidence.** Extend calibration/stats/compare so unknown or non-positive net gain keeps automatic expansion disabled; promotion requires every existing threshold plus enough eligible collaboration samples. | M | S13-T7 | — |

**Sprint gate:** two workers exchange one artifact request/reply through the
orchestrator with idempotency and hop limits; no peer writes or unsupported
live-steering claim exists; expansion is off by default and cannot be promoted
by unknown/non-positive evidence; `corepack pnpm release:check` passes.

---

## Not scheduled

| ID | Item | Why not scheduled |
|---|---|---|
| — | ADHD integration | **Undefined.** Zero repo-wide hits. Needs semantics before it can be a task. |
| — | First-party model runtime | `docs/15` D10 — direction undecided; must not block Sprints 1–7. |
| — | `bremio session show --max-events` | Documented, never parsed. Small; fold into any CLI sprint. |
| — | `config/routing.yaml` resolves from `process.cwd()` | Routing depends on invocation directory. Needs a decision. |
| — | `RunOutcome` has no error **code** | Adapters cannot transmit `classifyAgentError` results. |
| — | Munder-style scoped integration broker | Revisit only after a real MCP/external integration has an end-to-end consumer and threat model. Do not build a secret system speculatively. |
| — | Semantic/vector memory index | Existing reviewed memory must first be wired and benchmarked; add embeddings only if tags/recency demonstrably miss useful knowledge. |
| — | Schedules, webhooks, Slack/GitHub ingress | Needs authentication, replay protection, rate limits, repository authorization, secret handling and an emergency disable path. |
| — | Live mid-run agent messaging | S13-T5 must verify an acknowledged interactive-input seam per adapter. A message row without delivery is not collaboration. |
| — | Munder runtime, GOD agent, personas or office UI | **Rejected for Bremio.** They create a second authority or add product surface without improving measured orchestration outcomes. |
