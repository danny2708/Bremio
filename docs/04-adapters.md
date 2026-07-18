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

## Antigravity adapter — READ CAREFULLY (verified via web search, `agy` v1.1.0, 07/2026)
- Surface: `agy -p "<prompt>"` (non-interactive, alias `--print`), with
  `--model`, `--add-dir`, `--dangerously-skip-permissions`, `--print-timeout`
  (default 5m). The CLI is **real** and does edit the local repo.
- ⚠️ **TRAP 1 — non-TTY swallows output:** `agy -p` under a non-TTY
  (pipe/subprocess/CI) can **silently drop the final response**, with exit
  code still 0 ("succeeded but did nothing"). This is the most dangerous
  failure mode for an orchestrator spawning a child process. **Mandatory**:
  wrap it in a **pseudo-TTY (pty)**, parse text defensively, prefer
  API-key auth.
- ⚠️ **TRAP 2 — no read-only mode in `-p`:** it auto-approves **every** tool
  call, including `write_file`/shell (no `--approval-mode plan` yet). →
  a reviewer cannot be forced read-only at the CLI layer. Mitigation: run
  the Antigravity reviewer inside a **throwaway worktree**, grant it no
  secrets, and treat any writes it makes as discardable — only its
  findings/text are kept.
- ⚠️ **No `--output-format json`** → output must be parsed as text. Set
  `structuredOutput=false` ⇒ **Antigravity does NOT lead in the MVP** (a
  lead needs to return plan JSON). This trap is about task *execution*
  output, independent of the quota point below.
- Quota: **AI-Quota-Tray already reads Antigravity quota per model via the
  running IDE's local language-server `GetUserStatus` RPC** (process discovery,
  CSRF token, and `clientModelConfigs[].quotaInfo`; confirmed in AQT source on
  2026-07-18). Bremio's `packages/quota` consumes the resulting SQLite rows —
  don't re-implement it. If AQT's Antigravity source is ever
  unavailable at runtime, `@bremio/quota` returns an explicit unknown or
  unavailable capacity snapshot rather than guessing.
- Practical MVP roles: implementer (simple tasks), tester/UI-check.
  **Not lead** (blocked by the JSON-output trap above, not by quota).

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
