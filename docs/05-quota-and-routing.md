# 05 — Quota, Efficiency Model & Routing

## Foundational principles

1. **Don't rebuild the quota reader.** `AI-Quota-Tray` already reads
   official quota for Codex (`account/rateLimits/read`), Claude Code
   (status-line bridge), and Antigravity (CLI API). `packages/quota`
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

This slice deliberately does **not** affect routing yet. Unsupported schema
versions are rejected, and disabled/errored providers, missing buckets, or any
quota window older than 30 minutes normalize to `unknown`. This fail-closed
behavior prevents a fresh short window from hiding a stale longer-term limit.

## QuotaSnapshot (allows partial data)
```ts
interface QuotaSnapshot {
  provider: string; agentId: string;
  remainingPercent?: number; utilizationPercent?: number; resetsAt?: string;
  status: "healthy" | "limited" | "critical" | "exhausted" | "unknown";
  source: "provider-api" | "sdk" | "cli" | "estimated" | "manual";
  confidence: "high" | "medium" | "low";
  capturedAt: string;
}
```

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
Pooling multiple providers + **local (Jan), near-free** is the biggest and
most reliable win. Routing only improves things by **lowering
cost_per_task**, and only the **NET** portion counts.

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

## Single-agent escape hatch (must exist)
The lead is ALWAYS allowed to choose **zero-delegation**: do the whole thing
itself, or hand it **entirely** to one agent. For a sufficiently simple
task, this is the correct choice — no multi-task plan, no extra worktrees,
no handoff loss. The router must treat "single-agent" as a valid flow and
usually the default for small tasks.

## The escalation double-pay trap (bias check — Thinking Fast & Slow)
Cheap-model-first that guesses wrong means paying for **both the failed
cheap attempt and the expensive retry** — more than going straight to the
strong model. Cheap-first only wins once the router has been **calibrated**.
An uncalibrated router can make net_gain **negative**. This keeps the
principle already locked in `CLAUDE_master.md` (2026-07-16): escalate the
**stage** that actually failed — reasoning effort OR model tier, **never
both at once**.

## Usage ledger (the measurement tool — without it, "efficiency" is just a feeling)
The current early implementation appends one measurement-only JSONL entry per
task to `.bremio/ledger.jsonl` with `ts`, `runId`, `taskId`, `provider`,
`role`, `kind`, `status`, `durationMs`, and `filesChanged`; `bremio stats`
summarizes those entries. It deliberately records no model, token, or cost
data and nothing routes on it. The richer target shape below belongs to Phase 4.

```json
{ "provider":"codex", "model":"gpt-5.6-terra", "effort":"medium",
  "taskType":"backend-crud", "durationSeconds":284, "filesChanged":4,
  "tokens":{"in":0,"out":0}, "orchestrationCostProxy":0, "result":"success" }
```
Cost must **include coordination** (lead-plan + aggregate quota attributed
to the run) to make the multi-vs-single comparison honest. Once there are
enough samples, the ledger yields an empirical task→model map.

## Guardrail & calibration gate
- **Kill-switch**: if a run's orchestration overhead > X% of task cost →
  auto fall back to single-agent. Stops the system from going net-negative.
- **Calibration gate** (matches Kian-Brain's human-gate philosophy): the
  router is **not** allowed to trust cheap-first until the ledger has enough
  samples proving it doesn't create escalation waste.

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
Tiered model policy (trivial→critical) lives in `config/routing.yaml`; model
names are NEVER hardcoded in core — each adapter maps
`reasoningRequirement` → its own provider's model.

## Build order for this section
1. Ledger first (log the cost of every run, even before smart routing exists).
2. Consume quota from AI-Quota-Tray (Codex + Claude official; Antigravity per
   current AQT coverage). **Read-only observation slice shipped; router wiring
   waits for fresh-data calibration.**
3. Single-agent-vs-multi decision + kill-switch.
4. Scoring router + calibration gate (enable cheap-first only once the
   ledger has enough samples).
