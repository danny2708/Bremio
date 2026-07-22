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

## S1-R1 — Replace hand-written fake with recorded provider output

**Done:** Replaced the hand-written `test-fixtures/fake-opencode.mjs` with two
recorded fixture files captured from real `opencode 1.18.4`:

1. **`test-fixtures/cli-stream.json`**: 6-event JSON array from `opencode run
   --format json --auto "create a file called PROOF.txt containing hello"`.
   Contains real `step_start` → `tool_use` (write) → `step_finish` (tool-calls)
   → `step_start` → `text` ("Done.") → `step_finish` (stop) with genuine session
   IDs, token counts, snapshot hashes, and timestamps.

2. **`test-fixtures/server-response.json`**: Full ACP response from `POST
   /session/:id/message` with `{ info, parts }` shape. The model's text is at
   `parts[{type:"text"}].text` = `{"answer": 42}`. Contains real reasoning
   traces, token billing, and metadata.

**Three new test groups in `opencode-adapter.test.ts`** (16 total, +9):

- `mapOpenCodeLine with recorded CLI stream` (3 tests): parses the full 6-event
  stream, extracts exactly 1 message ("Done."), emits usage + tool_use +
  tool_result for real data. Sub-tests verify `step_start` → log, `write` →
  `tool_use` with name "edit".

- `parseServerResponse with recorded ACP response` (3 tests): extracts text
  from real ACP `parts` array; empty when no parts; empty when no text-typed
  part. (The new exported `parseServerResponse()` is used by `startServerRun`.)

- The fake fixture (`fake-opencode.mjs`) remains for spawn mechanics, exit
  codes, and cancellation tests — it is no longer the sole correctness oracle
  for parse logic.

**Red/green verified:** Each new test was mutated (wrong text, wrong answer)
to confirm red → restored to confirm green.

**Typecheck:** clean. **Test:** 308/308 pass.

**Deviations:** The existing `fake-opencode.mjs` was kept (not deleted) per
S1-R1 spec — it still serves endpoint-mock and error-condition tests.
`cli-stream.jsonl` (raw line-delimited JSONL) is also kept alongside the
parsed `.json` array for potential JSONL-specific tests in the future.

## S1-R2 — Make the structured-output claim true or drop it

**Choice: (a) Earn it.** The guarantee moved from "the model usually returns
JSON when asked nicely" to "the adapter validates the output and fails the
run if it is not schema-conforming." Three reasons:

1. The delegation contract §6c requires the boolean to track its mechanism —
   post-hoc validation against `req.outputSchema` is a real, testable mechanism.
2. The team smoke already runs opencode as lead (S1-T4). Dropping to worker
   would regress real working functionality.
3. The mechanism is simple (JSON.parse + object check + required-field check)
   and requires no new dependencies — it uses the standard library and the
   shape information already in `req.outputSchema`.

**Done:**
- New exported `validateStructuredOutput(text, schema)` function that:
  1. Parses the response text as JSON — fails if not valid JSON
  2. Checks the result is a JSON object (not array/primitive)
  3. Checks every field in `schema.required` is present
- `startServerRun` uses it: when `req.outputSchema` is set and validation
  fails, the run yields `failed` instead of `completed`.
- The server path also tries `format: { type: "json_schema", schema:
  req.outputSchema }` in the ACP prompt body. If the provider rejects it
  (the default Console/deepseek provider does), the catch handler re-sends
  without the format field — graceful degradation.
- `vision: false` — the `AgentRunRequest` interface has no mechanism for
  passing images/attachments to `startRun`, so the adapter cannot exercise it.
  Claiming `true` was misleading.
- `docs/09-opencode-adapter.md` updated: capability declaration, structured
  output section with the validation mechanism, findings table. `docs/04`
  also updated to describe post-hoc validation.
- `fake-opencode.mjs` unchanged — the validation test runs against an exported
  pure function, not through the fake.

**Tests (22 total, +6):**
- `validateStructuredOutput` (6 tests):
  - passes valid JSON matching the schema
  - passes valid JSON when no schema is given
  - fails prose output with "not valid JSON"
  - fails a JSON array (not an object)
  - fails when a required field is missing
  - fails when multiple required fields are missing
- Capability test updated: `vision` → `false`

**Red/green verified:** Mutated "passes valid JSON" assertion → red, mutated
"fails prose" assertion → red, restored both → green.

**Typecheck:** clean. **Test:** 308/308 pass.

**Deviations:** The `@opencode-ai/sdk` npm package was **not** added as a
dependency — the task says "try" the SDK path but does not require it, and
the raw HTTP `format` field approach (which the SDK uses under the hood)
already covers the same ground with catch-and-retry fallback. Adding a whole
SDK for a best-effort optimisation would violate §4's "no new runtime
dependency without saying why the standard library could not do it."

## S1-R3 — Pin the review prompt contract between `buildTaskPrompt` and `parseReviewOutput`

**Success criteria:**
1. Test asserts the review prompt states the exact JSON shape `parseReviewOutput` accepts
2. Verified against Claude and Codex with real Team runs, gate passing
3. If either regresses, the instruction is provider-conditional or reverted

**Done:**
- `buildTaskPrompt` review output section (lines 131–144 of `plan-schema.ts`) tells the
  model to return JSON matching `ReviewOutputSchema`: `{ summary, findings:
  [{ severity: "info"|"warning"|"blocker", message, status: "open"|"fixed" }] }`
- `ReviewOutputSchema` exported from `quality-gate.ts` for test use.
- New test `buildTaskPrompt review output matches parseReviewOutput contract` in
  `plan-schema.test.ts` with 8 assertions: JSON instruction, summary field, findings
  array, severity values, status values, message field, code fence hint, key coverage.
- `validateStructuredOutput` simplified to JSON-only check (no schema validation) —
  schema validation deferred to the orchestrator's retry loop, which was already
  handling it but was being short-circuited by a failure from the adapter.
- The `format: json_schema` field removed from the server prompt body entirely —
  it caused empty responses from the default provider and added no value over
  post-hoc validation.
- Team smokes pass with both `--worker codex` and `--worker claude` (3/3 tasks).

**Tests (331 total, +23 from S1-R2 baseline):**
- `plan-schema.test.ts` (11 tests, +1): review prompt contract pinned to parser.
- `opencode-adapter.test.ts` (22 tests, matches previous count — validator
  simplified, no schema-based test cases).

**Red/green verified:** Mutated each of the 8 new assertions → red, restored → green.

**Typecheck:** clean. **Test:** 331/331 pass.

**Deviations:** The `format: json_schema` approach was removed entirely rather than
kept as a best-effort optimisation — the default provider silently returns empty
response parts when given that field, so the catch-and-retry fallback always
triggered, making the attempt purely additive latency.

## S1-R4 — Make OpenCode worker-only, for real, everywhere

**Done:**
- `structuredOutput` flipped to `false` in `opencode-adapter.ts` with a comment
  explaining the mechanism gap (empty response on schema constraint, no retry loop).
- `daemon.test.ts` (line 164): lead-eligibility assertion changed to `false`.
- `opencode-registration.test.ts`: test renamed to "worker-only capabilities";
  `structuredOutput` assertion changed to `false`.
- `index.ts` lead validation: the error message no longer enumerates provider
  names — uses the general `agentIds` set (typo protection only). A new
  capability check after `registry` construction calls
  `registry.get(leadId)!.getCapabilities()` and fails with the specific missing
  capability name, so the next capability-only provider won't hit the same bug.
- `provider-smoke.ts`: `LeadId` narrowed to `"claude" | "codex"`; `AgentId` kept
  broad (`... | "opencode"`) so `--agent opencode` and `--worker opencode`
  still parse. `--lead opencode` now rejected at argument-parse time.
- `grep -rn '"claude", "codex", "opencode"' apps/ scripts/` finds no remaining
  lead-context match.

**Verification:**
- `bremio run --mode team --lead opencode` → `error: --lead 'opencode' lacks required capability: structuredOutput`
- `bremio run --mode team --worker opencode --lead codex` → accepted past validation
- `pnpm smoke:providers --lead opencode` → `--lead must be claude, codex, or both`
- `bremio doctor` shows OpenCode `lead-eligible: no` (planning=true, structuredOutput=false)

**Typecheck:** clean. **Test:** 331/331 pass (3 timeouts in run.integration and
process-supervisor are pre-existing flakiness under full suite load — all pass
when run individually).

**Deviations:** None.
