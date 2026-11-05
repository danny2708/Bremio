import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSearchTool, jsonSearchBackend } from "../web-search-tool";
import { createBremioMcpServer, type BremioMcpServerDeps } from "./bremio-server";

async function connect(deps: BremioMcpServerDeps) {
  const server = createBremioMcpServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

describe("bremio MCP server (P3-T5)", () => {
  it("offers exactly the two Bremio tools", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["bremio_post_note", "bremio_web_search"]);
  });

  it("answers web search through the bound tool and reports the call", async () => {
    const calls: unknown[] = [];
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ results: [{ title: "T", url: "https://t.test/", snippet: "s" }] }),
    })) as unknown as typeof fetch;
    const webSearch = new WebSearchTool(
      () => ({ allowed: true, reason: "ok" }),
      jsonSearchBackend({ endpoint: "https://s.test/" }),
      fetchFn,
    );
    const client = await connect({ webSearch, onCall: (r) => calls.push(r) });
    const result = await client.callTool({ name: "bremio_web_search", arguments: { query: "t" } });
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "ok", results: [{ url: "https://t.test/" }] });
    expect(calls).toEqual([{ tool: "bremio_web_search", ok: true, detail: "ok" }]);
  });

  it("returns a policy denial as a tool error, not a result", async () => {
    const webSearch = new WebSearchTool(() => ({ allowed: false, reason: "plan mode prohibits network access" }));
    const client = await connect({ webSearch });
    const result = await client.callTool({ name: "bremio_web_search", arguments: { query: "t" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/web search denied: plan mode prohibits network access/);
  });

  it("records notes through the run's blackboard", async () => {
    const notes: unknown[] = [];
    const client = await connect({ postNote: async (n) => void notes.push(n) });
    const result = await client.callTool({
      name: "bremio_post_note",
      arguments: { kind: "blocker", text: "need the staging DB URL" },
    });
    expect(result.isError).toBeFalsy();
    expect(notes).toEqual([{ kind: "blocker", content: "need the staging DB URL" }]);
  });

  it("says plainly when no blackboard is reachable", async () => {
    const client = await connect({});
    const result = await client.callTool({ name: "bremio_post_note", arguments: { kind: "fact", text: "x" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/note was not recorded/);
  });

  it("rejects an invalid note kind at the schema", async () => {
    const client = await connect({ postNote: async () => {} });
    const result = await client.callTool({ name: "bremio_post_note", arguments: { kind: "order", text: "x" } });
    expect(result.isError).toBe(true);
  });
});
