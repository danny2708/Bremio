# 07 — Install, update, uninstall, recovery

Everything an operator needs after the code is written: how to get Bremio onto a
machine, how to move it forward a version, how to take it off cleanly, and what
to do when something is wrong.

This alpha ships as a **local tarball plus a local VSIX**, not a registry
publication. Every command below assumes an artifact you built yourself.

---

## Components

Bremio is three artifacts that must agree on one wire protocol:

| Component | Ships as | Where it lives |
|---|---|---|
| CLI | `bremio-<version>.tgz`, installed globally by npm | the npm global prefix |
| Daemon | bundled **inside** the CLI, no separate install | started by `bremio daemon start` |
| VS Code extension | `bremio-<version>.vsix` | the VS Code extensions directory |

The CLI and the daemon are always the same version, because they are the same
artifact. The extension is installed separately, so it is the only one that can
drift — it checks the protocol version on connect and tells you which side is
behind.

## State on disk

| Path | Contents | Safe to delete? |
|---|---|---|
| `~/.bremio/bremio.db` | run history and the event log (SQLite, WAL) | yes — history is lost, nothing else |
| `~/.bremio/daemon.json` | port, token, pid, versions (`0600`) | yes, when no daemon is running |
| `~/.bremio/daemon.lock` | single-instance lock | yes, when no daemon is running |
| `<repo>/.bremio/runs/` | per-run reports and logs | yes |
| `<repo>/.bremio/worktrees/` | task worktrees awaiting merge | **no** — unmerged work lives here |
| `<repo>/.bremio/ledger.jsonl` | append-only usage ledger | yes — `bremio stats` goes blank |

Nothing is stored outside the home directory and the repositories you point at.

---

## Install

Prerequisites: **Node 22+**, **pnpm** via `corepack`, and at least one agent
reachable — the `codex` CLI logged in (`codex login`), Claude auth for the Agent
SDK, optionally `agy` for Antigravity.

From a source checkout:

```powershell
corepack pnpm install
corepack pnpm release:check          # typecheck, full suite, build, packed-install smoke
npm pack                             # produces bremio-<version>.tgz
npm install --global .\bremio-0.1.0-alpha.1.tgz
bremio --version
bremio doctor
```

`bremio doctor` is the install check that matters: it reports each adapter as
`ok`, `degraded` or `unavailable` with the reason. An `unavailable` adapter is a
credential or PATH problem on this machine, not a broken install.

The VS Code extension:

```powershell
cd apps/vscode-extension
corepack pnpm run package            # builds, then packs the VSIX
code --install-extension .\bremio-0.1.0-alpha.1.vsix
```

Then reload the window. The extension starts the daemon itself on first use, so
there is no separate daemon setup step.

### Verifying a genuinely fresh machine

```powershell
corepack pnpm e2e:fresh
```

This redirects `HOME` to a scratch profile and runs the path a new user actually
takes: no `~/.bremio`, no database, no daemon. It installs the tarball, starts
the daemon from nothing, runs something, restarts, and confirms the history
survived. Your real profile is neither read nor modified.

The complete pre-release evidence set is:

```powershell
corepack pnpm release:check   # typecheck + 415 tests + build + packed install
corepack pnpm e2e:fresh       # 21 fresh-profile daemon/install checks
corepack pnpm posix:verify    # run from Linux or a configured WSL distribution
```

`posix:verify` is not emulated through Windows Node. If `/bin/bash` is absent,
record the gate as environment-blocked and run it on a real Linux/WSL host;
never convert that into a pass.

---

## Update

Bremio does **not** update itself. Rewriting the binary that is currently
executing is how people end up with no working install at all, so the CLI prints
the commands instead:

```powershell
bremio update
```

The sequence is:

```powershell
npm i -g .\bremio-<new-version>.tgz   # CLI and the bundled daemon together
bremio daemon restart                 # the running daemon is still the old build
code --install-extension .\bremio-<new-version>.vsix
```

**`bremio daemon restart` is not optional.** Installing a new CLI leaves the old
daemon running in memory; until it restarts you are talking to the previous
version. `bremio daemon status` prints the daemon's own version and protocol
number — trust that over what `bremio --version` says.

Run history survives updates. The database carries a `PRAGMA user_version` and
migrates forward on open.

### Version mismatch

If the extension and the daemon disagree on the protocol, the connection is
refused with a message naming **which side is outdated** and the command to fix
it. This is deliberate: silently negotiating down would let an old client
misread a newer event stream.

---

## Uninstall

```powershell
bremio daemon stop                    # first — a running daemon holds the lock
npm uninstall -g bremio
code --uninstall-extension bremio.bremio-vscode
```

That removes the programs but leaves your data. To remove that too:

```powershell
Remove-Item -Recurse -Force $HOME\.bremio
```

Before you do, check for unmerged work — `<repo>/.bremio/worktrees/` holds task
branches that were never merged, and deleting a repo's `.bremio` throws them
away. `git worktree list` in the repo shows what is still registered.

Removing `~/.bremio` deletes all run history. It is a clean-slate operation, not
a repair — for repairs, see below.

---

## Recovery

### The daemon will not start: "already running"

A previous daemon holds the lock. Bremio never kills a process just because a
pid file names it — a pid is not evidence of ownership, and the number may have
been recycled by something unrelated. Liveness is proven by an authenticated
request to the published endpoint.

```powershell
bremio daemon status
```

- **running** — that is your daemon. Use it, or `bremio daemon restart`.
- **not running, stale endpoint** — the process died without cleaning up.
  `bremio daemon stop` clears the stale files, then start again.

### Runs stuck as `interrupted`

A run is marked `interrupted` when the daemon died mid-flight. It is
deliberately **not** `failed`: the daemon dying tells you nothing about whether
the agent's work was good. Reconciliation happens automatically at startup.

Interrupted runs are never pruned by retention, because they still need a
decision from you. Inspect the report under `<repo>/.bremio/runs/<runId>/`,
then either merge the worktree or discard it.

### A cancelled run that says `cancellation_failed`

Bremio reports `cancelled` only after execution is confirmed stopped. If the
grace period expires while the work is still running, the state becomes
`cancellation_failed` instead — an honest "I could not confirm this stopped",
not a false success. Find the process yourself (`bremio doctor --json` lists
what the daemon owns) and stop it, or restart the daemon.

### History has grown unwieldy

Retention runs at daemon startup, when nothing is streaming: terminal runs older
than **30 days** are deleted, always keeping the most recent **50**. Active and
interrupted runs are never touched. Just restart the daemon to trigger a pass.

### Something is wrong and you want to report it

```powershell
bremio doctor --json                          # to read yourself
bremio diagnostics export --out bundle.json   # to send to someone
```

The bundle carries versions, adapter health, daemon state, and storage
statistics. Tokens, credentials, API keys and authorization headers are
redacted; **prompts and repository contents are never included at all**.
Reporting a daemon bug should not require publishing what you were working on.

### Full reset

When nothing else works, and after checking for unmerged worktrees:

```powershell
bremio daemon stop
Remove-Item -Recurse -Force $HOME\.bremio
bremio daemon start
```

The daemon rebuilds its database on the next start. You lose run history and
keep everything else.

---

## Known limitations in this alpha

- **Windows process trees — a narrow residual race.** On POSIX the guarantee is
  complete: each run's children are detached into their own process group and
  `kill(-pgid)` reaches every descendant, including ones spawned after
  cancellation began. On Windows there are no such groups, so the supervisor
  snapshots the full descendant tree (`Get-CimInstance Win32_Process`) before
  signalling and re-checks every pid afterwards — a static tree of any depth is
  confirmed gone, verified in tests to three levels (root → child →
  grandchild). Daemon-wide shutdown terminates each owned run **sequentially**,
  not concurrently, so several `taskkill`/WMI sweeps cannot race and leave a
  process alive past its verification window. The one case still open is a race
  within a single run: a process spawned in the window between that snapshot and
  `taskkill /T` completing is neither in the snapshot nor caught by the walk,
  and would not be verified. Closing it fully needs a Win32 **Job Object** with
  `KILL_ON_JOB_CLOSE`, which the kernel enforces regardless of when a child
  appears — but that requires a native addon Bremio deliberately does not carry
  (the same reason `node:sqlite` was chosen over `better-sqlite3`). Until that
  trade is revisited, this is the residual risk: not "a grandchild survives" in
  general, but "a process born during the kill walk may survive." What Bremio
  does do is refuse to lie about it: after a termination that otherwise looked
  clean, the process table is checked for anything still referencing the run's
  workspace that started after the run did, and if something is found the run
  is reported `cancellation_failed` with the pids rather than `cancelled`. That
  check is best-effort — it stays silent when it cannot read the process table,
  and it excludes this process, its ancestors, and anything predating the run,
  because a false alarm would destroy the signal as thoroughly as a false
  success. It narrows the failure from *silent* to *stated*; it does not close
  the race.
- **No registry publication.** `npm i -g bremio` does not work for this alpha;
  install `bremio-0.1.0-alpha.1.tgz` from the artifact you built.
- **Quota freshness depends on the provider.** Bremio reads AI-Quota-Tray's
  database, which only advances when the provider's own tooling runs. Stale
  readings are labelled with their age rather than presented as current.
