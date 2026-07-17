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
| 99 | [99-risks-and-open-questions.md](99-risks-and-open-questions.md) | **Read before coding.** ROI, load-bearing risks, items to verify |

## Status

- Phase: **design** — no code yet. MVP = Phase 1 vertical slice (see roadmap).
- Origin: brainstorm with an agent (2026-07). These docs have been **filtered
  and reworked**, not copied verbatim.
- Open major decisions: see `99-risks-and-open-questions.md` §Open Questions.

> ⚠️ The docs describe the *target design*. Don't build it all at once —
> Phase 1 only needs to prove: any given lead can produce a valid plan, and
> the orchestrator can hand off a task to another agent running in its own
> worktree.
