import type { Tool } from "@modelcontextprotocol/sdk/types";

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  actionClass: "mcp-tool";
}

export interface McpResourceDescriptor {
  serverId: string;
  uri: string;
  name: string;
  actionClass: "read";
}

export function mapTool(tool: Tool, serverId: string): McpToolDescriptor {
  return {
    serverId,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    actionClass: "mcp-tool",
  };
}

export function mapTools(
  tools: Tool[],
  serverId: string,
): McpToolDescriptor[] {
  return tools.map((t) => mapTool(t, serverId));
}

export function mapResourceActionClass(): "read" {
  return "read";
}
