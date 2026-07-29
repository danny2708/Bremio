export interface McpStdioConfig {
  type: "stdio";
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
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
