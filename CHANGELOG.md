# Changelog

## 1.1.0 — 2026-07-23

Sessions stop being read-only. `bremio session continue <id> "<prompt>"` adds a
turn to work you already did, and the agent still knows what happened in the
earlier turns.

### How a turn remembers the last one

- Where the provider genuinely supports it, Bremio **resumes the provider's own
  session** — the agent keeps its real context, not a retelling of it.
- Where it does not, the prior turns are **re-assembled into a fresh prompt**.
- Which of the two happens is decided by the adapter's `resumableSessions`
  capability, never by the provider's name. Claude and Codex resume; OpenCode
  was probed and genuinely cannot resume non-interactively, so it re-injects and
  its capability says so.
- The mechanism and the reason for it are recorded on every turn, so a session
  that behaved differently than you expected can be explained afterwards.

### Failing closed instead of quietly degrading

- A turn whose context **does not fit the provider's budget is refused with the
  number it exceeded**, rather than being truncated into something that looks
  fine and has lost the middle.
- Older turns are elided to summaries when space runs short, and a summary is
  **labelled as one** — never presented as verbatim history.
- Token accounting says `measured` only when the provider reported it, and
  `estimated` otherwise. The two are never mixed into one unlabelled figure.
- An **expired provider session falls back to re-injection** instead of starting
  a blank session that would answer with no memory of the work so far. Expiry is
  matched by the shared error classifier, so it survives a provider rewording
  its message.

### Known limitations

- Re-injection is a reconstruction, not the provider's own state — a long
  session on a non-resumable provider will drift from one on a resumable one.
- `net_gain` and the calibration gate are per-run; they do not yet reason about
  the cost of a multi-turn session as a whole.

## 1.0.0 — 2026-07-23

First stable release. `0.1.0-alpha.1` could plan work, hand it to a second
agent, and judge the result. What it could not do was let you *see* any of that
afterwards, or tell you what it had decided and why. That is what 1.0 adds.

### Sessions you can reopen

- Runs are grouped into **sessions**. `bremio session list` and
  `bremio session show <id>` print a full transcript: your prompt, the process,
  the outcome. The TUI's run list is now selectable and opens the same
  transcript; the VS Code panel replays a past run with everything it actually
  did, not a summary of it.
- Existing history is migrated: every run from 0.1 becomes its own single-turn
  session. Nothing is discarded.

### You can see what the agents are doing

- Reasoning, tool calls and their exit codes are shown while a run works —
  previously the data was recorded and then thrown away by the display layer.
  One renderer now serves the CLI, the TUI and the panel, so they agree.
- Every task states the **provider-confirmed model and reasoning level**. When
  the provider did not report one it says `not reported` rather than quietly
  showing what was requested.
- Parallel tasks appear as one **lane each** — agent, model, status, current
  activity — instead of interleaving into a single stream. A failing lane stays
  visible while collapsed.

### Automatic decisions explain themselves

- `--mode auto` picks Single or Team, **gated on calibration**: until enough
  matched pairs exist it stays on Single and says so.
- A Single run that fails verification can be **escalated to Team**, never
  without `--escalate` or an explicit yes at the prompt.
- Every automatic choice carries a reason naming the actual cause
  (`exhausted at 2% remaining, fresh`), not a policy name.

### Knowing whether multi-agent was worth it

- `net_gain` is computed against the cheapest verified single-agent baseline,
  from provider-reported cost only. Missing cost is `unknown` **with the
  specific blocker named** — never an estimate presented as a measurement.
- A kill-switch stops a Team run after planning when coordination cost exceeds
  the configured share of that baseline. It never fires on an estimate.
- `bremio compare` collects a matched Single/Team pair from one clean commit.

### Providers

- **OpenCode** joins Claude, Codex and Antigravity as a worker.
- `@bremio/adapter-local` is a plug-and-play seam for local OpenAI-compatible
  servers (Jan, Ollama, LM Studio). It ships unregistered with all capabilities
  off: a bare chat endpoint owns no tools, so the router is given nothing to
  route to it until an integration says what it can actually do.
- Jan was dropped as a specific integration; the general seam above replaces it.

### Fixes worth naming

- The panel's **"Current file"** button never worked: clicking it moved focus to
  the panel, so the editor it was asking about no longer counted as active.
- A cancelled run whose workspace is still held by a process started after it
  now reports `cancellation_failed` with the pids, instead of claiming a stop it
  cannot confirm.
- Daemon shutdown terminates runs one at a time; concurrent `taskkill` sweeps
  were racing and occasionally leaving a process alive past verification.

### Known limitations

- **Windows process trees** are terminated with `taskkill /T /F`, not a Job
  Object. A process spawned in the window between the tree snapshot and the kill
  can survive. POSIX has no such gap — process groups reach descendants spawned
  at any time, and that is now verified on Linux rather than assumed. Closing it
  on Windows needs a native addon this project does not carry; the failure is
  reported rather than hidden.
- **No registry publication.** `npm i -g bremio` does not work. Install the
  `bremio-1.0.0.tgz` and `.vsix` you built.
- **Auto mode stays on Single** until you have collected enough matched pairs
  for the calibration gate. That is the design, not a defect.
- **Sessions are read-only.** Continuing one with a follow-up prompt — context
  assembly, budgets, provider session resume — is v1.1.

### Protocol

Wire protocol goes 1 → 2. All changes were additive, so an older extension
still works against a 1.0 daemon and is not refused. The bump is for the other
direction: a 1.0 extension against a 0.1 daemon now gets "the running daemon is
older than this extension" instead of an unexplained 404 from `/sessions`.

## 0.1.0-alpha.1 — 2026-07-19

Local alpha. Plan → delegate → execute in isolated git worktrees → independent
review → quality gate → manual merge. Claude and Codex as leads, Antigravity as
a worker. Usage ledger, quota reading from AI-Quota-Tray, TUI, loopback daemon
with durable history, and a VS Code panel.
