# 06 — Roadmap (by phase)

Principle: **prove the cheap thing before building the expensive one.** No
dashboard/quota/parallelism before the core loop runs.

## Phase 1 — Vertical slice (the real MVP)
Only **Claude (lead) + Codex (worker)**, **sequential**. Both return plan
JSON → enough to prove lead-swapping + delegation. (Antigravity isn't in yet
because it can't produce JSON — see 04.)

**Implementation status (2026-07-18):** shipped. Local typecheck, 66 tests,
and `bremio doctor` pass. A fresh two-provider real-run verification remains
blocked by the Claude session limit reported at runtime; do not mark this phase
fully closed until it is rerun after the reset.
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
✓ single-agent path exists (lead does it itself / hands the whole small
  task to one agent)
✓ results are aggregated into one report
✓ a task can be cancelled
✓ logs exist for debugging
```
Not needed yet: dashboard, parallelism, auto-merge, quota, Antigravity,
OpenCode/Jan.

## Phase 1.5 — Antigravity worker
Add the Antigravity adapter: **pty wrapper** (guards against non-TTY
swallowing output), reviewer/implementer runs in a **throwaway worktree**.
Not allowed to be the lead.

## Phase 2 — Lead swap (already possible since P1) + quality gate opens up
Add independent review (avoid-self-review), test gate, conflict detection,
manual approval before merge. Every lead still returns the same PlanSchema.

**Implementation status (2026-07-18):** shipped locally. Dependent task
worktrees inherit upstream branches; test tasks are read-only and expose shell
exit-code evidence; reviews return structured findings and are assigned away
from the implementation author; reports compute a fail-closed gate; and
`bremio merge` refuses missing/failed gates. Fresh Claude+Codex verification is
pending the Claude session reset.

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
them, but unreported worker defaults and the outcome baseline remain incomplete
before efficiency claims.

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

## Phase 5 — Parallel + VS Code extension
Run tasks in parallel (PQueue/BullMQ), panel UI. UI is just a surface; the
value lives in the daemon.

## Phase 6 — Additional providers
OpenCode (HTTP), Jan (local worker = near-free capacity). Each one = one
adapter package.

## First sprint (7 items)
1. pnpm TS monorepo. 2. `AgentAdapter` + `PlanSchema` + `TaskSchema`.
3. Claude adapter. 4. Codex adapter. 5. Sequential scheduler.
6. Worktree manager. 7. CLI `bremio run`.
Checkpoint: review the schemas + AgentAdapter **before** coding the adapters.
