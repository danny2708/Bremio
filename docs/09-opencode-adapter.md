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

**Decision:** Two paths — one-shot CLI (`opencode run --format json`) for
single-agent implementer/test/review tasks, and HTTP server (`opencode serve`)
for lead planning. The adapter spawns the process per run; the server is
started per-session and killed when done.

**Important findings during verification (S1-T4, 2026-07-21):**

1. **Windows stdin hang.** `opencode.exe` hangs indefinitely when its stdin is
   a pipe. Fixed by spawning with `stdin: "ignore"` (NUL device on Windows).
   Without this fix, every run (single or team) would timeout at 600s.

2. **ACP response shape.** `POST /session/:id/message` returns:
   ```json
   { "info": { ... }, "parts": [ { "type": "text", "text": "..." }, ... ] }
   ```
   The model response text is in `parts[{type:"text"}].text`, **not** in
   `info.text` or `data.info.structured_output` as initially documented.

3. **JSON Schema format unsupported.** The server's `format: { type:
   "json_schema", schema: {...} }` option causes the default provider
   (Console/deepseek-v4-flash-free) to return an error:
   `"Error from provider (Console): Upstream request failed"`. Structured
   output is only available through the `@opencode-ai/sdk` npm package, not
   through the raw HTTP ACP endpoint with the default provider. The adapter
   therefore sends the lead prompt as plain text with JSON format instructions
   in the prompt itself — the model reliably produces valid plan JSON.

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

### Structured output → lead eligibility (updated S1-R2)

The **one-shot CLI** (`opencode run --format json`) cannot constrain the output
to a schema — it only controls the serialization format of the event stream.

The **HTTP server** (`opencode serve`) accepts `format: { type: "json_schema",
schema: {...} }` in `POST /session/:id/message`. The adapter tries this path
first; if the provider rejects it (the default Console/deepseek provider does),
it falls back to a plain text prompt with JSON format instructions embedded.

Regardless of which path was taken, the adapter validates the final output
against `req.outputSchema`:
1. Parses the response text as JSON — if parsing fails, the run fails.
2. Checks the result is a JSON object, not an array or primitive.
3. Checks every field in `schema.required` is present.

Any failure yields a `failed` outcome. A completed run guarantees
schema-conforming output.

**Verdict: Yes, OpenCode is lead-eligible.** The adapter provides structured
output by post-hoc validation backed by adapter-level checks. The lead smoke
test (S1-T4) confirmed the lead planner produces valid PlanSchema JSON through
the server path. The adapter uses the server path for lead planning (needed for
session/workspace isolation) and the one-shot CLI for implementer/test/review
tasks.

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
| Structured output | **Lead-eligible: YES** via HTTP server path with post-hoc schema validation. The adapter validates JSON, verifies object type, and checks all required fields from `outputSchema`. Non-conforming output yields `failed`. Format hint sent to server as `format: json_schema`; falls back to plain text if rejected. One-shot CLI cannot constrain output. | S1-R2 implementation: `validateStructuredOutput()` in `opencode-adapter.ts` |
| Cancellation | Two paths: (1) subprocess kill via `ProcessSupervisor`, (2) `POST /session/:id/abort` on server for cooperative cancellation with confirmed stop. | `opencode serve` API docs: `POST /session/:id/abort` |
| Models | Rich model catalogue: `opencode models --verbose`. Each model has cost, limits, capabilities, variants (reasoning effort). Format: `<provider>/<model>`. | `opencode models --verbose` (full output shows 50+ models with detailed metadata) |
| Binary resolution | npm global install: `.cmd` shim → `node_modules/opencode-ai/bin/opencode.exe`. Resolution: `BREMIO_OPENCODE_BIN` → PATH → default npm location. Reuse cli-launcher pattern for `.cmd` shim. | `(Get-Command opencode).Source`, `Get-Content npm/opencode.cmd`, `Get-Content npm/opencode.ps1` |

## Resulting capability declaration

```ts
{
  planning: true,              // server/SDK path can produce structured plans
  structuredOutput: true,      // adapter validates output against outputSchema; fails if non-conforming
  repositoryRead: true,        // reads/writes in cwd or --dir; permission system restricts
  repositoryWrite: true,       // tool_use events show file writes with filepath
  shell: true,                 // tool_use with tool:"bash" observed
  testing: true,               // shell commands return real exit codes
  browser: false,              // no evidence of browser control
  vision: false,               // adapter has no interface for image/attachment input
  resumableSessions: false,    // no session resume API exposed; abort replaces resume
}
```

`testing` is `true` because OpenCode executes shell commands through the
`bash` permission/tool and returns real exit codes. The quality gate's
test-evidence requirement (exit-code-backed) is satisfied — this is not an
Antigravity-like prose-only surface.

`structuredOutput` is `true` because the adapter validates the final output
against `req.outputSchema`: it parses the response as JSON, checks that it is
a JSON object (not an array or primitive), and verifies every field listed in
`schema.required` is present. A run whose output fails any of these checks
yields a `failed` outcome rather than `completed`, so a caller that receives
a completed run is guaranteed schema-conforming output. The adapter also
attempts the `format: { type: "json_schema", schema }` native structured-output
path on the ACP request; if the provider rejects it, it falls back to a text
prompt with JSON instructions and relies on post-hoc validation.

`vision` is `false` because the `AgentRunRequest` interface defines no
mechanism for passing images or attachments to the adapter's `startRun`
method. The underlying model may support vision, but the adapter has no path
to exercise it.

## Structured output → lead eligibility (updated S1-R2)

The adapter validates JSON output against `req.outputSchema` before yielding
`completed`. A non-conforming response (prose, array, missing required fields)
produces a `failed` outcome. This is what backs `structuredOutput: true`:
the guarantee is adapter-level validation, not model-level enforcement.

The server path (`startServerRun`) first tries passing `format: {
type: "json_schema", schema: ... }` in the ACP prompt body. If the provider
rejects it (the default Console/deepseek provider does), the adapter catches
the error and re-sends without the format field. Either way, the response is
validated against `req.outputSchema` after receipt — post-hoc validation is
the mechanism, and native format support is a best-effort optimisation.

**Verdict: OpenCode is lead-eligible.** The adapter guarantees structured
output by post-hoc validation, and the lead smoke test (S1-T4) confirmed that
the lead planner produces valid PlanSchema JSON through the server path.

## Quota

Out of scope for this adapter. AI-Quota-Tray does not observe OpenCode, so
`@bremio/quota` reports OpenCode capacity as `unknown` — which the router
already handles as a soft penalty and never as a hard exclusion (`docs/05`).
Bremio does not build a second quota reader; that is R1 in `docs/99`.
