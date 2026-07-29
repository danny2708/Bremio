import { describe, it, expect, vi } from "vitest";
import { SkillManager } from "./manager";
import type { Skill } from "./types";

function mockSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    inputSchema: { type: "object" },
    execute: vi.fn().mockResolvedValue({ success: true, data: "ok", duration: 10 }),
    ...overrides,
  };
}

describe("SkillManager", () => {
  describe("register", () => {
    it("registers a skill in registered state", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      expect(sm.getState("test-skill")).toBe("registered");
    });

    it("returns this for chaining", () => {
      const sm = new SkillManager();
      const ret = sm.register(mockSkill());
      expect(ret).toBe(sm);
    });

    it("throws when registering a duplicate id", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      expect(() => sm.register(mockSkill())).toThrow("Skill already registered: test-skill");
    });

    it("accepts multiple skills with different ids", () => {
      const sm = new SkillManager();
      sm.register(mockSkill({ id: "a" }));
      sm.register(mockSkill({ id: "b" }));
      expect(sm.list()).toHaveLength(2);
    });
  });

  describe("enable", () => {
    it("transitions from registered to enabled", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      sm.enable("test-skill");
      expect(sm.getState("test-skill")).toBe("enabled");
    });

    it("is a no-op when already enabled", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      sm.enable("test-skill");
      sm.enable("test-skill");
      expect(sm.getState("test-skill")).toBe("enabled");
    });

    it("transitions from disabled to enabled", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      sm.enable("test-skill");
      sm.disable("test-skill");
      sm.enable("test-skill");
      expect(sm.getState("test-skill")).toBe("enabled");
    });

    it("transitions from error to enabled", async () => {
      const sm = new SkillManager();
      const skill = mockSkill({
        execute: vi.fn().mockRejectedValue(new Error("exec failed")),
      });
      sm.register(skill);
      sm.enable("test-skill");
      const result = await sm.execute("test-skill", {});
      expect(result.success).toBe(false);
      expect(sm.getState("test-skill")).toBe("error");
      sm.enable("test-skill");
      expect(sm.getState("test-skill")).toBe("enabled");
    });

    it("throws when enabling an unregistered skill", () => {
      const sm = new SkillManager();
      expect(() => sm.enable("unknown")).toThrow("Skill not registered: unknown");
    });
  });

  describe("disable", () => {
    it("transitions from enabled to disabled", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      sm.enable("test-skill");
      sm.disable("test-skill");
      expect(sm.getState("test-skill")).toBe("disabled");
    });

    it("is a no-op when already disabled", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      sm.enable("test-skill");
      sm.disable("test-skill");
      sm.disable("test-skill");
      expect(sm.getState("test-skill")).toBe("disabled");
    });

    it("transitions from error to disabled", async () => {
      const sm = new SkillManager();
      const skill = mockSkill({
        execute: vi.fn().mockRejectedValue(new Error("exec failed")),
      });
      sm.register(skill);
      sm.enable("test-skill");
      const result = await sm.execute("test-skill", {});
      expect(result.success).toBe(false);
      expect(sm.getState("test-skill")).toBe("error");
      sm.disable("test-skill");
      expect(sm.getState("test-skill")).toBe("disabled");
    });

    it("throws when disabling from registered state", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      expect(() => sm.disable("test-skill")).toThrow(
        'Cannot disable skill test-skill from state "registered"',
      );
    });
  });

  describe("execute", () => {
    it("executes an enabled skill and returns the result", async () => {
      const sm = new SkillManager();
      const skill = mockSkill();
      sm.register(skill);
      sm.enable("test-skill");
      const result = await sm.execute("test-skill", { query: "hello" });
      expect(result.success).toBe(true);
      expect(result.data).toBe("ok");
      expect(skill.execute).toHaveBeenCalledWith({ query: "hello" }, undefined);
    });

    it("passes context to the skill", async () => {
      const sm = new SkillManager();
      const skill = mockSkill();
      sm.register(skill);
      sm.enable("test-skill");
      const ctx = { runId: "run-1", signal: AbortSignal.timeout(5000) };
      await sm.execute("test-skill", {}, ctx);
      expect(skill.execute).toHaveBeenCalledWith({}, ctx);
    });

    it("throws when executing an unregistered skill", async () => {
      const sm = new SkillManager();
      await expect(sm.execute("unknown", {})).rejects.toThrow("Skill not registered: unknown");
    });

    it("throws when executing a non-enabled skill", async () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      // Skill is registered but not enabled
      await expect(sm.execute("test-skill", {})).rejects.toThrow(
        'Cannot execute skill test-skill: current state is "registered" (must be "enabled")',
      );
    });

    it("throws when executing a disabled skill", async () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      sm.enable("test-skill");
      sm.disable("test-skill");
      await expect(sm.execute("test-skill", {})).rejects.toThrow(
        'Cannot execute skill test-skill: current state is "disabled" (must be "enabled")',
      );
    });

    it("transitions to error state when skill execution throws, and returns a failed result", async () => {
      const sm = new SkillManager();
      const skill = mockSkill({
        execute: vi.fn().mockRejectedValue(new Error("something broke")),
      });
      sm.register(skill);
      sm.enable("test-skill");
      const result = await sm.execute("test-skill", {});
      expect(result.success).toBe(false);
      expect(result.error).toBe("something broke");
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(sm.getState("test-skill")).toBe("error");
      const reg = sm.list().find((r) => r.skill.id === "test-skill");
      expect(reg).toBeDefined();
      expect(reg!.error).toBe("something broke");
    });
  });

  describe("get", () => {
    it("returns the skill by id", () => {
      const sm = new SkillManager();
      const skill = mockSkill();
      sm.register(skill);
      expect(sm.get("test-skill")).toBe(skill);
    });

    it("returns undefined for unknown id", () => {
      const sm = new SkillManager();
      expect(sm.get("unknown")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all registrations", () => {
      const sm = new SkillManager();
      sm.register(mockSkill({ id: "a" }));
      sm.register(mockSkill({ id: "b" }));
      expect(sm.list()).toHaveLength(2);
    });

    it("returns a snapshot that cannot mutate internal state", () => {
      const sm = new SkillManager();
      sm.register(mockSkill({ id: "a" }));
      const list = sm.list();
      expect(list).toHaveLength(1);
      (list[0] as { state: string }).state = "enabled";
      expect(sm.getState("a")).toBe("registered");
    });
  });

  describe("getRegistry", () => {
    it("returns only enabled skills", () => {
      const sm = new SkillManager();
      sm.register(mockSkill({ id: "a" }));
      sm.register(mockSkill({ id: "b" }));
      sm.register(mockSkill({ id: "c" }));
      sm.enable("a");
      sm.enable("c");
      const reg = sm.getRegistry();
      expect(reg.has("a")).toBe(true);
      expect(reg.has("b")).toBe(false);
      expect(reg.has("c")).toBe(true);
      expect(reg.size).toBe(2);
    });

    it("returns skills that can be looked up by id", () => {
      const sm = new SkillManager();
      const skill = mockSkill({ id: "a" });
      sm.register(skill);
      sm.enable("a");
      const reg = sm.getRegistry();
      expect(reg.get("a")).toBe(skill);
    });
  });

  describe("getState", () => {
    it("returns the current state", () => {
      const sm = new SkillManager();
      sm.register(mockSkill());
      expect(sm.getState("test-skill")).toBe("registered");
      sm.enable("test-skill");
      expect(sm.getState("test-skill")).toBe("enabled");
    });

    it("returns undefined for unknown id", () => {
      const sm = new SkillManager();
      expect(sm.getState("unknown")).toBeUndefined();
    });
  });
});
