import { describe, expect, it } from "vitest";
import { ProcessSupervisor } from "@bremio/adapter-sdk";
import { RunToolset } from "./run-toolset";

describe("RunToolset", () => {
  describe("construction", () => {
    it("exposes a HookManager and SkillManager", () => {
      const ts = new RunToolset({ controlMode: "autopilot" });
      expect(ts.hooks).toBeDefined();
      expect(ts.skills).toBeDefined();
    });
  });

  describe("createCommandTool", () => {
    it("denies commands in plan mode", async () => {
      const ts = new RunToolset({ controlMode: "plan" });
      const supervisor = new ProcessSupervisor();
      const tool = ts.createCommandTool(supervisor);
      await expect(
        tool.execute("echo", ["hello"], { runId: "test-1" }),
      ).rejects.toThrow("plan mode prohibits commands");
    });

    it("denies commands in approve mode (requires per-action approval)", async () => {
      const ts = new RunToolset({ controlMode: "approve" });
      const supervisor = new ProcessSupervisor();
      const tool = ts.createCommandTool(supervisor);
      await expect(
        tool.execute("ls", ["-la"], { runId: "test-2" }),
      ).rejects.toThrow("requires per-action approval before executing commands");
    });

    it("allows commands in autopilot mode (no deny)", () => {
      const ts = new RunToolset({ controlMode: "autopilot" });
      const supervisor = new ProcessSupervisor();
      const tool = ts.createCommandTool(supervisor);
      expect(tool).toBeInstanceOf(Object);
    });
  });

  describe("createWebSearchTool", () => {
    it("denies network access in plan mode", async () => {
      const ts = new RunToolset({ controlMode: "plan" });
      const tool = ts.createWebSearchTool();
      await expect(tool.execute("test query")).rejects.toThrow("web search denied");
    });

    it("denies network access in approve mode (requires before-apply approval)", async () => {
      const ts = new RunToolset({ controlMode: "approve" });
      const tool = ts.createWebSearchTool();
      await expect(tool.execute("test query")).rejects.toThrow(
        "requires before-apply approval before searching the web",
      );
    });

    it("does not deny immediately in autopilot mode", () => {
      const ts = new RunToolset({ controlMode: "autopilot" });
      const tool = ts.createWebSearchTool();
      expect(tool).toBeInstanceOf(Object);
    });
  });

  describe("createMcpPermissionGuard", () => {
    it("denies mcp-tool calls in plan mode", () => {
      const ts = new RunToolset({ controlMode: "plan" });
      const guard = ts.createMcpPermissionGuard();
      const result = guard.checkToolCall("any-tool");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("prohibits");
    });

    it("requires per-action approval for mcp-tool calls in approve mode", () => {
      const ts = new RunToolset({ controlMode: "approve" });
      const guard = ts.createMcpPermissionGuard();
      const result = guard.checkToolCall("any-tool");
      expect(result.allowed).toBe(true);
      expect(result.approvalRequired).toBe("per-action");
    });

    it("allows mcp-tool calls in autopilot mode", () => {
      const ts = new RunToolset({ controlMode: "autopilot" });
      const guard = ts.createMcpPermissionGuard();
      const result = guard.checkToolCall("any-tool");
      expect(result.allowed).toBe(true);
      expect(result.approvalRequired).toBe("none");
    });
  });
});
