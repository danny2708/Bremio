# Bremio agent prompt pack

For running several coding agents in parallel against the Bremio roadmap. Each
agent starts cold, so every prompt is self-contained: it names the task, the
branch, the files, and how to record its work.

Coordination lives in three files:
- [`TASKS.md`](TASKS.md) — the board. What is left, who owns it, what blocks what.
- [`PROGRESS.md`](PROGRESS.md) — the narrative. One block per agent per sprint.
- [`docs/15-architecture-lock.md`](docs/15-architecture-lock.md) — locked
  semantics. **The doc wins over any prompt.**

The tech lead (Claude) reviews each branch, fixes what is wrong, and merges when
quality is sufficient. Agents do not merge their own work to `main`.

---

## The standing agreement — read once, before any task

1. **Read first, in order:** [`docs/10-delegation-contract.md`](docs/10-delegation-contract.md)
   (the working agreement, not repeated below), then the task's section in
   `docs/14`/`docs/15`, then the task row in `TASKS.md`.
2. **One task, one branch, one commit.** Branch from the latest `main`. Commit
   subject starts with the task id, e.g. `feat(daemon): S1-T1 session_config schema`.
   Use the repo's `type(scope): subject` style and the `Co-Authored-By` trailer.
3. **`git add -A` is forbidden.** Stage only the files your task changed.
4. **Never touch:** the AI-Quota-Tray repo, anything under `.bremio/`, and any
   file outside your task's stated scope. Record unrelated findings; do not fix them.
5. **Gates are mandatory per task:** `corepack pnpm typecheck`, then
   `corepack pnpm test`, then `corepack pnpm release:check`.
6. **Tests assert behaviour, and a fix starts with a failing test.** For any
   guard you add, red-check it: remove the production guard (not the assertion),
   confirm the test fails for the right reason, restore it, and note this in your
   `PROGRESS.md` `Verification`.
7. **Enforcement lives in code, never in a prompt.** A mode that only asks the
   model not to do something is not implemented (`docs/15` §2.2).
8. **Never derive provider identity from a model string; never substitute a
   provider silently.** This is the bug Sprint 0 fixed — do not reintroduce it.

---

## How to record your work — do this, every task

**At the start**, before your first edit:
1. In `TASKS.md`, change your task's `[ ]` to `[~]`.
2. In `PROGRESS.md`, under the current sprint heading, open a new block using the
   template at the top of that file. Fill **every** header field
   (agent, time, branch, task, status). Set `time` end to `open`.

**While working**, the moment you hit a blocker: write it into your block and set
the task to `[!]` in `TASKS.md`. A blocker you can clear yourself is not a
blocker — clear it and report the result instead.

**At the end**:
1. Complete your `PROGRESS.md` block: `Did` / `Decided` / `Verification`, and
   `Blocked / handed off` if relevant. Close `time`. Set `status: done`.
2. In `TASKS.md`, tick your task `[x]` — only if acceptance is met and the commit
   landed.
3. Commit. Stop. Do not start the next task or merge to `main`.

The tech lead reads the `PROGRESS.md` header fields to know who touched what,
when, and on which branch. Consistency there is what makes parallel work
reviewable, so treat the template as a contract, not a suggestion.

---

## Prompt — start of every task (paste, filling the two blanks)

```
You are a coding agent working on Bremio. Read AGENT-WORKFLOW.md "The standing
agreement" and "How to record your work" in full before editing anything.

Your task: <TASK-ID> from TASKS.md.
Its design authority: <the docs/14 or docs/15 section named in the task row>.

Do only this task. Confirm its "Depends on" tasks are ticked [x] in TASKS.md
before you begin; if any is not, stop and say so.

Open your PROGRESS.md block now, set the task to [~], then work. Follow the
acceptance criteria and required tests in the task's design section exactly.
Run typecheck and tests before you call it done. Red-check every guard you add.

When done: complete your PROGRESS.md block, tick the task [x], make one commit
whose subject starts with the task id. Do not merge to main. Do not start
another task.
```

---

## Sprint order and what can run in parallel

Take the sprints in order; within a sprint, the `Parallel?` column in `TASKS.md`
says what can run at once. The hard rules:

- **S1-T1 runs alone first.** Every other Sprint 1 task reads its schema.
- **S1-T6** (repository identity) and **S2-T5** (OpenCode `--auto`) and **S7-T8**
  (panel resize) share no files with their sprint-mates and can run alongside anything.
- **Sprints 8 and 9 are review-gated** (`⛔` in `TASKS.md`) — do not start
  without the tech lead's go-ahead.

## For the tech lead — review checklist per branch

1. `git diff main..<branch>` is exactly the task's scope — nothing adjacent.
2. Acceptance criteria in the design doc are met, not just "tests pass".
3. Red-checks are real: mutate the production guard yourself and watch the test fail.
4. No provider-name branching in policy; no model-string identity; no silent fallback.
5. Enforcement is in code, and any guarantee claimed is one the transport gives.
6. `PROGRESS.md` block is complete and honest about blockers/decisions.
7. Only then merge, and tick the task if the agent did not.
