import type { McpClientHandle } from "./types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";

export interface McpPermissionCheck {
  allowed: boolean;
  approvalRequired: "none" | "per-action" | "before-apply";
  reason: string;
}

export class McpPermissionGuard {
  constructor(
    private readonly checkPermission: (
      actionClass: string,
      toolName: string,
    ) => McpPermissionCheck = () => ({
      allowed: true,
      approvalRequired: "none",
      reason: "no policy check configured",
    }),
  ) {}

  checkToolCall(toolName: string): McpPermissionCheck {
    return this.checkPermission("mcp-tool", toolName);
  }

  async callTool(
    handle: McpClientHandle,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const check = this.checkToolCall(toolName);
    if (!check.allowed) {
      throw new Error(
        `MCP tool "${toolName}" denied: ${check.reason}`,
      );
    }
    return handle.callTool(toolName, args);
  }
}
