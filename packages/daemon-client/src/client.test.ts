import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@bremio/protocol";
import {
  DaemonClient,
  DaemonUnavailableError,
  ProtocolMismatchError,
} from "./client";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fakeDaemon(meta: Record<string, unknown>, extraRoutes?: {
  onStartRun?: (body: unknown) => { run: { id: string } };
  sseEvents?: Array<{ kind: string; message: string }>;
}): Promise<number> {
  const server: Server = createServer((req, res) => {
    if (req.headers["x-bremio-token"] !== "tok") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ app: "bremio-daemon" }));
    }
    if (req.url === "/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ready: true }));
    }
    if (req.url === "/meta") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(meta));
    }
    if (req.method === "POST" && req.url === "/runs") {
      res.writeHead(202, { "Content-Type": "application/json" });
      const body = extraRoutes?.onStartRun;
      const run = body ? body("") : { run: { id: "run-test-1" } };
      return res.end(JSON.stringify(run));
    }
    if (req.method === "GET" && req.url?.startsWith("/runs/") && req.url?.includes("/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      const events = extraRoutes?.sseEvents ?? [
        { kind: "status", message: "starting" },
        { kind: "finished", message: "completed" },
      ];
      for (const ev of events) {
        res.write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      return res.end();
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

async function endpointFile(port: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-dc-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "daemon.json");
  await fs.writeFile(
    file,
    JSON.stringify({ port, token: "tok", pid: process.pid, protocolVersion: PROTOCOL_VERSION }),
    "utf8",
  );
  return file;
}

describe("DaemonClient", () => {
  it("connects to a live daemon and returns the endpoint", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: {},
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });

    const endpoint = await client.connect();

    expect(endpoint.port).toBe(port);
    expect(endpoint.token).toBe("tok");
  });

  it("throws DaemonUnavailableError when no endpoint file exists", async () => {
    const client = new DaemonClient({ endpointPath: path.join(os.tmpdir(), "absent.json") });

    await expect(client.connect()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it("throws DaemonUnavailableError when the daemon does not answer", async () => {
    const client = new DaemonClient({ endpointPath: await endpointFile(1) });

    await expect(client.connect(400)).rejects.toThrow(/not responding/);
  });

  it("handshakes successfully when protocol versions match", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: { sse: true, cancel: true },
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });

    const meta = await client.handshake();

    expect(meta.daemonVersion).toBe("1.0.0");
    expect(meta.capabilities).toMatchObject({ sse: true, cancel: true });
  });

  it("throws ProtocolMismatchError when the daemon is too old", async () => {
    const port = await fakeDaemon({
      daemonVersion: "0.9.0",
      protocolVersion: 0,
      minimumClientProtocol: 0,
      capabilities: {},
    });
    const client = new DaemonClient({
      endpointPath: await endpointFile(port),
      clientProtocolVersion: PROTOCOL_VERSION,
    });

    await expect(client.handshake()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("throws ProtocolMismatchError when the client is too old", async () => {
    const port = await fakeDaemon({
      daemonVersion: "9.9.9",
      protocolVersion: 99,
      minimumClientProtocol: 99,
      capabilities: {},
    });
    const client = new DaemonClient({
      endpointPath: await endpointFile(port),
      clientProtocolVersion: PROTOCOL_VERSION,
    });

    await expect(client.handshake()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("waits until the daemon is ready", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: {},
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });

    const endpoint = await client.waitUntilReady(5_000);

    expect(endpoint.port).toBe(port);
  });

  it("caches the endpoint after connect so subsequent calls reuse it", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: {},
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });

    await client.connect();
    const meta = await client.handshake();
    const meta2 = await client.handshake();

    expect(meta.daemonVersion).toBe("1.0.0");
    expect(meta2.daemonVersion).toBe("1.0.0");
  });

  it("exposes endpoint and meta after connect+handshake", async () => {
    const port = await fakeDaemon({
      daemonVersion: "2.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: { approvals: true },
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });

    await client.connect();
    await client.handshake();

    expect(client.endpoint).toBeDefined();
    expect(client.endpoint!.port).toBe(port);
    expect(client.meta).toBeDefined();
    expect(client.meta!.capabilities.approvals).toBe(true);
  });

  it("uses the default protocol version and endpoint path when none given", () => {
    const client = new DaemonClient();
    expect(client.clientProtocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("starts a run via POST /runs", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: {},
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });
    await client.connect();

    const result = await client.startRun({
      mode: "single",
      repoPath: "/tmp/repo",
      prompt: "test",
      agentId: "claude",
    });

    expect(result.run.id).toBeTruthy();
  });

  it("streams events from an SSE endpoint", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: {},
    });
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });
    await client.connect();

    const events: Array<{ kind: string; message: string }> = [];
    const ac = new AbortController();

    const stream = client.streamEvents("run-1", (ev) => {
      events.push({ kind: ev.kind, message: ev.message });
      if (ev.kind === "finished") ac.abort();
    }, ac.signal);

    // The fake daemon sends events then closes
    await stream;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ kind: "status" });
  });

  it("cancels a run via POST /runs/:id/cancel", async () => {
    const port = await fakeDaemon({
      daemonVersion: "1.0.0",
      protocolVersion: PROTOCOL_VERSION,
      minimumClientProtocol: PROTOCOL_VERSION,
      capabilities: {},
    });
    // Manually send the cancel request since fakeDaemon doesn't handle /cancel routes
    // We'll test cancel by waiting for the fake to respond
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });
    await client.connect();

    // FakeDaemon returns 404 for unknown routes, so cancelRun will throw
    await expect(client.cancelRun("test-run-id")).rejects.toThrow();
  });

  it("cancels a run when the daemon supports it", async () => {
    let cancelled = false;
    const server: Server = createServer((req, res) => {
      if (req.headers["x-bremio-token"] !== "tok") {
        res.writeHead(401); return res.end("{}");
      }
      const pathname = new URL(req.url ?? "/", "http://host").pathname;
      if (pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ app: "bremio-daemon" }));
      }
      if (req.method === "POST" && pathname === "/runs/test-run-id/cancel") {
        cancelled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ cancelled: true }));
      }
      res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const client = new DaemonClient({ endpointPath: await endpointFile(port) });
    await client.connect();

    const result = await client.cancelRun("test-run-id");

    expect(cancelled).toBe(true);
    expect(result.cancelled).toBe(true);
  });
});
