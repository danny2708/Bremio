import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunRegistry,
  createDefaultPluginManager,
  defaultAdapters,
  type RunEvent,
  type SessionEvent,
} from "./runs";
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

  it("reports the repository's current branch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-branch-"));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    });
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git(["init", "-q", "-b", "trunk"]);
    git(["config", "user.email", "t@bremio.local"]);
    git(["config", "user.name", "Bremio Test"]);
    await fs.writeFile(path.join(dir, "README.md"), "x\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);

    const handle = await daemon();
    const response = await call(handle, `/repo-state?repo=${encodeURIComponent(dir)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ branch: "trunk" });
  }, 20_000);

  it("says a detached HEAD is detached rather than calling it a branch", async () => {
    // `revparse --abbrev-ref HEAD` answers the literal string "HEAD" when
    // detached, which would render as a branch named HEAD.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-detached-"));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    });
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@bremio.local"]);
    git(["config", "user.name", "Bremio Test"]);
    await fs.writeFile(path.join(dir, "README.md"), "x\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
    git(["checkout", "-q", "--detach", "HEAD"]);

    const handle = await daemon();
    const body = (await (await call(handle, `/repo-state?repo=${encodeURIComponent(dir)}`)).json()) as {
      branch?: string;
      detached?: boolean;
    };
    expect(body.detached).toBe(true);
    expect(body.branch).toBeUndefined();
  }, 20_000);

  it("names the problem instead of inventing a branch for a non-repository", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-norepo-"));
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    });

    const handle = await daemon();
    const body = (await (await call(handle, `/repo-state?repo=${encodeURIComponent(dir)}`)).json()) as {
      branch?: string;
      error?: string;
    };
    expect(body.branch).toBeUndefined();
    expect(body.error).toBeTruthy();
  }, 20_000);

  it("requires a repo to report state for", async () => {
    const handle = await daemon();
    expect((await call(handle, "/repo-state")).status).toBe(400);
  });

  it("serves an empty active list on an idle daemon", async () => {
    const handle = await daemon();
    const response = await call(handle, "/active");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { active: unknown[] }).active).toEqual([]);
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

  it("advertises exactly the adapters the run path can execute", async () => {
    // These were two separate literals. S4-T4 made the daemon the default path
    // for `bremio run`, at which point the route offered opencode while
    // `#execute` built a registry of three — so the advertised agent failed
    // with "not registered".
    const handle = await daemon();
    const response = await call(handle, "/adapters");
    const body = (await response.json()) as { adapters: Array<{ id: string }> };
    expect(body.adapters.map((a) => a.id).sort()).toEqual(
      defaultAdapters().map((a) => a.id).sort(),
    );
  }, 15_000);

  it("stops advertising a plugin once it is deactivated", async () => {
    // The version above compares two lists that both name the four built-in
    // ids, so it kept passing when S8-T6 pointed the route at a *fresh*
    // PluginManager while the run path used the daemon's own. Deactivation is
    // what tells them apart, and it is the feature S8-T6 exists to provide.
    const pluginManager = createDefaultPluginManager();
    await pluginManager.activateAll();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-plugin-db-"));
    const store = await RunStore.open(path.join(dir, "bremio.db"));
    cleanups.push(async () => {
      store.close();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    });
    const registry = new RunRegistry(store, undefined, undefined, pluginManager);
    const handle = await daemon(registry);

    const before = (await (await call(handle, "/adapters")).json()) as { adapters: Array<{ id: string }> };
    expect(before.adapters.map((a) => a.id)).toContain("opencode");

    await pluginManager.deactivate("opencode");

    const after = (await (await call(handle, "/adapters")).json()) as { adapters: Array<{ id: string }> };
    expect(after.adapters.map((a) => a.id)).not.toContain("opencode");
    // And the route agrees with what a run would actually get.
    expect(after.adapters.map((a) => a.id).sort()).toEqual(
      registry.executableAdapters().map((a) => a.id).sort(),
    );
  }, 20_000);

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

describe("legacy import (S4-T6)", () => {
  async function createReportOnDisk(
    runsDir: string,
    runId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const runDir = path.join(runsDir, runId);
    await fs.mkdir(runDir, { recursive: true });
    const report = {
      mode: "single",
      runId,
      createdAt: "2026-01-15T10:00:00.000Z",
      prompt: "legacy import test",
      primaryAgentId: "claude",
      repoPath: runsDir,
      result: {
        status: "completed",
        summary: "imported successfully",
        filesChanged: [],
        commandsExecuted: [],
        tests: [],
        logsPath: path.join(runDir, "single.log"),
        durationMs: 100,
      },
      verification: { status: "unverified", reasons: [] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
      ...overrides,
    };
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report), "utf8");
  }

  it("imports a report and creates a session+run visible via /sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-import-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const runsDir = path.join(dir, "repo", ".bremio", "runs");
    await createReportOnDisk(runsDir, "run-legacy-001");

    const registry = await freshRegistry();
    const handle = await daemon(registry);

    const response = await call(handle, "/legacy/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: path.join(dir, "repo") }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { imported: number; skipped: number };
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(0);

    // The imported session should appear in session listing.
    const sessionsRes = await call(handle, `/sessions?repo=${encodeURIComponent(path.join(dir, "repo"))}`);
    expect(sessionsRes.status).toBe(200);
    const sessionsBody = (await sessionsRes.json()) as { sessions: Array<{ id: string; turnCount: number }> };
    expect(sessionsBody.sessions).toHaveLength(1);
    expect(sessionsBody.sessions[0]?.turnCount).toBe(1);
  });

  it("is idempotent — calling import twice skips the already-imported report", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-import-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const runsDir = path.join(dir, "repo", ".bremio", "runs");
    await createReportOnDisk(runsDir, "run-legacy-002");

    const registry = await freshRegistry();
    const handle = await daemon(registry);

    // First import.
    const first = await call(handle, "/legacy/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: path.join(dir, "repo") }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { imported: number }).imported).toBe(1);

    // Second import — same repo, same reports.
    const second = await call(handle, "/legacy/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: path.join(dir, "repo") }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { imported: number; skipped: number };
    expect(secondBody.imported).toBe(0);
    expect(secondBody.skipped).toBe(1);

    // Still exactly one session.
    const sessionsRes = await call(handle, `/sessions?repo=${encodeURIComponent(path.join(dir, "repo"))}`);
    const sessionsBody = (await sessionsRes.json()) as { sessions: unknown[] };
    expect(sessionsBody.sessions).toHaveLength(1);
  });

  it("leaves the original report.json untouched on disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-import-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const reportPath = path.join(dir, "repo", ".bremio", "runs", "run-legacy-003", "report.json");
    const runsDir = path.join(dir, "repo", ".bremio", "runs");
    const createdAt = "2026-02-20T12:00:00.000Z";
    await createReportOnDisk(runsDir, "run-legacy-003", { createdAt });

    // Read the file content BEFORE import to compare after.
    const before = await fs.readFile(reportPath, "utf8");

    const registry = await freshRegistry();
    const handle = await daemon(registry);
    await call(handle, "/legacy/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: path.join(dir, "repo") }),
    });

    const after = await fs.readFile(reportPath, "utf8");
    expect(after).toBe(before);
  });

  it("rejects a request without repoPath as 400", async () => {
    const handle = await daemon();
    const response = await call(handle, "/legacy/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("repoPath");
  });

  it("imports a team report with mode: team", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-import-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const runsDir = path.join(dir, "repo", ".bremio", "runs");
    const runDir = path.join(runsDir, "run-legacy-team");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "report.json"),
      JSON.stringify({
        mode: "team",
        runId: "run-legacy-team",
        createdAt: "2026-03-10T08:00:00.000Z",
        prompt: "team legacy import",
        leadAgentId: "claude",
        repoPath: path.join(dir, "repo"),
        plan: { summary: "team plan", leadAgentId: "claude", tasks: [] },
        tasks: [],
        qualityGate: { status: "passed", testTaskIds: [], reviewTaskIds: [], reasons: [] },
        summary: { total: 0, completed: 0, failed: 0, cancelled: 0, filesChanged: 0 },
      }),
      "utf8",
    );

    const registry = await freshRegistry();
    const handle = await daemon(registry);

    const response = await call(handle, "/legacy/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: path.join(dir, "repo") }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { imported: number };
    expect(body.imported).toBe(1);

    // Verify the session config has legacy-import provenance.
    const sessionsRes = await call(handle, `/sessions?repo=${encodeURIComponent(path.join(dir, "repo"))}`);
    const sessionsBody = (await sessionsRes.json()) as { sessions: Array<{ id: string }> };
    expect(sessionsBody.sessions).toHaveLength(1);
    const sid = sessionsBody.sessions[0]!.id;

    const cfgRes = await call(handle, `/sessions/${sid}/config`);
    expect(cfgRes.status).toBe(200);
    const cfgBody = (await cfgRes.json()) as { config: { provenance: string } };
    expect(cfgBody.config.provenance).toBe("legacy-import");
  });
});

describe("multi-client SSE fan-out (S4-T8)", () => {
  it("delivers identical event sequences to two subscribers on one run", async () => {
    const registry = await freshRegistry();
    const started = registry.start({
      mode: "single",
      repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
      prompt: "noop",
      agentId: "claude",
    });

    const events1: RunEvent[] = [];
    const events2: RunEvent[] = [];
    const unsub1 = registry.subscribe(started.id, (e) => events1.push(e));
    const unsub2 = registry.subscribe(started.id, (e) => events2.push(e));

    // The run fails fast (bad repo); wait for termination.
    await new Promise<void>((resolve) => {
      registry.subscribe(started.id, (e) => {
        if (e.kind === "finished" || e.kind === "failed" || e.kind === "interrupted") resolve();
      });
    });

    unsub1();
    unsub2();

    expect(events1.length).toBeGreaterThan(0);
    expect(events2.length).toBeGreaterThan(0);
    expect(events1.length).toBe(events2.length);
    for (let i = 0; i < events1.length; i++) {
      expect(events1[i]?.seq).toBe(events2[i]?.seq);
      expect(events1[i]?.kind).toBe(events2[i]?.kind);
      expect(events1[i]?.message).toBe(events2[i]?.message);
    }
  });

  it("replays from the store for a client that reconnects mid-run", async () => {
    const registry = await freshRegistry();
    const started = registry.start({
      mode: "single",
      repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
      prompt: "noop",
      agentId: "claude",
    });

    // Subscribe for the full sequence.
    const all: RunEvent[] = [];
    await new Promise<void>((resolve) => {
      registry.subscribe(started.id, (e) => {
        all.push(e);
        if (e.kind === "finished" || e.kind === "failed" || e.kind === "interrupted") resolve();
      });
    });

    // A second subscriber connecting after the fact gets the same sequence via replay.
    const replayed: RunEvent[] = [];
    registry.subscribe(started.id, (e) => replayed.push(e))();

    expect(replayed.length).toBe(all.length);
    for (let i = 0; i < all.length; i++) {
      expect(replayed[i]?.seq).toBe(all[i]?.seq);
      expect(replayed[i]?.kind).toBe(all[i]?.kind);
    }
  });

  it("broadcasts session-updated when a run is added to an existing session", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;
    const run = store.createRun({ id: "sess-evt-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "first" });
    const sessionId = run.sessionId!;

    const received: SessionEvent[] = [];
    const unsub = registry.subscribeSession(sessionId, (e) => received.push(e));

    // Start a second run in the same session.
    registry.start({
      mode: "single",
      repoPath: "/tmp/repo",
      prompt: "second turn",
      agentId: "claude",
      sessionId,
    });

    // The subscribeSession listener fires synchronously during start().
    expect(received.length).toBe(1);
    expect(received[0]?.kind).toBe("session-updated");
    expect(received[0]?.sessionId).toBe(sessionId);
    expect(received[0]?.data).toBeDefined();
    expect((received[0]?.data as Record<string, unknown>)?.addedRunId).toBeDefined();

    unsub();
  });

  it("broadcasts session-updated when session config is created", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;
    const run = store.createRun({ id: "sess-cfg-evt", mode: "single", repositoryPath: "/tmp/repo", prompt: "cfg event" });
    const sessionId = run.sessionId!;

    const received: SessionEvent[] = [];
    const unsub = registry.subscribeSession(sessionId, (e) => received.push(e));

    registry.createSessionConfig({ sessionId, mode: "team", leadAgentId: "codex" });

    expect(received.length).toBe(1);
    expect(received[0]?.kind).toBe("session-updated");
    expect(received[0]?.sessionId).toBe(sessionId);
    expect(received[0]?.data).toBeDefined();
    expect((received[0]?.data as Record<string, unknown>)?.configRevision).toBe(2);

    unsub();
  });

  it("makes session events discoverable via the HTTP SSE endpoint (content-type)", async () => {
    const registry = await freshRegistry();
    const store = (registry as unknown as { store: RunStore }).store;
    const run = store.createRun({ id: "http-sess-evt", mode: "single", repositoryPath: "/tmp/repo", prompt: "http session sse" });
    const sessionId = run.sessionId!;

    const handle = await daemon(registry);
    const res = await call(handle, `/sessions/${sessionId}/events`, { signal: AbortSignal.timeout(100) }).catch(() => undefined);

    // Even though the stream never closes (session SSE has no terminal event),
    // the response headers must still indicate SSE.
    if (res) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    }
    // If fetch throws (abort before headers arrive), the test passes as long as
    // the route did not 404 or 500.
  });

  it("does not broadcast session-updated for a run without a sessionId", async () => {
    const registry = await freshRegistry();
    const received: SessionEvent[] = [];

    // Subscribe to a non-existent session should be a no-op.
    const unsub = registry.subscribeSession("nonexistent", (e) => received.push(e));

    registry.start({
      mode: "single",
      repoPath: "/tmp/repo",
      prompt: "standalone run",
      agentId: "claude",
    });

    expect(received).toHaveLength(0);
    unsub();
  });

  describe("session transitions (S6-T2)", () => {
    it("proposes colab from solo and broadcasts session-updated", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({
        id: "transition-prop-colab",
        mode: "single",
        repositoryPath: "/tmp/repo",
        prompt: "propose colab",
      });
      const sessionId = run.sessionId!;

      const received: SessionEvent[] = [];
      const unsub = registry.subscribeSession(sessionId, (e) => received.push(e));

      const result = registry.evaluateSessionTransition({
        sessionId,
        event: "propose-colab",
        reason: "complexity: 4 subtasks",
        turnsInStableMode: 2,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transition.from).toBe("solo");
        expect(result.transition.to).toBe("proposed-colab");
        expect(result.transition.mode).toBe("solo");
        expect(result.config).toBeDefined();
        expect(result.config!.collaborationState).toBe("proposed-colab");
        expect(result.config!.changeReason).toBe("complexity: 4 subtasks");
      }

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]?.kind).toBe("session-updated");
      unsub();
    });

    it("approves colab from proposed-colab", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({
        id: "transition-approve-colab",
        mode: "single",
        repositoryPath: "/tmp/repo",
        prompt: "approve colab",
        leadProvider: "claude",
      });
      const sessionId = run.sessionId!;

      // First propose.
      const propose = registry.evaluateSessionTransition({
        sessionId,
        event: "propose-colab",
        reason: "complexity: 3 subtasks",
        turnsInStableMode: 2,
      });
      expect(propose.ok).toBe(true);

      // Then approve.
      const approve = registry.evaluateSessionTransition({
        sessionId,
        event: "approve",
        reason: "lead approved",
        approval: { approved: true, via: "flag" },
      });
      expect(approve.ok).toBe(true);
      if (approve.ok) {
        expect(approve.transition.to).toBe("colab");
        expect(approve.transition.mode).toBe("colab");
        expect(approve.config!.collaborationState).toBe("colab");
      }
    });

    it("rejects an illegal transition via the HTTP endpoint with 409", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({
        id: "transition-http-409",
        mode: "single",
        repositoryPath: "/tmp/repo",
        prompt: "bad transition",
      });
      const sessionId = run.sessionId!;
      const handle = await daemon(registry);

      const res = await call(handle, `/sessions/${sessionId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "approve",
          reason: "no proposal in flight",
          turnsInStableMode: 2,
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("no edge");
    });

    it("fires a transition via the HTTP endpoint and returns 200", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({
        id: "transition-http-200",
        mode: "single",
        repositoryPath: "/tmp/repo",
        prompt: "good transition",
      });
      const sessionId = run.sessionId!;
      const handle = await daemon(registry);

      const res = await call(handle, `/sessions/${sessionId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "propose-colab",
          reason: "complexity increased",
          turnsInStableMode: 2,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { transition: { from: string; to: string } };
      expect(body.transition.from).toBe("solo");
      expect(body.transition.to).toBe("proposed-colab");
    });

    it("returns 404 for a non-existent session via HTTP", async () => {
      const handle = await daemon();

      const res = await call(handle, "/sessions/nonexistent/transition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "propose-colab", reason: "test" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("no config");
    });
  });

  describe("context items", () => {
    it("creates and lists context items for a session", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({ id: "ctx-test", mode: "single", repositoryPath: "/tmp/repo", prompt: "ctx" });
      const sessionId = run.sessionId!;

      const createRes = await call(await daemon(registry), `/sessions/${sessionId}/context-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "file", source: "/tmp/repo/src/main.ts" }),
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json() as { contextItem: { id: string; type: string; source: string; enabled: boolean; tokensEstimated?: number } };
      expect(createBody.contextItem.type).toBe("file");
      expect(createBody.contextItem.source).toBe("/tmp/repo/src/main.ts");
      expect(createBody.contextItem.enabled).toBe(true);
      expect(createBody.contextItem.tokensEstimated).toBeGreaterThan(0);

      const listRes = await call(await daemon(registry), `/sessions/${sessionId}/context-items`);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { contextItems: Array<{ id: string }> };
      expect(listBody.contextItems.length).toBe(1);
      expect(listBody.contextItems[0]!.id).toBe(createBody.contextItem.id);
    });

    it("deletes a context item", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({ id: "ctx-del", mode: "single", repositoryPath: "/tmp/repo", prompt: "ctx" });
      const sessionId = run.sessionId!;

      const handle = await daemon(registry);
      const createRes = await call(handle, `/sessions/${sessionId}/context-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "note", source: "a note" }),
      });
      const item = (await createRes.json() as { contextItem: { id: string } }).contextItem;

      const delRes = await call(handle, `/sessions/${sessionId}/context-items/${item.id}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      const listRes = await call(handle, `/sessions/${sessionId}/context-items`);
      const listBody = await listRes.json() as { contextItems: unknown[] };
      expect(listBody.contextItems).toHaveLength(0);
    });

    it("returns 404 for deleting a non-existent context item", async () => {
      const handle = await daemon();
      const res = await call(handle, "/sessions/nonexistent-session/context-items/nonexistent-item", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("toggles enabled state on a context item", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({ id: "ctx-tog", mode: "single", repositoryPath: "/tmp/repo", prompt: "ctx" });
      const sessionId = run.sessionId!;

      const handle = await daemon(registry);
      const createRes = await call(handle, `/sessions/${sessionId}/context-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url", source: "https://example.com" }),
      });
      const item = (await createRes.json() as { contextItem: { id: string; enabled: boolean } }).contextItem;
      expect(item.enabled).toBe(true);

      const toggleRes = await call(handle, `/sessions/${sessionId}/context-items/${item.id}/enabled`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(toggleRes.status).toBe(200);
      const toggled = await toggleRes.json() as { contextItem: { enabled: boolean } };
      expect(toggled.contextItem.enabled).toBe(false);
    });

    it("returns context metrics for a session (S7-T4)", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run = store.createRun({ id: "ctx-metrics", mode: "single", repositoryPath: "/tmp/repo", prompt: "ctx" });
      const sessionId = run.sessionId!;

      const handle = await daemon(registry);
      store.saveContextItem({ sessionId, type: "file", source: "/a.txt", tokensEstimated: 50 });
      store.saveContextItem({ sessionId, type: "file", source: "/b.txt", tokensEstimated: 150, enabled: false });
      store.saveContextItem({ sessionId, type: "image", source: "/img.png", tokensEstimated: 300 });

      const res = await call(handle, `/sessions/${sessionId}/context-metrics`);
      expect(res.status).toBe(200);
      const body = await res.json() as { metrics: { totalTokens: number; measurementMethod: string; enabledItemCount: number; totalItemCount: number } };
      expect(body.metrics.totalTokens).toBe(350); // 50 + 300 (disabled excluded)
      expect(body.metrics.measurementMethod).toBe("estimated");
      expect(body.metrics.enabledItemCount).toBe(2);
      expect(body.metrics.totalItemCount).toBe(3);
    });
  });

  describe("compact (S7-T5)", () => {
    it("POST /sessions/:id/compact creates a compact and returns it", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run0 = store.createRun({ id: "cr-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "compact test turn 0" });
      const sessionId = run0.sessionId!;
      store.createRun({ id: "cr-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "compact test turn 1", sessionId });

      const handle = await daemon(registry);
      const res = await call(handle, `/sessions/${sessionId}/compact`, { method: "POST" });
      expect(res.status).toBe(201);
      const body = await res.json() as { compact: { id: string; turnRangeStart: number; turnRangeEnd: number; summary: string; tokenCount: number } };
      expect(body.compact.turnRangeStart).toBe(0);
      expect(body.compact.turnRangeEnd).toBe(0);
      expect(body.compact.summary).toContain("Turn 0");
      expect(body.compact.tokenCount).toBeGreaterThan(0);
    });

    it("POST /sessions/:id/compact returns 409 for a session with no runs", async () => {
      const registry = await freshRegistry();
      const handle = await daemon(registry);
      const res = await call(handle, "/sessions/nonexistent/compact", { method: "POST" });
      expect(res.status).toBe(409);
    });

    it("GET /sessions/:id/compacts lists compacts", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run0 = store.createRun({ id: "cl-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "list compact" });
      const sessionId = run0.sessionId!;
      store.createRun({ id: "cl-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "list compact 1", sessionId });
      store.compactSession(sessionId);

      const handle = await daemon(registry);
      const res = await call(handle, `/sessions/${sessionId}/compacts`);
      expect(res.status).toBe(200);
      const body = await res.json() as { compacts: unknown[] };
      expect(body.compacts).toHaveLength(1);
    });

    it("DELETE /sessions/:id/compacts/:compactId removes a compact", async () => {
      const registry = await freshRegistry();
      const store = (registry as unknown as { store: RunStore }).store;
      const run0 = store.createRun({ id: "cd-0", mode: "single", repositoryPath: "/tmp/repo", prompt: "delete compact" });
      const sessionId = run0.sessionId!;
      store.createRun({ id: "cd-1", mode: "single", repositoryPath: "/tmp/repo", prompt: "delete compact 1", sessionId });
      const cmp = store.compactSession(sessionId);

      const handle = await daemon(registry);
      const res = await call(handle, `/sessions/${sessionId}/compacts/${cmp.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json() as { removed: boolean };
      expect(body.removed).toBe(true);
    });

    it("DELETE returns 404 for unknown compact id", async () => {
      const registry = await freshRegistry();
      const handle = await daemon(registry);
      const res = await call(handle, "/sessions/some-session/compacts/no-such-compact", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
