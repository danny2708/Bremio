import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@bremio/protocol";
import { collectRun } from "./stream";

async function* events(...items: AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* items;
}

describe("collectRun usage", () => {
  it("sums only provider-reported usage dimensions", async () => {
    const run = await collectRun(events(
      { type: "usage", runId: "r", ts: 1, inputTokens: 10, outputTokens: 2 },
      { type: "usage", runId: "r", ts: 2, inputTokens: 5, costUsd: 0.25 },
      { type: "completed", runId: "r", ts: 3, outcome: { status: "completed" } },
    ));

    expect(run.usage).toEqual({ inputTokens: 15, outputTokens: 2, costUsd: 0.25 });
  });

  it("does not invent usage when the provider reports none", async () => {
    const run = await collectRun(events(
      { type: "completed", runId: "r", ts: 1, outcome: { status: "completed" } },
    ));
    expect(run.usage).toBeUndefined();
  });
});
