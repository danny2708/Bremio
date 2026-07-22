# 04 — Adapters & Provider Surfaces

## AgentAdapter contract (every provider implements this)

```ts
interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  healthCheck(): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  listModels(): Promise<ModelDescriptor[]>;
  startRun(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  resumeRun(sessionId: string, request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancelRun(runId: string): Promise<void>;
}
```

> ⚠️ **Verify first:** the flags/RPCs below change fast (all post-cutoff,
> 07/2026). Before coding each adapter, run `--help` / read the official
> docs and update this file. Don't trust this list blindly.

## Claude Code adapter
- Surface: **Claude Agent SDK** (TypeScript) — model/effort selection,
  streaming, permissions, structured output, usage + rate-limit events.
- Quota in Bremio: consume AQT's opt-in Claude Code status-line bridge (5-hour
  and 7-day windows). SDK token usage is telemetry, not a quota percentage.
- Roles: lead, planner, implementer, reviewer. Eligible to be the lead.
- Risk: lowest among the current adapters. **Start here.**

## Codex adapter
- Surface: `codex exec` (one-shot) or the **Codex App Server**
  (`codex app-server --stdio`) for progress streaming, thread persistence,
  turn control.
- Model/effort: GPT-5.6 family — **Sol** (flagship), **Terra** (workhorse),
  **Luna** (cheap/fast); effort low→extra-high. Bremio passes the model with
  `--model` and normalized effort through
  `-c model_reasoning_effort="<level>"`; omission leaves Codex's
  `config.toml` defaults untouched.
- Quota: RPC `account/rateLimits/read` via app-server — **official**. This
  is exactly the source AI-Quota-Tray already uses → reuse it, don't
  re-read it.
- Roles: lead, implementer, reviewer, tester. Eligible to be the lead.

## Antigravity adapter (`agy` CLI 1.1.4, verified 2026-07-18)
- Surface: the authenticated **`agy` CLI** in print mode, spawned directly
  (`shell: false`). Work bills to the user's existing Google AI subscription;
  Bremio does not use the Python SDK or a `GEMINI_API_KEY`, and never drives the
  IDE or the interactive `agy` TUI.
- Auth: sign-in happens once via `agy` in a real terminal. There is no
  `agy auth status`, and the only definitive check is a billed prompt, so
  `doctor` reads the CLI's onboarding state file as a heuristic: `unavailable`
  when the binary is missing, `degraded` before sign-in, `ok` afterwards.
- **Workspace targeting is mandatory.** Verified: `agy` IGNORES the spawned
  process cwd and writes into its own scratch workspace, so every run passes
  `--add-dir <absolute path>` and restates the workspace root in the prompt.
- Permissions: `read-only` maps to `--mode plan`, which refuses writes but still
  returns prose. `workspace-write` maps to `--dangerously-skip-permissions`,
  because a non-interactive run cannot answer approval prompts.
- Non-TTY: verified that `agy -p` returns clean stdout with exit 0 under a
  non-TTY parent on 1.1.4, so the historical output-swallowing trap does not
  reproduce and **no pty wrapper is needed**.
- Streaming: prose only. Bremio emits one `message` event per output line plus a
  terminal `completed`; there are no tool/usage events because the CLI exposes
  none. `--print-timeout` is a provider-side safety net; real cancellation comes
  from the orchestrator signal.
- Roles: Single implementer and explicit Team implementation worker via
  `--worker antigravity`. There is no JSON output mode, so the adapter reports
  `structuredOutput=false` (and `planning=false`, `testing=false`) — the router
  therefore excludes it from lead and test-gate roles through the capability
  contract rather than a provider-specific check.
- Quota: unchanged and NOT read from `agy` (it has no machine-readable quota
  command; `/credits` only opens an interactive panel). **AI-Quota-Tray already
  reads Antigravity quota per model via the running IDE's local language-server
  `GetUserStatus` RPC** (process discovery, CSRF token, and
  `clientModelConfigs[].quotaInfo`; confirmed in AQT source on 2026-07-18).
  Bremio's `packages/quota` consumes the resulting SQLite rows. If that source
  is unavailable at runtime, `@bremio/quota` returns an explicit unknown or
  unavailable capacity snapshot rather than guessing.
- Binary resolution: PATH, then the installer's default location; override with
  `BREMIO_AGY_BIN`.

## OpenCode adapter (`opencode` 1.18.4, verified 2026-07-21)
- Surface: **one-shot CLI** (`opencode run --format json`) for
  implementer/test/review tasks, and **HTTP server** (`opencode serve`) for any
  task whose request carries an `outputSchema` (review tasks; not lead
  planning — see verdict below). The adapter spawns the process per run; the
  server is started per-session and killed when done.
- Binary resolution: `BREMIO_OPENCODE_BIN` → PATH → npm global `.cmd` shim
  at `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`. On Windows,
  the adapter resolves the `.cmd` shim to the `.exe` by reading the `.cmd`
  file and spawning the exe directly — avoids the cmd.exe quoting trap.
- Non-TTY fix: opencode.exe hangs when stdin is a pipe on Windows. The
  adapter spawns with `stdin: "ignore"` (NUL), which resolves the hang and
  lets the run complete normally (benchmarked ~22s for a single-agent prompt
  vs previously timing out at 600s).
- ACP server response: the `POST /session/:id/message` endpoint returns
  `{ info, parts }` where the model's text is in `parts[{type:"text"}].text`.
  The `info.text` and `data.info.structured_output` fields do not exist. The
  default Console provider (`deepseek-v4-flash-free`) returns **200 OK with an
  empty `parts` array** when asked for `format: json_schema` — not an error the
  adapter can catch. That failure mode is why the adapter no longer sends
  `format` at all (removed in S1-R3): the request always goes as plain text.
- Structured output (**not a guarantee — see verdict below**): the adapter
  extracts the first JSON object from the response (stripping code fences and
  any leading prose) and checks it parses and is an object. It does **not**
  check `outputSchema.required` — that field-level check is left to whichever
  caller re-validates the result (the lead's own repair-prompt retry, for a
  planning call; nothing, for a review task). A `failed` outcome only means
  "not JSON at all," not "matches the schema."
- Roles: implementer (via CLI), reviewer (via CLI or HTTP server, whichever
  `req.outputSchema` selects), tester (via CLI). **Not eligible to be the
  lead** — the router excludes it through the capability contract
  (`structuredOutput: false`), not a provider-specific check. Reasoning (S1-R4,
  2026-07-22): the mechanism above has no repair loop and a demonstrated
  silent-empty-response failure mode; Claude and Codex already provide the
  lead role with a schema constraint the provider itself enforces. OpenCode
  remains a fully capable **worker** for analysis, implementation, test and
  review tasks.
- Verified with real provider smoke (2026-07-21, historical): single-agent run
  PASS; a Team run with opencode as **lead** + claude worker also PASSED
  (3/3 tasks). That run is why S1-T4 first called OpenCode lead-eligible — it
  is evidence the mechanism can work on one model on one day, not evidence it
  is a guarantee. S1-R4 revisits the verdict for that reason.
- Jan was dropped from the current roadmap. No adapter was implemented, and
  there is no measured evidence that maintaining another local-provider path
  would improve net gain over OpenCode and the existing cloud workers.

## Plugin manifest (adding a provider = 1 package)
```ts
interface AgentPluginManifest {
  id: string; displayName: string; version: string;
  adapterFactory: () => AgentAdapter;
  supportedRoles: AgentRole[];
  configurationSchema: Record<string, unknown>;
}
```
