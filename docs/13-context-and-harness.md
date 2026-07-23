# 13 — Track B: context and the stateful harness

Turning Bremio from a tool that runs **one prompt** into one that holds a
**conversation**. This is v1.1, after Track A and after `1.0.0` is cut.

It depends on Track A: a session must exist and be visible before continuing one
means anything. It is also the larger and riskier of the two tracks — it touches
the protocol, the daemon, four adapters and a new package — so it opens with a
verification task, not a coding task.

Rules: [`10-delegation-contract.md`](10-delegation-contract.md).

## The one decision that keeps this tractable

In a multi-agent orchestrator, "context continuity" sounds like every agent must
remember everything. It must not, and pretending otherwise is how this track
would become unfinishable.

**Continuity is the lead's problem, and Single mode's problem.** Workers are
ephemeral by design: each receives a task prompt that the lead composed, does
one job in one worktree, and ends. What must carry across turns is the *lead's*
understanding — the plan so far, what was built, what failed — so it can re-plan
turn N+1 with knowledge of turns 1..N. A worker that needed the whole history
would be a worker that should have been given a better task prompt.

So: **the lead and the Single agent get real continuity; workers get better
task prompts.** Everything below follows from that.

## Two mechanisms, chosen by capability

| Adapter | `resumableSessions` today | Mechanism |
|---|---|---|
| Claude | `false` | Agent SDK session resume — provider holds the context |
| Codex | `false` | app-server thread persistence — provider holds the context |
| Antigravity | `false` | no session surface → Bremio re-injects assembled context |
| OpenCode | `false` | CLI is one-shot; server has sessions → probe (B0) |
| `adapter-local` | `false` | chat completions are stateless → re-inject message history |

`resumableSessions` already exists in `AgentCapabilities` and is `false`
everywhere, and `outcome.sessionId` already exists in the protocol to carry a
provider session id. The contract was designed for this; nothing has used it
yet.

Where the provider can resume, Bremio sends only the new turn and lets the
provider hold the history. Where it cannot, Bremio assembles and re-injects.
The harness picks per adapter from the capability — never from a provider name.

---

### Verified Findings (B0 Probe Results)

| Adapter | Can Resume Non-Interactively? | Required Identifier | Exposed in Stream Today? | Preserves Earlier Turns? | Unknown / Expired ID Behavior |
|---|---|---|---|---|---|
| **Claude** (`adapter-claude`) | **YES** | Session UUID (e.g. `4bf89d8e-...`) | **YES** (`msg.session_id` in `result` event) | **YES** (recalled `ALPHA-999` secret across turns) | Throws SDK Error (`--resume requires a valid session ID...`) |
| **Codex** (`adapter-codex`) | **YES** | Thread UUID (e.g. `019f8f24-...`) | **YES** (`thread_id` in `thread.started` event) | **YES** (recalled `BETA-777` secret across turns) | Exits non-zero (code 1) with `no rollout found for thread id` |
| **OpenCode** (`adapter-opencode`) | **NO** | Session ID string (`--session <id>`) | **NO** (CLI `--format json` omits session metadata) | **Not available** | **Not available** (hangs non-interactively without TTY) |
| **Antigravity** (`adapter-antigravity`) | **NO** | None (stateless execution surface) | **NO** | **NO** | N/A (re-injection required) |
| **Local** (`adapter-local`) | **NO** | None (stateless chat completions) | **NO** | **NO** | N/A (re-injection required) |

#### Exact Probes and Observations

1. **Claude (Agent SDK)**
   - **Command / Code**: Executed `node ./packages/adapter-claude/probe-claude.mjs` calling `@anthropic-ai/claude-agent-sdk` `query()`.
   - **Turn 1**: `query({ prompt: "Remember secret code ALPHA-999. Reply with ONLY 'OK'.", options: { maxTurns: 2 } })`.
     - *Observed*: Result event returned `session_id: "4bf89d8e-328f-42b1-872a-d2d9e73ed5db"`, result `"OK"`.
   - **Turn 2**: `query({ prompt: "What was the secret code I told you earlier?", options: { resume: "4bf89d8e-328f-42b1-872a-d2d9e73ed5db", maxTurns: 2 } })`.
     - *Observed*: Result event returned `"ALPHA-999"`, confirming turns are preserved.
   - **Invalid ID test**: `query({ prompt: "Hello", options: { resume: "invalid-session-id-12345" } })`.
     - *Observed*: Threw error `Claude Code returned an error result: Error: --resume requires a valid session ID or session title... Provided value "invalid-session-id-12345" is not a UUID`.

2. **Codex (app-server threads)**
   - **Command / Code**: Executed `node ./packages/adapter-codex/probe-codex.mjs` spawning `codex exec`.
   - **Turn 1**: `codex exec --json -s workspace-write -o out1.txt` with stdin `"Remember secret word BETA-777. Reply ONLY 'OK'."`.
     - *Observed*: First JSON line on stdout was `{"type":"thread.started","thread_id":"019f8f24-5ef0-7f41-baa7-f4f0466ecf10"}`.
   - **Turn 2**: `codex exec resume 019f8f24-5ef0-7f41-baa7-f4f0466ecf10 --json -o out2.txt` with stdin `"What was the secret word I told you earlier?"`.
     - *Observed*: Output file received `"BETA-777"`, confirming turn history is preserved.
   - **Invalid ID test**: `codex exec resume 00000000-0000-0000-0000-000000000000 --json -o out3.txt`.
     - *Observed*: Exited code 1 with stderr `Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)`.

3. **OpenCode (`opencode serve` / CLI)**
   - **Command / Code**: Executed `node ./packages/adapter-opencode/probe-opencode.mjs` and `opencode run "hello" --format json`.
   - *Observed*: Non-interactive execution of `opencode run` hangs without an interactive TTY session. CLI `--format json` does not emit session initialization events. OpenCode sessions are therefore not resumable via non-interactive CLI subprocesses in `adapter-opencode`.

#### `resumableSessions` Capability Summary (per docs/10 §6c)
- **Claude (`adapter-claude`)** and **Codex (`adapter-codex`)** may set `resumableSessions: true` once B4 implements `resumeRun()`, earned by provider-native non-interactive session/thread resumption (`options.resume` in Claude Agent SDK, `codex exec resume <thread_id>` in Codex).
- **OpenCode (`adapter-opencode`)**, **Antigravity (`adapter-antigravity`)**, and **Local (`adapter-local`)** MUST keep `resumableSessions: false`. Context continuity for these adapters is earned via Bremio's context assembler re-injection (Track B).

---

---

## B1 — The session remembers more than its transcript

**Goal.** Storage for what a later turn needs: provider session ids and a
running summary.

**Why.** Track A stores *what happened*. Continuity needs *what it means* — a
compact carry-forward, plus the provider handle when the provider holds context
itself.

**Files.** `apps/daemon/src/storage.ts`, `packages/protocol/src/`.

**Success criteria.**
- `session_context(session_id, turn_index, summary, provider_session_ids)`,
  migrated the same way A1-T1 migrated: an existing database upgrades in place
  with nothing lost.
- Provider session ids are stored per adapter, since a Team turn may hold one
  for the lead and none for the workers.
- A summary is stored per turn, never overwritten in place — turn N's summary
  must remain readable after turn N+1 exists.
- Nothing is fabricated: a turn with no summary reads as absent, not as "".

**Tests.** Migration preserves existing data; per-adapter ids round-trip; an
absent summary is distinguishable from an empty one.

**Commit.** `feat(daemon): store what a later turn needs to know`

---

## B2 — The context assembler

**Goal.** Given a session and a new prompt, produce the input for the next turn.

**Why.** This is the heart of the track, and the place where an honest system
differs from a plausible one.

**Files.** New `packages/harness/` — `context-assembler.ts` (+ tests).

**Success criteria.**
- Input: session history (prior prompts, outcomes, summaries) and the current
  repository state. Output: the lead's prompt for this turn.
- The **current diff state** is included — what previous turns actually changed
  — because "now also handle the error case" is meaningless without it.
- Ordering is explicit and stable: recent turns verbatim, older turns as
  summaries, oldest dropped only after being summarised.
- Nothing user-supplied is silently truncated mid-token in a way that changes
  meaning; when content is elided, the prompt says so.
- Pure and synchronous where possible, so it is testable without a provider.

**Tests.** Exact assembled output for a fixed history; a turn referring to a
prior change sees that change; elision is announced. Assert content, not shape.

**Commit.** `feat(harness): assemble the next turn from the session so far`

---

## B3 — The context budget

**Goal.** Sessions that grow without either exploding the window or lying.

**Why.** Every long conversation eventually exceeds the model's context. How a
system handles that is a correctness property, not an optimisation.

**Files.** `packages/harness/context-budget.ts` (+ tests).

**Success criteria.**
- A per-provider budget, from configuration — no model names in core
  (`docs/05`).
- When the assembled context would exceed the budget, older turns are
  **summarised, then dropped** — never silently truncated.
- Token accounting uses **provider-reported usage where it exists**; an estimate
  is labelled as an estimate and never presented as measured. This is the same
  rule `net_gain` follows, for the same reason.
- If the budget cannot be satisfied even after summarising, the turn **fails
  closed with a reason** rather than sending a context it knows is wrong.

**Tests.** A history over budget summarises rather than truncates; a
provider-reported count is preferred over an estimate; an impossible budget
fails with a named reason. Exact values.

**Commit.** `feat(harness): keep a session inside its context budget`

---

## B4 — `resumeRun`, for the adapters that earned it

**Goal.** Implement resume where B0 proved it works.

**Why.** Where the provider holds context, Bremio should not rebuild it —
re-injection costs quota and loses provider-side state.

**Files.** `packages/adapter-claude/`, `packages/adapter-codex/`, and any other
adapter B0 cleared. Their tests.

**Success criteria.**
- `resumeRun(sessionId, request)` is implemented for each cleared adapter, and
  `resumableSessions` becomes `true` **only** there.
- The provider session id is emitted in `outcome.sessionId` so the harness can
  store it.
- An expired or unknown provider session is a **classified, non-fatal failure**
  that the harness can fall back from — not a crash, and not a silent new
  session pretending to be the old one.
- Adapters B0 did not clear keep `resumableSessions: false` and keep rejecting
  `resumeRun` explicitly.
- Fixtures are recorded from the real provider (`docs/10` §5).

**Tests.** Resume replays into a continued session; an unknown session id is
classified and recoverable; a non-resumable adapter still rejects explicitly.

**Commit.** `feat(adapters): resume a provider session where one exists`

---

## B5 — Continuity, Single first

**Goal.** A follow-up prompt continues the session.

**Why.** Single mode is one agent and one workspace — the simplest place for
continuity to be correct. Team adds a lead, workers and worktrees on top; doing
it second means the hard part is debugged in the easy case.

**Files.** `packages/harness/turn-runner.ts`, `packages/orchestrator/src/single-run.ts`,
then `run.ts`; `apps/cli/src/index.ts` (`--continue` / `bremio session continue`).

**Success criteria.**
- A follow-up turn in Single mode sees the prior turns and the changes they
  made, and lands as turn N+1 of the same session.
- Resume is used where the capability allows; re-injection otherwise. The choice
  is made from the capability, never a provider name, and the reason is recorded
  in the turn like every other automatic decision (`docs/08` S4-T3).
- Team continuity follows, with the lead resuming and workers still receiving
  composed task prompts.
- Cancellation and the fail-closed guarantees from Sprint 4 hold across turns —
  a cancelled turn does not corrupt the session.
- The ledger attributes each turn separately, so `net_gain` stays computable.

**Tests.** A second turn sees the first's changes; the mechanism chosen matches
the capability; a cancelled turn leaves the session resumable and intact.

**Commit.** `feat(harness): continue a session with a follow-up turn`

---

## B6 — Prove the harness fails closed too

**Goal.** One integration test asserting the harness's safety properties as a
set, in the shape of `fail-closed.integration.test.ts`.

**Why.** Sprint 4 showed the failure mode: each guard had a unit test, nothing
proved they held together, and the one property nobody exercised was the one
that was broken.

**Files.** One new integration test under `packages/harness/`.

**Success criteria.** With the real assembler and real budget:
1. a context that cannot fit fails closed with a reason, never sends truncated;
2. an expired provider session falls back to re-injection rather than starting a
   silent blank session;
3. a cancelled turn leaves the session resumable;
4. a summary is never presented as verbatim history;
5. an estimated token count is never reported as measured;
6. a non-resumable adapter never receives `resumeRun`.

**Each assertion must fail for the right reason when its guard is removed** —
verify by removing one, and record it. `docs/10` §5: a test must cover the
property its name claims.

**Commit.** `test(harness): prove the context guarantees hold together`

---

## Sequencing and risk

B0 gates everything: B4 and B5 cannot be specified precisely until the resume
surfaces are known, and this document should be **revised after B0** rather than
followed blindly. B1–B3 can proceed in parallel with B0 since they do not depend
on provider behaviour.

The largest risk is not technical but definitional: "context" quietly expanding
until every agent needs everything. The scoping decision at the top of this
document is the guard against that, and any task that starts giving workers
session history is out of scope until a measured reason says otherwise.
