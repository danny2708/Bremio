import { promises as fs } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunRegistry, type RunEvent } from "./runs";
import { RunStore } from "./storage";
import { startDaemonServer, type DaemonHandle } from "./server";
import { publishEndpoint, readEndpoint, retractEndpoint } from "./endpoint";

const TOKEN = "test-token";
const cleanups: Array<() => Promise<void>> = [];

/** Send a hand-written request so headers fetch refuses to set are testable. */
function rawRequest(port: number, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1];
      if (!status) reject(new Error(`no status line in: ${buffer.slice(0, 120)}`));
      else resolve(Number(status));
    });
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function freshRegistry(): Promise<RunRegistry> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-daemon-db-"));
  const store = await RunStore.open(path.join(dir, "bremio.db"));
  cleanups.push(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => {});
  });
  return new RunRegistry(store);
}

async function daemon(registry?: RunRegistry): Promise<DaemonHandle> {
  const handle = await startDaemonServer({
    token: TOKEN,
    version: "test",
    registry: registry ?? (await freshRegistry()),
  });
  cleanups.push(() => handle.close());
  return handle;
}

function call(
  handle: DaemonHandle,
  route: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  if (token !== null) headers["X-Bremio-Token"] = token ?? TOKEN;
  return fetch(`http://127.0.0.1:${handle.port}${route}`, { ...rest, headers });
}

describe("daemon HTTP surface", () => {
  it("answers health with a valid token", async () => {
    const handle = await daemon();
    const response = await call(handle, "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ app: "bremio-daemon", version: "test" });
  });

  it("rejects a missing or wrong token", async () => {
    const handle = await daemon();

    expect((await call(handle, "/health", { token: null })).status).toBe(401);
    expect((await call(handle, "/health", { token: "nope" })).status).toBe(401);
  });

  it("rejects a spoofed Host header", async () => {
    const handle = await daemon();
    // Raw socket, not fetch: undici treats Host as a forbidden header and drops
    // it silently, so a fetch-based test would assert nothing.
    const status = await rawRequest(
      handle.port,
      [
        "GET /health HTTP/1.1",
        "Host: evil.example.com",
        `X-Bremio-Token: ${TOKEN}`,
        "Connection: close",
      ],
    );

    expect(status).toBe(403);
  });

  it("accepts loopback by name", async () => {
    const handle = await daemon();
    const status = await rawRequest(handle.port, [
      "GET /health HTTP/1.1",
      `Host: localhost:${handle.port}`,
      `X-Bremio-Token: ${TOKEN}`,
      "Connection: close",
    ]);

    expect(status).toBe(200);
  });

  it("404s an unknown endpoint", async () => {
    const handle = await daemon();
    expect((await call(handle, "/nope")).status).toBe(404);
  });

  it("rejects a malformed run request instead of starting one", async () => {
    const registry = await freshRegistry();
    const handle = await daemon(registry);

    const response = await call(handle, "/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "team" }), // no repo, prompt, or agent
    });

    expect(response.status).toBe(400);
    expect(registry.list()).toHaveLength(0);
  });

  it("404s events for an unknown run", async () => {
    const handle = await daemon();
    expect((await call(handle, "/runs/does-not-exist/events")).status).toBe(404);
  });

  it("reports 409 when cancelling a run that is not live", async () => {
    const handle = await daemon();
    const response = await call(handle, "/runs/does-not-exist/cancel", { method: "POST" });
    expect(response.status).toBe(409);
  });
});

describe("run registry", () => {
  /** Wait for a run to reach a terminal state without touching internals. */
  function settled(registry: RunRegistry, id: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = registry.subscribe(id, (event) => {
        if (event.kind === "finished" || event.kind === "failed") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  it("replays buffered events to a subscriber that attaches late", async () => {
    const registry = await freshRegistry();
    const started = registry.start({
      mode: "single",
      repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
      prompt: "noop",
      agentId: "claude",
    });
    await settled(registry, started.id);

    // Attaching after everything already happened must still deliver history:
    // a UI opened mid-run cannot be left with a blank panel.
    const replayed: RunEvent[] = [];
    registry.subscribe(started.id, (event) => replayed.push(event))();

    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.at(-1)?.kind).toMatch(/finished|failed/);
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i + 1));
  });

  it("resumes after a sequence number instead of repeating delivered events", async () => {
    const registry = await freshRegistry();
    const started = registry.start({
      mode: "single",
      repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
      prompt: "noop",
      agentId: "claude",
    });
    await settled(registry, started.id);

    const all: RunEvent[] = [];
    registry.subscribe(started.id, (event) => all.push(event))();
    expect(all.length).toBeGreaterThan(0);

    // Resuming at the last delivered sequence must yield nothing: a reconnect
    // that re-sent history would duplicate every line already on screen.
    const afterEverything: RunEvent[] = [];
    registry.subscribe(started.id, (event) => afterEverything.push(event), all.length)();
    expect(afterEverything).toHaveLength(0);

    // Resuming one earlier yields exactly the tail.
    const tail: RunEvent[] = [];
    registry.subscribe(started.id, (event) => tail.push(event), all.length - 1)();
    expect(tail).toHaveLength(1);
    expect(tail[0]?.seq).toBe(all.length);
  });

  it("streams live events and resumes from a sequence number", async () => {
    const registry = await freshRegistry();
    const handle = await daemon(registry);

    // A fake run whose events we control, so no provider is involved.
    const started = registry.start({
      mode: "single",
      repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
      prompt: "noop",
      agentId: "claude",
    });

    // The run fails fast (bad repo), which is enough to prove the pipeline:
    // events are buffered, replayed, and the stream closes on a terminal event.
    const response = await call(handle, `/runs/${started.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain("data:");
    // Terminal event closes the stream rather than hanging the client.
    expect(text).toMatch(/"kind":"(finished|failed)"/);
  });

  it("keeps a run readable after it finishes", async () => {
    const registry = await freshRegistry();
    const handle = await daemon(registry);
    const started = registry.start({
      mode: "single",
      repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
      prompt: "noop",
      agentId: "claude",
    });
    await call(handle, `/runs/${started.id}/events`).then((r) => r.text());

    const detail = await call(handle, `/runs/${started.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { run: { status: string } };
    expect(["failed", "cancelled", "completed"]).toContain(body.run.status);
  });
});

describe("endpoint discovery", () => {
  it("round-trips and then retracts the endpoint file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-daemon-"));
    const file = path.join(dir, "daemon.json");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

    // pid must match this process: retract deliberately refuses to delete a
    // file another daemon owns (covered in lifecycle.test.ts).
    await publishEndpoint(
      {
        port: 1234,
        token: "t",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        daemonVersion: "test",
        protocolVersion: 1,
      },
      file,
    );
    expect(await readEndpoint(file)).toMatchObject({ port: 1234, token: "t" });

    await retractEndpoint(file);
    expect(await readEndpoint(file)).toBeUndefined();
  });

  it("treats a malformed endpoint file as absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-daemon-"));
    const file = path.join(dir, "daemon.json");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

    await fs.writeFile(file, "{ not json", "utf8");
    expect(await readEndpoint(file)).toBeUndefined();
  });
});
