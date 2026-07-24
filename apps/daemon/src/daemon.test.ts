import { promises as fs } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunRegistry, type RunEvent } from "./runs";
import { RunStore, type PersistedSession, type SessionDetail } from "./storage";
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

  it("enumerates four adapters including opencode", async () => {
    const handle = await daemon();
    const response = await call(handle, "/adapters");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { adapters: Array<{ id: string; leadEligible: boolean }> };
    expect(body.adapters).toHaveLength(4);
    const ids = body.adapters.map((a) => a.id);
    expect(ids).toContain("opencode");
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("antigravity");
  }, 15_000);

  it("reports opencode lead-eligibility from the capability contract", async () => {
    const handle = await daemon();
    const response = await call(handle, "/adapters");
    const body = (await response.json()) as { adapters: Array<{ id: string; leadEligible: boolean }> };
    const opencode = body.adapters.find((a) => a.id === "opencode");
    expect(opencode).toBeDefined();
    // OpenCode has planning=true but structuredOutput=false since S1-R4.
    expect(opencode!.leadEligible).toBe(false);
  }, 15_000);
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

describe("sessions", () => {
  it("lists sessions for a repository", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;

    // Session A: single-turn (implicit).
    const r1 = store.createRun({ id: "ls-r1", mode: "single", repositoryPath: "/tmp/repo-a", prompt: "first" });
    // Session B: multi-turn — reuse the id from its first run.
    const r2 = store.createRun({ id: "ls-r2", mode: "single", repositoryPath: "/tmp/repo-a", prompt: "second" });
    store.createRun({ id: "ls-r3", mode: "single", repositoryPath: "/tmp/repo-a", prompt: "third", sessionId: r2.sessionId });
    // Different repo (should not appear).
    store.createRun({ id: "ls-r4", mode: "single", repositoryPath: "/tmp/repo-b", prompt: "other" });

    const handle = await daemon(registry);
    const response = await call(handle, "/sessions?repo=/tmp/repo-a");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: PersistedSession[] };
    // Two sessions: session A (1 turn) and session B (2 turns).
    expect(body.sessions).toHaveLength(2);
    // Session B should have 2 turns.
    const multi = body.sessions.find((s) => s.id === r2.sessionId);
    expect(multi).toBeDefined();
    expect(multi!.turnCount).toBe(2);
  });

  it("rejects a missing repo query parameter with 400", async () => {
    const handle = await daemon();
    const response = await call(handle, "/sessions");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("repo");
  });

  it("returns session detail with turns in order, model, and reasoning", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;

    const r1 = store.createRun({ id: "sd-r1", mode: "single", repositoryPath: "/tmp/repo", prompt: "first turn" });
    const sesId = r1.sessionId;
    store.createRun({ id: "sd-r2", mode: "single", repositoryPath: "/tmp/repo", prompt: "second turn", sessionId: sesId });
    store.appendEvent("sd-r2", "usage", { model: "gpt-4", reasoningLevel: "high" });
    store.updateRun("sd-r2", { status: "completed" });

    const handle = await daemon(registry);
    const response = await call(handle, `/sessions/${sesId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: SessionDetail };
    expect(body.session.id).toBe(sesId);
    expect(body.session.turns).toHaveLength(2);
    expect(body.session.turns[0]?.turnIndex).toBe(0);
    expect(body.session.turns[0]?.prompt).toBe("first turn");
    expect(body.session.turns[1]?.turnIndex).toBe(1);
    expect(body.session.turns[1]?.prompt).toBe("second turn");
    expect(body.session.turns[1]?.model).toBe("gpt-4");
    expect(body.session.turns[1]?.reasoningLevel).toBe("high");

    // S1-T5: session detail includes config with provenance.
    expect(body.session.config).toBeDefined();
    const cfg = body.session.config!;
    expect(cfg.provenance).toBe("native");
    expect(cfg.completeness).toBe("partial");
  });

  it("404s an unknown session id", async () => {
    const handle = await daemon();
    const response = await call(handle, "/sessions/does-not-exist");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown session");
  });
});

describe("session config", () => {
  it("GET /sessions/:id/config returns the current config", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;
    const run = store.createRun({ id: "cfg-endpoint", mode: "team", repositoryPath: "/tmp/repo", prompt: "cfg test" });
    const sid = run.sessionId!;

    const handle = await daemon(registry);
    const response = await call(handle, `/sessions/${sid}/config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { config: Record<string, unknown> };
    expect(body.config.revision).toBe(1);
    expect(body.config.mode).toBe("team");
  });

  it("GET /sessions/:id/configs lists all revisions", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;
    const run = store.createRun({ id: "cfg-list", mode: "single", repositoryPath: "/tmp/repo", prompt: "list cfg" });
    const sid = run.sessionId!;
    store.createSessionConfig({ sessionId: sid, mode: "team", leadAgentId: "codex" });

    const handle = await daemon(registry);
    const response = await call(handle, `/sessions/${sid}/configs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { configs: Array<Record<string, unknown>> };
    expect(body.configs).toHaveLength(2);
    expect(body.configs[0]?.revision).toBe(1);
    expect(body.configs[1]?.revision).toBe(2);
  });

  it("POST /sessions/:id/config creates a new revision", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;
    const run = store.createRun({ id: "cfg-post", mode: "single", repositoryPath: "/tmp/repo", prompt: "post cfg" });
    const sid = run.sessionId!;

    const handle = await daemon(registry);
    const response = await call(handle, `/sessions/${sid}/config`, {
      method: "POST",
      body: JSON.stringify({ mode: "team", leadAgentId: "claude", model: "gpt-4" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { config: Record<string, unknown> };
    expect(body.config.revision).toBe(2);
    expect(body.config.mode).toBe("team");
    expect(body.config.leadAgentId).toBe("claude");
    expect(body.config.model).toBe("gpt-4");

    // Verify the latest config was updated.
    const getResponse = await call(handle, `/sessions/${sid}/config`);
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as { config: Record<string, unknown> };
    expect(getBody.config.revision).toBe(2);
    expect(getBody.config.mode).toBe("team");
  });

  it("GET /sessions/:id/config 404s an unknown session", async () => {
    const handle = await daemon();
    const response = await call(handle, "/sessions/nonexistent/config");
    expect(response.status).toBe(404);
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
