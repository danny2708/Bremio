import { describe, expect, it } from "vitest";
import { extractJsonObject, parsePlan } from "./lead-manager";
import type { CollectedRun } from "./stream";

function run(finalText?: string, structured?: unknown): CollectedRun {
  return {
    outcome: {
      status: "completed",
      ...(finalText ? { finalText } : {}),
      ...(structured !== undefined ? { structured } : {}),
    },
    assistantText: finalText ?? "",
    commands: [],
  };
}

const validPlanObject = {
  summary: "Add a greeting",
  leadAgentId: "codex",
  tasks: [
    { id: "TASK-001", title: "implement greeting", kind: "implementation", risk: "low" },
  ],
};

describe("extractJsonObject", () => {
  it("extracts a fenced JSON object with surrounding prose", () => {
    const text = 'Here is the plan:\n```json\n{"a":1,"b":{"c":2}}\n```\nDone.';
    expect(extractJsonObject(text)).toEqual({ a: 1, b: { c: 2 } });
  });

  it("handles braces inside strings", () => {
    const text = '{"msg":"a } b","n":3}';
    expect(extractJsonObject(text)).toEqual({ msg: "a } b", n: 3 });
  });

  it("returns undefined when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
  });
});

describe("parsePlan", () => {
  it("parses a plan from final text", () => {
    const result = parsePlan(run(JSON.stringify(validPlanObject)), "codex");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.tasks[0]?.id).toBe("TASK-001");
  });

  it("prefers native structured output when present", () => {
    const result = parsePlan(run("garbage text", validPlanObject), "codex");
    expect(result.ok).toBe(true);
  });

  it("injects the lead id when the model omits leadAgentId", () => {
    const { leadAgentId, ...withoutLead } = validPlanObject;
    void leadAgentId;
    const result = parsePlan(run(JSON.stringify(withoutLead)), "claude");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.leadAgentId).toBe("claude");
  });

  it("reports an error for an unparseable plan", () => {
    const result = parsePlan(run("definitely not a plan"), "codex");
    expect(result.ok).toBe(false);
  });
});
