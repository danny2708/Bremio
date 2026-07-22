# 06 — Roadmap (by phase)

Principle: **prove the cheap thing before building the expensive one.** No
dashboard/quota/parallelism before the core loop runs.

## v0.1 alpha release cut

**Status (updated 2026-07-22): shipped locally as `0.1.0-alpha.1`.** The
distributable npm tarball contains the bundled CLI/TUI and daemon; the VS Code
extension ships as a local VSIX. Four adapters are registered: lead-capable
Claude/Codex plus worker-only Antigravity/OpenCode. `pnpm release:check`
typechecks, runs 365 tests, builds, packs, installs into a clean temporary
project, and exercises the installed version/help/doctor commands. A separate
fresh-profile E2E verifies daemon startup, authentication, persistence,
restart, and diagnostics. Real-provider smoke remains explicit because it
consumes quota.

The next product milestone is evidence, not more surface area: net gain is
computed and reported fail-closed, and `bremio compare` now collects matched
Single/Team samples from one clean commit. The next step is running enough real
pairs to satisfy calibration before Auto routing may make decisions. Parallel
execution, TUI, daemon, and editor integration have already shipped in the
alpha; light-theme panel polish and automatic decisions remain open.

## Execution modes — manual before automatic

**Implementation status (2026-07-18):** explicit `Single` and `Team` modes are
shipped and real-provider verified for Claude and Codex. Single is one direct
adapter call in the current workspace with dirty-state warning, logs/report,
cancellation, requested/actual
identity, usage, and recognizable verification-command evidence. It does not
create a plan, scheduler tasks, worktrees, an independent review, or a merge
target. Team is the existing plan/delegate/review flow. Legacy `--lead` without
`--mode` still means Team. Real fixtures passed Claude Single, Codex Single,
Claude-led Team, and Codex-led Team; the Team quality gates completed 3/3 in
both lead directions.

Still deferred after the manual-mode evidence gate:

- `Auto` mode selection;
- user-approved Single→Team escalation;
- extracting Single into another package (keep it as an orchestrator module
  until a concrete package boundary is justified).

Phase 1.5 provides Antigravity as a real-verified Single agent and explicit
Team implementation worker through the authenticated `agy` CLI. It remains
excluded from planning and test-gate roles by capability, not by provider name.

## Phase 1 — Vertical slice (the real MVP)
Only **Claude (lead) + Codex (worker)**, **sequential**. Both return plan
JSON → enough to prove lead-swapping + delegation. Antigravity was deliberately
outside the Phase-1 scope and arrived in Phase 1.5.

**Implementation status (2026-07-18):** closed. Local typecheck, test suite,
and `bremio doctor` pass. After the Claude quota reset, fresh Team fixtures
passed in both lead directions with real delegation and passed quality gates.
The explicit `pnpm smoke:providers --lead both --timeout 600` harness exercises
both real lead directions in separate disposable repos; it consumes quota and
is intentionally excluded from the normal test suite.

**Done criteria:**
```
✓ a single prompt
✓ can pick Claude OR Codex as lead
✓ lead returns a valid plan JSON (matching PlanSchema)
✓ orchestrator hands off ≥1 task to a DIFFERENT agent
✓ that agent edits code in its own worktree
✓ direct single-agent path exists (one adapter call; no Team plan/worktree)
✓ results are aggregated into one report
✓ a task can be cancelled
✓ logs exist for debugging
```
Not needed yet: dashboard, parallelism, auto-merge, automatic quota routing,
OpenCode/Jan.

## Phase 1.5 — Antigravity worker
**Implemented and verified with a real run (2026-07-18):** the authenticated
`agy` CLI 1.1.4 in print mode, so Antigravity work uses the existing Google AI
subscription instead of a separate API key. Mandatory `--add-dir` workspace
targeting (verified: `agy` ignores the process cwd), `--mode plan` for
read-only, `--dangerously-skip-permissions` for write, prose events,
cancellation, and explicit Single/Team worker selection. Verified that
`agy -p` returns clean stdout under a non-TTY parent, so no pty wrapper is
needed. A real `bremio run --mode single --agent antigravity` created the
requested file with a ledger entry and report; `doctor` reports `ok`.

Antigravity is not allowed to lead (`planning=false`) and is not a test-gate
agent until the SDK exposes reliable shell exit codes through its response
stream.

## Phase 2 — Lead swap (already possible since P1) + quality gate opens up
Add independent review (avoid-self-review), test gate, conflict detection,
manual approval before merge. Every lead still returns the same PlanSchema.

**Implementation status (2026-07-18):** shipped locally. Dependent task
worktrees inherit upstream branches; test tasks are read-only and expose shell
exit-code evidence; reviews return structured findings and are assigned away
from the implementation author; reports compute a fail-closed gate; and
`bremio merge` refuses missing/failed gates. Fresh Claude+Codex Team fixtures
passed the full implementation, test, and independent-review flow.

## Phase 3 — Full worktree lifecycle
Diff/merge manager, cherry-pick, worktree cleanup, reliable kill-on-timeout.

**Early slice shipped:** `bremio merge` previews a gate-approved task's diff,
requires confirmation (or `--yes`), merges with `--no-ff`, then removes its
worktree and branch; conflicts abort cleanly. `bremio run --timeout <seconds>`
applies a hard limit to every planning attempt and task, propagates cancellation
to the provider adapter, and blocks downstream tasks. `--strategy cherry-pick`
applies only each task-owned commit in plan order and excludes inherited
dependency history; conflicts abort and restore the base tree. Automatic merge
remains out of scope.

## Phase 4 — Quota-aware routing + efficiency (see 05)
Usage ledger → consume AI-Quota-Tray → single-vs-multi decision +
kill-switch → scoring router + calibration gate. Enforce the `net_gain > 0`
invariant.

**Efficiency slices shipped:** a measurement-only ledger and `bremio stats` that
preserve provider-reported task and lead-planning token/cost usage without
estimation (including failed planning attempts), plus a
read-only schema-v1 AI-Quota-Tray SQLite consumer and `bremio quota`. The first
quota-aware safety router is available only through explicit opt-in; stale,
missing, errored, disabled, or unsupported quota cannot hard-exclude an agent.
The ledger now computes `net_gain` against the cheapest fully measured verified
Single baseline. A calibration-gated kill-switch can stop Team after planning
but before worker tasks when measured coordination cost exceeds the configured
share. Automatic initial flow selection remains open; unreported costs keep the
switch inert rather than creating an estimate.

**Capacity sub-roadmap:**

1. **4A Observe/display:** canonical `QuotaProvider`; Capacity cards; preserve
   Claude windows, Codex multi-window limits, and Antigravity per-model limits;
   show source/confidence/age; manual re-read and native-usage links. Split run
   history into requested/actual model and requested/provider-confirmed
   reasoning level without estimating quota consumed per task.
2. **4B Freshness/monitoring:** AQT-owned polling every 1-5 minutes, per-window
   confidence degradation, last-updated timestamps, and low-capacity alerts.
3. **4C Routing:** configurable thresholds, lead reserve, model-aware
   Antigravity scoring, all-window Codex scoring, hard exclusion only for fresh
   confident exhaustion, and soft penalties for stale/unknown/low-confidence
   data. Full checklist and policy live in `05-quota-and-routing.md`.

Do not copy AQT's provider fetch implementations into Bremio. Add a stable AQT
refresh boundary (command/IPC/shared package) if re-reading SQLite is not enough.

**4A status (updated 2026-07-22):** the canonical capacity schema and
`QuotaProvider` are implemented. AQT snapshots now map to one Claude, Codex,
and Antigravity capacity card through `bremio capacity` (`bremio quota` remains
an alias). Run history separates requested and provider-confirmed model and
reasoning metadata. The TUI renders capacity cards with explicit unavailable
and last-known states; CLI/TUI refresh through AQT and native usage actions are
available where a provider exposes one.

**4B freshness status (2026-07-18):** capacity snapshots and individual
windows now carry explicit freshness. Confidence degrades as data ages while
last-known values remain visible; the CLI shows per-window update timestamps
and suppresses low-capacity alerts for stale, unknown, or low-confidence data.
AQT-owned polling remains open.

**4C routing status (updated 2026-07-22):** a conservative, opt-in scored
router is
available through `bremio run --capacity-routing`. It applies configurable
50%/20%/5% bands, protects a 15% lead reserve, uses the minimum across Codex
account windows, hard-excludes only fresh high-confidence exhaustion, and
treats stale/unknown/low-confidence data as a soft signal. Automatic enablement
remains behind ledger calibration. Verified Antigravity display names now map
to provider model ids in `packages/quota/src/antigravity-models.ts`; unknown
buckets remain unmapped and cannot drive routing.

**4D calibration status (updated 2026-07-22):** Single and Team runs record flow
mode and a mode-appropriate objective outcome; `--comparison <id>` links
controlled runs. `bremio stats` evaluates configurable minimum paired
evidence, non-inferiority, actual-model coverage, provider-reported cost
coverage, and Team-only coordination coverage. It recommends Single while
evidence is insufficient. Net-gain computation, fail-closed stats presentation,
controlled pair collection, and the calibrated pre-task cost kill-switch are
implemented; automatic initial flow selection remains open. No token-to-quota
or missing-price estimate is introduced.

## Phase 5 — Parallel + VS Code extension
Run tasks in parallel, panel UI. UI is just a surface; the value lives in the
daemon.

**Parallel execution shipped and real-provider verified (2026-07-18).** The
scheduler runs ready tasks in waves with bounded concurrency (`--concurrency`,
default 2) instead of one at a time, still honouring every declared dependency.
Results are returned in topological order regardless of completion order, so
reports stay deterministic.

Concurrency covers *agent execution only*: worktree creation and diff capture
are serialized through a mutex, because `git worktree add` and the capture
commit contend on shared `.git` metadata. Agent runs dominate wall-clock time,
so serializing the git steps costs almost nothing and removes a class of
lock-contention failures. A unit test asserts git operations never overlap
while four tasks execute concurrently.

Verified for real with a Claude-led Team run: after the implementation task
completed, the dependent test (Codex) and review (Claude) tasks ran
concurrently on two different providers; every worktree was based correctly on
the implementation commit, the main repo stayed clean, and no git lock errors
occurred. Streamed output is tagged per task, since interleaved lines are
otherwise unreadable.

**Daemon and VS Code extension shipped (2026-07-18).** `apps/daemon` is the
process docs/03 described: it holds run state, streams events, and exposes
adapters, capacity, runs, diff, and merge over a token-guarded loopback HTTP
surface. The CLI (`bremio daemon`) and the VS Code extension are both clients,
so a run started in one surface is visible from the other.

The extension provides Run (Single/Team with live streaming and cancel), Runs,
Capacity, and Doctor, plus diff review and gate-checked merge behind an explicit
confirmation dialog. It depends on no `@bremio/*` package — the extension host is
shared with the editor, so the adapters stay out of it — and spawns the daemon
when one is not already reachable.

**Durable local orchestrator (2026-07-18).** The daemon now survives restarts:
runs, events and artifacts persist to SQLite, a single-instance lock keeps one
daemon per user, startup reconciles anything left mid-flight to `interrupted`,
and the protocol carries a version handshake with readiness separate from
liveness. The extension reconnects from its last sequence rather than replaying
or skipping. Provider failures are classified into a small set of codes with a
bounded, conservative retry policy.

Still open in Phase 5: Windows tree termination is confirmed with a centralized
supervisor and `taskkill /T /F`, but it is weaker than a Job Object against a
descendant created during the kill walk. The panel remains dark-only.

## Phase 6 — Additional providers
OpenCode (verified 2026-07-21). Jan was dropped from the current roadmap: there
is no adapter or measured evidence that maintaining another local-provider path
would beat OpenCode and the existing cloud workers.

**OpenCode adapter status (updated S1-R4, 2026-07-22):** shipped and
real-provider verified as a **worker**. `@bremio/adapter-opencode` supports the
one-shot CLI path (`opencode run --format json`) for implementer/test/review
tasks, and the HTTP server path (`opencode serve`) for review tasks that carry
an `outputSchema`. It handles the npm `.cmd` shim resolution and the Windows
stdin-pipe hang. Real-provider smokes pass:

| Mode | Result |
|---|---|
| Single (opencode) | PASS — file created, test run, verification passed |
| Team (opencode worker, claude/codex lead) | PASS — 3/3 tasks (impl, test, review), quality gate passed |

OpenCode is **not lead-eligible** (`structuredOutput=false`). It was briefly
`true`: a Team run with opencode as lead passed on 2026-07-21, but the
mechanism behind it — post-hoc JSON extraction with no schema enforcement and
no repair loop, plus a discovered failure mode where the default provider
returns an empty response instead of an error when asked for schema-constrained
output — was not reliable enough to trust with whole-plan authorship. Claude
and Codex cover the lead role with a schema constraint their own provider
enforces; OpenCode is a strong worker instead.

Additional providers now require measured demand and one adapter package each;
none is committed for the alpha-to-v1 path.

## First sprint (7 items)
1. pnpm TS monorepo. 2. `AgentAdapter` + `PlanSchema` + `TaskSchema`.
3. Claude adapter. 4. Codex adapter. 5. Sequential scheduler.
6. Worktree manager. 7. CLI `bremio run`.
Checkpoint: review the schemas + AgentAdapter **before** coding the adapters.
