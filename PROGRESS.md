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

## Parity — Option C (docs/17 P0–P3)

### P0…P3 — hygiene, bench, closed loop, real tools
- **agent:** Claude (tech lead) + three parallel worktree forks (P1, P2, P3)
- **time:** 2026-11-05T01:20 → 2026-11-05T14:30
- **branch:** claude/dreamy-rubin-5tnzfg (forks merged from `worktree-agent-*`)
- **task(s):** P0-T1…T6, P1-T1…T5, P2-T1…T7, P3-T1…T5, P3-FIX, P2-FIX
- **status:** done

**Did**
- P0: typecheck green again (S13-T7 broke it; the panel's renderer copy also
  lacked the new cases — drift test now covers them); CI on ubuntu+windows;
  one version pinned by release smoke; this log archived; doctor states which
  tools reach agents.
- P1: `packages/bench` + 12 self-checked cases + `bremio bench run|report|check`
  + `bench` ledger scope ignored by stats/calibration + dispatch-only workflow.
- P2: `errorCode` on outcomes; bounded Team fix loop and Single `--verify` loop;
  `--review-plan` checkpoint (CLI + daemon route); definition of done;
  `--max-replans`; `--auto-pr`. `docs/19`.
- P3: run-scoped adapter wrapper delivering opted-in MCP (Claude, Codex),
  five veto hook points, playbooks under a token budget, pluggable web search,
  `bremio mcp serve`. `docs/20`.
- Review fixes by the tech lead: trust-on-digest for repo configs that spawn
  host processes (`bremio trust`); auto-PR refuses before pushing when `gh`
  or a GitHub remote is missing.

**Decided**
- Plan checkpoint without a terminal **rejects** (docs/14 ADR-4 fail-closed),
  overriding the directive's "approve unless policy denies"; the doc wins.
- An untrusted hooks file **denies** rather than being skipped: a skipped guard
  reads as a passed one. Playbooks are prompt text and are not trust-gated.
- `SPRINT-LOG.md` stays in place: `docs/10` and the prompt packs reference it.
- Library default for `maxFixIterations` is 0 (reports unchanged); CLI and
  daemon default to 2.

**Blocked / handed off**
- The P1 exit criterion (a real baseline number) and the docs/17 gate need a
  provider-backed `bremio bench` run; no quota was spent in this session.
- Follow-ups recorded on the board: P3-F1, P3-F2, P2-F1, P2-F2.

**Verification**
- Each fork: typecheck, test, build, release:smoke green in its worktree, with
  red-checks per guard (listed in each merge's fork report).
- Tech lead: trust guard red-checked (4/7 trust tests fail without it); auto-PR
  push-order test red before the fix, green after.
- Merged branch (`corepack pnpm release:check` equivalent): typecheck clean;
  test 111 files, 1410 passed / 3 skipped; build OK; release smoke PASS.
