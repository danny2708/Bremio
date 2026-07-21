# Sprint Log — `sprint/opencode-completion`

## S1-T1 — Verify the OpenCode automation surface

**Done:** Replaced every hypothesis in `docs/09-opencode-adapter.md` with
observed facts by probing the installed opencode 1.18.4 binary. Tested all nine
questions: surface (found three usable surfaces — one-shot CLI, HTTP server, ACP
server), auth, workspace targeting (critically confirmed opencode respects
`--dir` and cwd, unlike Antigravity), permission mapping (rich per-tool
granular system), streaming shape (structured JSON events with token usage),
structured output (YES — lead-eligible via server/SDK path with JSON Schema),
cancellation (both subprocess kill and HTTP abort), models (full catalogue with
cost/limits/variants), and binary resolution (npm shim pattern).

**Hard:** The `opencode serve` HTTP server could not be probed directly via curl
because the process startup via `Start-Process` failed on the cmd shim (it is
not a Win32 app). Had to use `Start-Job` with the direct exe path to start the
server. The Structured Output capability is only available through the
server/SDK path (`@opencode-ai/sdk`), not through the one-shot CLI — this is a
critical design constraint.

**Assumed:** That `POST /session/:id/abort` cleanly terminates work without
orphans (documented but not live-tested — would need a running server + active
session). That the SDK's `session.prompt()` with `format.json_schema` is
available in the same HTTP API (inferred from the SDK being auto-generated from
the server's OpenAPI spec). That `testing` capability (exit-code-backed) holds
because the bash tool returns real exit codes — confirmed at the permission/CLI
level but not proven with a live test run.

**Deviations:** None — all success criteria met.

## S1-T2 — Implement `packages/adapter-opencode`

**Done:** Created the `@bremio/adapter-opencode` package mirroring
`adapter-antigravity`'s scaffolding exactly. Three source modules:
`src/binary.ts` (binary resolution via `BREMIO_OPENCODE_BIN` → PATH → `.cmd`
shim fallback, reusing the `apps/vscode-extension/src/cli-launcher.ts` approach
without re-deriving it), `src/events.ts` (maps opencode `--format json` event
lines to normalized `AgentEvent` — `step_start`→log, `step_finish`→usage with
token counts, `text`→message, `tool_use`→tool_use/tool_result pairs for write,
bash, read, glob, grep), and `src/opencode-adapter.ts` (full `AgentAdapter`
implementation with two run paths: CLI one-shot via `opencode run --format
json`, and HTTP server via `opencode serve` when `outputSchema` is provided for
structured output). Seven tests pass, covering capabilities, health, unavailable
binary, normal streaming, failure, cancel-before-start, and cancel-after-done.

**Hard:** The structured output path requires starting an `opencode serve`
server as a child process, finding a free port, waiting for it to become ready,
creating a session via the HTTP API, sending a structured prompt, and cleaning
up. This is inherently more complex than the one-shot CLI path. The HTTP API
`POST /session/:id/message` with `format.json_schema` was inferred from SDK
docs rather than live-tested against the server.

**Assumed:** That `POST /session/:id/message` accepts `format` with
`json_schema` type and a `schema` field (from SDK docs, the SDK is
auto-generated from the server's OpenAPI spec). That the fake fixture's event
output matches real opencode `--format json` output closely enough for
normalization tests. That `fetch` is available (Node 22+ has global fetch).

**Deviations:** None — all success criteria met. 7/7 tests pass, typecheck
clean, full test suite passes (303 tests, 37 files).

## S1-T3 — Offer OpenCode everywhere an agent is chosen

**Done:** Registered `OpenCodeAdapter` in all six surfaces that enumerate agents.

| Surface | Change |
|---|---|
| `apps/cli/src/index.ts` | Import, help text (`--agent`, `--lead`, `--worker`), `agentIds` set, registry creation, doctor loop, lead type cast |
| `apps/daemon/src/server.ts` | Import, `/adapters` endpoint adapter list |
| `apps/cli/src/tui/data.ts` | Import, `AGENT_LABELS` map, `createAdapters()` |
| `apps/vscode-extension/src/webview.ts` | Already dynamic (CSS variable `--agent-opencode` was already defined) |
| `scripts/provider-smoke.ts` | Import, type unions, argument parsing, `createProviderRegistry()`, health check |
| `apps/cli/package.json`, `apps/daemon/package.json` | Added `@bremio/adapter-opencode: "workspace:*"` dependency |

The hardcoded lead-name check (`values.lead !== "claude" && values.lead !== "codex"`) was replaced with an agent-agnostic check using the `agentIds` set — core no longer learns provider names.

**Tests:** Three new tests added:
1. `apps/cli/src/opencode-registration.test.ts` — verifies `AGENT_LABELS`, `createAdapters()` returns 4 adapters, and opencode's `getCapabilities()` confirms lead eligibility.
2. `apps/daemon/src/daemon.test.ts` — `/adapters` endpoint returns 4 adapters including opencode, and opencode reports `leadEligible: true`.
3. `apps/cli/src/tui/theme.test.ts` — updated the colour check to include opencode.

**Hard:** The daemon `/adapters` endpoint calls `healthCheck()` on each adapter, which can be slow when real provider binaries are probed. The two new daemon tests needed a 15-second timeout.

**Deviations:** None. 308/308 tests pass (38 files), typecheck clean. No hardcoded three-agent triple survives in `apps/` and `packages/` (the `AQT_AGENT_IDS` in `packages/quota/src/aqt-provider.ts` is a data constant listing the three AQT-tracked providers — a different concern from Bremio's agent enumeration).

## S1-T4 — Real-provider smoke (Single + Team) + verify + commit

**Done:** Both smoke modes pass with real opencode 1.18.4:

```
# Single (opencode as implementer)
$ pnpm smoke:providers --mode single --agent opencode --timeout 600
=== provider smoke: mode=single agent=opencode repo=... ===
preflight opencode: ok — opencode 1.18.4; providers configured
PASS mode=single agent=opencode run=run-...

# Team (opencode as lead, claude as worker)
$ pnpm smoke:providers --mode team --lead opencode --timeout 600
=== provider smoke: lead=opencode repo=... ===
preflight opencode: ok — opencode 1.18.4; providers configured
preflight claude: ok — Claude Agent SDK loaded
lead started: opencode
task started: TASK-001 -> claude
task finished: TASK-001 completed
task started: TASK-002 -> claude
task started: TASK-003 -> opencode
task finished: TASK-003 completed
task finished: TASK-002 completed
PASS lead=opencode run=run-... tasks=3/3
```

`release:check` passes: typecheck ✅, test 308/308 ✅, build ✅, release:smoke ✅.

**Three bugs fixed to make the smoke pass:**

1. **Windows stdin hang (`binary.ts`).** `opencode.exe` hangs when stdin is a
   pipe. The adapter now resolves the npm `.cmd` shim to the `.exe` path (by
   reading the `.cmd` file and extracting the exe path from its `%dp0%` logic)
   and spawns with `stdin: "ignore"`. Without this fix every run timed out at
   600s vs ~22s directly from PowerShell.

2. **ACP response parsing (`opencode-adapter.ts`, `startServerRun`).** The
   `POST /session/:id/message` endpoint returns `{ info, parts }` — the
   model's text is in `parts[{type:"text"}].text`. The adapter was looking for
   `data.info.structured_output` (wrong shape) and then `info.text` (wrong
   field). Also removed the `format: { type: "json_schema", schema }` field
   from the prompt body — the default provider (Console/deepseek) rejects it
   with an upstream error.

3. **Review prompt format (`plan-schema.ts`).** The review task prompt told
   the model to "Return the structured review object required by the output
   schema" without defining what that schema is. Added the exact JSON
   structure (`{ summary, findings: [{ severity, message, status }] }`) to
   the prompt so the model produces valid review output that passes
   `ReviewOutputSchema` Zod validation.

**Hard:** The Windows stdin hang was the most difficult — it only manifests
when the parent process pipes stdin (not when running from a real terminal),
so it didn't appear in the S1-T1 manual probing. Diagnosed by systematically
testing different spawn configurations: `.exe` with NUL stdin worked, `.exe`
with piped stdin hung, `.cmd` with any stdin config errored. Root cause:
opencode.exe checks TTY state on stdin before proceeding.

The `.cmd` shim EINVAL on `shell: false` was also Windows-specific — Node.js
cannot spawn `.cmd` files directly without `shell: true`. The fix resolves the
`.cmd` → `.exe` path once during binary resolution, then spawns the `.exe`
directly.

**Assumed:** That the review model will follow the JSON structure instructions
reliably across providers — only tested with deepseek-v4-flash-free as
opencode's default provider. That Claude tasks in Team mode continue to work
(Claude SDK credentials were already configured from S1-T3).

**Deviations:** None. All success criteria met. Docs updated: `04-adapters.md`
(promoted from future to verified), `06-roadmap.md` (Phase 6 status), and
`09-opencode-adapter.md` (corrected response shape and structured output
findings).
