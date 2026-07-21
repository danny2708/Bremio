import { describe, expect, it } from "vitest";
import type { Plan, Task } from "@bremio/protocol";
import { buildTaskPrompt, planJsonSchema } from "./plan-schema";
import { ReviewOutputSchema } from "./quality-gate";

// Codex `--output-schema` enforces OpenAI strict structured output. A regression
// here (e.g. a missing additionalProperties:false) makes the real lead 400 and
// fail, which unit-testing the orchestrator otherwise wouldn't catch.
describe("planJsonSchema is strict-structured-output compliant", () => {
  const properties = planJsonSchema.properties as {
    tasks: {
      minItems?: unknown;
      items?: {
        additionalProperties?: unknown;
        required?: string[];
        properties?: Record<string, unknown>;
        minItems?: unknown;
      };
    };
  };
  const tasks = properties.tasks;
  const item = tasks.items ?? {};

  it("sets additionalProperties:false at every object level", () => {
    expect(planJsonSchema.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
  });

  it("lists every task property in required", () => {
    const keys = Object.keys(item.properties ?? {}).sort();
    expect([...(item.required ?? [])].sort()).toEqual(keys);
  });

  it("omits array-size keywords unsupported by strict mode", () => {
    expect(tasks.minItems).toBeUndefined();
    expect(item.minItems).toBeUndefined();
  });
});

describe("buildTaskPrompt review output matches parseReviewOutput contract", () => {
  const plan: Plan = {
    summary: "test summary",
    leadAgentId: "opencode",
    tasks: [
      {
        id: "TASK-001",
        title: "review the changes",
        kind: "review",
        risk: "low",
        requiredCapabilities: ["repository.read", "review"],
        preferredAgents: [],
        dependencies: [],
        acceptanceCriteria: ["all changes are reviewed"],
      },
    ],
  };
  const task: Task = plan.tasks[0]!;

  const prompt = buildTaskPrompt(plan, task);

  it("instructs the model to return a JSON object", () => {
    expect(prompt).toContain("Return your review as a JSON object");
  });

  it("describes the summary field", () => {
    expect(prompt).toContain("summary");
    expect(prompt).toContain("assessment");
  });

  it("describes the findings array", () => {
    expect(prompt).toContain("findings");
  });

  it("lists valid severity values", () => {
    expect(prompt).toContain("severity");
    expect(prompt).toContain("info");
    expect(prompt).toContain("warning");
    expect(prompt).toContain("blocker");
  });

  it("lists valid status values", () => {
    expect(prompt).toContain("status");
    expect(prompt).toContain("open");
    expect(prompt).toContain("fixed");
  });

  it("describes the message field", () => {
    expect(prompt).toContain("message");
    expect(prompt).toContain("description");
  });

  it("suggests a ```json code block wrapper", () => {
    expect(prompt).toContain("```json");
  });

  it("review output shape matches ReviewOutputSchema", () => {
    const schemaShape = ReviewOutputSchema;
    const schemaKeys = Object.keys(schemaShape.shape);
    for (const key of schemaKeys) {
      expect(prompt).toContain(key);
    }
  });
});
