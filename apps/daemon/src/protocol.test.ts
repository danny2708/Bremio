import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type RunningDaemon } from "./index";
import { MINIMUM_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "./endpoint";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

async function daemon(): Promise<RunningDaemon> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-proto-"));
  dirs.push(dir);
  const running = await startDaemon({
    version: "test",
    lockFile: path.join(dir, "daemon.lock"),
    endpointFile: path.join(dir, "daemon.json"),
    databasePath: path.join(dir, "bremio.db"),
  });
  closers.push(() => running.close());
  return running;
}

function call(d: RunningDaemon, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${d.port}${route}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "X-Bremio-Token": d.token },
  });
}

/** Drive a run to a terminal state without spending provider quota. */
async function failedRun(d: RunningDaemon): Promise<string> {
  const started = d.registry.start({
    mode: "single",
    repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
    prompt: "noop",
    agentId: "claude",
  });
  await new Promise<void>((resolve) => {
    const unsubscribe = d.registry.subscribe(started.id, (event) => {
      if (event.kind === "finished" || event.kind === "failed") {
        unsubscribe();
        resolve();
      }
    });
  });
  return started.id;
}

describe("protocol handshake", () => {
  it("advertises versions and capabilities", async () => {
    const d = await daemon();
    const meta = (await (await call(d, "/meta")).json()) as {
      protocolVersion: number;
      minimumClientProtocol: number;
      capabilities: Record<string, boolean>;
    };

    expect(meta.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(meta.minimumClientProtocol).toBe(MINIMUM_CLIENT_PROTOCOL);
    expect(meta.capabilities).toMatchObject({
      sse: true,
      sseResume: true,
      persistentRuns: true,
      persistentEvents: true,
      retry: true,
    });
  });

  it("reports resume as unsupported rather than offering a fake button", async () => {
    const d = await daemon();
    const meta = (await (await call(d, "/meta")).json()) as { capabilities: { resume: boolean } };

    // No adapter can resume mid-run; claiming otherwise would silently restart.
    expect(meta.capabilities.resume).toBe(false);
  });

  it("requires a token for metadata", async () => {
    const d = await daemon();
    const response = await fetch(`http://127.0.0.1:${d.port}/meta`);
    expect(response.status).toBe(401);
  });

  it("separates readiness from liveness", async () => {
    const d = await daemon();

    expect((await call(d, "/health")).status).toBe(200);
    const ready = await call(d, "/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, acceptingRuns: true });
  });

  it("stops answering once shutdown completes", async () => {
    const d = await daemon();
    await call(d, "/shutdown", { method: "POST" });

    // Poll rather than sleeping a fixed amount: shutdown takes as long as it
    // takes, and a fixed delay makes this flaky under load.
    const deadline = Date.now() + 5_000;
    let stillAnswering = true;
    while (Date.now() < deadline && stillAnswering) {
      try {
        await call(d, "/ready");
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        stillAnswering = false;
      }
    }

    expect(stillAnswering).toBe(false);
  });
});

describe("SSE contract", () => {
  it("emits stable ids scoped to the run and a named event type", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    const text = await (await call(d, `/runs/${id}/events`)).text();

    expect(text).toContain(`id: ${id}:1`);
    expect(text).toMatch(/event: (failed|finished)/);
    expect(text).toContain("data: {");
  });

  it("resumes from Last-Event-ID without repeating delivered events", async () => {
    const d = await daemon();
    const id = await failedRun(d);
    const last = d.store.lastSeq(id);

    const resumed = await (
      await call(d, `/runs/${id}/events`, { headers: { "Last-Event-ID": `${id}:${last}` } })
    ).text();

    // Everything was already delivered, so the stream must carry no data
    // frames — a reconnect that replayed would duplicate the whole log.
    expect(resumed).not.toContain("data: {");
  });

  it("ignores a Last-Event-ID belonging to a different run", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    const text = await (
      await call(d, `/runs/${id}/events`, { headers: { "Last-Event-ID": "some-other-run:99" } })
    ).text();

    // Trusting another run's position would silently skip this run's history.
    expect(text).toContain(`id: ${id}:1`);
  });

  it("closes the stream on a terminal event", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    // Resolving at all proves the server ended the response rather than
    // holding the client open forever.
    const text = await (await call(d, `/runs/${id}/events`)).text();
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("recovery actions", () => {
  it("offers retry but never resume", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    const detail = (await (await call(d, `/runs/${id}`)).json()) as {
      recovery: { canRetry: boolean; canResume: boolean };
    };
    expect(detail.recovery.canRetry).toBe(true);
    expect(detail.recovery.canResume).toBe(false);
  });

  it("creates a new run linked to the original and leaves it intact", async () => {
    const d = await daemon();
    const id = await failedRun(d);
    const originalEvents = d.store.readEvents(id).length;

    const response = await call(d, `/runs/${id}/retry`, { method: "POST" });
    expect(response.status).toBe(202);
    const { run } = (await response.json()) as { run: { id: string; retryOfRunId?: string } };

    expect(run.id).not.toBe(id);
    expect(run.retryOfRunId).toBe(id);
    // The original is the record of what went wrong; a retry that overwrote it
    // would destroy the reason for retrying.
    expect(d.store.getRun(id)?.status).toBe("failed");
    expect(d.store.readEvents(id)).toHaveLength(originalEvents);
  });

  it("refuses to retry a run that is still in flight", async () => {
    const d = await daemon();
    d.store.createRun({ id: "busy", mode: "single", repositoryPath: "/tmp/r", prompt: "p" });
    d.store.updateRun("busy", { status: "running" });

    const response = await call(d, "/runs/busy/retry", { method: "POST" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("still running");
  });

  it("404s an unknown run and 409s its retry", async () => {
    const d = await daemon();
    expect((await call(d, "/runs/nope")).status).toBe(404);
    expect((await call(d, "/runs/nope/retry", { method: "POST" })).status).toBe(409);
  });

  it("can retry an interrupted run", async () => {
    const d = await daemon();
    d.store.createRun({ id: "stranded", mode: "team", repositoryPath: "/tmp/r", prompt: "p" });
    d.store.updateRun("stranded", { status: "interrupted" });

    const response = await call(d, "/runs/stranded/retry", { method: "POST" });
    expect(response.status).toBe(202);
  });
});
