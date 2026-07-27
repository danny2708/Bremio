import { describe, expect, it } from "vitest";
import {
  canBackControlMode,
  collaborationToExecution,
  displayLabel,
  evaluate,
  executionToCollaboration,
  validateCombination,
} from "./policy";
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

  // ── autopilot: safe actions allowed, dangerous actions denied but overrideable ──
  it.each(["read", "write", "create", "delete", "command", "network", "mcp-tool"] as ActionClass[])(
    "autopilot mode allows %s without approval",
    (action) => {
      const result = evaluate("autopilot", action);
      expect(result.allowed, result.reason).toBe(true);
      expect(result.approvalRequired).toBe("none");
    },
  );

  it.each(["git-destructive", "outside-workspace", "user-config"] as ActionClass[])(
    "autopilot mode denies %s",
    (action) => {
      const result = evaluate("autopilot", action);
      expect(result.allowed, result.reason).toBe(false);
    },
  );

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

describe("validateCombination (docs/15 §2.3)", () => {
  it("allows solo + direct-workspace for plan and autopilot", () => {
    expect(validateCombination("solo", "plan", "direct-workspace")).toEqual({ valid: true, granularity: "none" });
    expect(validateCombination("solo", "autopilot", "direct-workspace")).toEqual({ valid: true, granularity: "none" });
  });

  it("allows solo + isolated-worktree for all control modes", () => {
    expect(validateCombination("solo", "plan", "isolated-worktree")).toEqual({ valid: true, granularity: "none" });
    expect(validateCombination("solo", "approve", "isolated-worktree")).toEqual({ valid: true, granularity: "before-apply" });
    expect(validateCombination("solo", "autopilot", "isolated-worktree")).toEqual({ valid: true, granularity: "none" });
  });

  it("rejects colab + direct-workspace", () => {
    const res = validateCombination("colab", "autopilot", "direct-workspace");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Co-lab mode requires isolated-worktree");
  });

  it("allows colab + isolated-worktree", () => {
    expect(validateCombination("colab", "autopilot", "isolated-worktree")).toEqual({ valid: true, granularity: "none" });
  });

  it("rejects solo + approve + direct-workspace without per-action seam", () => {
    const res = validateCombination("solo", "approve", "direct-workspace", "none");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Approve control mode requires isolated-worktree");
  });

  it("allows solo + approve + direct-workspace when transport has per-action seam", () => {
    const res = validateCombination("solo", "approve", "direct-workspace", "per-action");
    expect(res.valid).toBe(true);
    expect(res.granularity).toBe("per-action");
  });
});

describe("canBackControlMode (docs/15 §2.2)", () => {
  // The rule this pins used to live only in a doc comment on
  // ReadOnlyEnforcement — comment-only enforcement, which is exactly what the
  // rule forbids. Nothing could fail when it was violated.

  it.each(["hard-sandbox", "provider-native", "worktree-contained"] as const)(
    "lets %s back plan mode",
    (enforcement) => {
      expect(canBackControlMode("plan", enforcement, "direct-workspace").ok).toBe(true);
    },
  );

  it.each(["advisory", "unsupported"] as const)(
    "refuses to let %s back plan mode",
    (enforcement) => {
      const res = canBackControlMode("plan", enforcement, "direct-workspace");
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.reason).toContain(enforcement);
    },
  );

  it("refuses an unenforced adapter for plan even in an isolated worktree", () => {
    // A worktree contains the write, but plan mode promises the write never
    // happened. Containment is not the same guarantee.
    expect(canBackControlMode("plan", "unsupported", "isolated-worktree").ok).toBe(false);
  });

  it("accepts an unenforced adapter for approve when isolated, since the worktree is the backing", () => {
    expect(canBackControlMode("approve", "unsupported", "isolated-worktree").ok).toBe(true);
  });

  it("refuses an unenforced adapter for approve in the user's own workspace", () => {
    const res = canBackControlMode("approve", "advisory", "direct-workspace");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toContain("isolated worktree");
  });

  it("constrains nothing in autopilot, which makes no read-only promise", () => {
    expect(canBackControlMode("autopilot", "unsupported", "direct-workspace").ok).toBe(true);
  });

  it("covers the local adapter, the one that ships reporting no enforcement", () => {
    // adapter-local declares readOnlyEnforcement: "unsupported". It is
    // unregistered today, so this is a trap set for whoever registers it.
    expect(canBackControlMode("plan", "unsupported", "direct-workspace").ok).toBe(false);
  });
});

describe("Solo/Co-lab codec (docs/15 §2.1)", () => {
  it("converts single → solo", () => {
    expect(executionToCollaboration("single")).toBe("solo");
  });

  it("converts team → colab", () => {
    expect(executionToCollaboration("team")).toBe("colab");
  });

  it("converts solo → single", () => {
    expect(collaborationToExecution("solo")).toBe("single");
  });

  it("converts colab → team", () => {
    expect(collaborationToExecution("colab")).toBe("team");
  });

  it("round-trips through both codecs", () => {
    for (const mode of ["single", "team"] as const) {
      expect(collaborationToExecution(executionToCollaboration(mode))).toBe(mode);
    }
  });

  it("displayLabel returns Solo for solo", () => {
    expect(displayLabel("solo")).toBe("Solo");
  });

  it("displayLabel returns Co-lab for colab", () => {
    expect(displayLabel("colab")).toBe("Co-lab");
  });
});
