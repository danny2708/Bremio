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

## Antigravity adapter (official SDK 0.1.7, verified 2026-07-18)
- Surface: the official `google-antigravity` Python SDK behind a one-process,
  one-run JSONL sidecar. Bremio does not drive the IDE or wrap the interactive
  `agy` TUI.
- Auth: `GEMINI_API_KEY`, or Vertex/Enterprise environment configuration plus
  ADC. The SDK does **not** reuse an Antigravity IDE login or its subscription
  quota. `doctor` distinguishes missing SDK (`unavailable`) from installed SDK
  without detected credentials (`degraded`).
- Permissions: both modes disable subagents and scope file tools to the task
  workspace. `read-only` exposes only the SDK's read-only built-ins.
  `workspace-write` additionally exposes create/edit/shell and uses the SDK's
  declarative allow policy. The SDK's `run_command` is not filesystem-sandboxed
  like its file tools, so Bremio never enables it for a read-only task.
- Streaming: text, thoughts, tool calls, structured output, session id, and
  provider token usage normalize into `AgentEvent`. SDK 0.1.7 does not expose
  reliable shell exit codes through `ChatResponse`, so Antigravity is not
  eligible for Bremio test gates yet.
- Roles: Single implementer and explicit Team implementation worker via
  `--worker antigravity`. `planning=false` and `testing=false`, so it cannot be
  selected as lead or test gate. Structured output support is retained for
  future roles rather than being inferred from text.
- Quota: **AI-Quota-Tray already reads Antigravity quota per model via the
  running IDE's local language-server `GetUserStatus` RPC** (process discovery,
  CSRF token, and `clientModelConfigs[].quotaInfo`; confirmed in AQT source on
  2026-07-18). Bremio's `packages/quota` consumes the resulting SQLite rows —
  don't re-implement it. If AQT's Antigravity source is ever
  unavailable at runtime, `@bremio/quota` returns an explicit unknown or
  unavailable capacity snapshot rather than guessing.
- Package pin and setup live in
  `packages/adapter-antigravity/requirements.txt`; the interpreter can be
  selected with `BREMIO_ANTIGRAVITY_PYTHON`.

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
