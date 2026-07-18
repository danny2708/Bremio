import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import { AntigravityAdapter, buildAntigravityRequest } from "./antigravity-adapter";

const fakeSidecar = fileURLToPath(
  new URL("../test-fixtures/fake-sidecar.mjs", import.meta.url),
);

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run:test",
    role: "implementer",
    prompt: "implement it",
    cwd: process.cwd(),
    permission: "workspace-write",
    ...overrides,
  };
}

describe("AntigravityAdapter", () => {
  it("maps Bremio requests without inventing provider-reported identity", () => {
    expect(buildAntigravityRequest(request({ reasoningLevel: "xhigh" }), "gemini-default"))
      .toEqual({
        runId: "run:test",
        prompt: "implement it",
        cwd: process.cwd(),
        permission: "workspace-write",
        model: "gemini-default",
        reasoningLevel: "xhigh",
      });
  });

  it("reports sidecar health and streams normalized events", async () => {
    const adapter = new AntigravityAdapter({
      pythonBin: process.execPath,
      sidecarPath: fakeSidecar,
    });
    await expect(adapter.healthCheck()).resolves.toEqual({
      status: "ok",
      detail: "fake sidecar",
    });

    const events = [];
    for await (const event of adapter.startRun(request())) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_use",
      "tool_result",
      "message",
      "usage",
      "completed",
    ]);
    expect(events.find((event) => event.type === "message")).toMatchObject({
      text: "permission=workspace-write",
    });
  });

  it("is worker-capable but not lead- or test-gate eligible", async () => {
    const adapter = new AntigravityAdapter();
    await expect(adapter.getCapabilities()).resolves.toMatchObject({
      planning: false,
      structuredOutput: true,
      repositoryWrite: true,
      shell: true,
      testing: false,
    });
  });
});
