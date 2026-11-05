# 20 — Tools delivered to agents (docs/17 P3)

**Status:** implemented (P3-T1…T5). `bremio doctor` prints the live summary
under "tools delivered to agents".

Everything here is **opt-in per run** and lives in the repository's
`.bremio/` directory, which Bremio git-ignores — it is local user
configuration, never something a cloned repository can ship.

## How it reaches agents

`prepareRunExtensions` (`packages/orchestrator/src/extensions/`) wraps the run's
adapter registry once. Every adapter call of the run — planning, plan repair,
tasks, resumes — goes through `startRun`/`resumeRun` of the wrapper, so no call
site can skip it. Wired into: daemon runs (CLI default path, ephemeral daemon,
VS Code panel), `bremio run --standalone`, `bremio compare`, in-process session
continuation, and the provider smoke.

Every run carries the **MCP policy gate** for its control mode, even with no
servers attached, so a provider's *own* MCP calls follow the run's mode too
(Claude only; see the table).

## MCP servers (`--mcp <id>`, P3-T1)

Declare servers in `.bremio/mcp-servers.json` (same file `bremio mcp list`
reads):

```json
[{ "id": "docs", "name": "Docs", "transport": { "type": "stdio", "command": "docs-mcp", "args": [] } }]
```

`id` is restricted to `[A-Za-z0-9_-]{1,64}`; `bremio` is reserved.
`envPassthrough: ["NAME"]` on a stdio server inherits variables by name.

| Adapter | Attaches | Transports | Policy enforcement |
|---|---|---|---|
| claude | Agent SDK `mcpServers` | stdio, sse, streamable-http | **per call** in `canUseTool`; also gates the user's own Claude MCP |
| codex | `-c mcp_servers.<id>={…}` (+ `env_vars` for passthrough) | stdio, streamable-http | **once per run**: servers are withheld unless policy allows MCP now; codex's own configured MCP is not gated |
| antigravity, opencode | — (`mcp: false`) | — | a run asking for servers gets a warn event naming the agent that runs without them |

Rules: read-only requests (lead planning, review, test) never get servers —
the provider sandbox does not cover a server process it spawns. Plan mode
forbids MCP; approve mode needs a per-call approval no run can grant yet; both
**fail the run before any agent is called** when `--mcp` is given. Unknown ids
fail the run.

## Hooks (`.bremio/hooks.json`, P3-T2)

```json
[{ "id": "lint", "point": "run:post-task", "command": "node", "args": ["scripts/lint-gate.mjs"], "timeoutMs": 60000 }]
```

| Point | Where | A veto… |
|---|---|---|
| `run:pre-plan` | before a lead/planner call | fails the call; provider never reached |
| `run:pre-task` | before any other agent call | fails the call; provider never reached |
| `run:post-task` | after a completed non-lead call | turns the task `failed` (work stays where the agent left it) |
| `run:pre-apply` | daemon `/apply`, approved isolated-worktree merge | refuses the apply |
| `run:pre-merge` | daemon `/merge`, `bremio merge` (after the quality gate) | refuses the merge |

Contract: `shell: false`; context as JSON on stdin, `BREMIO_HOOK_POINT` and
`BREMIO_HOOK_ID` in env; exit 0 allows, anything else vetoes with the last
stderr line. Start failure, crash, timeout and an unreadable hooks file all
deny. On Windows use an `.exe` or `node <script>` (no `.cmd` without a shell).

## Playbooks (`--skill <name>`, P3-T3)

`.bremio/skills/<name>.md` or `.bremio/skills/<name>/SKILL.md`. Prepended to
the prompt of every agent call (the prompt, not `systemPrompt`, because codex
and antigravity ignore the latter), escaped like memory injection, budgeted at
4000 estimated tokens — over budget fails the run, nothing is truncated. Each
call reports `playbooks injected: … (~N tokens, estimated)`.

## Web search (P3-T4)

| Variable | Meaning |
|---|---|
| `BREMIO_WEB_SEARCH_BACKEND` | `brave` or `json`; unset = unconfigured |
| `BREMIO_WEB_SEARCH_ENDPOINT` | required for `json`; optional override for `brave` |
| `BREMIO_WEB_SEARCH_API_KEY` | the key, or name another variable with `BREMIO_WEB_SEARCH_API_KEY_ENV` |
| `BREMIO_WEB_SEARCH_API_KEY_HEADER` | `json` only; default `Authorization: Bearer` |

`json` expects `GET <endpoint>?q=&count=` → `{"results":[{"title","url","snippet"}]}`.
Unconfigured answers `status: "unconfigured"` and sends nothing. The `network`
policy check always runs first.

## Bremio's own MCP server (`--mcp bremio`, P3-T5)

`bremio mcp serve` (stdio) exposes:

- `bremio_web_search` — the configured backend, under the run's `network` policy.
- `bremio_post_note` — blocker / question / fact / decision on the run's
  blackboard (daemon `/blackboard/<runId>`).

The attaching run passes `BREMIO_CONTROL_MODE` and (daemon runs) `BREMIO_RUN_ID`;
a missing/unknown mode means `plan`. Web-search settings travel by name
(`envPassthrough` / codex `env_vars`), never as values in argv. The server is
started from the same CLI entry as the daemon, so versions match.

### Known limits

- Calls are recorded through the provider's own tool events in `run_events`
  and the blackboard row; there is no separate daemon audit row per call.
- `bremio_post_note` needs the persistent daemon at the default endpoint (or
  `BREMIO_DAEMON_ENDPOINT`); under an ephemeral daemon or `--standalone` it
  answers that the note was not recorded.
- `CommandTool` is still not offered to agents: every provider already has a
  shell, and a second one would need its own approval surface first.
- The daemon's `/blackboard` POST accepts its body without schema validation
  (pre-existing; not changed here).
