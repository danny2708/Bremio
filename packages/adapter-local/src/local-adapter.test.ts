import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@bremio/protocol";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import { LocalOpenAiAdapter } from "./local-adapter";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface FakeOptions {
  /** Chunks emitted as OpenAI-style `data:` frames before `[DONE]`. */
  chunks?: unknown[];
  /** Delay between chunks, so a test can cancel mid-stream. */
  delayMs?: number;
  models?: string[];
  /** When set, `/chat/completions` answers with this status instead of a stream. */
  chatStatus?: number;
}

/** A local server that speaks the OpenAI-compatible wire format Bremio targets. */
async function fakeServer(options: FakeOptions = {}): Promise<string> {
  const models = options.models ?? ["local-model-a", "local-model-b"];
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      if (options.chatStatus && options.chatStatus !== 200) {
        res.writeHead(options.chatStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      void (async () => {
        for (const chunk of options.chunks ?? []) {
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } catch {
            return; // client aborted; stop writing
          }
          if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        }
        if (!res.writableEnded) {
          try {
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {
            /* client gone */
          }
        }
      })();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/v1`;
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run:test",
    role: "implementer",
    prompt: "say hello",
    cwd: process.cwd(),
    permission: "read-only",
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const delta = (content: string) => ({ choices: [{ delta: { content } }] });

describe("LocalOpenAiAdapter capabilities", () => {
  it("defaults to an all-false, unroutable posture", async () => {
    const caps = await new LocalOpenAiAdapter({ id: "x", baseUrl: "http://localhost:1/v1" }).getCapabilities();
    for (const [key, value] of Object.entries(caps)) {
      if (key === "readOnlyEnforcement") continue;
      expect(value).toBe(false);
    }
  });

  it("explicitly rejects resumeRun", () => {
    const adapter = new LocalOpenAiAdapter({ id: "x", baseUrl: "http://localhost:1/v1" });
    expect(() => adapter.resumeRun("s-123", request())).toThrow(/not implemented/i);
  });

  it("merges an explicit capability override over the conservative default", async () => {
    const caps = await new LocalOpenAiAdapter({
      id: "x",
      baseUrl: "http://localhost:1/v1",
      capabilities: { repositoryRead: true, repositoryWrite: true },
    }).getCapabilities();
    expect(caps.repositoryRead).toBe(true);
    expect(caps.repositoryWrite).toBe(true);
    expect(caps.shell).toBe(false); // untouched keys stay false
  });
});

describe("LocalOpenAiAdapter health and models", () => {
  it("lists the models the server advertises", async () => {
    const baseUrl = await fakeServer({ models: ["phi-4", "qwen-3"] });
    const models = await new LocalOpenAiAdapter({ id: "x", baseUrl }).listModels();
    expect(models.map((m) => m.id)).toEqual(["phi-4", "qwen-3"]);
  });

  it("reports ok when the server is reachable and a model is loaded", async () => {
    const baseUrl = await fakeServer();
    const health = await new LocalOpenAiAdapter({ id: "x", baseUrl }).healthCheck();
    expect(health.status).toBe("ok");
  });

  it("reports degraded when reachable but no model is loaded", async () => {
    const baseUrl = await fakeServer({ models: [] });
    const health = await new LocalOpenAiAdapter({ id: "x", baseUrl }).healthCheck();
    expect(health.status).toBe("degraded");
    expect(health.detail).toMatch(/no model/i);
  });

  it("reports unavailable when nothing is listening", async () => {
    const health = await new LocalOpenAiAdapter({
      id: "x",
      baseUrl: "http://127.0.0.1:9/v1", // discard port, refuses
    }).healthCheck();
    expect(health.status).toBe("unavailable");
  });
});

describe("LocalOpenAiAdapter streaming", () => {
  it("streams deltas as message events and ends with one completed carrying the full text", async () => {
    const baseUrl = await fakeServer({
      chunks: [delta("Hel"), delta("lo"), delta(" world"), { usage: { prompt_tokens: 5, completion_tokens: 3 } }],
    });
    const events = await collect(new LocalOpenAiAdapter({ id: "x", baseUrl, model: "m" }).startRun(request()));

    expect(events[0]?.type).toBe("started");

    const messages = events.filter((e) => e.type === "message");
    expect(messages.map((m) => (m.type === "message" ? m.text : ""))).toEqual(["Hel", "lo", " world"]);

    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(1);
    if (usage[0]?.type === "usage") expect(usage[0].inputTokens).toBe(5);

    const terminals = events.filter((e) => e.type === "completed");
    expect(terminals).toHaveLength(1);
    if (terminals[0]?.type === "completed") {
      expect(terminals[0].outcome.status).toBe("completed");
      expect(terminals[0].outcome.finalText).toBe("Hello world");
    }
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("discovers the model from /models when none is configured", async () => {
    const baseUrl = await fakeServer({ models: ["only-model"], chunks: [delta("ok")] });
    // No model in config and none on the request — must not fail for that reason.
    const events = await collect(new LocalOpenAiAdapter({ id: "x", baseUrl }).startRun(request()));
    const terminal = events.find((e) => e.type === "completed");
    if (terminal?.type !== "completed") throw new Error("no terminal event");
    expect(terminal.outcome.status).toBe("completed");
    expect(terminal.outcome.finalText).toBe("ok");
  });

  it("surfaces a non-200 as a failed outcome, not a hang", async () => {
    const baseUrl = await fakeServer({ chatStatus: 500 });
    const events = await collect(new LocalOpenAiAdapter({ id: "x", baseUrl, model: "m" }).startRun(request()));
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("completed");
    if (terminal?.type === "completed") {
      expect(terminal.outcome.status).toBe("failed");
      expect(terminal.outcome.error).toContain("500");
    }
  });
});

describe("LocalOpenAiAdapter cancellation", () => {
  it("stops mid-stream and reports cancelled, not completed", async () => {
    const baseUrl = await fakeServer({
      chunks: [delta("one"), delta("two"), delta("three"), delta("four")],
      delayMs: 200, // slow enough to cancel after the first delta
    });
    const adapter = new LocalOpenAiAdapter({ id: "x", baseUrl, model: "m" });
    const events: AgentEvent[] = [];
    const iterator = adapter.startRun(request({ runId: "cancel-me" }))[Symbol.asyncIterator]();

    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      events.push(value);
      if (value.type === "message") await adapter.cancelRun("cancel-me");
    }

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("completed");
    if (terminal?.type === "completed") expect(terminal.outcome.status).toBe("cancelled");
    // It must have stopped early, not drained all four deltas.
    expect(events.filter((e) => e.type === "message").length).toBeLessThan(4);
  });

  it("cancelRun for an unknown run is a no-op", async () => {
    await expect(new LocalOpenAiAdapter({ id: "x", baseUrl: "http://localhost:1/v1" }).cancelRun("nope")).resolves.toBeUndefined();
  });
});
