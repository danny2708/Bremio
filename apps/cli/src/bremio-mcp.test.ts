import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bremioServerDeps, controlModeFromEnv } from "./bremio-mcp";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "index.ts");

describe("bremio mcp serve dependencies (P3-T5)", () => {
  it("defaults to the strictest mode when the run did not say", () => {
    expect(controlModeFromEnv({})).toBe("plan");
    expect(controlModeFromEnv({ BREMIO_CONTROL_MODE: "root" })).toBe("plan");
    expect(controlModeFromEnv({ BREMIO_CONTROL_MODE: "autopilot" })).toBe("autopilot");
  });

  it("denies web search outside autopilot before any request", async () => {
    let fetched = false;
    const deps = bremioServerDeps({
      env: { BREMIO_CONTROL_MODE: "plan", BREMIO_WEB_SEARCH_BACKEND: "json", BREMIO_WEB_SEARCH_ENDPOINT: "https://s.test/" },
      fetchFn: (async () => {
        fetched = true;
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });
    await expect(deps.webSearch!.execute("q")).rejects.toThrow(/web search denied/);
    expect(fetched).toBe(false);
  });

  it("is unconfigured in autopilot without a backend", async () => {
    const deps = bremioServerDeps({ env: { BREMIO_CONTROL_MODE: "autopilot" } });
    expect(await deps.webSearch!.execute("q")).toMatchObject({ status: "unconfigured" });
  });

  it("posts notes to the attaching run's blackboard", async () => {
    const posted: Array<[string, Record<string, unknown>]> = [];
    const deps = bremioServerDeps({
      env: { BREMIO_RUN_ID: "run-abc" },
      connectDaemon: async () => ({
        addBlackboardEntry: async (runId: string, entry: Record<string, unknown>) => {
          posted.push([runId, entry]);
          return { ok: true };
        },
      }) as never,
    });
    await deps.postNote!({ kind: "blocker", content: "missing secret" });
    expect(posted[0]![0]).toBe("run-abc");
    expect(posted[0]![1]).toMatchObject({ kind: "blocker", content: "missing secret", metadata: { source: "bremio-mcp" } });
  });

  it("offers no note tool target without a run id", () => {
    expect(bremioServerDeps({ env: {} }).postNote).toBeUndefined();
  });
});

describe("bremio mcp serve over real stdio (P3-T5)", () => {
  it("starts, lists its tools and answers a call", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cliEntry, "mcp", "serve"],
      env: { ...(process.env as Record<string, string>), BREMIO_CONTROL_MODE: "autopilot", BREMIO_WEB_SEARCH_BACKEND: "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["bremio_post_note", "bremio_web_search"]);
      const result = await client.callTool({ name: "bremio_web_search", arguments: { query: "x" } });
      const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
      expect(body.status).toBe("unconfigured");
    } finally {
      await client.close();
    }
  }, 30_000);
});
