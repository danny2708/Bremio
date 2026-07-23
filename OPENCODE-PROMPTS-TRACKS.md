# OpenCode prompt pack — Track A (v1.0) and Track B (v1.1)

Fifteen prompts, in order. Paste one into opencode, let it finish, verify the
commit landed, paste the next.

**Single source of truth is `docs/12-session-history-and-observability.md`
(Track A) and `docs/13-context-and-harness.md` (Track B).** Each prompt points at
its task section and restates only what must not be missed. If a prompt and the
doc disagree, the doc wins.

---

## Before the first prompt

Run once, yourself:

```powershell
cd D:\Work\Side-Projects\Bremio
git checkout track/A/session-history-and-observability
```

Track A happens on that branch. Track B gets its own branch when it starts.

## Between prompts

```powershell
git log --oneline -1
git status --short          # expect clean
```

At the end of each milestone:

```powershell
corepack pnpm release:check
```

## Read once, before the first task

`docs/10-delegation-contract.md` in full — it is the working agreement and no
prompt below repeats it. Three clauses from §5 exist because sprints 1, 3 and 4
each broke them, and this track will meet the same shapes:

- **Fixtures are recorded from the real thing.** A fake you wrote encodes what
  you believe, so it passes exactly when your belief is self-consistent —
  including when it is wrong.
- **A test must cover the property its name claims.** Delete the guard your test
  names; that test must go red. Sprint 4 shipped a test called "escalation never
  runs without approval" that stayed green when the approval check was removed.
- **Never assert on source text to prove behaviour**, and **assert exact values,
  not shapes** — a sign or type check passes a wrong formula.

---

# Track A — Session history and observability

## A0-T1 — Attaching the current file actually attaches it

```text
Task A0-T1. Read docs/12-session-history-and-observability.md section "A0-T1".

Bug: in the VS Code panel, "Current file" never attaches anything. Clicking the
button moves focus to the webview, so vscode.window.activeTextEditor is
undefined and attachActiveFile posts "No file is open in the editor to attach."
The feature cannot work as written.

Fix it by remembering the last focused text editor
(onDidChangeActiveTextEditor, ignoring undefined), so focus moving to the panel
does not erase it.

Two things not to break:
- With genuinely no text editor ever opened, the explicit error must still be
  posted. Do not turn "nothing to attach" into silence.
- Untitled and virtual documents are not files on disk; do not attach them as
  if they were.

Write the three tests listed in docs/12. Append your SPRINT-LOG.md entry.
Commit:
fix(extension): attach the file the user is actually looking at
```

## A1-T1 — A session is a first-class, durable thing

```text
Task A1-T1. Read docs/12 section "A1-T1".

Add sessions to the daemon store: sessions(id, repository_path, title,
created_at, updated_at), plus runs.session_id and runs.turn_index.

SCHEMA_VERSION goes 1 to 2 with a REAL migration. An existing v1 database must
open, upgrade in place, and keep every run and every event. This is the one
irreversible thing in the task: a migration that drops data cannot be undone by
reverting the commit, because the user's database is already changed. Test the
upgrade against a v1 fixture database before you trust it.

A run created without a session gets one implicitly, so no existing code path
has to change to keep working.

Retention must keep sessions whole: pruneRuns must not leave a session with a
hole in the middle of its turns. Either the session goes or it stays — state
which rule you chose, and why, in a comment.

Write the five tests listed in docs/12. Append your SPRINT-LOG.md entry. Commit:
feat(daemon): make a session a durable, first-class record
```

## A1-T2 — The daemon can serve a session

```text
Task A1-T2. Read docs/12 section "A1-T2".

Add GET /sessions?repo=<path> and GET /sessions/:id, authenticated exactly the
way every other route is. A session detail returns its turns in order, each with
prompt, status, run id, and the model/reasoning actually used.

An unknown session id is a 404 with a message — not a 500, and not an empty
object that renders as a blank screen.

Decide whether the protocol version must move, and JUSTIFY IT IN THE COMMIT
BODY. Additive routes normally do not require a bump, but the extension refuses
to talk to a daemon it disagrees with, so the reasoning gets written down rather
than assumed.

Write the four tests listed in docs/12. Append your SPRINT-LOG.md entry. Commit:
feat(daemon): serve sessions and their turns
```

## A2-T1 — Every surface renders events through one module

```text
Task A2-T1. Read docs/12 section "A2-T1".

There are three event renderers today and they disagree: the TUI shows
reasoning and tool calls, the panel shows neither, the CLI shows a third subset.
The events already carry everything — the daemon emits { kind, message, data }
where data is the full AgentEvent. Only the display layer throws it away.

Build ONE pure mapping from AgentEvent to a display model (kind, one-line
summary, optional detail, severity), and make the CLI, the TUI and the panel all
use it. Delete the per-surface switches; do not leave one as a fallback.

Two criteria that are easy to miss:
- An unrecognised event type renders as a labelled line. Never dropped silently
  — a future provider event must be visible, not invisible.
- The panel consumes it the way renderCapacityCards already does: exported, and
  inlined into the webview script via .toString(), so panel and test run one
  implementation. Asserting on the script TEXT instead would pass even with the
  branch disabled.

Assert the exact rendered strings per event variant. Append your SPRINT-LOG.md
entry. Commit:
feat(event-view): render every event through one module
```

## A2-T2 — Say which model and which reasoning level

```text
Task A2-T2. Read docs/12 section "A2-T2" and docs/05 on requested vs
provider-confirmed.

usage events already carry the provider-confirmed model and reasoning level. No
surface shows them, so in a Team run the user cannot tell which model did which
task — which makes the cost numbers unreadable.

Show, for the lead and every worker: agent, provider-confirmed model,
provider-confirmed reasoning level.

The rule that matters: when the provider did not report one, say "not reported".
Never fall back to the requested value silently, and never guess. Where
requested and confirmed differ, show both — that divergence is exactly the
signal docs/05 says must not be lost.

Write the three tests listed in docs/12, asserting exact strings. Append your
SPRINT-LOG.md entry. Commit:
feat(ui): name the model and reasoning behind every task
```

**Milestone A2 gate:** `corepack pnpm release:check`

## A3-T1 — `bremio session list` and `bremio session show`

```text
Task A3-T1. Read docs/12 section "A3-T1".

Add bremio session list [--repo <path>] and bremio session show <id>. show
prints the full transcript: for each turn the prompt, then the process rendered
through the A2-T1 module, then the outcome. --json produces the same content as
data for both.

An unknown id exits non-zero with a message naming what was not found. If long
output is elided, say so and how to see the rest — never truncate silently.

Write the three tests listed in docs/12. Append your SPRINT-LOG.md entry. Commit:
feat(cli): list and reopen past sessions
```

## A3-T2 — The TUI opens a session

```text
Task A3-T2. Read docs/12 section "A3-T2".

tui/screens/runs.tsx lists runs and stops — there is no selection and no replay,
so history is unreachable from the TUI. This is the bug the user reported.

Make the list selectable (show the binding on screen), and open the selected
session into a transcript rendered through the A2-T1 module. Esc returns with
the selection intact. A live session keeps streaming; a finished one is static.

Reasoning and tool calls are collapsed by default with a marker showing there is
more, and expandable. A transcript that is a wall of text is not readable.

On tests: the repo has no Ink render harness. Either add ink-testing-library as
a devDependency — SAY SO AND WHY in SPRINT-LOG.md, per docs/10 section 4 — and
write real render tests, or extract the transcript assembly into a pure function
and test that. Do not skip the tests; state which route you took and why.

Append your SPRINT-LOG.md entry. Commit:
feat(tui): open a session and replay its transcript
```

## A3-T3 — The panel replays what actually happened

```text
Task A3-T3. Read docs/12 section "A3-T3".

openRun already replays a past run, but through the lossy {kind, message} path,
so reasoning, tool calls and the model never appear. The data was there the
whole time — the panel discards it.

Replay through the A2-T1 module, framed as prompt then process then outcome so
it reads as a session rather than a log dump.

The one hard case: a run still in flight must replay its history and then
continue live from the last sequence, with no duplicated and no dropped events.
Test that explicitly — off-by-one here is invisible until a user sees a line
twice.

Write the three tests listed in docs/12. Append your SPRINT-LOG.md entry. Commit:
feat(extension): replay a session with its full process
```

## A4-T1 — Parallel work as lanes

```text
Task A4-T1. Read docs/12 section "A4-T1".

Concurrency defaults to 2 and can be raised; today every task's events
interleave into one stream tagged [TASK-00N], which is unreadable. The user's
design reference is the herdr repo.

One lane per task: id, title, agent, model, status, current activity — one line
each. The lead's planning phase is a lane too, so the run has one shape from
planning to aggregation.

The criterion that defines the task: the default view is O(number of tasks), NOT
O(number of events). A third concurrent task must not push the first off the
screen. A lane expands to its full stream, one at a time.

And the safety one: a failed or blocked lane must be visible while collapsed. A
failure hidden by another task's noise is the whole problem restated.

Nothing is discarded — collapsing is a view; the full stream stays in the
transcript.

Write the three tests listed in docs/12. Append your SPRINT-LOG.md entry. Commit:
feat(ui): show parallel work as lanes, not a wall of text
```

**Track A gate:** `corepack pnpm release:check`, then hand back for audit.

---

# Track B — Context and the stateful harness

Do not start Track B until Track A is merged and `1.0.0` is cut. Track B gets
its own branch.

## B0 — Verify the resume surfaces

```text
Task B0. Read docs/13-context-and-harness.md section "B0".

This is a VERIFICATION task, not a coding task. Do not write source code.

Probe the real session-resume surface of Claude (Agent SDK), Codex (app-server
threads) and OpenCode (opencode serve sessions). For each, answer explicitly:
can a prior session be resumed non-interactively; what identifier is required;
is that identifier exposed in the stream today; does resuming preserve the
earlier turns; and what happens when the id is unknown or expired.

Record the exact command or call you ran and what you observed.

Two rules:
- Anything you cannot determine is recorded as "not available". Never write an
  assumption as a finding. Designing B1-B6 on documentation instead of
  observation would repeat the sprint-1 mistake at four times the scale.
- End with an explicit statement of which adapters may set resumableSessions to
  true, and what mechanism earns it. Per docs/10 section 6c, the boolean moves
  only with the mechanism.

Fill in the Findings table in docs/13. Append your SPRINT-LOG.md entry. Commit:
docs(harness): record the verified session-resume surfaces
```

## B1 — The session remembers more than its transcript

```text
Task B1. Read docs/13 section "B1".

Add session_context(session_id, turn_index, summary, provider_session_ids),
migrated the way A1-T1 migrated: an existing database upgrades in place with
nothing lost.

Provider session ids are stored per adapter — a Team turn may hold one for the
lead and none for the workers.

A summary is stored per turn and never overwritten in place: turn N's summary
must still be readable after turn N+1 exists. And a turn with no summary reads
as absent, not as an empty string — the two mean different things.

Append your SPRINT-LOG.md entry. Commit:
feat(daemon): store what a later turn needs to know
```

## B2 — The context assembler

```text
Task B2. Read docs/13 section "B2", including the scoping decision at the top of
that document.

Create packages/harness with context-assembler.ts: given a session's history and
the current repository state, produce the lead's prompt for the next turn.

Include the CURRENT DIFF STATE — what previous turns actually changed. "Now also
handle the error case" is meaningless without it.

Ordering is explicit and stable: recent turns verbatim, older turns as
summaries, oldest dropped only after being summarised. When content is elided,
the prompt says so.

Keep it pure and synchronous so it is testable without a provider. Assert the
exact assembled output for a fixed history — content, not shape.

Append your SPRINT-LOG.md entry. Commit:
feat(harness): assemble the next turn from the session so far
```

## B3 — The context budget

```text
Task B3. Read docs/13 section "B3".

Sessions grow past the model's context window. How that is handled is a
correctness property, not an optimisation.

Per-provider budget from configuration — no model names in core (docs/05).
Over budget: summarise older turns, then drop them. Never silently truncate.

Two rules carried over from the efficiency work, for the same reason:
- Token accounting uses provider-reported usage where it exists. An estimate is
  LABELLED as an estimate and never presented as measured.
- If the budget cannot be satisfied even after summarising, the turn FAILS
  CLOSED with a reason. Do not send a context you know is wrong.

Assert exact values. Append your SPRINT-LOG.md entry. Commit:
feat(harness): keep a session inside its context budget
```

## B4 — `resumeRun` for the adapters that earned it

```text
Task B4. Read docs/13 section "B4" and your own B0 findings.

Implement resumeRun(sessionId, request) for each adapter B0 cleared, and set
resumableSessions to true ONLY there. Emit the provider session id in
outcome.sessionId so the harness can store it.

An expired or unknown provider session is a classified, non-fatal failure the
harness can fall back from — not a crash, and not a silent new session
pretending to be the old one. That last one is the dangerous case: it looks like
success and loses the user's context.

Adapters B0 did not clear keep resumableSessions false and keep rejecting
resumeRun explicitly.

Fixtures recorded from the real provider, per docs/10 section 5. Append your
SPRINT-LOG.md entry. Commit:
feat(adapters): resume a provider session where one exists
```

## B5 — Continuity, Single first

```text
Task B5. Read docs/13 section "B5".

A follow-up prompt continues the session. Do Single mode FIRST — one agent, one
workspace, the simplest place for continuity to be correct — then Team, where
the lead resumes and workers still receive composed task prompts.

The mechanism is chosen from the CAPABILITY, never from a provider name: resume
where resumableSessions is true, re-inject otherwise. Record which was used and
why in the turn, like every other automatic decision (docs/08 S4-T3).

Two invariants that must survive: cancellation and the Sprint 4 fail-closed
guarantees hold across turns — a cancelled turn leaves the session resumable and
uncorrupted. And the ledger attributes each turn separately, so net_gain stays
computable.

Append your SPRINT-LOG.md entry. Commit:
feat(harness): continue a session with a follow-up turn
```

## B6 — Prove the harness fails closed too

```text
Task B6. Read docs/13 section "B6".

One integration test asserting all six harness safety properties together, with
the real assembler and real budget — not mocks of the things under test. The six
are listed in docs/13.

Then do this, and record it in SPRINT-LOG.md: remove one guard, confirm the
corresponding assertion fails FOR THE RIGHT REASON, and restore it.

Sprint 4 is why this instruction is here. It shipped a test named "escalation
never runs without approval" that only checked eligibility; removing the
approval gate left it green. A test that passes whether or not the guard exists
is worse than no test, because it manufactures confidence.

Commit:
test(harness): prove the context guarantees hold together
```

**Track B gate:** `corepack pnpm release:check`, then hand back for audit.

---

# FIX

```text
The gate failed. Read the output below and fix the cause, not the symptom.

Do not weaken an assertion, skip a test, or catch and swallow an error to make
it pass. If the failure means the task's success criteria cannot be met as
written, stop and record the blocker in SPRINT-LOG.md per docs/10 section 7.

<paste the failing output>
```

# BLOCKED

```text
You reported a blocker. Before I decide, give me:
- what you tried, and what you observed — the exact command and output;
- which success criterion cannot be met, and why;
- what you would need in order to meet it;
- what you would do instead, and what that would cost.

Do not implement the alternative yet.
```
