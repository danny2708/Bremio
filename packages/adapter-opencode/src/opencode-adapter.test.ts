import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { OpenCodeAdapter } from "./opencode-adapter";

const fakeOpenCode = fileURLToPath(new URL("../test-fixtures/fake-opencode.mjs", import.meta.url));

function adapter(): OpenCodeAdapter {
  return new OpenCodeAdapter({ explicitBin: process.execPath, extraArgs: [fakeOpenCode], defaultTimeoutMs: 30_000 });
}

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

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("OpenCodeAdapter", () => {
  it("reports capabilities matching the S1-T1 findings", async () => {
    const caps = await adapter().getCapabilities();
    expect(caps.planning).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.repositoryRead).toBe(true);
    expect(caps.repositoryWrite).toBe(true);
    expect(caps.shell).toBe(true);
    expect(caps.testing).toBe(true);
    expect(caps.browser).toBe(false);
    expect(caps.vision).toBe(true);
    expect(caps.resumableSessions).toBe(false);
  });

  it("reports the opencode version from healthCheck", async () => {
    const health = await adapter().healthCheck();
    expect(health.status).toBe("ok");
    expect(health.detail).toContain("1.18.4");
  });

  it("reports unavailable when the binary is not found", async () => {
    const health = await new OpenCodeAdapter({ explicitBin: "/nonexistent/opencode" }).healthCheck();
    expect(health.status).toBe("unavailable");
    expect(health.detail).toMatch(/not found/i);
  });

  it("streams JSON events and completes with exactly one terminal event", async () => {
    const events = await collect(adapter().startRun(request({ prompt: "do it", cwd: process.cwd() })));
    expect(events[0]?.type).toBe("started");

    const messages = events.filter((e) => e.type === "message");
    expect(messages.length).toBeGreaterThan(0);

    const usage = events.filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThan(0);

    const terminals = events.filter((e) => e.type === "completed");
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    if (terminal?.type === "completed") {
      expect(terminal.outcome.status).toBe("completed");
      expect(terminal.outcome.finalText).toContain("Done");
    }

    const lastEvent = events.at(-1);
    expect(lastEvent?.type).toBe("completed");
  });

  it("surfaces a non-zero exit as a failed outcome", async () => {
    const events = await collect(adapter().startRun(request({ prompt: "FAIL_PLEASE", cwd: process.cwd() })));
    const terminals = events.filter((e) => e.type === "completed");
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    if (terminal?.type === "completed") {
      expect(terminal.outcome.status).toBe("failed");
      expect(terminal.outcome.error).toMatch(/exited with code 3/);
    }
  });

  it("passes a multi-line prompt through without flattening it", async () => {
    const multiLine = "ECHO_PROMPT\nline two\n\n- bullet three";
    const events = await collect(adapter().startRun(request({ prompt: multiLine })));
    const terminal = events.find((e) => e.type === "completed");
    if (terminal?.type !== "completed") throw new Error("no terminal event");
    expect(terminal.outcome.finalText).toContain("line two");
    expect(terminal.outcome.finalText).toContain("- bullet three");
    // The assertion that matters: structure survived the process boundary.
    expect(terminal.outcome.finalText?.split("\n").length).toBeGreaterThan(2);
  });

  it("keeps the system prompt separate from the task prompt", async () => {
    const events = await collect(
      adapter().startRun(request({ prompt: "ECHO_PROMPT task body", systemPrompt: "system rules here" })),
    );
    const terminal = events.find((e) => e.type === "completed");
    if (terminal?.type !== "completed") throw new Error("no terminal event");
    expect(terminal.outcome.finalText).toContain("system rules here");
    expect(terminal.outcome.finalText).toContain("task body");
  });

  it("reports no models rather than offering agent names as model ids", async () => {
    // `build` and `plan` are permission profiles; handing them to --model would
    // fail. Empty means "use the provider's configured default".
    await expect(adapter().listModels()).resolves.toEqual([]);
  });

  it("cancelRun before startRun is a no-op", async () => {
    await expect(adapter().cancelRun("run:nonexistent")).resolves.toBeUndefined();
  });

  it("cancelRun after completion is a no-op", async () => {
    const adapt = adapter();
    await collect(adapt.startRun(request({ cwd: process.cwd() })));
    await expect(adapt.cancelRun("run:test")).resolves.toBeUndefined();
  });
});
