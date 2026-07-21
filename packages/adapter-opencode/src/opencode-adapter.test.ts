import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { mapOpenCodeLine } from "./events";
import { OpenCodeAdapter, parseServerResponse, validateStructuredOutput } from "./opencode-adapter";

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
    expect(caps.vision).toBe(false);
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

const fixtureDir = fileURLToPath(new URL("../test-fixtures", import.meta.url));

describe("mapOpenCodeLine with recorded CLI stream", () => {
  const records: unknown[] = JSON.parse(readFileSync(`${fixtureDir}/cli-stream.json`, "utf8"));

  it("parses the complete recorded stream without errors", () => {
    const allEvents = records.flatMap((rec: unknown) => mapOpenCodeLine(JSON.stringify(rec), "run:fixture"));
    expect(allEvents.length).toBeGreaterThan(0);

    const messages = allEvents.filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0]?.type === "message") expect(messages[0].text).toBe("Done.");

    const usage = allEvents.filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThan(0);

    const toolUses = allEvents.filter((e) => e.type === "tool_use");
    expect(toolUses.length).toBeGreaterThan(0);

    const toolResults = allEvents.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
  });

  it("emits a log for step-start from the recorded stream", () => {
    const stepStartLines = records.filter((r) => (r as Record<string, unknown>).type === "step_start");
    for (const line of stepStartLines) {
      const events = mapOpenCodeLine(JSON.stringify(line), "run:fixture");
      expect(events).toHaveLength(1);
      if (events[0]) expect(events[0].type).toBe("log");
    }
  });

  it("extracts tool_use + tool_result for write from the recorded stream", () => {
    const toolUseRecords = records.filter((r) => (r as Record<string, unknown>).type === "tool_use");
    expect(toolUseRecords.length).toBeGreaterThan(0);
    for (const rec of toolUseRecords) {
      const events = mapOpenCodeLine(JSON.stringify(rec), "run:fixture");
      const toolUseEvent = events.find((e) => e.type === "tool_use");
      expect(toolUseEvent).toBeDefined();
      if (toolUseEvent?.type === "tool_use") expect(toolUseEvent.name).toBe("edit");
    }
  });
});

describe("parseServerResponse with recorded ACP response", () => {
  const response: { parts?: Array<{ type: string; text?: string }> } = JSON.parse(
    readFileSync(`${fixtureDir}/server-response.json`, "utf8"),
  );

  it("extracts the text part from the ACP response", () => {
    const text = parseServerResponse(response);
    expect(JSON.parse(text)).toEqual({ answer: 42 });
  });

  it("returns empty string when there are no parts", () => {
    expect(parseServerResponse({})).toBe("");
  });

  it("returns empty string when no part has type text", () => {
    expect(parseServerResponse({ parts: [{ type: "step-start" }] })).toBe("");
  });
});

describe("validateStructuredOutput", () => {
  const planSchema = {
    type: "object",
    required: ["summary", "leadAgentId", "tasks"],
    properties: {
      summary: { type: "string" },
      leadAgentId: { type: "string" },
      tasks: { type: "array" },
    },
  };

  it("passes valid JSON matching the schema", () => {
    const result = validateStructuredOutput(
      JSON.stringify({ summary: "a", leadAgentId: "opencode", tasks: [] }),
      planSchema,
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect((result.data as Record<string, unknown>).summary).toBe("a");
  });

  it("passes valid JSON when no schema is given", () => {
    const result = validateStructuredOutput('{"ok": true}');
    expect(result.valid).toBe(true);
  });

  it("fails prose output with not-valid-JSON", () => {
    const result = validateStructuredOutput("Hello, I am a helpful assistant.", planSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("not valid JSON");
  });

  it("fails a JSON array (not an object)", () => {
    const result = validateStructuredOutput("[1, 2, 3]", planSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("must be a JSON object");
  });

  it("fails when a required field is missing", () => {
    const result = validateStructuredOutput(JSON.stringify({ summary: "a" }), planSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("leadAgentId");
  });

  it("fails when multiple required fields are missing", () => {
    const result = validateStructuredOutput("{}", planSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("summary");
  });
});
