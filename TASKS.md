# Bremio task board

Single source of truth for **what is left to do and who owns it**. One line per
task. Tick a box only when the task's acceptance criteria are met *and* its
commit has landed on its branch.

- Design authority: [`docs/14`](docs/14-architecture-review-and-plan.md) (plan)
  and [`docs/15`](docs/15-architecture-lock.md) (locked semantics). **If a task
  line and a doc disagree, the doc wins** — fix the line, do not the code.
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

## Sprint 7 — Session and context UX

| ✓ | ID | Task | Size | Depends on | Parallel? |
|---|---|---|---|---|---|
| [x] | S7-T1 | `ContextItem` model + persistence | M | S1-T1 | — |
| [x] | S7-T2 | Add/remove context mid-session (CLI + panel) | M | S7-T1 | — |
| [~] | S7-T3 | Images: paste, drag-drop, picker — gated on `vision`, honest fallback | M | S7-T1 | ‖ S7-T2 |
| [ ] | S7-T4 | Context measurement surfaced, keeping `estimated`/`measured` labels | M | — | ‖ S7-T1 |
| [ ] | S7-T5 | Compact: summary artifact + manual command | L | S7-T4 | — |
| [ ] | S7-T6 | Provider-native compact integration | M | S7-T5 | — |
| [ ] | S7-T7 | Automatic compact thresholds | M | S7-T5 | — |
| [ ] | S7-T8 | Panel resize (independent of everything) | S | — | ‖ everything |

---

## Sprint 8 — Tools and integrations ⛔ needs review

Gated on `docs/15` §2 and the outcome of Sprint 2. Do not start without sign-off.

| ✓ | ID | Task | Size | Depends on |
|---|---|---|---|---|
| [ ] | S8-T1 | Bremio command tool, reusing `ProcessSupervisor` unchanged | L | S3-T1 |
| [ ] | S8-T2 | Web search tool | M | S3-T1 |
| [ ] | S8-T3 | MCP: manifest + discovery | M | S8-T1 |
| [ ] | S8-T4 | MCP: transport + capability mapping | L | S8-T3 |
| [ ] | S8-T5 | MCP: permission integration + UI | M | S8-T4 |
| [ ] | S8-T6 | Plugin lifecycle (distinct from skills — `docs/14` §2.14) | L | S8-T3 |
| [ ] | S8-T7 | Skill lifecycle | M | S8-T6 |
| [ ] | S8-T8 | User-extensible hooks with veto semantics | L | S3-T1 |

---

## Sprint 9 — Memory ⛔ needs review

| ✓ | ID | Task | Size | Depends on |
|---|---|---|---|---|
| [ ] | S9-T1 | Memory scope model (session / project / user) | S | — |
| [ ] | S9-T2 | Storage + retrieval with provenance | M | S9-T1 |
| [ ] | S9-T3 | Proposal → review → store lifecycle | L | S9-T2 |
| [ ] | S9-T4 | Injection under a token budget | M | S9-T3 |

---

## Not scheduled

| ID | Item | Why not scheduled |
|---|---|---|
| — | ADHD integration | **Undefined.** Zero repo-wide hits. Needs semantics before it can be a task. |
| — | First-party model runtime | `docs/15` D10 — direction undecided; must not block Sprints 1–7. |
| — | `bremio session show --max-events` | Documented, never parsed. Small; fold into any CLI sprint. |
| — | `config/routing.yaml` resolves from `process.cwd()` | Routing depends on invocation directory. Needs a decision. |
| — | `RunOutcome` has no error **code** | Adapters cannot transmit `classifyAgentError` results. |
