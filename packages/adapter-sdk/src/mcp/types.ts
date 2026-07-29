import type {
  Tool,
  ServerCapabilities,
  Resource,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types";
import type { McpServerManifest } from "./manifest";

export interface McpServerDiscovery {
  manifest: McpServerManifest;
  serverName: string;
  serverVersion: string;
  capabilities: ServerCapabilities;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export interface McpClientHandle {
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): { name: string; version: string } | undefined;
  listTools(): Promise<{ tools: Tool[] }>;
  listResources(): Promise<{ resources: Resource[] }>;
  listPrompts(): Promise<{ prompts: Prompt[] }>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<CallToolResult>;
  readResource(uri: string): Promise<ReadResourceResult>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<GetPromptResult>;
  close(): Promise<void>;
}
