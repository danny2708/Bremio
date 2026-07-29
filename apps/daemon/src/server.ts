import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  CreateApprovalRequestSchema,
  DecideApprovalRequestSchema,
  ReasoningLevelSchema,
} from "@bremio/protocol";
import { MINIMUM_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "./endpoint";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  defaultAqtDatabasePath,
  readAqtQuota,
  refreshAqtIfAvailable,
  toAqtCapacitySnapshots,
} from "@bremio/quota";
import { MergeManager } from "@bremio/workspace";
import { RunRegistry, createDefaultPluginManager, type SessionEvent } from "./runs";
import { isTerminal, type CreateContextItemInput, type PersistedContextItem } from "./storage";
import { mergeRun } from "./merge";
import { applyRunPatch, revertRunPatch } from "./apply";
import { loadReportByRunId } from "@bremio/orchestrator";

/** Requests carry a prompt at most; anything larger is malformed or hostile. */
const MAX_BODY_BYTES = 256 * 1024;

const StartRunSchema = z.object({
  // `auto` is resolved by the registry from the repository's ledger, so every
  // client gets the same decision from the same evidence.
  mode: z.enum(["single", "team", "auto"]),
  repoPath: z.string().min(1),
  prompt: z.string().min(1),
  agentId: z.string().min(1),
  workerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  comparisonId: z.string().min(1).optional(),
  /** Continue an existing session: this run becomes its next turn. */
  sessionId: z.string().min(1).optional(),
  workspaceStrategy: z.enum(["direct-workspace", "isolated-worktree"]).optional(),
  controlMode: z.enum(["plan", "approve", "autopilot"]).optional(),
});

const MergeSchema = z.object({
  repoPath: z.string().min(1),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
  strategy: z.enum(["merge", "cherry-pick"]).optional(),
});

const ApplyRevertSchema = z.object({
  repoPath: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().optional(),
  filePath: z.string().optional(),
  force: z.boolean().optional(),
});

export interface DaemonServerOptions {
  token: string;
  version: string;
  /** Owns run execution and the durable record; the server only routes to it. */
  registry: RunRegistry;
  /** Invoked by an authenticated shutdown request. */
  onShutdown?: () => void;
  /**
   * True once storage is open, migrations are done and the orchestrator can
   * accept work. Separate from liveness: a process that is up but not yet
   * usable must not be treated as ready.
   */
  isReady?: () => boolean;
}

export interface DaemonHandle {
  server: Server;
  port: number;
  registry: RunRegistry;
  close(): Promise<void>;
}

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonHandle> {
  const registry = options.registry;
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

  if (method === "GET" && route === "/ready") {
    // Distinct from /health: a client that starts the daemon must wait for
    // this, not merely for the port to accept connections.
    const ready = options.isReady?.() ?? true;
    return sendJson(res, ready ? 200 : 503, {
      ready,
      acceptingRuns: registry.accepting,
      ...(ready ? {} : { detail: "storage or orchestrator is still starting" }),
    });
  }

  if (method === "GET" && route === "/meta") {
    return sendJson(res, 200, {
      daemonVersion: options.version,
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: MINIMUM_CLIENT_PROTOCOL,
      capabilities: {
        sse: true,
        sseResume: true,
        persistentRuns: true,
        persistentEvents: true,
        cancel: true,
        merge: true,
        retry: true,
        approvals: true,
        apply: true,
        revert: true,
        compact: true,
        // No adapter exposes a safe mid-run resume, so this stays false rather
        // than offering a button that would silently start over.
        resume: false,
      },
    });
  }

  if (method === "POST" && route === "/shutdown") {
    if (!options.onShutdown) return sendJson(res, 501, { error: "shutdown is not supported" });
    // Answer before exiting so `daemon stop` sees a result rather than a
    // dropped socket. Asking the daemon to stop itself is what lets `stop`
    // avoid signalling a PID it cannot prove belongs to Bremio.
    sendJson(res, 202, { stopping: true, activeRuns: registry.activeCount });
    setTimeout(() => options.onShutdown?.(), 10);
    return;
  }

  if (method === "GET" && route === "/adapters") {
    // Literally the list the run path executes with, read off this daemon's
    // own registry — not a freshly built one, which would keep advertising a
    // plugin after it had been deactivated here.
    const adapters = registry.executableAdapters();
    const diagnostics = await Promise.all(
      adapters.map(async (adapter) => {
        const [health, capabilities, runtimeCaps] = await Promise.all([
          adapter.healthCheck(),
          adapter.getCapabilities(),
          adapter.getRuntimeCapabilities().catch(() => undefined),
        ]);
        return {
          id: adapter.id,
          health,
          capabilities,
          runtimeCapabilities: runtimeCaps,
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
    return sendJson(res, 200, {
      runs: registry.list(repoPath ?? undefined),
    });
  }

  const runEvents = /^\/runs\/([^/]+)\/events$/.exec(route);
  if (method === "GET" && runEvents) {
    return streamEvents(req, res, registry, decodeURIComponent(runEvents[1] ?? ""), url);
  }

  const runRetry = /^\/runs\/([^/]+)\/retry$/.exec(route);
  if (method === "POST" && runRetry) {
    const id = decodeURIComponent(runRetry[1] ?? "");
    try {
      return sendJson(res, 202, { run: registry.retry(id) });
    } catch (err) {
      // "still running" and "unknown run" are answers the UI must render, not
      // server faults.
      return sendJson(res, 409, { error: (err as Error).message });
    }
  }

  const runCancel = /^\/runs\/([^/]+)\/cancel$/.exec(route);
  if (method === "POST" && runCancel) {
    const cancelled = registry.cancel(decodeURIComponent(runCancel[1] ?? ""));
    return sendJson(res, cancelled ? 200 : 409, { cancelled });
  }

  if (method === "GET" && route === "/sessions") {
    const repoPath = url.searchParams.get("repo");
    if (!repoPath) return sendJson(res, 400, { error: "repo query parameter is required" });
    return sendJson(res, 200, { sessions: registry.sessions(repoPath) });
  }

  const sessionEvents = /^\/sessions\/([^/]+)\/events$/.exec(route);
  if (method === "GET" && sessionEvents) {
    return streamSessionEvents(req, res, registry, decodeURIComponent(sessionEvents[1] ?? ""));
  }

  const sessionDetail = /^\/sessions\/([^/]+)$/.exec(route);
  if (method === "GET" && sessionDetail) {
    const id = decodeURIComponent(sessionDetail[1] ?? "");
    const session = registry.sessionDetail(id);
    if (!session) return sendJson(res, 404, { error: `unknown session: ${id}` });
    return sendJson(res, 200, { session });
  }

  const sessionConfigGet = /^\/sessions\/([^/]+)\/config$/.exec(route);
  if (method === "GET" && sessionConfigGet) {
    const id = decodeURIComponent(sessionConfigGet[1] ?? "");
    const cfg = registry.getSessionConfig(id);
    if (!cfg) return sendJson(res, 404, { error: `no config for session: ${id}` });
    return sendJson(res, 200, { config: cfg });
  }

  const sessionConfigsList = /^\/sessions\/([^/]+)\/configs$/.exec(route);
  if (method === "GET" && sessionConfigsList) {
    const id = decodeURIComponent(sessionConfigsList[1] ?? "");
    return sendJson(res, 200, { configs: registry.listSessionConfigs(id) });
  }

  const sessionConfigPost = /^\/sessions\/([^/]+)\/config$/.exec(route);
  if (method === "POST" && sessionConfigPost) {
    const id = decodeURIComponent(sessionConfigPost[1] ?? "");
    try {
      const input = (await readJsonBody(req)) as Record<string, unknown>;
      const cfg = registry.createSessionConfig({ sessionId: id, ...input });
      return sendJson(res, 201, { config: cfg });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  const sessionTransitionPost = /^\/sessions\/([^/]+)\/transition$/.exec(route);
  if (method === "POST" && sessionTransitionPost) {
    const id = decodeURIComponent(sessionTransitionPost[1] ?? "");
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const result = registry.evaluateSessionTransition({ sessionId: id, ...body } as Parameters<typeof registry.evaluateSessionTransition>[0]);
      if (result.ok) {
        return sendJson(res, 200, { transition: result.transition, config: result.config });
      }
      return sendJson(res, 409, { error: result.reason });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  const contextItemsList = /^\/sessions\/([^/]+)\/context-items$/.exec(route);
  if (method === "GET" && contextItemsList) {
    const id = decodeURIComponent(contextItemsList[1] ?? "");
    const items = registry.listContextItems(id);
    return sendJson(res, 200, { contextItems: items });
  }

  const contextItemCreate = /^\/sessions\/([^/]+)\/context-items$/.exec(route);
  if (method === "POST" && contextItemCreate) {
    const id = decodeURIComponent(contextItemCreate[1] ?? "");
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const input: CreateContextItemInput = { sessionId: id, type: String(body.type ?? "") as CreateContextItemInput["type"], source: String(body.source ?? ""), scope: body.scope as CreateContextItemInput["scope"], tokensEstimated: body.tokensEstimated as number | undefined, measurementMethod: body.measurementMethod as CreateContextItemInput["measurementMethod"], enabled: body.enabled as boolean | undefined };
      if (input.tokensEstimated === undefined) {
        let text = input.source;
        if (input.type === "file" || input.type === "image") {
          try {
            text = readFileSync(input.source, "utf-8");
          } catch {
            text = input.source;
          }
        }
        input.tokensEstimated = Math.ceil(text.length / 4);
        input.measurementMethod = "estimated";
      }
      const item = registry.createContextItem(input);
      return sendJson(res, 201, { contextItem: item });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  const contextItemDetail = /^\/sessions\/([^/]+)\/context-items\/([^/]+)$/.exec(route);
  if (method === "GET" && contextItemDetail) {
    const itemId = decodeURIComponent(contextItemDetail[2] ?? "");
    const item = registry.getContextItem(itemId);
    if (!item) return sendJson(res, 404, { error: `unknown context item: ${itemId}` });
    return sendJson(res, 200, { contextItem: item });
  }

  const contextItemDelete = /^\/sessions\/([^/]+)\/context-items\/([^/]+)$/.exec(route);
  if (method === "DELETE" && contextItemDelete) {
    const itemId = decodeURIComponent(contextItemDelete[2] ?? "");
    const removed = registry.deleteContextItem(itemId);
    if (!removed) return sendJson(res, 404, { error: `unknown context item: ${itemId}` });
    return sendJson(res, 200, { removed: true });
  }

  const contextItemToggle = /^\/sessions\/([^/]+)\/context-items\/([^/]+)\/enabled$/.exec(route);
  if (method === "PATCH" && contextItemToggle) {
    const itemId = decodeURIComponent(contextItemToggle[2] ?? "");
    try {
      const body = (await readJsonBody(req)) as { enabled: boolean };
      const item = registry.updateContextItemEnabled(itemId, body.enabled);
      if (!item) return sendJson(res, 404, { error: `unknown context item: ${itemId}` });
      return sendJson(res, 200, { contextItem: item });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  const contextMetrics = /^\/sessions\/([^/]+)\/context-metrics$/.exec(route);
  if (method === "GET" && contextMetrics) {
    const id = decodeURIComponent(contextMetrics[1] ?? "");
    const metrics = registry.getSessionContextMetrics(id);
    return sendJson(res, 200, { metrics });
  }

  const sessionCompact = /^\/sessions\/([^/]+)\/compact$/.exec(route);
  if (method === "POST" && sessionCompact) {
    const id = decodeURIComponent(sessionCompact[1] ?? "");
    try {
      const compact = registry.compactSession(id);
      return sendJson(res, 201, { compact });
    } catch (err) {
      return sendJson(res, 409, { error: (err as Error).message });
    }
  }

  const sessionCompactsList = /^\/sessions\/([^/]+)\/compacts$/.exec(route);
  if (method === "GET" && sessionCompactsList) {
    const id = decodeURIComponent(sessionCompactsList[1] ?? "");
    return sendJson(res, 200, { compacts: registry.getSessionCompacts(id) });
  }

  const sessionCompactDelete = /^\/sessions\/([^/]+)\/compacts\/([^/]+)$/.exec(route);
  if (method === "DELETE" && sessionCompactDelete) {
    const compactId = decodeURIComponent(sessionCompactDelete[2] ?? "");
    const removed = registry.deleteSessionCompact(compactId);
    if (!removed) return sendJson(res, 404, { error: `unknown compact: ${compactId}` });
    return sendJson(res, 200, { removed: true });
  }

  const runDetail = /^\/runs\/([^/]+)$/.exec(route);
  if (method === "GET" && runDetail) {
    const id = decodeURIComponent(runDetail[1] ?? "");
    const run = registry.get(id);
    if (run) {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
      return sendJson(res, 200, {
        run,
        events: registry.events(id, Number.isFinite(afterSeq) ? afterSeq : 0),
        artifacts: registry.artifacts(id),
        recovery: registry.recoveryOptions(id),
      });
    }
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
    try {
      return sendJson(res, 202, { run: registry.start(parsed.data) });
    } catch (err) {
      // Refusing work during shutdown is an expected answer, not a fault.
      return sendJson(res, 503, { error: (err as Error).message });
    }
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

  if (method === "POST" && route === "/apply") {
    const parsed = ApplyRevertSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return sendJson(res, 400, { error: "invalid apply request", detail: parsed.error.issues });
    }
    try {
      const outcome = await applyRunPatch(parsed.data);
      return sendJson(res, outcome.ok ? 200 : 409, outcome);
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  if (method === "POST" && route === "/revert") {
    const parsed = ApplyRevertSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return sendJson(res, 400, { error: "invalid revert request", detail: parsed.error.issues });
    }
    try {
      const outcome = await revertRunPatch(parsed.data);
      return sendJson(res, outcome.ok ? 200 : 409, outcome);
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  // ── Approval routes ────────────────────────────────────────────────

  if (method === "GET" && route === "/approval/requests") {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const runId = url.searchParams.get("runId") ?? undefined;
    const state = url.searchParams.get("state") ?? undefined;
    return sendJson(res, 200, { requests: registry.listApprovalRequests({ sessionId, runId, state }) });
  }

  if (method === "POST" && route === "/approval/requests") {
    const parsed = CreateApprovalRequestSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return sendJson(res, 400, { error: "invalid request", detail: parsed.error.issues });
    }
    const { request, autoDenied } = registry.createApprovalRequest({
      sessionId: parsed.data.sessionId,
      runId: parsed.data.runId,
      actionClass: parsed.data.actionDigest.actionClass,
      actionTarget: parsed.data.actionDigest.target,
      actionDescription: parsed.data.actionDigest.description,
      actionDigest: parsed.data.actionDigest.digest,
      risk: parsed.data.risk,
    });
    return sendJson(res, 201, { request, autoDenied });
  }

  const approvalRequestDetail = /^\/approval\/requests\/([^/]+)$/.exec(route);
  if (method === "GET" && approvalRequestDetail) {
    const id = decodeURIComponent(approvalRequestDetail[1] ?? "");
    const req = registry.getApprovalRequest(id);
    if (!req) return sendJson(res, 404, { error: `unknown approval request: ${id}` });
    return sendJson(res, 200, { request: req });
  }

  const approvalDecide = /^\/approval\/requests\/([^/]+)\/decide$/.exec(route);
  if (method === "POST" && approvalDecide) {
    const id = decodeURIComponent(approvalDecide[1] ?? "");
    const parsed = DecideApprovalRequestSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return sendJson(res, 400, { error: "invalid decision", detail: parsed.error.issues });
    }
    const result = registry.decideApprovalRequest({
      id,
      decision: parsed.data.decision,
      decidedBy: parsed.data.decidedBy,
      reason: parsed.data.reason,
    });
    if (!result) return sendJson(res, 409, { error: `request ${id} is not pending` });

    // If this decision resolves a pending review (S3-T4), unblock the run.
    registry.resolvePendingApproval(id, parsed.data.decision);

    return sendJson(res, 200, { request: result });
  }

  const approvalCancel = /^\/approval\/requests\/([^/]+)\/cancel$/.exec(route);
  if (method === "POST" && approvalCancel) {
    const id = decodeURIComponent(approvalCancel[1] ?? "");
    const body = (await readJsonBody(req).catch(() => undefined)) as Record<string, unknown> | undefined;
    const cancelledBy = body?.cancelledBy as string | undefined;
    const result = registry.cancelApprovalRequest(id, cancelledBy);
    if (!result) return sendJson(res, 409, { error: `request ${id} is not pending` });
    return sendJson(res, 200, { request: result });
  }

  if (method === "GET" && route === "/audit") {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const limit = url.searchParams.get("limit") ?? undefined;
    const events = registry.listAuditEvents({
      sessionId,
      ...(limit ? { limit: Number(limit) } : {}),
    });
    return sendJson(res, 200, { events });
  }

  if (method === "POST" && route === "/legacy/import") {
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const repoPath = typeof body?.repoPath === "string" ? body.repoPath : undefined;
    if (!repoPath) return sendJson(res, 400, { error: "repoPath is required" });
    const result = await registry.importReports(repoPath);
    return sendJson(res, 200, result);
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
/** Events after which the run cannot produce more output. */
function isTerminalKind(kind: string): boolean {
  return kind === "finished" || kind === "failed" || kind === "interrupted";
}

/**
 * Resolve where to resume from.
 *
 * `Last-Event-ID` is echoed back by the browser EventSource contract, so it is
 * whatever this server last sent: `<runId>:<seq>`. An id belonging to a
 * different run is ignored rather than trusted, since replaying from another
 * run's position would silently skip or duplicate events.
 */
function parseLastEventId(
  header: string | string[] | undefined,
  fallback: string | null,
  runId: string,
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw) {
    const separator = raw.lastIndexOf(":");
    const id = separator === -1 ? raw : raw.slice(0, separator);
    const seq = Number(separator === -1 ? raw : raw.slice(separator + 1));
    if ((separator === -1 || id === runId) && Number.isFinite(seq) && seq >= 0) return seq;
  }
  const parsed = Number(fallback ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

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
  // instead of losing whatever arrived while it was disconnected. Ids are
  // `<runId>:<seq>` so one cannot be mistaken for a position in another run.
  const afterSeq = parseLastEventId(
    req.headers["last-event-id"],
    url.searchParams.get("afterSeq"),
    runId,
  );
  const unsubscribe = registry.subscribe(
    runId,
    (event) => {
      // A named event type means a client never has to parse the message text
      // to know what happened.
      res.write(`id: ${runId}:${event.seq}\n`);
      res.write(`event: ${event.kind}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (isTerminalKind(event.kind)) res.end();
    },
    afterSeq,
  );

  // A client resuming past the last event of an already-finished run has
  // nothing left to receive, and no terminal event will arrive to close the
  // stream — so close it here rather than leaving the connection hanging.
  const run = registry.get(runId);
  if (run && isTerminal(run.status)) {
    unsubscribe();
    res.end();
    return;
  }

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  const stop = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on("close", stop);
  res.on("close", stop);
}

function streamSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  registry: RunRegistry,
  sessionId: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  const unsubscribe = registry.subscribeSession(sessionId, (event: SessionEvent) => {
    res.write(`event: ${event.kind}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  const stop = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on("close", stop);
  res.on("close", stop);
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
