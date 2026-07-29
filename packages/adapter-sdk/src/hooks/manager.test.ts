import { describe, it, expect, vi } from "vitest";
import { HookManager } from "./manager";
import type { HookHandler, HookHandlerResult, HookRegistration } from "./types";

function mockHandler(overrides?: Partial<HookHandler>): HookHandler {
  return vi.fn().mockResolvedValue({ allow: true }) as unknown as HookHandler;
}

function makeRegistration(overrides: Partial<HookRegistration> = {}): HookRegistration {
  return {
    id: "test-hook",
    hookPoint: "skill:before-execute",
    handler: mockHandler(),
    ...overrides,
  };
}

describe("HookManager", () => {
  describe("register", () => {
    it("registers a hook", () => {
      const hm = new HookManager();
      const reg = makeRegistration();
      hm.register(reg);
      expect(hm.list()).toHaveLength(1);
    });

    it("returns this for chaining", () => {
      const hm = new HookManager();
      const ret = hm.register(makeRegistration());
      expect(ret).toBe(hm);
    });

    it("throws when registering a duplicate id", () => {
      const hm = new HookManager();
      hm.register(makeRegistration());
      expect(() => hm.register(makeRegistration())).toThrow(
        "Hook already registered: test-hook",
      );
    });

    it("stores a snapshot of the registration", () => {
      const hm = new HookManager();
      const reg = makeRegistration();
      hm.register(reg);
      reg.id = "mutated";
      const listed = hm.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe("test-hook");
    });
  });

  describe("unregister", () => {
    it("removes a registered hook", () => {
      const hm = new HookManager();
      hm.register(makeRegistration());
      hm.unregister("test-hook");
      expect(hm.list()).toHaveLength(0);
    });

    it("throws when unregistering an unknown id", () => {
      const hm = new HookManager();
      expect(() => hm.unregister("unknown")).toThrow("Hook not registered: unknown");
    });
  });

  describe("evaluate", () => {
    it("returns allowed=true when no hooks are registered for the point", async () => {
      const hm = new HookManager();
      const result = await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(result.allowed).toBe(true);
    });

    it("returns allowed=true when all handlers allow", async () => {
      const hm = new HookManager();
      hm.register(makeRegistration({ id: "a", handler: mockHandler() }));
      hm.register(makeRegistration({ id: "b", handler: mockHandler() }));
      const result = await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(result.allowed).toBe(true);
    });

    it("returns allowed=false when a handler denies", async () => {
      const hm = new HookManager();
      hm.register(
        makeRegistration({
          id: "denier",
          handler: vi
            .fn()
            .mockResolvedValue({ allow: false, reason: "not allowed" } as HookHandlerResult),
        }),
      );
      const result = await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("not allowed");
      expect(result.deniedBy).toBe("denier");
    });

    it("stops at the first denial (priority order)", async () => {
      const hm = new HookManager();
      const first = vi.fn().mockResolvedValue({ allow: false, reason: "first denies" });
      const second = vi.fn().mockResolvedValue({ allow: true });
      hm.register(makeRegistration({ id: "first", handler: first, priority: 1 }));
      hm.register(makeRegistration({ id: "second", handler: second, priority: 2 }));
      const result = await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(result.allowed).toBe(false);
      expect(result.deniedBy).toBe("first");
      expect(second).not.toHaveBeenCalled();
    });

    it("returns allowed=true and skips handlers for other hook points", async () => {
      const hm = new HookManager();
      hm.register(makeRegistration({ id: "other" }));
      const result = await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(result.allowed).toBe(true);
    });

    it("handles a handler that throws", async () => {
      const hm = new HookManager();
      hm.register(
        makeRegistration({
          id: "thrower",
          handler: vi.fn().mockRejectedValue(new Error("oops")),
        }),
      );
      const result = await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("oops");
      expect(result.deniedBy).toBe("thrower");
    });

    it("passes the context to the handler", async () => {
      const hm = new HookManager();
      const handler = vi.fn().mockResolvedValue({ allow: true });
      hm.register(makeRegistration({ id: "ctx-check", handler }));
      const ctx = { skillId: "my-skill", args: { query: "hello" }, runId: "run-1" };
      await hm.evaluate("skill:before-execute", ctx);
      expect(handler).toHaveBeenCalledWith(ctx);
    });

    it("runs handlers in priority order (lower first)", async () => {
      const hm = new HookManager();
      const order: number[] = [];
      hm.register(
        makeRegistration({
          id: "p10",
          priority: 10,
          handler: vi.fn().mockImplementation(async () => { order.push(10); return { allow: true }; }),
        }),
      );
      hm.register(
        makeRegistration({
          id: "p5",
          priority: 5,
          handler: vi.fn().mockImplementation(async () => { order.push(5); return { allow: true }; }),
        }),
      );
      hm.register(
        makeRegistration({
          id: "p1",
          priority: 1,
          handler: vi.fn().mockImplementation(async () => { order.push(1); return { allow: true }; }),
        }),
      );
      await hm.evaluate("skill:before-execute", { skillId: "test" });
      expect(order).toEqual([1, 5, 10]);
    });
  });

  describe("list", () => {
    it("returns all registered hooks", () => {
      const hm = new HookManager();
      hm.register(makeRegistration({ id: "a" }));
      hm.register(makeRegistration({ id: "b" }));
      expect(hm.list()).toHaveLength(2);
    });
  });

  describe("listForPoint", () => {
    it("returns hooks for a specific point", () => {
      const hm = new HookManager();
      hm.register(makeRegistration({ id: "a", hookPoint: "skill:before-execute" }));
      expect(hm.listForPoint("skill:before-execute")).toHaveLength(1);
    });

    it("returns only hooks matching the point", () => {
      const hm = new HookManager();
      hm.register(makeRegistration({ id: "a", hookPoint: "skill:before-execute" }));
      expect(hm.listForPoint("skill:before-execute")).toHaveLength(1);
    });
  });
});
