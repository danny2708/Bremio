import type { McpClientHandle } from "./types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpPermissionCheck {
  allowed: boolean;
  approvalRequired: "none" | "per-action" | "before-apply";
  reason: string;
}

/**
 * Gates MCP tool calls on a policy decision.
 *
 * `checkPermission` is required. It used to default to
 * `{ allowed: true, reason: "no policy check configured" }` — a security
 * control that permits everything when nobody wires it up, in a codebase where
 * every other gate fails closed. Requiring it makes the omission a compile
 * error instead of a silent allow.
 */
export class McpPermissionGuard {
  constructor(
    private readonly checkPermission: (
      actionClass: string,
      toolName: string,
    ) => McpPermissionCheck,
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
    // `approvalRequired` was carried in the result type, returned by the policy
    // binding, and never read — so in `approve` control mode, where
    // `evaluate("approve", "mcp-tool")` answers `allowed: true` with
    // `per-action`, the call went through with no approval ever requested.
    // The command and web-search gates already refuse this case; this one did
    // not. Obtaining the approval is the caller's job (S3); running the tool
    // before it exists is not an option.
    if (check.approvalRequired !== "none") {
      throw new Error(
        `MCP tool "${toolName}" requires ${check.approvalRequired} approval, which has not been granted`,
      );
    }
    return handle.callTool(toolName, args);
  }
}
