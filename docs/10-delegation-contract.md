# 10 — Delegation contract

The working agreement for any agent doing implementation work on Bremio that a
human did not write line by line. Every prompt in `OPENCODE-PROMPTS.md` inherits
this file; the prompts stay short because the rules live here.

Read this before the first task, not per task.

---

## 1. Where the work goes

All work happens on the branch **`sprint/opencode-completion`**.

```powershell
git checkout -b sprint/opencode-completion    # once, at the start
```

`main` stays at the released alpha. Never commit to `main`, never merge into it,
never rebase it. The whole sprint is one revertible unit: if the work turns out
bad, the branch is deleted and nothing is lost.

## 2. Untouchable

- **`main`** — no commits, no merges, no force pushes.
- **The AI-Quota-Tray repository** (`D:\Work\Side-Projects\AI-Quota-Tray`) — a
  different project with uncommitted work in it. Bremio reads AQT's SQLite and
  calls its loopback API; it never edits AQT's source.
- **`.bremio/`** in this repo — run artifacts and leftover worktrees. Read them
  if useful; never delete or rewrite them.
- **Publishing.** No `npm publish`, no `vsce publish`, no marketplace upload, no
  pushing a git tag. Building a local `.tgz` or `.vsix` is fine; releasing it to
  the world is the user's decision, not an agent's.
- **`git add -A`** — forbidden without exception. Stage the specific files the
  task changed. An `-A` sweeps in artifacts, worktrees and unrelated edits, and
  it is the single easiest way to make a diff unreviewable.

## 3. Definition of done — every task, no exceptions

A task is done when **all** of these hold:

1. `corepack pnpm typecheck` is clean.
2. The tests the task requires are **written and passing** — not stubbed, not
   skipped, not `it.todo`.
3. `corepack pnpm test` passes in full. A test that was green before your change
   and is red after is your problem, even if it looks unrelated.
4. Exactly **one commit**, containing only that task's changes.
5. Any status line in `docs/` that your change makes false is corrected **in the
   same commit**. A checked box that isn't true is worse than an unchecked one.
6. One entry appended to `SPRINT-LOG.md` (see §6).

At the end of each sprint, additionally: `corepack pnpm release:check` passes.

## 4. Code conventions

This repo has a strong existing style. Match it rather than importing your own.

- **TypeScript strict**, ESM only, Node 22+. `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax` are on — index access is possibly-undefined and type
  imports need `import type`.
- **Zod 4** for anything crossing a boundary (config files, wire payloads,
  provider output). Parse, don't cast.
- **No new runtime dependency** without saying so in `SPRINT-LOG.md` and why the
  standard library or an existing dep could not do it. `node:sqlite` was chosen
  over `better-sqlite3` for exactly this reason.
- **Comments explain why, not what.** The existing code comments a decision and
  its alternative ("PID is not evidence of ownership"), never a restatement of
  the line below. Match that density — sparse, and load-bearing when present.
- **Model names are never hardcoded in core.** They live in configuration and in
  each adapter. See `docs/05`.
- **Fail closed.** When data is missing, stale or unverified, the honest answer
  is `unknown` and the safe action is the conservative one. Never fabricate a
  percentage, a cost, or a confirmation.

## 5. Test policy

- A test asserts **observable behaviour**, not implementation shape. Testing
  that a private method was called proves nothing about the product.
- A bug fix starts with a test that **reproduces the bug** — red first, then
  green.
- **Fixtures must be recorded from the real thing.** A fake you wrote yourself
  encodes what you *believe* the provider emits, so the test passes exactly when
  your belief is self-consistent — including when it is wrong. This is not
  hypothetical: sprint 1 shipped a hand-written provider fake, kept 308 tests
  green, and the adapter still could not parse a single real response. It took
  three rounds of live debugging to find a shape the fake had asserted was
  correct all along. Capture real output, commit those bytes, parse those.
  A hand-written fake is acceptable *in addition*, for spawn mechanics and error
  paths — never as the only source of truth about a response shape.
- **A test must be able to fail.** Before calling a test done, break the thing it
  covers and confirm it goes red. A test that passes either way manufactures
  confidence, which is worse than having no test at all.
- Timing: never assert "it finished" after a fixed `setTimeout`. Poll with a
  bound. A flaky test in this repo has already cost a debugging session.
- Platform-dependent behaviour (process groups, file modes) is tested where it
  exists; a Windows-only assertion in a POSIX test is noise.

## 6. Reporting — `SPRINT-LOG.md`

Create it at the repo root on the first task, append one entry per task:

```markdown
## S1-T2 — packages/adapter-opencode

**Done:** what actually changed, in two or three sentences.
**Hard:** what fought back — a surface that behaved differently than documented,
a test that was awkward to write, a design choice with no obvious winner.
**Assumed:** anything you decided without evidence, and what would confirm it.
**Deviations:** any success criterion you could not meet, and why.
```

This log is read as evidence afterwards. Be accurate rather than flattering —
"I could not verify X" is a useful entry; a green checkmark over an unverified
claim destroys the value of the whole log.

## 6b. What counts as a deviation

`Deviations: None` is a claim, and sprint 1 made it on a task that had three.
Record a deviation whenever **any** of these happened — each one on its own:

- You changed a file the task did not list, especially anything shared. "The fix
  had to go there" is the reason to record it, not the reason to skip recording.
- You made a provider-specific problem into a cross-cutting change. Editing
  shared behaviour so one provider passes silently changes it for every other
  provider, and no test in this repo will tell you.
- You solved it a different way than the task prescribed. Sometimes yours is
  better — say so and say why; a deviation is not an admission of error.
- You could not meet a success criterion exactly as written.
- You disabled, skipped, loosened or deleted an existing assertion.
- You added a runtime dependency.
- A declared capability, guarantee or doc claim no longer matches what the code
  does after your change.

The rule of thumb: if a reviewer reading the diff would be surprised, it is a
deviation. Write it down while you still remember why.

## 6c. Capability claims track their mechanism

A capability boolean in `getCapabilities()` is a **promise the router acts on**,
not a description of a good day. `structuredOutput: true` means the adapter can
*constrain* output to a schema and fail when it doesn't validate — not that a
model produced valid JSON when asked nicely.

So: **if you remove or bypass the mechanism that guarantees a capability, the
boolean changes in the same commit.** Observing the right output once, on one
model, is evidence about that model, not a property of the adapter. Overstating
here is uniquely expensive because the router will hand that agent work it
cannot do, and the quality gate is fail-closed on the result.

## 6d. Clean up after yourself

Scratch scripts, probe files and temporary fixtures are fine while you work —
they are how real debugging happens. Delete them before you commit. The repo
root should be exactly as clean as you found it, including untracked files.

## 7. The honesty rule

**This is the most important rule in the document.**

If a task cannot be completed as specified — the surface does not work the way
the plan assumed, a success criterion turns out to be impossible, a test cannot
be written honestly — then **stop and write the blocker in `SPRINT-LOG.md`**.

Do **not**:

- weaken or delete a success criterion so the task can be called done;
- delete, skip or loosen an assertion so a test goes green;
- catch and swallow an error to make a failure disappear;
- report a step as passing when it was not run.

A task marked blocked with a clear reason is a good outcome. A task marked done
that isn't is the one failure mode this whole arrangement cannot absorb, because
everything after it is built on a false floor.

## 8. Commit format

The repo's existing convention:

```
type(scope): imperative subject in lower case

Why this change exists — the problem it solves or the behaviour it corrects.
What the reader would otherwise wonder about the diff. Not a restatement of
the file list.

Co-Authored-By: <your agent identity>
```

`type` is one of `feat`, `fix`, `refactor`, `test`, `docs`, `build`. Scope is the
package or app touched. Each task in `docs/08` names its commit subject — use it.

## 9. When you are stuck

In order:

1. Read the surrounding code. This repo answers most of its own questions, and
   the comments are unusually load-bearing.
2. Read `docs/08-completion-plan.md` for that task's success criteria, and the
   design doc it references.
3. Verify against the real thing — run the command, probe the endpoint, read the
   actual output. `docs/04` carries a standing "⚠️ Verify first" for exactly
   this reason: the providers move faster than the docs.
4. If it is still blocked, record it per §7 and move to the next task. Do not
   guess, and do not silently reduce scope.
