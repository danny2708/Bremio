# 06 — Roadmap (by phase)

Principle: **prove the cheap thing before building the expensive one.** No
dashboard/quota/parallelism before the core loop runs.

## v0.1 CLI release cut

**Status (2026-07-18): shipped locally.** Feature scope is frozen at the
explicit Single/Team CLI, three current adapters, the Team quality gate and
manual merge lifecycle, plus measurement and opt-in capacity safety routing.
The distributable npm tarball contains a bundled Node CLI and the Antigravity
sidecar. `pnpm release:check` typechecks, runs the automated suite, builds,
packs, installs into a clean temporary project, and exercises the installed
version/help/doctor commands. Real-provider smoke remains explicit because it
consumes quota.

The next product milestone is evidence, not more surface area: configure SDK
credentials and verify a real Antigravity worker run, collect matched
Single/Team comparisons, and only then decide whether Auto routing has positive
ROI. Parallel execution, dashboard, and editor integration stay out of v0.1.

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

Phase 1.5 now provides Antigravity as a Single agent and explicit Team
implementation worker. The next execution milestone is real-provider
Antigravity verification once SDK credentials are configured, followed by
evidence-driven hardening rather than automatic expansion into later phases.

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

**Early slices shipped:** a measurement-only ledger and `bremio stats` that
preserve provider-reported task and lead-planning token/cost usage without
estimation (including failed planning attempts), plus a
read-only schema-v1 AI-Quota-Tray SQLite consumer and `bremio quota`. The first
quota-aware safety router is available only through explicit opt-in; stale,
missing, errored, disabled, or unsupported quota cannot hard-exclude an agent.
Automatic optimization, the kill-switch, and `net_gain` enforcement are not
implemented yet; confirmed model ids are preserved when a provider exposes
them, but unreported worker defaults and paired baseline/cost evidence remain
incomplete before efficiency claims.

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

**4A contract status (2026-07-18):** the canonical capacity schema and
`QuotaProvider` are implemented. AQT snapshots now map to one Claude, Codex,
and Antigravity capacity card through `bremio capacity` (`bremio quota` remains
an alias). Run history now separates requested and provider-confirmed model and
reasoning metadata. A graphical card surface and native-usage actions remain
open.

**4B freshness status (2026-07-18):** capacity snapshots and individual
windows now carry explicit freshness. Confidence degrades as data ages while
last-known values remain visible; the CLI shows per-window update timestamps
and suppresses low-capacity alerts for stale, unknown, or low-confidence data.
AQT-owned polling remains open.

**4C routing status (2026-07-18):** a conservative, opt-in safety router is
available through `bremio run --capacity-routing`. It applies configurable
50%/20%/5% bands, protects a 15% lead reserve, uses the minimum across Codex
account windows, hard-excludes only fresh high-confidence exhaustion, and
treats stale/unknown/low-confidence data as a soft signal. Automatic enablement
remains behind ledger calibration. Antigravity routing remains blocked until
AQT exposes or Bremio can explicitly map verified provider model ids.

**4D calibration status (2026-07-18):** Single and Team runs now record flow
mode and a mode-appropriate objective outcome; `--comparison <id>` links
controlled runs. `bremio stats` evaluates configurable minimum paired
evidence, non-inferiority, actual-model coverage, provider-reported cost
coverage, and Team-only coordination coverage. It recommends Single while
evidence is insufficient. Automatic flow selection and the cost kill-switch
remain open;
no token-to-quota or missing-price estimate is introduced.

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

Still open in Phase 5: cancellation does not guarantee an empty process tree on
Windows (see the limitations in `03-modules.md`), and the panel remains
dark-only.

## Phase 6 — Additional providers
OpenCode (verified 2026-07-21), Jan (local worker = near-free capacity).

**OpenCode adapter status (2026-07-21):** shipped and real-provider verified.
`@bremio/adapter-opencode` supports both the one-shot CLI path
(`opencode run --format json`) for implementer/test/review tasks and the HTTP
server path (`opencode serve`) for lead planning. It handles the npm `.cmd`
shim resolution and the Windows stdin-pipe hang. Real-provider smokes pass:

| Mode | Result |
|---|---|
| Single (opencode) | PASS — file created, test run, verification passed |
| Team (opencode lead + claude worker) | PASS — 3/3 tasks (impl, test, review), quality gate passed |

OpenCode is lead-eligible (`planning=true`), but its default provider
(Console/deepseek-v4-flash-free) does not support native `json_schema`
structured output, so the lead prompt uses plain-text format instructions
instead. The model reliably produces valid plan JSON when instructed.

Jan remains as a future integration — a local OpenAI-compatible server for
near-free capacity as a fallback worker. Each provider = one adapter package.

## First sprint (7 items)
1. pnpm TS monorepo. 2. `AgentAdapter` + `PlanSchema` + `TaskSchema`.
3. Claude adapter. 4. Codex adapter. 5. Sequential scheduler.
6. Worktree manager. 7. CLI `bremio run`.
Checkpoint: review the schemas + AgentAdapter **before** coding the adapters.
