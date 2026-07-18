# Bremio

> A provider-agnostic orchestrator that turns AI coding agents
> (Claude Code, Codex, Antigravity, …) into one coordinated team.
>
> **Different minds. One team.**

You prompt from **one place** and explicitly choose an execution mode:
**Single** passes the original request directly to one selected agent in the
current workspace; **Team** asks a swappable lead to plan, then a
provider-agnostic orchestrator assigns isolated worktree tasks and aggregates
the results. ROI goal: **get the most out of the models with the least quota.**

## Status
**Bremio v0.1 CLI is release-ready as a local npm artifact.** Phase 1
(vertical slice) is implemented, plus the Phase-2 quality gate and
early Phase-4 measurement/quota slices — explicit Single/Team modes, Claude
(Agent SDK) + Codex (`codex exec --json`) as swappable lead/workers, and an
Antigravity SDK worker, a validator, a sequential
scheduler, dependency-aware git-worktree isolation, independent review,
exit-code-backed test evidence, review-gated merge, and the CLI. Full design
lives in [`docs/`](docs/); start at [`docs/README.md`](docs/README.md). Still out
of scope (see [`docs/06`](docs/06-roadmap.md)): Antigravity lead/test-gate
roles, automatically enabled/calibrated quota optimization, parallelism,
dashboard.

The release gate typechecks, runs the full automated suite, builds the bundled
CLI, packs it, installs that tarball into a clean temporary project, and checks
`--version`, `--help`, and all three `doctor` entries. Real-provider smoke is a
separate explicit gate because it consumes quota.

## Build and install the v0.1 artifact

From a source checkout:

```powershell
corepack pnpm install
corepack pnpm release:check
npm pack
npm install --global .\bremio-0.1.0.tgz
bremio --version
bremio doctor
```

`npm pack` runs the build again. The tarball contains the CLI bundle, source
map, and Antigravity Python sidecar plus its requirements file. This v0.1 cut
is intentionally a local tarball release (`private: true`), not an npm registry
publication.

## Quickstart
Prerequisites: **Node 22+**, **pnpm** (via `corepack`), the **`codex`** CLI on
`PATH` and logged in (`codex login`), and Claude auth for the Agent SDK
(`ANTHROPIC_API_KEY` or a Claude Code login).

Antigravity is optional. It needs Python 3.10+, the official SDK, and either
`GEMINI_API_KEY` or Vertex credentials. Install it in a dedicated environment
and point Bremio at that interpreter (PowerShell example):

```powershell
py -3.12 -m venv .bremio\antigravity-venv
& .bremio\antigravity-venv\Scripts\python.exe -m pip install -r packages\adapter-antigravity\requirements.txt
$env:BREMIO_ANTIGRAVITY_PYTHON = (Resolve-Path .bremio\antigravity-venv\Scripts\python.exe).Path
```

Keep credentials outside the repository. `bremio doctor` reports Antigravity
as `unavailable` if its SDK environment is missing, or `degraded` until
supported credentials are visible to the configured sidecar.

```sh
corepack pnpm install
corepack pnpm test          # unit + quality-gate + timeout E2E runs
corepack pnpm typecheck
corepack pnpm release:check # full local release gate + clean packed install

# check adapter health / lead-eligibility
corepack pnpm bremio doctor

# Single: one adapter call in the current workspace; no plan/scheduler/worktree/merge
corepack pnpm bremio run --mode single --agent codex --timeout 600 --repo /path/to/repo "fix the failing test"
corepack pnpm bremio run --mode single --agent claude --repo /path/to/repo "add a health endpoint"
corepack pnpm bremio run --mode single --agent antigravity --repo /path/to/repo "update the docs"

# Team: lead plans -> orchestrator hands a task to the OTHER agent,
# which edits code in its own git worktree; results aggregate into one report
corepack pnpm bremio run --mode team --lead codex --timeout 600 --repo /path/to/repo "add a health endpoint"
corepack pnpm bremio run --mode team --lead claude --repo /path/to/repo "fix the failing test"
corepack pnpm bremio run --mode team --lead claude --worker antigravity --repo /path/to/repo "add a health endpoint"
# --lead without --mode remains a backward-compatible alias for Team
corepack pnpm bremio run --lead codex --model gpt-5.6-terra --reasoning high --repo /path/to/repo "review this change"

# after the run's test + independent-review gate passes, review the diff and merge
corepack pnpm bremio merge TASK-002 --repo /path/to/repo          # prompts y/N
corepack pnpm bremio merge --run <runId> --repo /path/to/repo --yes
corepack pnpm bremio merge --run <runId> --strategy cherry-pick --repo /path/to/repo --yes

# summarize the usage ledger and fail-closed calibration readiness
corepack pnpm bremio stats --repo /path/to/repo

# inspect normalized AQT capacity with per-window freshness (read-only)
corepack pnpm bremio capacity --aging-after 15 --stale-after 30

# explicitly enable the conservative Phase-4C safety router for a run
corepack pnpm bremio run --mode team --capacity-routing --lead codex --repo /path/to/repo "fix the failing test"

# explicit real-provider smoke (consumes quota; default = Team, both leads)
corepack pnpm smoke:providers --mode team --lead both --timeout 600
corepack pnpm smoke:providers --mode single --agent both --timeout 600
corepack pnpm smoke:providers --mode team --lead claude --worker antigravity --timeout 600
```

In Single mode the selected agent uses the current workspace directly. Bremio
warns if it is already dirty and does not create a worktree, branch, or merge
step. Team tasks run in `<repo>/.bremio/worktrees/<taskId>-<agent>/` on branch
`bremio/<taskId>-<agent>`; per-task logs and `report.json` land in
`<repo>/.bremio/runs/<runId>/`. Press **Ctrl+C** to cancel an in-flight run.
`--timeout <seconds>` applies a hard limit to each planning attempt and worker
task; timeout cancellation is propagated to the active provider process.

`smoke:providers` first checks the selected adapters, then creates a disposable
git fixture per run. Single mode requires a completed direct implementation
with recognizable passing verification evidence. Team mode requires real
delegation plus a passed test/review gate. Fixtures are deleted on success and
retained on failure; pass `--keep` to retain successes too. Antigravity's
preflight fails closed while its SDK credentials are missing. The command is
intentionally excluded from both `pnpm test` and `release:check`, so normal QA
never spends provider quota.

Team runs never auto-merge — worktrees are **left for review**. `bremio merge`
first requires a passed run quality gate, then shows the diff, asks for
confirmation (or `--yes`), merges into the base branch (`--no-ff`), and cleans
up the worktree + branch; conflicts abort cleanly. Test/review tasks inherit
their dependency branches, so they inspect the implementation rather than HEAD.
`--strategy cherry-pick` instead applies each task-owned `commitHash` in plan
order, excluding inherited dependency history; conflicts also abort cleanly.
Every task also appends a line to `.bremio/ledger.jsonl`, including
provider-reported task and lead-planning token/cost
usage plus requested/provider-confirmed model and reasoning identity when
available, summarized by
`bremio stats [--since <date>]`.
Planning entries are counted as coordination rather than tasks, including on
planning failure. Every completed execution path adds a run-summary with its
flow mode and mode-appropriate objective outcome: recognizable command evidence
for Single, or the fail-closed quality gate for Team. `--comparison <id>` can link
controlled runs of the same request. Stats recommends single-agent until there
are enough matched comparisons plus provider-reported model, cost, and
coordination coverage. Missing usage remains unknown; no price is estimated.
`bremio capacity` (`bremio quota` is an alias)
reads AI-Quota-Tray's schema-v1 SQLite database in read-only mode. Unsupported
schema versions are rejected. Aging snapshots lose confidence, while stale,
disabled, or errored providers normalize to `unknown` without dropping their
last-known values. `bremio run --capacity-routing` opts into the conservative
Phase-4C safety slice: only fresh, high-confidence exhaustion can prohibit an
agent; stale/unknown data is a soft penalty and preserves established routing.
This remains opt-in until ledger calibration supports automatic optimization.

## Packages
`protocol` (Zod contracts) · `adapter-sdk` (the `AgentAdapter` interface) ·
`adapter-claude` · `adapter-codex` · `adapter-antigravity` (official Python SDK
sidecar) · `orchestrator` (direct Single runner plus
Team lead-manager, validator, router, scheduler, aggregator) · `quota`
(read-only AQT consumer) · `workspace`
(worktrees + logs) · `apps/cli`.

## Core principles
- Orchestrator is provider-agnostic — Claude is only the *default lead*.
- Lead **proposes** the plan; the orchestrator **executes** it (swapping the
  lead doesn't require rewriting the core).
- Single and Team are explicit manual modes. Future Auto may choose Team only when
  `outcome ≥ single-agent baseline` and `net_gain > 0`.
- Don't rebuild the quota reader — consume `AI-Quota-Tray`.
- No UI-extension scraping; use official programmatic surfaces.

## MVP (Phase 1)
Claude (lead) + Codex (worker), sequential. See
[`docs/06-roadmap.md`](docs/06-roadmap.md).

## Stack (planned)
Node 22 · TypeScript · pnpm workspaces · Zod · SQLite · simple-git · Pino · Vitest.
Adapters: Claude Agent SDK · Codex app-server/exec · official Antigravity
Python SDK sidecar.
