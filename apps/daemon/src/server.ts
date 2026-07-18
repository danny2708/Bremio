import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import { ReasoningLevelSchema } from "@bremio/protocol";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  refreshAqtIfAvailable,
  toAqtCapacitySnapshots,
} from "@bremio/quota";
import { MergeManager } from "@bremio/workspace";
import { RunRegistry } from "./runs";
import { mergeRun } from "./merge";
import { listReports, loadReportByRunId } from "@bremio/orchestrator";

/** Requests carry a prompt at most; anything larger is malformed or hostile. */
const MAX_BODY_BYTES = 256 * 1024;

const StartRunSchema = z.object({
  mode: z.enum(["single", "team"]),
  repoPath: z.string().min(1),
  prompt: z.string().min(1),
  agentId: z.string().min(1),
  workerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  comparisonId: z.string().min(1).optional(),
});

const MergeSchema = z.object({
  repoPath: z.string().min(1),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
  strategy: z.enum(["merge", "cherry-pick"]).optional(),
});

export interface DaemonServerOptions {
  token: string;
  version: string;
  registry?: RunRegistry;
}

export interface DaemonHandle {
  server: Server;
  port: number;
  registry: RunRegistry;
  close(): Promise<void>;
}

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonHandle> {
  const registry = options.registry ?? new RunRegistry();
  const server = createServer((req, res) => {
    void handle(req, res, options, registry).catch((err: unknown) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    port,
    registry,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: DaemonServerOptions,
  registry: RunRegistry,
): Promise<void> {
  // Reject anything not addressed to loopback by name: a browser page tricked
  // into rebinding a hostname to 127.0.0.1 sends its own Host value.
  const host = req.headers.host ?? "";
  if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) {
    return sendJson(res, 403, { error: "unexpected Host header" });
  }
  if (req.headers["x-bremio-token"] !== options.token) {
    return sendJson(res, 401, { error: "missing or invalid token" });
  }

  const url = new URL(req.url ?? "/", `http://${host}`);
  const route = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && route === "/health") {
    return sendJson(res, 200, { app: "bremio-daemon", version: options.version, pid: process.pid });
  }

  if (method === "GET" && route === "/adapters") {
    const adapters = [new ClaudeAdapter(), new CodexAdapter(), new AntigravityAdapter()];
    const diagnostics = await Promise.all(
      adapters.map(async (adapter) => {
        const [health, capabilities] = await Promise.all([
          adapter.healthCheck(),
          adapter.getCapabilities(),
        ]);
        return {
          id: adapter.id,
          health,
          capabilities,
          // The capability contract decides eligibility, not a hardcoded list.
          leadEligible: capabilities.planning && capabilities.structuredOutput,
        };
      }),
    );
    return sendJson(res, 200, { adapters: diagnostics });
  }

  if (method === "GET" && route === "/capacity") {
    return sendJson(res, 200, await readCapacity(url.searchParams.get("refresh") !== "false"));
  }

  if (method === "GET" && route === "/runs") {
    const repoPath = url.searchParams.get("repo");
    const stored = repoPath ? await listReports(repoPath) : [];
    return sendJson(res, 200, {
      live: registry.list().map(summarize),
      stored: stored.map((entry) => ({ runId: entry.runId, report: entry.report })),
    });
  }

  const runEvents = /^\/runs\/([^/]+)\/events$/.exec(route);
  if (method === "GET" && runEvents) {
    return streamEvents(req, res, registry, decodeURIComponent(runEvents[1] ?? ""), url);
  }

  const runCancel = /^\/runs\/([^/]+)\/cancel$/.exec(route);
  if (method === "POST" && runCancel) {
    const cancelled = registry.cancel(decodeURIComponent(runCancel[1] ?? ""));
    return sendJson(res, cancelled ? 200 : 409, { cancelled });
  }

  const runDetail = /^\/runs\/([^/]+)$/.exec(route);
  if (method === "GET" && runDetail) {
    const id = decodeURIComponent(runDetail[1] ?? "");
    const live = registry.get(id);
    if (live) return sendJson(res, 200, { run: summarize(live), events: live.events });
    const repoPath = url.searchParams.get("repo");
    const stored = repoPath ? await loadReportByRunId(repoPath, id) : undefined;
    if (!stored) return sendJson(res, 404, { error: `unknown run: ${id}` });
    return sendJson(res, 200, { report: stored.report });
  }

  if (method === "POST" && route === "/runs") {
    const parsed = StartRunSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return sendJson(res, 400, { error: "invalid run request", detail: parsed.error.issues });
    }
    const run = registry.start(parsed.data);
    return sendJson(res, 202, { run: summarize(run) });
  }

  if (method === "GET" && route === "/diff") {
    const repoPath = url.searchParams.get("repo");
    const branch = url.searchParams.get("branch");
    if (!repoPath || !branch) {
      return sendJson(res, 400, { error: "repo and branch are required" });
    }
    const manager = new MergeManager(repoPath);
    const base = url.searchParams.get("base") ?? (await manager.currentBranch());
    const commit = url.searchParams.get("commit");
    try {
      // A task commit shows only what that task owns; the branch diff includes
      // whatever dependency history it was based on.
      return sendJson(
        res,
        200,
        commit ? await manager.getCommitDiff(commit) : await manager.getDiff(branch, base),
      );
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  if (method === "POST" && route === "/merge") {
    const parsed = MergeSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return sendJson(res, 400, { error: "invalid merge request", detail: parsed.error.issues });
    }
    const outcome = await mergeRun(parsed.data);
    // A refused merge is a normal answer, not a server fault: the gate and the
    // dirty-tree checks are expected outcomes the UI must render.
    return sendJson(res, outcome.ok ? 200 : 409, outcome);
  }

  return sendJson(res, 404, { error: `unknown endpoint: ${method} ${route}` });
}

async function readCapacity(refresh: boolean): Promise<unknown> {
  const service = refresh ? (await refreshAqtIfAvailable()).status : undefined;
  const databasePath = defaultAqtDatabasePath();
  if (!databasePath) {
    return { error: "cannot locate the AI-Quota-Tray database", ...(service ? { service } : {}) };
  }
  try {
    const source = readAqtQuota({ databasePath, staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS });
    return {
      databasePath: source.databasePath,
      readAt: source.readAt,
      snapshots: toAqtCapacitySnapshots(source),
      ...(service ? { service } : {}),
    };
  } catch (err) {
    return { error: (err as Error).message, ...(service ? { service } : {}) };
  }
}

/**
 * Server-Sent Events rather than a WebSocket: the only streaming direction is
 * server to client, and commands (start, cancel) are plain POSTs. SSE runs on
 * node:http with no extra dependency.
 */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  registry: RunRegistry,
  runId: string,
  url: URL,
): void {
  if (!registry.get(runId)) {
    return sendJson(res, 404, { error: `unknown run: ${runId}` });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  // Clients reconnect with the last id they saw, so a dropped stream resumes
  // instead of losing whatever arrived while it was disconnected.
  const afterSeq = Number(
    req.headers["last-event-id"] ?? url.searchParams.get("afterSeq") ?? 0,
  );
  const unsubscribe = registry.subscribe(
    runId,
    (event) => {
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.kind === "finished" || event.kind === "failed") res.end();
    },
    Number.isFinite(afterSeq) ? afterSeq : 0,
  );

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  const stop = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on("close", stop);
  res.on("close", stop);
}

function summarize(run: ReturnType<RunRegistry["list"]>[number]) {
  return {
    id: run.id,
    mode: run.mode,
    repoPath: run.repoPath,
    prompt: run.prompt,
    agentId: run.agentId,
    state: run.state,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.report ? { report: run.report } : {}),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}
