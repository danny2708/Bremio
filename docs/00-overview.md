# 00 — Overview

## The real pain point

Currently vibe-coding across 3 parallel tools: **Codex** (VS Code extension),
**Claude Code** (VS Code extension), **Antigravity IDE**. Two concrete pains:

1. **Context-switching**: constantly jumping between terminal / extension /
   IDE to hand off work and collect results.
2. **Quota-tracking**: each provider has its own quota, and you have to
   remember how much is left to decide which agent to use.

Bremio targets **#1 first** (a single entry point with task assignment), and
**reuses the existing solution for #2** instead of rebuilding it (see
§Boundary below).

## What Bremio IS

A **control plane** with two explicit manual execution modes:
- **Single** → pass the original prompt directly to one selected adapter in the
  current workspace. The agent may reason internally, but Bremio does not
  create a Plan, schedule tasks, create worktrees, or aggregate model output.
- **Team** → a **lead** (a role, not the system's owner) creates a plan.
- The **orchestrator** (independent of every provider) makes the final call
  on which agent does which task, with what permissions, in which worktree,
  with which model.
- The lead can be **swapped** between Claude and Codex. Antigravity and
  OpenCode are Single/Team workers whose current structured-output contracts
  are not strong enough for lead eligibility.
- The lead **can also** take on code tasks, depending on quota.
- **Auto** selection and Single→Team escalation are later phases, not aliases
  for either manual mode.

## What Bremio is NOT (Non-goals)

- ❌ **Not a new AI coding tool.** It doesn't generate code with its own model.
- ❌ **Doesn't drive UI extensions** (clicking the Codex/Claude/Antigravity
  panel). UI is not a stable integration contract → use official
  programmatic surfaces instead.
- ❌ **Doesn't scrape quota from UI/IDE.** Only reads official sources; if a
  source is missing, it's reported as `unknown`.
- ❌ **Not a v1.0 right away.** The original MVP was a sequential vertical
  slice. The alpha has since added parallel execution and UI surfaces, but it
  still does not claim Auto routing, auto-merge, or v1 readiness.
- ❌ **Doesn't rebuild a quota reader.** See the boundary below.

## Boundary with AI-Quota-Tray (important)

`D:\Work\Side-Projects\AI-Quota-Tray` **already** reads official quota for
Codex (`account/rateLimits/read`), Claude Code (status-line bridge), and
Antigravity (local language-server RPC). Bremio **does not rebuild** this —
it **consumes** that output (see `05-quota-and-routing.md`). Otherwise we'd
be writing the same hardest piece of logic twice, in the same directory.

## Success criteria (MVP)

See `06-roadmap.md`. In short: one prompt can run either directly through one
Claude/Codex/Antigravity/OpenCode adapter in the current workspace (Single), or
through a Claude/Codex lead that returns Plan JSON and delegates isolated tasks
(Team), optionally to Antigravity or OpenCode as workers.
Both paths are cancellable, observable, and leave durable reports/logs.

## Core values guiding the design

Consistency (the team works from a clear contract) · ROI (don't build the
expensive thing before proving the cheap thing works) · Honesty (if quota is
`unknown`, say `unknown`).

## Additional design principles (efficiency-first)

- **P1 — Multi-agent must "earn its keep."** A multi-agent flow is only
  chosen when `outcome ≥ best-single-agent baseline` **and** `net_gain > 0`
  (quota saved minus orchestration cost). Otherwise → single-agent. Details
  and formula in `05`.
- **P2 — Single-agent is a first-class flow.** It is a direct adapter path,
  not a one-task Team plan and not a lead choosing zero-delegation. Manual mode
  selection comes first; Auto may default small tasks to Single only after
  calibration proves its policy.
- **P3 — Measure net, not gross.** "efficiency > 0" is a vacuous condition;
  the thing that must be enforced and measured is `net_gain > 0` against a
  fixed baseline. Without a usage ledger, no savings claim is allowed. See
  `05` §Efficiency model.
