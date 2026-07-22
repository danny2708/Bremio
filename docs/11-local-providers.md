# 11 — Local providers (the plug-and-play seam)

Bremio ships four cloud/CLI adapters. This document describes the **frame** for
adding a *local* model — Jan, Ollama, LM Studio, `llama.cpp`'s server, vLLM —
without writing an adapter from scratch. It is scaffolding, not a shipped
provider: nothing here is registered in the CLI, daemon, or router, so it costs
nothing until you deliberately wire it in.

Jan was dropped as a *specific* provider (`docs/04`, no measured net-gain case
for maintaining a bespoke local path). This is the *general* replacement: when a
local model is worth integrating, it should be a few lines, not a new package.

## Why one adapter covers them all

Almost every local server exposes the **OpenAI-compatible** HTTP API —
`POST /v1/chat/completions` (streaming via SSE) and `GET /v1/models`. So a single
adapter, `LocalOpenAiAdapter` in `@bremio/adapter-local`, speaks to all of them;
a specific provider is just a `LocalProviderConfig` (a base URL, an optional
model, a capability posture).

| Provider | Default base URL | Preset |
|---|---|---|
| Jan | `http://localhost:1337/v1` | `LOCAL_PROVIDER_PRESETS.jan` |
| Ollama | `http://localhost:11434/v1` | `LOCAL_PROVIDER_PRESETS.ollama` |
| LM Studio | `http://localhost:1234/v1` | `LOCAL_PROVIDER_PRESETS.lmstudio` |
| anything else | your URL | `defineLocalProvider({ … })` |

Each preset carries a `baseUrlEnvVar` (`BREMIO_JAN_BASE_URL`, …) so the same
config points at a different host without a code change. `model` is left empty on
purpose: the adapter asks `/models` and uses the first one loaded, which is what
makes a fresh Ollama or LM Studio work without the caller knowing the model name.

## What the adapter does, and what it deliberately does not

Done, reusable, tested (`local-adapter.test.ts`, over a real OpenAI-format SSE
server): streaming `chat/completions` → normalized `AgentEvent`s, one terminal
`completed`, token-usage passthrough, `healthCheck` (unavailable / degraded /
ok), `listModels`, model auto-discovery, and cooperative cancellation that
reports `cancelled` (never a false `completed`).

**Capabilities default to all-`false`.** A bare chat endpoint owns no tools — it
cannot read a repo, write files, or run a shell — so out of the box the router
hands it nothing and it can never be given work it would silently fail. That is
the safe default, not a limitation to work around: a text model is a text model.

This is the honest seam. To make a local model a real Bremio *worker* you supply
what a chat endpoint lacks, then declare it:

- **Text-only advisory use** (summaries, explanations, draft review prose): keep
  the capabilities off and drive the adapter directly; it is not routed as a
  task worker.
- **Real implementation/test work**: wrap the model in an agentic harness that
  grants file and shell tools (the adapter's transport is unchanged), then turn
  on `repositoryWrite` / `shell` / `testing` in the config's `capabilities`.
- **Structured output**: only set `structuredOutput: true` if your integration
  actually validates the result against the schema and fails otherwise — the
  same bar `docs/10` §6c holds every adapter to.

## Plug it in (three steps)

1. **Describe it.** Pick a preset or write `defineLocalProvider({ id, baseUrl,
   model?, capabilities? })`. Turn on only the capabilities your setup truly
   provides.
2. **Construct it.** `new LocalOpenAiAdapter(config)` — a standard `AgentAdapter`.
3. **Register it** where the other adapters are listed (`apps/cli/src/index.ts`,
   `apps/daemon/src/server.ts`, `apps/cli/src/tui/data.ts`), exactly as a cloud
   adapter is registered. The router picks it up through the capability contract;
   no core code learns its name.

```ts
import { LocalOpenAiAdapter, LOCAL_PROVIDER_PRESETS, defineLocalProvider } from "@bremio/adapter-local";

// A preset, as an advisory text worker (no tools, nothing routed to it):
const jan = new LocalOpenAiAdapter(LOCAL_PROVIDER_PRESETS.jan);

// A custom local model behind an agentic harness that can edit and run tests:
const local = new LocalOpenAiAdapter(defineLocalProvider({
  id: "workstation",
  baseUrl: "http://localhost:8080/v1",
  model: "qwen3-coder",
  capabilities: { repositoryRead: true, repositoryWrite: true, shell: true, testing: true },
}));
```

## Not done here (on purpose)

- No registration in any shipped surface — wiring is step 3, a deliberate act.
- No quota integration: local runs cost no subscription quota, so
  `@bremio/quota` reports them `unknown`, which the router already treats as a
  soft signal, never a hard exclusion.
- No agentic harness: turning a chat model into a tool-using worker is the
  integration's job, and the capability flags are where that intent is declared.
