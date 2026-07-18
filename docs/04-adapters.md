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
- Risk: lowest of the three. **Start here.**

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

## OpenCode / Jan (future, not the MVP)
- **OpenCode**: has a headless HTTP server (`opencode serve`) → the adapter
  talks HTTP instead of driving the TUI.
- **Jan**: local OpenAI-compatible server (default `localhost:1337`) →
  integrate as a **local model provider / local worker**, no desktop UI
  automation. Strategic role: **near-free capacity** as a fallback when
  cloud agents are low on quota (reading code, preliminary analysis,
  building test skeletons). See `05` — this is where `net_gain` is easiest
  to keep positive.

## Plugin manifest (adding a provider = 1 package)
```ts
interface AgentPluginManifest {
  id: string; displayName: string; version: string;
  adapterFactory: () => AgentAdapter;
  supportedRoles: AgentRole[];
  configurationSchema: Record<string, unknown>;
}
```
