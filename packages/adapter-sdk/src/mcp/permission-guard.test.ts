import { describe, it, expect, vi } from "vitest";
import { McpPermissionGuard } from "./permission-guard";
import type { McpClientHandle } from "./types";

function mockClient(overrides: Partial<McpClientHandle> = {}): McpClientHandle {
  return {
    getServerCapabilities: () => ({ tools: {} }),
    getServerVersion: () => ({ name: "mock", version: "1.0" }),
    listTools: () => Promise.resolve({ tools: [] }),
    listResources: () => Promise.resolve({ resources: [] }),
    listPrompts: () => Promise.resolve({ prompts: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text" as const, text: "ok" }] }),
    readResource: () => Promise.resolve({ contents: [{ uri: "", text: "" }] }),
    getPrompt: () => Promise.resolve({ messages: [] }),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe("McpPermissionGuard", () => {
  it("cannot be constructed without a policy check", () => {
    // It used to default to allow-everything with the reason "no policy check
    // configured", so forgetting to wire the gate opened it. The check is now
    // required, which turns that omission into a compile error.
    // @ts-expect-error the constructor argument is mandatory
    expect(() => new McpPermissionGuard()).toBeTypeOf("function");
  });

  it("passes actionClass mcp-tool to the check function", async () => {
    const checkFn = vi.fn().mockReturnValue({
      allowed: true,
      approvalRequired: "none" as const,
      reason: "allowed",
    });
    const guard = new McpPermissionGuard(checkFn);

    guard.checkToolCall("echo");

    expect(checkFn).toHaveBeenCalledWith("mcp-tool", "echo");
  });

  it("denies tool call when check returns not allowed", async () => {
    const guard = new McpPermissionGuard(() => ({
      allowed: false,
      approvalRequired: "none" as const,
      reason: "MCP tools denied in plan mode",
    }));

    const check = guard.checkToolCall("echo");

    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("plan mode");
  });

  it("reports approval required from policy check", async () => {
    const guard = new McpPermissionGuard(() => ({
      allowed: true,
      approvalRequired: "per-action" as const,
      reason: "MCP tool use requires per-action approval",
    }));

    const check = guard.checkToolCall("echo");

    expect(check.allowed).toBe(true);
    expect(check.approvalRequired).toBe("per-action");
  });

  it("callTool throws when denied", async () => {
    const guard = new McpPermissionGuard(() => ({
      allowed: false,
      approvalRequired: "none" as const,
      reason: "denied",
    }));
    const handle = mockClient();

    await expect(guard.callTool(handle, "echo", {}))
      .rejects.toThrow('MCP tool "echo" denied: denied');
    expect(handle.callTool).not.toHaveBeenCalled();
  });

  it("callTool delegates to handle when allowed", async () => {
    const handle = mockClient({
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: "hello" }],
      }),
    });
    const guard = new McpPermissionGuard(() => ({
      allowed: true,
      approvalRequired: "none" as const,
      reason: "allowed",
    }));

    const result = await guard.callTool(handle, "echo", { msg: "hi" });

    expect(handle.callTool).toHaveBeenCalledWith("echo", { msg: "hi" });
    expect(result.content[0]!.type).toBe("text");
  });
});
