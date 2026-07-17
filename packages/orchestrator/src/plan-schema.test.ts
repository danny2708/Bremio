import { describe, expect, it } from "vitest";
import { planJsonSchema } from "./plan-schema";

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
