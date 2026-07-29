export type {
  McpStdioConfig,
  McpSseConfig,
  McpStreamableHttpConfig,
  McpTransportConfig,
  McpServerManifest,
} from "./manifest";

export type {
  McpClientHandle,
  McpServerDiscovery,
} from "./types";

export {
  McpDiscovery,
  type ConnectClientFn,
} from "./discovery";

export {
  createTransport,
  connectClient,
} from "./transport";

export {
  mapTool,
  mapTools,
  mapResourceActionClass,
  type McpToolDescriptor,
  type McpResourceDescriptor,
} from "./capability-mapping";
