import { describe, it, expect, vi } from "vitest";
import type { AgentRole } from "../capabilities";
import { PluginManager } from "./manager";
import type { AgentAdapter, AgentCapabilities, AdapterRuntimeCapabilities } from "../..";

function createMockAdapter(id: string): AgentAdapter {
  return {
    id,
    provider: id,
    healthCheck: vi.fn().mockResolvedValue({ status: "ok" as const }),
    getCapabilities: vi.fn().mockResolvedValue({
      planning: true,
      structuredOutput: true,
      repositoryRead: true,
      repositoryWrite: true,
      shell: false,
      testing: false,
      browser: false,
      vision: false,
      resumableSessions: false,
      readOnlyEnforcement: "unsupported" as const,
    } satisfies AgentCapabilities),
    getRuntimeCapabilities: vi.fn().mockResolvedValue({
      adapterId: id,
      transport: "cli" as const,
      approval: "none" as const,
      structuredToolEvents: false,
      contextMetrics: "none" as const,
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: false,
    } satisfies AdapterRuntimeCapabilities),
    listModels: vi.fn().mockResolvedValue([]),
    startRun: vi.fn().mockImplementation(async function* (): AsyncIterable<unknown> {}),
    resumeRun: vi.fn().mockImplementation(async function* (): AsyncIterable<unknown> {}),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PluginManager", () => {
  describe("register", () => {
    it("registers a plugin in registered state", () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "test",
          displayName: "Test",
          version: "1.0.0",
          adapterFactory: () => createMockAdapter("test"),
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
      });
      expect(mgr.getState("test")).toBe("registered");
    });

    it("throws when registering a duplicate id", () => {
      const mgr = new PluginManager();
      const descriptor = {
        manifest: {
          id: "dup",
          displayName: "Dup",
          version: "1.0.0",
          adapterFactory: () => createMockAdapter("dup"),
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
      };
      mgr.register(descriptor);
      expect(() => mgr.register(descriptor)).toThrow("already registered");
    });

    it("returns this for chaining", () => {
      const mgr = new PluginManager();
      const result = mgr.register({
        manifest: {
          id: "chain",
          displayName: "Chain",
          version: "1.0.0",
          adapterFactory: () => createMockAdapter("chain"),
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
      });
      expect(result).toBe(mgr);
    });
  });

  describe("activate", () => {
    it("transitions from registered to active and creates the adapter", async () => {
      const mgr = new PluginManager();
      const factory = vi.fn(() => createMockAdapter("my-adapter"));
      mgr.register({
        manifest: {
          id: "my-adapter",
          displayName: "My Adapter",
          version: "1.0.0",
          adapterFactory: factory,
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
      });
      await mgr.activate("my-adapter");
      expect(mgr.getState("my-adapter")).toBe("active");
      expect(factory).toHaveBeenCalledOnce();
    });

    it("calls onActivate hook before creating the adapter", async () => {
      const mgr = new PluginManager();
      const onActivate = vi.fn();
      mgr.register({
        manifest: {
          id: "hooks",
          displayName: "Hooks",
          version: "1.0.0",
          adapterFactory: () => createMockAdapter("hooks"),
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
        hooks: { onActivate },
      });
      await mgr.activate("hooks");
      expect(onActivate).toHaveBeenCalledOnce();
    });

    it("transitions to error when activation hook throws", async () => {
      const mgr = new PluginManager();
      const onError = vi.fn();
      mgr.register({
        manifest: {
          id: "fail-hook",
          displayName: "Fail Hook",
          version: "1.0.0",
          adapterFactory: () => createMockAdapter("fail-hook"),
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
        hooks: {
          onActivate: async () => { throw new Error("hook failed"); },
          onError,
        },
      });
      await expect(mgr.activate("fail-hook")).rejects.toThrow("hook failed");
      expect(mgr.getState("fail-hook")).toBe("error");
      expect(mgr.getAdapter("fail-hook")).toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
    });

    it("transitions to error when factory throws", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "fail-factory",
          displayName: "Fail Factory",
          version: "1.0.0",
          adapterFactory: () => { throw new Error("factory failed"); },
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
      });
      await expect(mgr.activate("fail-factory")).rejects.toThrow("factory failed");
      expect(mgr.getState("fail-factory")).toBe("error");
    });

    it("rejects from invalid states", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "t",
          displayName: "T",
          version: "1.0.0",
          adapterFactory: () => createMockAdapter("t"),
          supportedRoles: ["implementer"] as AgentRole[],
          configurationSchema: {},
        },
      });
      // Activate once
      await mgr.activate("t");
      expect(mgr.getState("t")).toBe("active");
      // Activate again is a no-op
      await mgr.activate("t");
      expect(mgr.getState("t")).toBe("active");
    });

    it("throws for unknown plugin", async () => {
      const mgr = new PluginManager();
      await expect(mgr.activate("nope")).rejects.toThrow("not registered");
    });
  });

  describe("activateAll", () => {
    it("activates all registered plugins", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "a", displayName: "A", version: "1.0.0",
          adapterFactory: () => createMockAdapter("a"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      mgr.register({
        manifest: {
          id: "b", displayName: "B", version: "1.0.0",
          adapterFactory: () => createMockAdapter("b"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      await mgr.activateAll();
      expect(mgr.getState("a")).toBe("active");
      expect(mgr.getState("b")).toBe("active");
    });

    it("collects errors when some plugins fail activation", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "good", displayName: "Good", version: "1.0.0",
          adapterFactory: () => createMockAdapter("good"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      mgr.register({
        manifest: {
          id: "bad", displayName: "Bad", version: "1.0.0",
          adapterFactory: () => { throw new Error("bad"); },
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      await expect(mgr.activateAll()).rejects.toThrow("Failed to activate");
      expect(mgr.getState("good")).toBe("active");
      expect(mgr.getState("bad")).toBe("error");
    });
  });

  describe("deactivate", () => {
    it("transitions from active to inactive and removes the adapter", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "d", displayName: "D", version: "1.0.0",
          adapterFactory: () => createMockAdapter("d"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      await mgr.activate("d");
      expect(mgr.getAdapter("d")).toBeDefined();
      await mgr.deactivate("d");
      expect(mgr.getState("d")).toBe("inactive");
      expect(mgr.getAdapter("d")).toBeUndefined();
    });

    it("calls onDeactivate hook", async () => {
      const mgr = new PluginManager();
      const onDeactivate = vi.fn();
      mgr.register({
        manifest: {
          id: "hook-d", displayName: "Hook D", version: "1.0.0",
          adapterFactory: () => createMockAdapter("hook-d"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
        hooks: { onDeactivate },
      });
      await mgr.activate("hook-d");
      await mgr.deactivate("hook-d");
      expect(onDeactivate).toHaveBeenCalledOnce();
    });

    it("is idempotent when already inactive", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "idem", displayName: "Idem", version: "1.0.0",
          adapterFactory: () => createMockAdapter("idem"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      await mgr.activate("idem");
      await mgr.deactivate("idem");
      await mgr.deactivate("idem");
      expect(mgr.getState("idem")).toBe("inactive");
    });
  });

  describe("deactivateAll", () => {
    it("deactivates all active plugins", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "x", displayName: "X", version: "1.0.0",
          adapterFactory: () => createMockAdapter("x"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      mgr.register({
        manifest: {
          id: "y", displayName: "Y", version: "1.0.0",
          adapterFactory: () => createMockAdapter("y"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      await mgr.activateAll();
      await mgr.deactivateAll();
      expect(mgr.getState("x")).toBe("inactive");
      expect(mgr.getState("y")).toBe("inactive");
    });
  });

  describe("getAdapter", () => {
    it("returns undefined for unregistered plugin", () => {
      const mgr = new PluginManager();
      expect(mgr.getAdapter("nope")).toBeUndefined();
    });

    it("returns undefined before activation", () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "pre", displayName: "Pre", version: "1.0.0",
          adapterFactory: () => createMockAdapter("pre"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      expect(mgr.getAdapter("pre")).toBeUndefined();
    });
  });

  describe("getRegistry", () => {
    it("returns only active adapters", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "a1", displayName: "A1", version: "1.0.0",
          adapterFactory: () => createMockAdapter("a1"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      mgr.register({
        manifest: {
          id: "a2", displayName: "A2", version: "1.0.0",
          adapterFactory: () => createMockAdapter("a2"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      await mgr.activate("a1");
      const registry = mgr.getRegistry();
      expect(registry.has("a1")).toBe(true);
      expect(registry.has("a2")).toBe(false);
      expect(registry.size).toBe(1);
    });
  });

  describe("list", () => {
    it("returns all registered plugins with their state", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "l1", displayName: "L1", version: "1.0.0",
          adapterFactory: () => createMockAdapter("l1"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      mgr.register({
        manifest: {
          id: "l2", displayName: "L2", version: "1.0.0",
          adapterFactory: () => createMockAdapter("l2"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      const list = mgr.list();
      expect(list).toHaveLength(2);
      expect(list.every((p) => p.state === "registered")).toBe(true);
    });

    it("returns copies, not live references", async () => {
      const mgr = new PluginManager();
      mgr.register({
        manifest: {
          id: "copy", displayName: "Copy", version: "1.0.0",
          adapterFactory: () => createMockAdapter("copy"),
          supportedRoles: ["implementer"] as AgentRole[], configurationSchema: {},
        },
      });
      const list1 = mgr.list();
      await mgr.activate("copy");
      const list2 = mgr.list();
      expect(list1[0]?.state).toBe("registered");
      expect(list2[0]?.state).toBe("active");
    });
  });

  describe("getState", () => {
    it("returns undefined for unknown plugin", () => {
      const mgr = new PluginManager();
      expect(mgr.getState("unknown")).toBeUndefined();
    });
  });
});
