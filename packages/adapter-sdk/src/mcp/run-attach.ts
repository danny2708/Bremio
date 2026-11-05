import type { AgentRunRequest } from "../types";
import type { McpServerManifest, McpTransportConfig } from "./manifest";
import type { McpPermissionCheck } from "./permission-guard";

/**
 * Server ids become config keys in provider CLIs (Codex `-c mcp_servers.<id>`
 * is split on dots; Claude names tools `mcp__<id>__<tool>`). Restricting the
 * id to a bare-key alphabet keeps one manifest entry from addressing another
 * provider config path.
 */
const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidMcpServerId(id: string): boolean {
  return SERVER_ID.test(id);
}

/**
 * The MCP servers an adapter may attach for this request.
 *
 * Read-only requests get none: an MCP tool's side effects are unknown to
 * Bremio, and the provider sandbox that makes a reviewer read-only does not
 * cover a server process the provider spawns. Fail closed rather than let a
 * read-only task reach a server that can write.
 */
export function attachableMcpServers(req: AgentRunRequest): McpServerManifest[] {
  if (req.permission !== "workspace-write") return [];
  return [...(req.mcpServers ?? [])].filter((s) => isValidMcpServerId(s.id));
}

/**
 * Per-call MCP decision. A request without a gate denies: the gate is how the
 * run's control mode reaches the adapter, and a missing gate must not mean
 * "allowed" (same rule as `McpPermissionGuard`'s required constructor arg).
 */
export function checkMcpToolCall(req: AgentRunRequest, toolName: string): McpPermissionCheck {
  if (!req.mcpToolGate) {
    return {
      allowed: false,
      approvalRequired: "none",
      reason: "no MCP policy gate was supplied for this run",
    };
  }
  return req.mcpToolGate(toolName);
}

/** True when the check lets the call run now (allowed, no outstanding approval). */
export function mcpCheckPermitsNow(check: McpPermissionCheck): boolean {
  return check.allowed && check.approvalRequired === "none";
}

/** Human-readable denial for an MCP check that does not permit the call now. */
export function describeMcpDenial(toolName: string, check: McpPermissionCheck): string {
  if (!check.allowed) return `MCP tool "${toolName}" denied: ${check.reason}`;
  return `MCP tool "${toolName}" requires ${check.approvalRequired} approval, which has not been granted`;
}

export type McpTransportType = McpTransportConfig["type"];
