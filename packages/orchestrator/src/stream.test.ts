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
