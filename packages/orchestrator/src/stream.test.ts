import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@bremio/protocol";
import { collectRun } from "./stream";

async function* events(...items: AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* items;
}

describe("collectRun usage", () => {
  it("sums only provider-reported usage dimensions", async () => {
    const run = await collectRun(events(
      {
        type: "usage",
        runId: "r",
        ts: 1,
        model: "provider-model",
        reasoningLevel: "high",
        inputTokens: 10,
        outputTokens: 2,
      },
      {
        type: "usage",
        runId: "r",
        ts: 2,
        model: "provider-model",
        reasoningLevel: "high",
        inputTokens: 5,
        costUsd: 0.25,
      },
      { type: "completed", runId: "r", ts: 3, outcome: { status: "completed" } },
    ));

    expect(run.usage).toEqual({ inputTokens: 15, outputTokens: 2, costUsd: 0.25 });
    expect(run.actualModel).toBe("provider-model");
    expect(run.actualReasoningLevel).toBe("high");
  });

  it("does not invent usage when the provider reports none", async () => {
    const run = await collectRun(events(
      { type: "completed", runId: "r", ts: 1, outcome: { status: "completed" } },
    ));
    expect(run.usage).toBeUndefined();
  });

  it("extracts file reads from read-like tool_use events", async () => {
    const run = await collectRun(events(
      {
        type: "tool_use",
        runId: "r",
        ts: 1,
        name: "read",
        input: { file_path: "src/main.ts" },
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 2,
        name: "Read",
        input: { file_path: "src/utils.ts" },
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 3,
        name: "read",
        input: { filepath: "README.md" },
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 4,
        name: "grep",
        input: { file_path: "config.ts" },
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 5,
        name: "glob",
        input: { file_path: "src/**/*.ts" },
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 6,
        name: "shell",  // not a read tool
        input: { command: "ls" },
      },
      { type: "completed", runId: "r", ts: 7, outcome: { status: "completed" } },
    ));

    // filesRead is collected in event order
    expect(run.filesRead).toEqual([
      "src/main.ts",
      "src/utils.ts",
      "README.md",
      "config.ts",
      "src/**/*.ts",
    ]);
  });

  it("ignores tool_use events without a file path", async () => {
    const run = await collectRun(events(
      {
        type: "tool_use",
        runId: "r",
        ts: 1,
        name: "read",
        input: {},
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 2,
        name: "read",
      },
      {
        type: "tool_use",
        runId: "r",
        ts: 3,
        name: "Read",
        input: { file_path: "file.ts" },
      },
      { type: "completed", runId: "r", ts: 4, outcome: { status: "completed" } },
    ));

    expect(run.filesRead).toEqual(["file.ts"]);
  });

  it("omits conflicting provider identity instead of guessing", async () => {
    const run = await collectRun(events(
      { type: "usage", runId: "r", ts: 1, model: "model-a", reasoningLevel: "low" },
      { type: "usage", runId: "r", ts: 2, model: "model-b", reasoningLevel: "high" },
      { type: "completed", runId: "r", ts: 3, outcome: { status: "completed" } },
    ));

    expect(run.actualModel).toBeUndefined();
    expect(run.actualReasoningLevel).toBeUndefined();
    expect(run.usage).toBeUndefined();
  });
});
