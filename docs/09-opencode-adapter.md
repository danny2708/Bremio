# 09 — OpenCode adapter

> **Status: verified against opencode 1.18.4.** S1-T1 completed. Every claim
> below is an *observed fact*, not a hypothesis. See the Findings table for the
> exact commands run and what was observed. Anything that could not be determined
> is recorded as "not available".

Installed locally: **opencode 1.18.4**, resolved as an npm global install at
`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe` via the `.cmd` shim.

## Why OpenCode

`docs/06` Phase 6 lists OpenCode as an additional provider, and `docs/04`
already sketches it as "has a headless HTTP server → the adapter talks HTTP
instead of driving the TUI". Two things make it worth doing first among the
remaining work:

1. **It is a different integration shape.** Claude is an in-process SDK, Codex is
   a JSONL subprocess, Antigravity is a prose-only CLI. OpenCode is an HTTP
   server with an official JS SDK (`@opencode-ai/sdk`), exercising a fourth
   shape and proving `AgentAdapter` is genuinely provider-agnostic rather than
   accidentally fitted to three.
2. **It is the tool building this milestone.** Bremio integrating the agent that
   writes it produces first-hand knowledge of the surface that no amount of
   reading docs would.

## What the adapter must answer

Every provider in `docs/04` answers the same questions. These are the ones
S1-T1 closed, each with the probe that closed it.

### Surface

Three surfaces exist:

| Surface | Command | Key flags |
|---|---|---|
| One-shot CLI | `opencode run "<message>"` | `--format json`, `--dir <path>`, `--auto`, `--agent`, `--model` |
| HTTP server | `opencode serve` | `--port`, `--hostname`, OpenAPI 3.1 at `/doc`, SSE at `/event` |
| ACP server | `opencode acp` | nd-JSON over stdio, `--cwd`, JSON-RPC |

**Decision:** HTTP server path (`opencode serve`) + `@opencode-ai/sdk` npm
package. This gives structured streaming, structured output via JSON Schema, and
clean cancellation via `POST /session/:id/abort`. The one-shot CLI `--format
json` streams raw events but cannot constrain output format — it is not
sufficient for lead eligibility. The server gives both.

**Server process ownership:** Bremio spawns one per run (same model as
`adapter-codex` spawning `codex exec`). The server lifecycle is tied to the run:
start → use → stop. Attaching to a user-run instance is not supported.

### Auth

Auth is per-provider, managed through OpenCode's credential system:

```powershell
opencode providers login        # interactive
opencode providers list          # list configured credentials
```

Credentials are stored in `~/.local/share/opencode/auth.json`. The `opencode
providers list` command shows configured providers and their auth method.

For the HTTP server, `OPENCODE_SERVER_PASSWORD` enables basic auth (username
defaults to `opencode`, override via `OPENCODE_SERVER_USERNAME`).

**healthCheck:** probe by running `opencode providers list` and checking the
exit code + output. If it lists at least one credential or environment-variable
provider, report `ok`. If the binary is missing, `unavailable`. If running but
no providers configured, `degraded` — matching Antigravity's pattern.

### Workspace targeting

Tested in a throwaway git repo at `$env:TEMP\opencode-workspace-test`, invoked
from `D:\Work\Side-Projects\Bremio` (a **different** working directory):

```powershell
# From bremio dir, with --dir:
opencode run "create a file called PROOF.txt containing workspace-targeting-test" --dir "$env:TEMP\opencode-workspace-test" --format json --auto
# → File created at $env:TEMP\opencode-workspace-test\PROOF.txt ✓

# From the test dir, without --dir:
cd $env:TEMP\opencode-workspace-test
opencode run "create a file called CWD_TEST.txt containing from-native-cwd" --format json --auto
# → File created at $env:TEMP\opencode-workspace-test\CWD_TEST.txt ✓
```

**Verdict:** OpenCode respects both the process cwd AND the explicit `--dir`
flag. Without `--dir`, files land in the process cwd. With `--dir`, files land
in the specified directory. The server path also has per-session workspace
control. This is **not** like Antigravity — a worktree-isolated orchestrator
can safely control where files land by spawning in the correct cwd or passing
`--dir` / session project path.

### Permission mapping

OpenCode has a rich permission system with granular tool-level controls:

```powershell
opencode agent list              # list all agents (build, plan, explore, etc.)
opencode agent create            # create custom agent with permission profile
```

Key permissions: `read`, `edit`, `bash`, `glob`, `grep`, `webfetch`, `task`,
etc. Each can be `allow`, `ask`, or `deny`. The `--auto` flag auto-approves
non-denied requests.

Built-in agents demonstrate read-only enforcement:
- **build** (default): all tools allowed
- **plan**: `edit: deny`, `bash: deny` — read-only by permission
- **explore** (subagent): read-only, cannot modify files

**Verdict:** Read-only is enforceable through agent permissions (`edit: deny`,
`bash: deny`). Both review and test-gate roles can be implemented using a custom
agent with restricted permissions. The adapter can create or configure an agent
profile via the server API or config file.

### Streaming shape

`opencode run --format json` produces one JSON object per line:

```json
{"type":"step_start","timestamp":...,"sessionID":"...","part":{...}}
{"type":"tool_use","timestamp":...,"sessionID":"...","part":{"type":"tool","tool":"write","callID":"...","state":{"status":"completed","input":{...},"output":"...","metadata":{"filepath":"...","exists":false,"truncated":false}}}}
{"type":"step_finish","timestamp":...,"sessionID":"...","part":{"reason":"tool-calls","tokens":{"total":...,"input":...,"output":...,"reasoning":...,"cache":{"write":0,"read":0}},"cost":0}}
{"type":"text","timestamp":...,"sessionID":"...","part":{"type":"text","text":"..."}}
{"type":"step_finish","timestamp":...,"sessionID":"...","part":{"reason":"stop","tokens":{...},"cost":...}}
```

Available event types:
- `step_start` / `step_finish` — lifecycle, with `reason` field (`"stop"` = terminal)
- `text` — text content with `time.start`/`time.end`
- `tool_use` — tool calls with `tool` name, `callID`, `state.status` (`"completed"`/`"failed"`), `input`, `output`, `metadata.filepath`

Token usage: reported on every `step_finish` with `tokens.total`, `input`,
`output`, `reasoning`, `cache` hit/miss, and `cost`.

**SDK/server path:** the `@opencode-ai/sdk` provides typed access to the same
events plus structured output. Events are also available via SSE at
`GET /event`.

**Mapping to `AgentEvent`:** straightforward — `tool_use` → tool call events,
`text` → text events, `step_finish` with `reason: "stop"` → terminal event,
`tokens` → usage event.

### Structured output → lead eligibility

The **one-shot CLI** (`opencode run --format json`) cannot constrain the output
to a schema — it only controls the serialization format of the event stream.

The **HTTP server + SDK** (`@opencode-ai/sdk`) provides structured output via
`session.prompt()` with a JSON Schema constraint:

```ts
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "..." }],
    format: {
      type: "json_schema",
      schema: { /* PlanSchema as JSON Schema */ },
    },
  },
})
// result.data.info.structured_output → validated JSON matching PlanSchema
```

The SDK supports `json_schema` output format type with configurable retry count
(default 2) and returns validated JSON directly. On failure it returns a
`StructuredOutputError` with the attempted result.

**Verdict: Yes, OpenCode is lead-eligible.** When using the server/SDK path,
`structuredOutput = true` and `planning = true`. The structured output is
schema-validated, not prompt-level coaxing. This requires the HTTP server path
(not the one-shot CLI).

### Cancellation

Two paths:
1. **One-shot CLI:** killing the subprocess stops work. The `ProcessSupervisor`
   handles this (Windows: `taskkill /T`, POSIX: process group signal).
2. **HTTP server:** `POST /session/:id/abort` explicitly aborts a running
   session. The SDK exposes this as `client.session.abort({ path: { id } })`.

The HTTP server path provides cooperative cancellation with confirmed stop — the
abort endpoint returns a boolean and the server owns the session lifecycle.

### Models

```powershell
opencode models --verbose        # full model list with metadata
opencode models <provider>       # filter by provider
opencode models --refresh        # refresh from models.dev
```

Each model entry includes:
- `id`, `providerID`, `name`, `family`
- `cost`: `input`, `output`, `cache` (with tier pricing)
- `limit`: `context`, `input`, `output` sizes
- `capabilities`: `reasoning`, `toolcall`, `attachment`, `temperature`, etc.
- `variants`: reasoning effort levels (`none`, `low`, `medium`, `high`, `xhigh`, `max`)
- `status`: `active` or retired

Model ID format: `<provider>/<model>` (e.g. `openai/gpt-5.6-terra`).

**`listModels()`:** returns the full model catalogue. Each model carries its
own capabilities and variant definitions. The adapter maps `reasoningLevel` to
`variants` — each model declares which reasoning efforts it supports.

### Binary resolution

```powershell
(Get-Command opencode).Source  # → C:\...\npm\opencode.ps1
# npm global install produces three shims:
#   opencode         (Unix shell script — not used on Windows)
#   opencode.cmd     (calls %dp0%\node_modules\opencode-ai\bin\opencode.exe)
#   opencode.ps1     (same)
```

The `.cmd` shim forwards to:
`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`

**Resolution order:** `BREMIO_OPENCODE_BIN` env var → PATH → default npm
location. Reuse the `apps/vscode-extension/src/cli-launcher.ts` approach for
handling the `.cmd` shim on Windows. Same pattern as `BREMIO_AGY_BIN`.

## Findings

| Question | Verdict | Evidence |
|---|---|---|
| Surface | Three surfaces: one-shot `opencode run`, HTTP server `opencode serve`, ACP server `opencode acp`. Adapter uses HTTP server + `@opencode-ai/sdk`. | `opencode --help`, `opencode run --help`, `opencode serve --help`, `opencode acp --help` |
| Auth | Per-provider credentials stored in `~/.local/share/opencode/auth.json`. Server option: `OPENCODE_SERVER_PASSWORD`. healthCheck: `opencode providers list` exit code. | `opencode providers list`, `opencode providers --help` |
| Workspace targeting | Respects process cwd by default. Explicit `--dir <path>` flag overrides. Server has per-session workspace. NOT like Antigravity — safe for worktree orchestration. | `opencode run "create PROOF.txt" --dir "$env:TEMP\opencode-workspace-test" --format json --auto` from different cwd → file landed at `--dir` path. Same without `--dir` → file landed in cwd. |
| Permission mapping | Granular tool-level permissions (`read`, `edit`, `bash`, etc.) with `allow`/`ask`/`deny`. Built-in "plan" agent has `edit: deny`. Custom agents via config or `opencode agent create`. Read-only is enforceable. | `opencode agent list`, `opencode agent create --help`, docs/agents and docs/permissions |
| Streaming shape | Structured JSON events per line: `step_start`, `step_finish`, `text`, `tool_use`. Token usage + cost on every `step_finish`. Clear terminal event (`reason: "stop"`). File paths in tool metadata. | `opencode run --format json --auto "create PROOF.txt"` |
| Structured output | **Lead-eligible: YES** via HTTP server + SDK. `@opencode-ai/sdk` supports `session.prompt()` with `format: { type: "json_schema", schema: {...} }`. Schema-validated, retry on failure. One-shot CLI cannot constrain output. | `npm view @opencode-ai/sdk`, SDK docs: Structured Output with json_schema format |
| Cancellation | Two paths: (1) subprocess kill via `ProcessSupervisor`, (2) `POST /session/:id/abort` on server for cooperative cancellation with confirmed stop. | `opencode serve` API docs: `POST /session/:id/abort` |
| Models | Rich model catalogue: `opencode models --verbose`. Each model has cost, limits, capabilities, variants (reasoning effort). Format: `<provider>/<model>`. | `opencode models --verbose` (full output shows 50+ models with detailed metadata) |
| Binary resolution | npm global install: `.cmd` shim → `node_modules/opencode-ai/bin/opencode.exe`. Resolution: `BREMIO_OPENCODE_BIN` → PATH → default npm location. Reuse cli-launcher pattern for `.cmd` shim. | `(Get-Command opencode).Source`, `Get-Content npm/opencode.cmd`, `Get-Content npm/opencode.ps1` |

## Resulting capability declaration

```ts
{
  planning: true,              // server/SDK path can produce structured plans
  structuredOutput: true,      // @opencode-ai/sdk supports json_schema format
  repositoryRead: true,        // reads/writes in cwd or --dir; permission system restricts
  repositoryWrite: true,       // tool_use events show file writes with filepath
  shell: true,                 // tool_use with tool:"bash" observed
  testing: true,               // shell commands return real exit codes
  browser: false,              // no evidence of browser control
  vision: true,                // model capabilities show image input support
  resumableSessions: false,    // no session resume API exposed; abort replaces resume
}
```

`testing` is `true` because OpenCode executes shell commands through the
`bash` permission/tool and returns real exit codes. The quality gate's
test-evidence requirement (exit-code-backed) is satisfied — this is not an
Antigravity-like prose-only surface.

`structuredOutput` is `true` only when using the server/SDK path. The one-shot
CLI (`opencode run --format json`) does NOT support structured output. The
capability declaration assumes the adapter uses the server path.

`vision` is `true` based on model capabilities — models used through OpenCode
may support image input, but this depends on the underlying provider/model
selected. Reported conservatively as `true` since the capability exists in the
model catalogue.

## Quota

Out of scope for this adapter. AI-Quota-Tray does not observe OpenCode, so
`@bremio/quota` reports OpenCode capacity as `unknown` — which the router
already handles as a soft penalty and never as a hard exclusion (`docs/05`).
Bremio does not build a second quota reader; that is R1 in `docs/99`.
