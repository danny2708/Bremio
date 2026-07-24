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

## Sprint 0 — Architecture lock and containment

### S0-ALL — architecture lock + two P0 containment patches
- **agent:** Claude (Opus 4.8), acting as tech lead
- **time:** 2026-07-24 → 2026-07-24
- **branch:** main
- **task(s):** S0-T1, S0-T2, S0-T3, S0-T4
- **status:** done

**Did**
- Probed all four adapter transports (`docs/15` §3). Key result: `agy 1.1.5`
  `--mode accept-edits` auto-*denies* headlessly, so there is no safe writable
  CLI flag — only `--dangerously-skip-permissions`, which also grants shell and
  network.
- Wrote the architecture lock: three independent axes (Collaboration / Control /
  Workspace), transport-level capabilities, identity + provenance model, honest
  daemon-restart semantics, and a plan amendment. `docs/15`.
- **Containment 1** (`apps/cli/src/session.ts`, `apps/daemon/src/storage.ts`):
  resume now reads persisted `lead_provider`/`mode`, projected onto
  `SessionDetail`. No model-string derivation, no `claude` default, no silent
  mode default. Unknown/unavailable → an error that names the session and refuses
  to substitute a provider.
- **Containment 2** (`packages/adapter-antigravity/`): `workspace-write` no
  longer implies `--dangerously-skip-permissions`. It is opt-in
  (`allowDangerousPermissionBypass`, default false); a writable run without it
  fails before spawn with an actionable message.

**Decided**
- Fail closed on the resume bug rather than "best guess", because a wrong
  provider is billed and looks legitimate — worse than a refusal.
- `WorkspaceStrategy` is a third axis, not a property of Solo/Co-lab. Consequence
  recorded: "Solo" now means "one agent", not "edits your files directly"; the
  TUI copy must change when Approve ships.
- Did **not** fix OpenCode's unconditional `--auto` (same defect class) — out of
  the approved containment scope. Logged as `docs/15` §8 and `TASKS.md` S2-T5.

**Verification**
- `corepack pnpm typecheck` — clean.
- `corepack pnpm test` — 562 passed / 58 files (was 544; +18 containment tests).
- `corepack pnpm release:check` — PASS, `bremio 1.2.0` packed install clean.
- Red-check 1: restored `?? "claude"` + model-string parse → 2 resume tests
  failed for the right reason (wrong provider, and fallback). Reverted.
- Red-check 2: forced the bypass on unconditionally → 4 antigravity tests failed
  (build throws, message content, no-downgrade, run reports failed). Reverted.
- Audits: `grep "model.*split"` — no production hit derives identity (only
  OpenCode's `provider/model` API parse). `grep "dangerously-skip-permissions"`
  — only in the gated path and its tests.

**Handed off**
- Next task per the lock: **S1-T1** (session_config schema v4 + migration),
  following the transactional/idempotent v1→v2 pattern in `storage.ts`. It blocks
  the rest of Sprint 1, so it runs alone first.
