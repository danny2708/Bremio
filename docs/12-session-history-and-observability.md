# 12 — Track A: session history and observability

What the first real dogfooding run found missing, turned into work. This track
is the **v1.0 blocker**: `1.0.0` is not cut until it lands, because a stability
promise on a tool whose runs cannot be reopened would be a promise about the
wrong thing.

Track B (`13-context-and-harness.md`) follows as v1.1 and depends on this one —
you must be able to *see* a session before continuing it is meaningful.

Rules of engagement are unchanged and not repeated per task:
[`10-delegation-contract.md`](10-delegation-contract.md). Read §5 first; two of
its clauses exist because of failures in sprints 3 and 4 and this track will hit
the same shapes.

## The gap, precisely

Verified against `main` before writing this, not assumed:

| Observation | Reality today |
|---|---|
| Every event is already durable | `run_events(run_id, seq, type, payload)` in SQLite WAL, plus `readEvents(runId, afterSeq)`. **The backbone exists.** |
| Events are already rich | The daemon emits `{ kind, message, data }` where `data` is the full `AgentEvent` — `thinking`, `tool_use`, `tool_result`, `usage` are all preserved. **Nothing is lost in transit; the clients throw it away.** |
| There is no session | Only `runs`. One run = one prompt. No grouping, no turns, nothing to reopen. |
| The TUI cannot open a past run | `tui/screens/runs.tsx` is a read-only list; there is no selection, no replay. This is exactly the "open không mở được lịch sử" report. |
| The panel replays, but lossily | `openRun` replays events as `{kind, message}` lines — the reasoning, the tool calls and the model are dropped at the display layer. |
| Rendering is duplicated and divergent | `cli/ui.ts` `compactEvent`, `tui/screens/run.tsx`, and the webview each map events their own way. The TUI is the only one that shows `thinking`/`tool_use`. |
| Model and reasoning level are recorded but not shown | `usage` events carry provider-confirmed `model` and `reasoningLevel`; no surface displays them per agent. |
| Parallel tasks are a flat stream | Events are tagged `[TASK-00N]` into one log. With concurrency 2+ the screen is unreadable. |

So this track is mostly **display and one schema change** — not a rewrite. The
expensive part (durable, complete, ordered events) is already paid for.

---

# A0 — The small thing first

## A0-T1 — Attaching the current file actually attaches it

**Goal.** "Current file" in the panel attaches the file the user is looking at.

**Why.** It never works, because clicking the button moves focus to the webview,
so `vscode.window.activeTextEditor` is `undefined` and the handler posts "No
file is open in the editor to attach." The feature is unusable by construction,
and it is the first thing a user touches.

**Files.** `apps/vscode-extension/src/extension.ts` (`attachActiveFile`, and a
new subscription), its test.

**Success criteria.**
- Clicking "Current file" while a text editor is open attaches that file, with
  the workspace-relative label and the absolute path, as `describeFile` already
  produces.
- The last focused text editor is remembered (`onDidChangeActiveTextEditor`,
  ignoring `undefined` and non-file schemes), so focus moving to the panel does
  not erase it.
- With genuinely no text editor ever opened, the existing explicit error is
  still posted — the fix must not turn "nothing to attach" into silence.
- Untitled/virtual documents are not attached as if they were files on disk.

**Tests.**
1. remembering an editor then losing focus still yields that file;
2. never having had an editor yields the explicit error, not an empty attach;
3. a non-file scheme (untitled) is refused.

**Commit.** `fix(extension): attach the file the user is actually looking at`

---

# A1 — Sessions exist and survive

## A1-T1 — A session is a first-class, durable thing

**Goal.** Runs belong to sessions; sessions outlive the process and the schema
upgrade.

**Why.** Everything else in this track needs something to reopen. A "session" is
the unit the user thinks in ("that thing I asked yesterday"), and today only
`runs` exists.

**Files.** `apps/daemon/src/storage.ts` (+ `storage.test.ts`).

**Success criteria.**
- New tables/columns: `sessions(id, repository_path, title, created_at,
  updated_at)`; `runs.session_id` and `runs.turn_index`.
- `SCHEMA_VERSION` goes 1 → 2 with a **real migration**: an existing v1 database
  opens, upgrades in place, and keeps every existing run and event. A fresh
  database and an upgraded one end up structurally identical.
- A run created without a session gets one implicitly (single turn), so nothing
  in the current code path has to change to keep working.
- `title` is derived from the first turn's prompt, truncated — never invented,
  and never the whole prompt.
- **Retention keeps sessions whole.** `pruneRuns` must not leave a session with
  holes in the middle of its turns; either the session goes or it stays. State
  in a comment which rule you chose and why.
- Listing sessions for a repository is ordered by most recent activity.

**Tests.**
1. a v1 fixture database upgrades to v2 with all runs and events intact;
2. a fresh v2 database and an upgraded v1 database have the same schema;
3. a run created with no session gets an implicit one at `turn_index` 0;
4. pruning never leaves a session with a gap in its turns;
5. sessions list ordered by most recent activity, scoped to the repository.

**Commit.** `feat(daemon): make a session a durable, first-class record`

## A1-T2 — The daemon can serve a session

**Goal.** A client can list sessions and fetch one with its turns.

**Why.** Three surfaces need the same data; each inventing its own assembly from
`/runs` is how they drifted apart the first time.

**Files.** `apps/daemon/src/server.ts` (+ `daemon.test.ts`), and the client in
`apps/vscode-extension/src/client.ts`.

**Success criteria.**
- `GET /sessions?repo=<path>` and `GET /sessions/:id` exist, authenticated the
  same way every other route is.
- A session detail returns its turns in order; each turn carries its prompt,
  status, run id, and the model/reasoning actually used.
- An unknown session id is a 404 with a message, not a 500 and not an empty
  object that renders as a blank screen.
- Whether the protocol version must move is **decided and justified in the
  commit body** — additive routes normally do not require it, but the extension
  refuses to talk to a daemon it disagrees with, so the reasoning must be
  written down rather than assumed.

**Tests.**
1. listing returns sessions for the requested repo only;
2. a detail returns turns in order with their run ids;
3. an unknown id is 404 with a message;
4. an unauthenticated request is refused exactly as other routes refuse it.

**Commit.** `feat(daemon): serve sessions and their turns`

---

# A2 — One renderer, and the truth it was hiding

## A2-T1 — Every surface renders events through one module

**Goal.** One mapping from `AgentEvent` to a display model, used by the CLI, the
TUI and the panel.

**Why.** There are three today and they disagree: the TUI shows reasoning and
tool calls, the panel shows neither, and the CLI shows a third subset. The
richest data is already in the event; only the display layer discards it. One
module also means one place to fix, and one place to test.

**Files.** New `packages/event-view/` (or a module inside `packages/protocol`
— choose and justify), consumed by `apps/cli/src/ui.ts`,
`apps/cli/src/tui/screens/run.tsx`, `apps/vscode-extension/src/webview.ts`.
Delete the per-surface mapping logic; do not leave it as a fallback.

**Success criteria.**
- A pure function maps every `AgentEvent` variant to a display model: kind, a
  one-line summary, an optional detail body, and a severity.
- `message`, `thinking`, `tool_use`, `tool_result`, `usage` and `log` are all
  representable. Tool calls state the tool and its target; `tool_result` states
  the exit code when the provider gave one.
- An unrecognised event type renders as a labelled line — **never dropped
  silently**. A future provider event must be visible, not invisible.
- All three surfaces import it. `grep` shows no surface-local event switch left.
- The panel consumes it the way `renderCapacityCards` already does (exported,
  inlined via `.toString()`), so panel and test run one implementation.

**Tests.** Assert the exact rendered strings for each event variant, plus:
an unknown type is surfaced; a `tool_result` without an exit code says so rather
than printing a fake `0`. Red-check by deleting a branch.

**Commit.** `feat(event-view): render every event through one module`

## A2-T2 — Say which model and which reasoning level, for every agent

**Goal.** The lead and each worker show the model and reasoning level actually
used.

**Why.** `docs/05` already separates *requested* from *provider-confirmed*, and
`usage` events carry the confirmed values — but no surface shows them. In a Team
run the user cannot currently tell which model did which task, which makes the
cost and quality numbers unreadable.

**Files.** The A2-T1 module, `apps/cli/src/ui.ts`, `apps/cli/src/tui/`,
`apps/vscode-extension/src/webview.ts`.

**Success criteria.**
- Every task line shows: agent, provider-confirmed model, provider-confirmed
  reasoning level.
- When the provider did not report one, the surface says **"not reported"** — it
  never falls back to the requested value silently, and never guesses.
- Where requested and confirmed differ, both are shown; that divergence is the
  signal `docs/05` says must not be lost.
- The lead's planning run gets the same treatment as the workers.

**Tests.**
1. confirmed model and reasoning render for a task;
2. an unreported model renders as "not reported", not as the requested value;
3. requested ≠ confirmed renders both. Exact strings; red-check.

**Commit.** `feat(ui): name the model and reasoning behind every task`

---

# A3 — Reopen a session

## A3-T1 — `bremio session list` and `bremio session show`

**Goal.** The transcript of any past session, from the terminal.

**Why.** The CLI is the surface with no session view at all, and it is the one
that works over SSH and in a pipe.

**Files.** `apps/cli/src/index.ts` (command + help), a new
`apps/cli/src/session.ts` (+ test).

**Success criteria.**
- `bremio session list [--repo <path>]` shows id, title, turn count, last
  activity, and status.
- `bremio session show <id>` prints the full transcript: for each turn the
  prompt, then the process rendered through A2-T1, then the outcome.
- `--json` produces the same content as data, for both.
- An unknown id exits non-zero with a message naming what was not found.
- Long transcripts are not truncated silently; if output is elided, it says so
  and how to see the rest.

**Tests.**
1. list shows a seeded session with its turn count;
2. show renders prompt, process and outcome in order;
3. an unknown id exits non-zero with a naming message.

**Commit.** `feat(cli): list and reopen past sessions`

## A3-T2 — The TUI opens a session instead of listing it

**Goal.** Selecting a session in the TUI replays its transcript.

**Why.** This is the reported bug: the runs screen lists and stops. There is no
way in, which makes the history effectively unreachable.

**Files.** `apps/cli/src/tui/screens/runs.tsx` (becomes sessions),
a new transcript screen, `apps/cli/src/tui/data.ts`.

**Success criteria.**
- The list is selectable with the keyboard, and the binding is shown on screen.
- Selecting a session opens its transcript, rendered through A2-T1.
- `Esc` returns to the list with the previous selection intact.
- A live session opened mid-run keeps streaming; a finished one is static.
- Reasoning and tool calls are collapsed by default with a marker showing there
  is more, and expandable — the transcript must be readable, not a wall.

**Tests.** The TUI has no Ink render harness today. Either add
`ink-testing-library` as a devDependency — **say so and why in `SPRINT-LOG.md`**,
per `docs/10` §4 — and write real render tests, or extract the transcript
assembly into a pure function and test that. Do not skip the task's tests; state
which route you took.
1. a session with N turns assembles N turn blocks in order;
2. collapsed detail is present but marked, not lost;
3. selecting an unknown/empty session shows an explicit empty state.

**Commit.** `feat(tui): open a session and replay its transcript`

## A3-T3 — The panel replays what actually happened

**Goal.** Opening a past run in the panel shows the real process, not a summary.

**Why.** `openRun` already replays — but through the lossy `{kind, message}`
path, so the reasoning, tool calls and model never appear. The data was there
the whole time.

**Files.** `apps/vscode-extension/src/extension.ts` (the replay path),
`apps/vscode-extension/src/webview.ts`.

**Success criteria.**
- Replay renders through A2-T1, with the same detail a live run shows.
- The transcript is framed as prompt → process → outcome, so it reads as a
  session rather than a log dump.
- A run still in flight replays its history and then continues live from the
  last sequence, with no duplicated and no dropped events.
- The session list in the panel offers every session for the open repository.

**Tests.**
1. replaying a recorded event set renders reasoning and tool calls, not just
   messages;
2. replay-then-follow produces each event exactly once;
3. an empty run renders an explicit empty state.

**Commit.** `feat(extension): replay a session with its full process`

---

# A4 — Parallel work, without the wall of text

## A4-T1 — An overview that survives concurrency

**Goal.** With several tasks running at once, the default view stays readable.

**Why.** Concurrency defaults to 2 and can be raised; today every task's events
interleave into one stream tagged `[TASK-00N]`. The user asked for an overview
that does not overwhelm — the design reference they named is `herdr`.

**Files.** `apps/cli/src/tui/screens/run.tsx`, `apps/vscode-extension/src/webview.ts`,
the A2-T1 module.

**Success criteria.**
- One **lane per task**: id, title, agent, model, status, and the current
  activity in one line.
- The default view is **O(number of tasks)**, not O(number of events). Adding a
  third concurrent task must not push the first one off the screen.
- A lane is expandable to its full rich stream, one at a time.
- A failure is never hidden by another task's noise: a failed or blocked lane is
  visible in the collapsed view without expanding it.
- The lead's planning phase is a lane too, so the run has one consistent shape
  from planning to aggregation.
- Nothing is discarded — collapsing is a view, and the full stream is still in
  the transcript.

**Tests.**
1. N concurrent tasks produce N lanes and a bounded number of lines;
2. a failed lane is visible while collapsed;
3. expanding a lane yields that task's events and no other task's.

**Commit.** `feat(ui): show parallel work as lanes, not a wall of text`

---

# The v1.0 gate (after A4)

Track A closing is what unblocks `S5-T4` in
[`08-completion-plan.md`](08-completion-plan.md). Before the version moves:

```powershell
corepack pnpm release:check
corepack pnpm e2e:fresh
corepack pnpm posix:verify
```

`posix:verify` was previously recorded as blocked "because no WSL distribution
is installed". That was wrong: WSL is installed (Ubuntu, bash 5.2). What is
missing is **Node inside the distro** — `posix-verify.sh` checks for it and
exits. Install Node 22+ in the distro and run the gate for real; it is a v1.0
requirement, and an environment-blocked gate must never be recorded as passed.
