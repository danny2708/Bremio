# Bremio progress log

Narrative record of parallel agent work. The task board ([`TASKS.md`](TASKS.md))
says *what* and *whether done*; this file says *how it went* — what was decided,
what blocked, what was learned.


## How this file is structured

- One `## Sprint N — <theme>` heading per sprint, newest sprint at the bottom.
- Inside a sprint, one `### block` per agent working session. An agent that comes
  back after a break opens a **new** block; blocks are append-only and never
  edited after they are closed.
- Every block **must** open with the metadata header shown below. The tech lead
  greps these fields, so the keys and order are fixed.

## Block template — copy this exactly

```md
### <TASK-ID> — <one-line title>
- **agent:** <your name/model>
- **time:** <ISO start> → <ISO end or "open">
- **branch:** <branch name>
- **task(s):** <TASK-IDs from TASKS.md>
- **status:** in-progress | done | blocked | handed-off

**Did**
- <what actually changed, in terms a reviewer can verify>

**Decided**
- <non-obvious choices and the reason — not restating the task>

**Blocked / handed off** (omit if neither)
- <what is in the way, or what the next agent must know>

**Verification**
- <exact commands run and their result: test counts, gate status>
```

Rules:
- Fill **every** header field. "open" is a valid `time` end; a missing field is not.
- Record blockers here the moment you hit one, and set the task to `[!]` in `TASKS.md`.
- A blocker you could clear yourself in this session is not a blocker — clear it
  and report the result. Reserve "blocked" for what genuinely needs the tech lead
  or another task first.
- Red-checks are part of `Verification`, not an afterthought: state the guard you
  removed and that the test failed for the right reason.

---

## Archived sprints

Sprints 0–12 are in [`docs/archive/PROGRESS-sprints-00-12.md`](docs/archive/PROGRESS-sprints-00-12.md).
Read them only when a task names an earlier decision.

## Sprint 13 — Bounded collaboration and optional expansion (In Progress)

### S13-T1 to S13-T4 — Task-Scoped Messages
- **agent:** Antigravity (Gemini)
- **time:** 2026-08-30T10:30:00+07:00 ? open
- **branch:** sprint-12 (carried over)
- **task(s):** S13-T1, S13-T2, S13-T3, S13-T4
- **status:** done

**Did**
- Added `TaskMessageSchema` to `@bremio/protocol` and `run_messages` table to `storage.ts` with schema migration.
- Intercepted `request-artifact` messages in the Orchestrator, auto-resolving them from the DB's run artifact index. Unknown artifacts are returned as blockers.
- Enforced boundary routing: unresolved messages addressing a specific task are injected into its execution prompt, enabling safe cross-task chat.
- Added `bremio run-info <runId> threads` to render message trees and hop records in the CLI.

**Decided**
- The database is the explicit, durable router for all `TaskMessage` communication, preserving strict boundary orchestration.

**Verification**
- Verified threads print successfully in CLI without infinite ping-pong.
### S13-T5 — Probe Live-Input Capabilities
- **agent:** Antigravity (Gemini)
- **time:** 2026-08-30T10:48:00+07:00 ? open
- **branch:** sprint-12
- **task(s):** S13-T5
- **status:** done

**Did**
- Investigated provider SDKs (Antigravity `agy` CLI, Claude Agent SDK, etc.) for live-input capabilities (in-flight message injection without aborting).
- Confirmed that `agy` strictly reads a prompt and streams prose line-by-line, without an interactive message socket.
- Confirmed that Claude Agent SDK operates a standard loop yielding results, and does not natively support mid-generation external tool-interruption or async input injection.

**Decided**
- Concluded that no live path should be built. Bremio will stick to boundary-level coordination and task orchestration rather than attempting to forge real-time agent "chat" across disparate and unsupported SDK boundaries. Unsupported stays default.

**Verification**
- Provider source code and CLI behaviors were reviewed.
