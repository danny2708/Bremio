import type { AgentCapabilities } from "@bremio/adapter-sdk";

/**
 * A local, self-hosted model server that speaks the OpenAI-compatible
 * `/v1/chat/completions` API — Jan, Ollama, LM Studio, llama.cpp's server,
 * vLLM, and most others expose exactly this. Describing one is all it takes to
 * get an adapter; see `LocalOpenAiAdapter` and `docs/11-local-providers.md`.
 */
export interface LocalProviderConfig {
  /** Stable adapter id, e.g. "jan" or "ollama". */
  id: string;
  /** Human-facing name for pickers and logs. Defaults to `id` where shown. */
  displayName?: string;
  /**
   * OpenAI-compatible base URL, version segment included
   * (e.g. `http://localhost:1337/v1`). A trailing slash is tolerated.
   */
  baseUrl: string;
  /**
   * Default model id. May be left empty: the adapter then asks the server's
   * `/models` and uses the first one loaded, which is what makes a fresh Ollama
   * or LM Studio "just work" without the caller knowing the model name.
   */
  model?: string;
  /**
   * Env var that overrides `baseUrl` at runtime, so the same preset points at a
   * different host without a code change (e.g. `BREMIO_JAN_BASE_URL`).
   */
  baseUrlEnvVar?: string;
  /**
   * Env var holding a bearer token, for the rare local server that wants one.
   * Most need no auth; omit it then.
   */
  apiKeyEnvVar?: string;
  /**
   * Capability posture. The default (see `CONSERVATIVE_CAPABILITIES`) is
   * everything `false` on purpose: a bare chat endpoint cannot read a repo,
   * write files, or run a shell, so out of the box the router hands it nothing —
   * it can never be given work it would silently fail. Turn on only what your
   * integration genuinely provides: wrap the model in an agentic harness that
   * grants file/shell tools before claiming `repositoryWrite`/`shell`, and only
   * claim `structuredOutput` if you actually validate the output against the
   * schema. This is the one field that decides what the model is allowed to do.
   */
  capabilities?: Partial<AgentCapabilities>;
  /** Path probed by `healthCheck`, relative to `baseUrl`. Default `/models`. */
  healthPath?: string;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

/**
 * The safe default: a text-only chat model that owns no tools. Nothing routable
 * is enabled, so an unconfigured local provider is inert rather than dangerous.
 */
export const CONSERVATIVE_CAPABILITIES: AgentCapabilities = {
  planning: false,
  structuredOutput: false,
  repositoryRead: false,
  repositoryWrite: false,
  shell: false,
  testing: false,
  browser: false,
  vision: false,
  resumableSessions: false,
};

/**
 * Identity today; the seam where future validation/normalization of a config
 * would live, so callers can write `defineLocalProvider({ ... })` now and get
 * that for free later.
 */
export function defineLocalProvider(config: LocalProviderConfig): LocalProviderConfig {
  return config;
}

/**
 * Ready-made configs for the common local servers, at their default ports.
 * These are data, not registrations — nothing here is wired into the CLI,
 * daemon, or router. Wiring one in is the deliberate "plug" step documented in
 * `docs/11-local-providers.md`; until then they cost nothing and change no
 * behaviour. `model` is intentionally empty so the adapter discovers whatever
 * the server has loaded.
 */
export const LOCAL_PROVIDER_PRESETS = {
  jan: defineLocalProvider({
    id: "jan",
    displayName: "Jan",
    baseUrl: "http://localhost:1337/v1",
    baseUrlEnvVar: "BREMIO_JAN_BASE_URL",
  }),
  ollama: defineLocalProvider({
    id: "ollama",
    displayName: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    baseUrlEnvVar: "BREMIO_OLLAMA_BASE_URL",
  }),
  lmstudio: defineLocalProvider({
    id: "lmstudio",
    displayName: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    baseUrlEnvVar: "BREMIO_LMSTUDIO_BASE_URL",
  }),
} as const;
