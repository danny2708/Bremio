export interface McpStdioConfig {
  type: "stdio";
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  /**
   * Names of variables to inherit from the environment that starts the
   * server (P3-T5). Names, not values, so a secret never has to be written
   * into a config value or a provider's argv. Codex forwards only a fixed
   * allow-list plus `env_vars`, so without this a codex-started server would
   * not see e.g. its API key.
   */
  envPassthrough?: readonly string[];
  cwd?: string;
}

export interface McpSseConfig {
  type: "sse";
  url: string;
}

export interface McpStreamableHttpConfig {
  type: "streamable-http";
  url: string;
}

export type McpTransportConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpStreamableHttpConfig;

export interface McpServerManifest {
  id: string;
  name: string;
  description?: string;
  transport: McpTransportConfig;
}
