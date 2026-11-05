// `.js` suffixes required: esbuild resolves the SDK through its exports map.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSearchTool } from "../web-search-tool";

/**
 * Bremio's own tools, offered to agents as an MCP server (docs/17 P3-T5).
 *
 * This is how Bremio gains a say in what an agent does mid-task without
 * owning the model loop: the provider calls these like any MCP tool, the
 * provider's tool events record the call in the run's event stream, and each
 * handler applies Bremio policy before acting.
 *
 * Deliberately small. Every tool here has a consumer that already exists in
 * the daemon (the run blackboard) or in this package (web search).
 */
export const BREMIO_MCP_SERVER_ID = "bremio";

export type BremioNoteKind = "blocker" | "question" | "fact" | "decision";

export interface BremioMcpServerDeps {
  /** Web search with the run's network policy already bound (P3-T4). */
  webSearch?: WebSearchTool;
  /**
   * Record a note on the run's blackboard. Absent when the server has no run
   * to write to; the tool then answers with an error instead of pretending.
   */
  postNote?: (note: { kind: BremioNoteKind; content: string }) => Promise<void>;
  /** Called once per tool call with its result, for logging. */
  onCall?: (record: { tool: string; ok: boolean; detail: string }) => void;
  version?: string;
}

const MAX_NOTE_CHARS = 4000;

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) };
}

export function createBremioMcpServer(deps: BremioMcpServerDeps): McpServer {
  const server = new McpServer({ name: "bremio", version: deps.version ?? "0.0.0" });
  const record = (tool: string, ok: boolean, detail: string) => deps.onCall?.({ tool, ok, detail });

  server.registerTool(
    "bremio_web_search",
    {
      description:
        "Search the web through the backend the user configured for Bremio. Returns JSON {status, results:[{title,url,snippet}]}. status 'unconfigured' means no backend is set up.",
      inputSchema: {
        query: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ query, maxResults }) => {
      if (!deps.webSearch) {
        record("bremio_web_search", false, "web search is not available in this server");
        return text("web search is not available in this Bremio MCP server", true);
      }
      try {
        const result = await deps.webSearch.execute(query, { maxResults: maxResults ?? 5, timeout: 15_000 });
        record("bremio_web_search", result.status === "ok", result.status);
        return text(JSON.stringify(result));
      } catch (err) {
        const message = (err as Error).message;
        record("bremio_web_search", false, message);
        return text(message, true);
      }
    },
  );

  server.registerTool(
    "bremio_post_note",
    {
      description:
        "Record a blocker, question, fact or decision on this Bremio run's shared blackboard so the user and later tasks can see it. Use 'blocker' when you cannot continue without something.",
      inputSchema: {
        kind: z.enum(["blocker", "question", "fact", "decision"]),
        text: z.string().min(1).max(MAX_NOTE_CHARS),
      },
    },
    async ({ kind, text: content }) => {
      if (!deps.postNote) {
        record("bremio_post_note", false, "no run blackboard is reachable");
        return text("no Bremio run blackboard is reachable from this server; the note was not recorded", true);
      }
      try {
        await deps.postNote({ kind, content });
        record("bremio_post_note", true, kind);
        return text(`recorded ${kind} on the run blackboard`);
      } catch (err) {
        const message = (err as Error).message;
        record("bremio_post_note", false, message);
        return text(`note was not recorded: ${message}`, true);
      }
    },
  );

  return server;
}
