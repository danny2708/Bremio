# Bremio — Docs Index

> **Bremio** — A provider-agnostic orchestrator that turns AI coding agents
> (Claude Code, Codex, Antigravity, …) into one coordinated team.
> Tagline: *Different minds. One team.*

You prompt from **one place**; a **lead** (Claude by default, swappable)
analyzes the request and proposes a plan; the **orchestrator** assigns tasks
to the right agents, isolates them via git worktrees, and aggregates the
results back into one place.

## Read in this order

| # | File | Content |
|---|---|---|
| 00 | [00-overview.md](00-overview.md) | Problem, goals, **non-goals**, success criteria |
| 01 | [01-architecture.md](01-architecture.md) | Layered architecture, provider-agnostic protocol, core concepts |
| 02 | [02-flow.md](02-flow.md) | End-to-end flow: prompt → plan → route → execute → aggregate |
| 03 | [03-modules.md](03-modules.md) | Monorepo packages, responsibilities, boundaries, worktree isolation |
| 04 | [04-adapters.md](04-adapters.md) | Automation surface per provider (**verified**) + constraints |
| 05 | [05-quota-and-routing.md](05-quota-and-routing.md) | Quota normalization (reuses AI-Quota-Tray) + routing scoring |
| 06 | [06-roadmap.md](06-roadmap.md) | Phased plan (vertical slice first) |
| 07 | [07-operations.md](07-operations.md) | **Install, update, uninstall, recovery** + known limitations |
| 08 | [08-completion-plan.md](08-completion-plan.md) | Alpha → v1.0: 5 sprints, 20 tasks, success criteria |
| 09 | [09-opencode-adapter.md](09-opencode-adapter.md) | OpenCode adapter design + verification checklist |
| 10 | [10-delegation-contract.md](10-delegation-contract.md) | Working agreement for delegated implementation |
| 11 | [11-local-providers.md](11-local-providers.md) | Plug-and-play seam for local models (Jan/Ollama/LM Studio) |
| 12 | [12-session-history-and-observability.md](12-session-history-and-observability.md) | Track A (v1.0 blocker): sessions, one renderer, parallel lanes |
| 13 | [13-context-and-harness.md](13-context-and-harness.md) | Track B (v1.1): context assembly, budget, session continuity |
| 99 | [99-risks-and-open-questions.md](99-risks-and-open-questions.md) | **Read before coding.** ROI, load-bearing risks, items to verify |

## Status

- Code status (2026-07-22): `0.1.0-alpha.1` ships the CLI and Ink TUI, a
  durable loopback daemon, and a VS Code panel. Team execution is
  dependency-aware and parallel (default concurrency 2), while git worktree
  mutations stay serialized. Reports, cancellation states, diagnostics,
  quality-gated manual merge, durable history, and recovery paths are present.
- Claude and Codex are lead-capable. Antigravity uses the authenticated `agy`
  CLI and OpenCode uses its CLI/HTTP surfaces; both are Single/Team workers but
  are excluded from lead selection by their capability contracts. Real smoke
  evidence exists for all four providers, including both Claude/Codex lead
  directions and worker runs for Antigravity and OpenCode.
- Capacity can ask AQT to refresh through its authenticated loopback API, then
  reads AQT's schema-v1 SQLite source. CLI/TUI surfaces preserve windows,
  freshness, confidence, unavailable/last-known states, and native usage links.
  Scored capacity routing is opt-in. Net-gain arithmetic, fail-closed stats,
  controlled pair collection, and the calibrated pre-task cost kill-switch are
  implemented, as are calibration-gated Auto mode and user-approved Single→Team
  escalation.
- The local release gate passes typecheck, 415 tests, bundle build, clean packed
  install, and a 21-check fresh-profile daemon E2E on Windows. The separate
  POSIX verification now passes too (WSL Ubuntu 24.04, Node 22.23.1): process
  groups, single-instance lock and discovery, SQLite, SSE resume, cancellation
  states, and `0600` on the token file. All three v1.0 gates are green.
- Origin: brainstorm with an agent (2026-07). These docs have been **filtered
  and reworked**, not copied verbatim.
- Resolved v0.1 decisions and remaining risks: see
  `99-risks-and-open-questions.md`.

> ⚠️ The docs describe the *target design*. Don't build it all at once —
> Phase 1 only needs to prove: any given lead can produce a valid plan, and
> the orchestrator can hand off a task to another agent running in its own
> worktree.
