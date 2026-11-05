import { randomUUID } from "node:crypto";
// `.js` suffix required: esbuild resolves the SDK through its exports map.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  WebSearchTool,
  createBremioMcpServer,
  resolveWebSearchBackend,
  type BremioMcpServerDeps,
} from "@bremio/adapter-sdk";
import { DaemonClient } from "@bremio/daemon-client";
import { evaluate, type ControlMode } from "@bremio/policy";

const CONTROL_MODES: readonly ControlMode[] = ["plan", "approve", "autopilot"];

/**
 * The control mode the attaching run passed in. Missing or unknown means
 * `plan` — the most restrictive mode — so a server started by hand or by a
 * misconfigured caller cannot do more than the strictest run could.
 */
export function controlModeFromEnv(env: Record<string, string | undefined>): ControlMode {
  const raw = env.BREMIO_CONTROL_MODE as ControlMode | undefined;
  return raw && CONTROL_MODES.includes(raw) ? raw : "plan";
}

export interface ServerDepsOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof globalThis.fetch;
  /** Daemon access for blackboard notes; defaults to the user's daemon. */
  connectDaemon?: () => Promise<Pick<DaemonClient, "addBlackboardEntry">>;
  version?: string;
}

/** Build the `bremio` MCP server's dependencies from its environment (P3-T5). */
export function bremioServerDeps(options: ServerDepsOptions = {}): BremioMcpServerDeps {
  const env = options.env ?? process.env;
  const controlMode = controlModeFromEnv(env);
  const resolved = resolveWebSearchBackend(env);
  const webSearch = new WebSearchTool(
    () => {
      const e = evaluate(controlMode, "network");
      if (!e.allowed) return { allowed: false, reason: e.reason };
      if (e.approvalRequired !== "none") {
        return { allowed: false, reason: `${controlMode} mode requires ${e.approvalRequired} approval for network access` };
      }
      return { allowed: true, reason: "allowed by policy" };
    },
    "backend" in resolved ? resolved.backend : undefined,
    options.fetchFn,
    "reason" in resolved ? resolved.reason : undefined,
  );

  const runId = env.BREMIO_RUN_ID?.trim();
  const connect =
    options.connectDaemon ??
    (async () => {
      const client = new DaemonClient(env.BREMIO_DAEMON_ENDPOINT ? { endpointPath: env.BREMIO_DAEMON_ENDPOINT } : {});
      await client.connect();
      return client;
    });

  return {
    webSearch,
    ...(runId
      ? {
          postNote: async (note) => {
            const client = await connect();
            await client.addBlackboardEntry(runId, {
              id: randomUUID(),
              kind: note.kind,
              content: note.content,
              author: "agent via bremio mcp",
              metadata: { source: "bremio-mcp" },
              createdAt: new Date().toISOString(),
            });
          },
        }
      : {}),
    onCall: (record) => {
      // stdout is the MCP channel; diagnostics go to stderr only.
      process.stderr.write(`${JSON.stringify({ bremioMcp: record })}\n`);
    },
    ...(options.version ? { version: options.version } : {}),
  };
}

/** `bremio mcp serve`: run the server over stdio until the client disconnects. */
export async function serveBremioMcp(version: string): Promise<number> {
  const server = createBremioMcpServer(bremioServerDeps({ version }));
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close().catch(() => {});
  return 0;
}
