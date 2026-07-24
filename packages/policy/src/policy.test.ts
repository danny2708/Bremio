import { describe, expect, it } from "vitest";
import { evaluate } from "./policy";
import type { ActionClass, ControlMode } from "./policy";

const ALL_CONTROL_MODES: ControlMode[] = ["plan", "approve", "autopilot"];

const ALL_ACTIONS: ActionClass[] = [
  "read",
  "write",
  "create",
  "delete",
  "command",
  "network",
  "mcp-tool",
  "git-destructive",
  "outside-workspace",
  "user-config",
];

describe("ControlMode × ActionClass matrix", () => {
  // ── plan: only read is allowed ────────────────────────────────────────
  it.each(ALL_ACTIONS.filter((a) => a !== "read"))(
    "plan mode denies %s",
    (action) => {
      const result = evaluate("plan", action);
      expect(result.allowed, result.reason).toBe(false);
      expect(result.approvalRequired).toBe("none");
    },
  );

  // Red-check guard: if the plan→read rule is set to denied, this test
  // must fail, proving the matrix actually allows reads in plan mode.
  // Red-check: temporarily flip to false to verify the test can catch a regression.
  it("plan mode allows read", () => {
    const result = evaluate("plan", "read");
    expect(result.allowed, result.reason).toBe(true);
    expect(result.approvalRequired).toBe("none");
  });

  // ── approve: everything is allowed but requires approval ──────────────
  it("approve mode allows read without approval", () => {
    const result = evaluate("approve", "read");
    expect(result.allowed, result.reason).toBe(true);
    expect(result.approvalRequired).toBe("none");
  });

  it.each(["write", "create", "network"] as ActionClass[])(
    "approve mode allows %s with before-apply approval",
    (action) => {
      const result = evaluate("approve", action);
      expect(result.allowed, result.reason).toBe(true);
      expect(result.approvalRequired).toBe("before-apply");
    },
  );

  it.each(["delete", "command", "mcp-tool", "git-destructive", "outside-workspace", "user-config"] as ActionClass[])(
    "approve mode allows %s with per-action approval",
    (action) => {
      const result = evaluate("approve", action);
      expect(result.allowed, result.reason).toBe(true);
      expect(result.approvalRequired).toBe("per-action");
    },
  );

  // ── autopilot: everything allowed, no approval ────────────────────────
  it.each(ALL_ACTIONS)("autopilot mode allows %s", (action) => {
    const result = evaluate("autopilot", action);
    expect(result.allowed, result.reason).toBe(true);
    expect(result.approvalRequired).toBe("none");
  });

  // ── every cell is reachable (no gaps in the matrix) ──────────────────
  it("every ControlMode × ActionClass cell returns a result", () => {
    for (const mode of ALL_CONTROL_MODES) {
      for (const action of ALL_ACTIONS) {
        const result = evaluate(mode, action);
        expect(typeof result.allowed).toBe("boolean");
        expect(typeof result.reason).toBe("string");
      }
    }
  });
});
