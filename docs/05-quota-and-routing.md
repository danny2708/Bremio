# 05 — Quota, Efficiency Model & Routing

## Foundational principles

1. **Don't rebuild the quota reader.** `AI-Quota-Tray` already reads
   official quota for Codex (`account/rateLimits/read`), Claude Code
   (status-line bridge), and Antigravity (local language-server
   `GetUserStatus` RPC). `packages/quota`
   **consumes** that source (reads the cache file AQT writes, or the
   official-source logic is split into a shared package). No UI scraping.
2. **Be honest about `unknown`.** If a machine-readable source is missing →
   report `status:"unknown"`, don't guess and route on a made-up number.
3. **Quota is Phase 4, NOT the MVP.** Prove orchestration works first;
   optimize quota afterward, once a usage ledger exists to measure it.

## Current AQT integration (2026-07-18)

`packages/quota` now reads AQT's WAL-backed schema-v1 SQLite database directly
and read-only. `bremio quota [--db <path>] [--stale-after <minutes>]` exposes the
normalized result for calibration. The default database is under
`%LOCALAPPDATA%/aiquotatray/AI Quota Tray/data/quota-history.sqlite3`.

Routing remains disabled by default. `bremio run --capacity-routing` explicitly
enables the conservative 4C safety slice. Unsupported schema versions are
rejected, and disabled/errored providers, missing buckets, or old quota windows
remain unknown/low-confidence signals rather than hard exclusions.

### Coverage audit

| Agent | Already available through AQT SQLite | Gap in Bremio |
|---|---|---|
| Claude Code | 5-hour and 7-day windows from the opt-in status-line bridge | CLI/TUI cards and native-usage action are implemented. Extra windows such as "Weekly Fable" are not currently whitelisted by AQT and must remain absent until a structured source is verified. |
| Codex | Every `rateLimitsByLimitId` entry, including primary/secondary windows and optional individual limits | Multiple windows are preserved and the 4C evaluator uses their minimum remaining percentage. |
| Antigravity | One bucket per model from `clientModelConfigs[].quotaInfo`, with remaining fraction and reset time | CLI/TUI display every bucket. Known display keys map to verified provider model ids; unknown keys stay visible but cannot drive routing. |

AQT persists Antigravity's display-derived bucket key rather than a provider
model id. Bremio maps only the display names verified through `agy models list`
in `packages/quota/src/antigravity-models.ts`; unrecognized names deliberately
remain unmapped and are not routing evidence.

Current runtime check on 2026-07-18 found AQT stopped and the database last
updated on 2026-07-12. `bremio quota` correctly reports every provider as
`unknown`/stale. The first Capacity UI must show this freshness explicitly.

## Target `QuotaProvider` contract

`readAqtQuota()` remains the concrete AQT source adapter. The canonical
`QuotaProvider` contract above it preserves multiple account windows and
per-model Antigravity capacity:

```ts
interface QuotaProvider {
  readonly id: string;
  readSnapshot(): Promise<AgentCapacitySnapshot>;
  refresh?(): Promise<AgentCapacitySnapshot>; // delegates to AQT; does not copy fetch logic
  openNativeUsage?(): Promise<void>;
}

interface AgentCapacitySnapshot {
  agentId: string;
  availability: "idle" | "busy" | "unavailable" | "unknown";
  status: "healthy" | "limited" | "critical" | "exhausted" | "unknown";
  confidence: "high" | "medium" | "low";
  freshness: "fresh" | "aging" | "stale" | "unknown";
  source: { name: string; confidenceLabel: string };
  capturedAt: number;
  windows: QuotaWindow[];
}

interface QuotaWindow {
  id: string;
  label: string;
  scope: "account" | "model";
  modelId?: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: number;
  windowMinutes?: number;
  capturedAt: number;
  freshness: "fresh" | "aging" | "stale" | "unknown";
  confidence: "high" | "medium" | "low";
}
```

The default freshness policy marks data as `aging` after half of the stale
window (15 minutes with the default 30-minute cutoff). Aging reduces source
confidence by one level; stale data is always low-confidence. Percentages and
reset times remain visible as last-known observations. Both thresholds are
configurable through `bremio capacity --aging-after ... --stale-after ...`.

Quota is separate from `AgentAdapter`; provider execution adapters do not own
or duplicate capacity snapshots.

## Capacity surface

Use **Capacity** as the tab name. It is broader than quota and can later include
agent availability, active-task count, health, recent latency, quota windows,
and whether the agent can accept more work.

The first UI slice should provide:

- one card per agent, with every quota window/model bucket;
- used/remaining percentages, reset time, source, confidence, and data age;
- manual refresh and provider-specific `Open usage` when a native page exists;
- explicit unavailable/unknown states instead of fabricated percentages.

The Refresh button initially re-reads AQT SQLite. Do **not** copy the Codex RPC,
Claude bridge, or Antigravity process-discovery/CSRF logic into Bremio;
duplicated provider logic would drift and double the security surface.

## AQT loopback API — the source refresh boundary (2026-07-18)

The "stable AQT command/IPC" this section called for now exists, so capacity is
active rather than passively read.

AQT binds `127.0.0.1` on an ephemeral port and publishes the port plus a
per-launch token to `<app data>/bridge/local-api.json`. Endpoints:
`GET /health`, `GET /overview`, `POST /refresh`.

**The endpoint is a trigger, not a second data source.** Bremio asks AQT to
fetch, AQT persists to its SQLite, and Bremio reads that database exactly as
before. One data path means provider parsing is never duplicated, so the two
projects cannot drift in how a bucket is interpreted.

Trust model: loopback-only bind; a token required on every request; a `Host`
check to blunt DNS rebinding from a browser page; an 8 KB request cap. Callers
must already be able to read this user's local app data — the same boundary
that protects the SQLite database. The endpoint file is a *hint*: it survives a
crash, so liveness is proven by connecting, and a published-but-dead endpoint
reports `stale-endpoint`, never `live`.

`bremio capacity` refreshes by default (`--no-refresh` opts out) and always
states whether the source was LIVE or last-known. The TUI Capacity screen
refreshes on open, every 30s, and on `r`.

### Contact age vs data age (fixed 2026-07-18)

AQT's `persist_snapshots` skips the insert when a bucket's values are
unchanged, so `quota_snapshots.fetched_at` records when a value *first
appeared*, not when it was last confirmed. A steady quota (Antigravity buckets
sitting at 100%) therefore looked days stale moments after a successful poll,
and Bremio's rule that one stale window fails its whole provider closed turned
that into a `unknown`/`STALE` card over current data.

Provider-level age now comes from `providers.updated_at`, which AQT writes on
every successful fetch. Windows keep their own `fetched_at`. The two answer
different questions and are labelled accordingly: the provider line reads
`last contact <age> ago`, each window reports its own data age.

This is safe for routing by construction: `assessCapacity` reads only
`snapshot.windows` — `statusForRemaining` from window percentages and
`isTrustedWindow` from per-window freshness and confidence. It never reads the
provider-level `status`, `freshness`, or `confidence`, so this change affects
reporting only, never agent selection.

**Known limitation.** For Claude the fetch reads a status-line cache file, so a
successful read moves `updated_at` even when the cached content is old: the
provider can read fresh contact while every window is stale. The `status` stays
`unknown` (AQT applies `CLAUDE_STALE_AFTER_SECONDS` itself), and the windows
show their real ages. Capping provider freshness by the newest window would fix
this case but would reintroduce the original bug for steady values, since a
steady quota and an abandoned source are indistinguishable from bucket
timestamps alone.

### Retiring withdrawn buckets (fixed 2026-07-18)

Consumers read the latest row per bucket, so a bucket the provider stopped
reporting kept serving its final value forever (observed on `codex:secondary`,
which held a 07-12 value indefinitely). On a successful fetch that produced at
least one bucket, AQT now writes a tombstone — NULL percentages, `fetched_at`
now, `severity = 'retired'` — for every previously-latest bucket absent from
the new set. History is preserved rather than deleted, and the guard on a
non-empty result stops a partial failure from retiring everything.

Bremio drops `retired` buckets entirely, so a withdrawn limit tier neither
displays nor constrains routing. `severity` is already free-form TEXT, so this
needs no schema change and AQT's `user_version` stays 1.

## Compatibility note

The old single-window `AgentAdapter.getQuota()` placeholder has been removed.
`AgentCapacitySnapshot` is the only normalized quota representation in Bremio.

## Efficiency model — "best out of the models, minimal quota"

ROI goal: **get the most out of the models with the least quota.** But this
must be measured correctly, avoiding over-promising. Three corrections to
the original intuition:

**(a) Multi-agent does NOT default to ≥ single-agent.** Multi-agent has
hidden costs: coordination cost (lead planning + aggregation), handoff loss
(agent B loses agent A's original reasoning), integration risk (more
worktrees = more merge surface). For small tasks, **one strong agent doing
the whole thing** usually wins on both quality and quota. → The baseline for
comparison is *the best single agent completing the whole task*, not "3
agents are always better."

**(b) Capacity adds up by cost-per-task, not by adding "efficiency."**
```
effective_capacity  ≈  Σ_i ( quota_i / cost_per_task_i )
```
Pooling providers can increase effective capacity, but only measured
cost-per-task improvements count. Jan was dropped from the current roadmap:
there is no implemented adapter or evidence that another local-provider path
would improve net gain. Routing only helps by **lowering cost_per_task**, and
only the **NET** portion counts.

**(c) Measure net, not gross. The invariant to enforce is `net_gain > 0`,
NOT `efficiency > 0`** (the latter is always vacuously true, since its
baseline is undefined):
```
net_gain = quota_saved_vs_baseline
         − quota_spent_on_orchestration(plan + aggregate + handoff + escalation_retries)
```
Fixed baseline: "the best single agent completing the whole task." If
net_gain ≤ 0 for a task type → that flow isn't worth it, fall back to
single-agent.

## Two mandatory invariants (enforced at the scheduler, measured via the ledger)
```
Per-task:  chosen_flow.outcome ≥ best_single_agent_baseline.outcome
Per-run:   net_gain > 0   (otherwise → fall back to single-agent)
```

## Single-agent baseline (implemented)

Single is an explicit direct adapter path: one selected agent receives the
original prompt in the current workspace. It does not invoke the lead planner,
router, scheduler, worktree manager, reviewer, or aggregation model. This makes
it an honest low-overhead baseline rather than a Team run labeled
"zero-delegation." Auto may later prefer it for small tasks, but manual mode
selection is the current policy.

## The escalation double-pay trap (bias check — Thinking Fast & Slow)
Cheap-model-first that guesses wrong means paying for **both the failed
cheap attempt and the expensive retry** — more than going straight to the
strong model. Cheap-first only wins once the router has been **calibrated**.
An uncalibrated router can make net_gain **negative**. This keeps the
principle already locked in `CLAUDE_master.md` (2026-07-16): escalate the
**stage** that actually failed — reasoning effort OR model tier, **never
both at once**.

## Usage ledger (the measurement tool — without it, "efficiency" is just a feeling)
The current implementation appends one measurement-only JSONL entry per task
to `.bremio/ledger.jsonl` with `ts`, `runId`, `taskId`, `provider`, `role`,
`kind`, `status`, `durationMs`, and `filesChanged`. Provider-reported input/
output tokens and cost are also preserved when present for both worker tasks
and lead planning/repair. Planning entries use `scope:"coordination"`, remain
separate from task completion metrics, and are recorded best-effort even when
planning fails. Both paths add `scope:"run"` entries with explicit `flowMode`,
a mode-appropriate `outcomeVerified`, and optional user-supplied
`comparisonId`. `bremio stats` reports provider-cost net gain per comparison
group and in aggregate, plus coverage and calibration blockers. Any incomplete
comparison remains `unknown` with its exact reason; aggregate net gain remains
unknown if even one group is incomplete. Calibration blockers name the missing
dimension and its sample deficit. Bremio never estimates a price.
Provider-confirmed model ids are recorded when exposed (including Claude's
system event), while an unreported Codex default remains unknown rather than
inferred. A group cannot produce numeric `net_gain` until it has a verified
single-agent baseline and complete provider-reported task and coordination
costs.

```json
{ "provider":"codex", "model":"gpt-5.6-terra", "effort":"medium",
  "taskType":"backend-crud", "durationSeconds":284, "filesChanged":4,
  "tokens":{"in":0,"out":0}, "orchestrationCostProxy":0, "result":"success" }
```
Cost must **include coordination** (lead-plan + aggregate quota attributed
to the run) to make the multi-vs-single comparison honest. Once there are
enough samples, the ledger yields an empirical task→model map.

## Guardrail & calibration gate
- **Kill-switch (implemented):** after a valid Team plan but before assignment,
  worktree creation, or worker execution, compare provider-reported coordination
  cost with the cheapest objectively verified Single task cost for the same
  `comparisonId`. The documented default in `config/routing.yaml` is 25%. If
  overhead exceeds that share, run the original prompt directly with the
  baseline provider and preserve the reason in the report. The check is inert
  unless calibration is ready and every included entry reports `costUsd`; it is
  never revisited after worker execution starts.
- **Calibration gate** (matches Kian-Brain's human-gate philosophy): the
  router is **not** allowed to trust cheap-first until the ledger has enough
  samples proving it doesn't create escalation waste.

The implemented readiness gate defaults to five controlled comparison groups,
90% multi-agent non-inferiority, 80% actual-model coverage, 80%
provider-reported cost coverage, and complete coordination coverage. A group is
evaluable only when a Single run with the same `comparisonId` passes its
recognizable verification-command check. A Team run remains non-inferior only
when its fail-closed quality gate passes. Until every threshold passes, the
recommendation is
`single-agent`; readiness means only `controlled-multi-agent`, not automatic
optimization. Policy thresholds are programmatically configurable.

This deliberately does not claim subjective quality equivalence or convert
tokens into subscription quota. The kill-switch therefore fires only for a
calibrated, fully measured comparison; partial real-world cost coverage leaves
it inert. The CLI can collect explicit Single baselines, but automatic initial
mode selection remains disabled.

## Router scoring (Phase 4, once the ledger exists)
The lead only describes the **need**, never picks a model name:
```json
{ "complexity":"high", "reasoningRequirement":"high",
  "contextRequirement":"large", "needsBrowser":false, "needsWriteAccess":true }
```
The router maps need → actual agent+model. Suggested scoring:
```ts
score = capabilityScore*0.30 + quotaScore*0.25 + taskFitScore*0.20
      + qualityScore*0.15   + speedScore*0.05  + preferenceScore*0.05;

if (agent.id === task.authorAgentId && task.kind === "review") score -= 100; // avoid self-review
if (quota.status === "critical") score -= 40;
if (!caps.repositoryWrite && task.needsWrite) return -Infinity;
```

Target policy (configuration, not hardcoded core logic):

```yaml
capacityPolicy:
  healthy:  { remainingPercentMin: 50 }
  limited:  { remainingPercentMin: 20 }
  critical: { remainingPercentMin: 5 }

routing:
  avoidCriticalAgents: true
  prohibitExhaustedAgents: true
  reserveLeadCapacityPercent: 15
  unknownQuotaPenalty: 10
```

The AQT observation normalizer retains source labels for display. The router
independently applies a validated, overrideable 50%/20%/5% policy; raw
percentages remain unchanged in Capacity output.

Router rules:

- Codex capacity is the minimum remaining value across the applicable account
  windows; all windows remain visible in the UI.
- Antigravity capacity is evaluated for the candidate model. A limited model
  must not make every other Antigravity model unavailable.
- A fresh, high-confidence exhausted window may prohibit that candidate.
- Low-confidence, stale, or unknown quota is a **soft scoring signal only**.
  It may apply `unknownQuotaPenalty`; it must never be the sole hard exclusion.
- Reserve lead capacity before assigning additional worker tasks to the lead.

Tiered model policy (trivial→critical) lives in `config/routing.yaml`; model
names are NEVER hardcoded in core — each adapter maps
`reasoningRequirement` → its own provider's model.

## Run-history fields (separate from quota)

Do not infer "TASK-018 consumed 3.7% quota." Keep the inexpensive facts Bremio
already controls or receives:

```ts
interface RunExecutionMetadata {
  requestedModel?: string;
  actualModel?: string;
  requestedReasoningLevel?: string;
  actualReasoningLevel?: string;
  durationMs: number;
  status: "completed" | "failed" | "cancelled";
}
```

Duration/status and requested/provider-confirmed execution identity are now
recorded separately in task results and the ledger. `--model` and `--reasoning`
capture explicit lead requests; actual model/reasoning remain absent unless a
provider event confirms them. Provider token/cost events remain optional
telemetry and are never converted into quota percentage.

## Capacity implementation checklist

### 4A — Observe and display

- [x] Read AQT schema-v1 SQLite read-only.
- [x] Preserve Codex multi-window buckets.
- [x] Preserve Antigravity per-model buckets.
- [x] Expose observation through `bremio quota`.
- [x] Introduce `QuotaProvider` and one canonical capacity schema.
- [x] Map the AQT source to one canonical card per supported agent; expose it
      through `bremio capacity` while retaining `bremio quota` as an alias.
- [x] Split requested/actual model and reasoning metadata in reports and the
      ledger without inferring provider defaults.
- [x] Add graphical **Capacity** cards in the TUI while keeping the CLI's data
      age, source, confidence, freshness, and every-window detail.
- [x] Add AQT-backed refresh, provider-specific `Open usage`, and explicit
      unavailable/last-known states in CLI/TUI surfaces.
- [ ] Extend AQT's Claude whitelist only when another structured window is
      verified; do not synthesize "Weekly Fable" from token usage.

### 4B — Freshness and monitoring

- [x] Degrade confidence per window as data ages; retain last-known values for
      display while marking them stale.
- [x] Let AQT own provider polling; Bremio consumes snapshots and can now
      trigger a fetch through the loopback API instead of waiting for AQT's
      own 30-900s tick.
- [x] Add confidence-gated CLI low-capacity alerts and per-window last-updated
      timestamps. Stale/unknown/low-confidence data never triggers an alert.

### 4C — Router integration

- [x] Add programmatically configurable thresholds and lead reserve with
      validated 50%/20%/5% and 15% defaults.
- [x] Apply hard exclusion only to fresh, high-confidence exhaustion.
- [x] Apply soft penalties to unknown/low-confidence/stale data. The default
      10-point penalty cannot erase the established 25-point task-role
      preference; trusted critical capacity can trigger a healthy fallback.
- [x] Select Antigravity capacity by candidate model and Codex capacity by all
      applicable rate-limit windows. The evaluator implements both rules and
      Codex is wired; Antigravity is now mapped through `antigravity-models.ts`.

The safety router is opt-in through `bremio run --capacity-routing`. This is a
calibration guard: normal runs retain the proven deterministic router until the
ledger has enough evidence to enable optimization automatically.

### 4D — Calibration readiness

- [x] Record run-level flow mode and mode-appropriate objective outcome.
- [x] Support explicit `comparisonId` metadata for controlled paired runs.
- [x] Report paired evidence, non-inferiority, model/cost/coordination coverage,
      blockers, and a fail-closed single-agent recommendation in `bremio stats`.
- [x] Add an explicit direct CLI Single baseline execution mode for Claude
      and Codex.
- [x] Enforce an automatic orchestration-cost kill-switch only after reported
      cost coverage meets the calibration gate. The decision is made after
      planning and before the first task; missing cost keeps it inert.

## Build order for this section
1. Ledger first (log the cost of every run, even before smart routing exists).
2. Consume quota from AI-Quota-Tray (Codex + Claude official; Antigravity per
   current AQT coverage). **Read-only observation slice shipped; router wiring
   waits for fresh-data calibration.**
3. Single-agent-vs-multi evidence gate. **Readiness reporting, direct baseline
   execution, net-gain arithmetic, and the calibrated pre-task kill-switch have
   shipped; automatic initial mode selection remains open.**
4. Scoring router + calibration gate. **The weighted, capability-aware router
   is implemented behind opt-in capacity routing; automatic/cheap-first mode
   remains disabled until paired evidence passes the gate.**
