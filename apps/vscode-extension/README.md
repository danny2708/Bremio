# Bremio for VS Code

Orchestrate AI coding agents from one panel — **different minds, one team.**

Run a single agent directly, or let a swappable lead plan work that other agents
execute in isolated git worktrees. Watch progress live, review the diff, and
merge only after the quality gate passes.

## Requirements

The Bremio CLI must be installed from the matching local alpha artifact and on
your `PATH`:

```
npm install --global ./bremio-0.1.0-alpha.1.tgz
```

There is no npm registry publication for this alpha. The CLI/daemon and VSIX
must carry compatible protocol versions; see `docs/07-operations.md` for the
build, update, and mismatch workflow.

The extension talks to a local daemon over loopback HTTP and starts one for you
if none is running. It never runs provider adapters inside the extension host,
so a hung agent cannot take VS Code down with it.

## Panel

| Tab | What it shows |
|---|---|
| **Run** | Start a Single or Team run, stream progress, cancel |
| **Runs** | Durable history, including runs interrupted by a restart |
| **Capacity** | Provider quota from AI-Quota-Tray, with data age |
| **Doctor** | Adapter health and lead eligibility |

## Settings

- `bremio.cliPath` — path to the `bremio` executable (default: `bremio`)
- `bremio.autoStartDaemon` — start the daemon automatically (default: `true`)

## Alpha status

This is `0.1.0-alpha.1`. Cancellation is verified on Windows; POSIX support is
present but less exercised. The panel is dark-only. See the repository for the
full list of known limitations.
