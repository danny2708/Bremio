import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSingleInstanceLock, clearStaleLock, processExists, verifyDaemonAlive } from "./lock";
import {
  cleanLeakedEndpointFiles,
  publishEndpoint,
  readEndpoint,
  retractEndpoint,
} from "./endpoint";
import { DaemonAlreadyRunningError, daemonStatus, startDaemon, stopDaemon } from "./index";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

async function sandbox(): Promise<{ lockFile: string; endpointFile: string; databasePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-life-"));
  dirs.push(dir);
  return {
    lockFile: path.join(dir, "daemon.lock"),
    endpointFile: path.join(dir, "daemon.json"),
    databasePath: path.join(dir, "bremio.db"),
  };
}

function endpoint(port: number, token = "t") {
  return {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    daemonVersion: "test",
    protocolVersion: 1,
  };
}

describe("single-instance lock", () => {
  it("grants the lock to the first caller only", async () => {
    const files = await sandbox();

    const first = await acquireSingleInstanceLock(files);
    expect(first.acquired).toBe(true);

    // No daemon is actually listening, so the second caller finds the holder
    // unverifiable and takes over — but it must never see both as acquired at
    // the same instant through a plain "file exists" check.
    const lockContents = JSON.parse(await fs.readFile(files.lockFile, "utf8")) as { pid: number };
    expect(lockContents.pid).toBe(process.pid);
  });

  it("refuses to start when a real daemon answers", async () => {
    const files = await sandbox();
    const running = await startDaemon({ version: "test", ...files });
    closers.push(() => running.close());

    await expect(startDaemon({ version: "test", ...files })).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  it("takes over a lock whose owner no longer answers", async () => {
    const files = await sandbox();
    // A lock left by a crashed daemon, pointing at a PID that is alive (ours)
    // but is not a Bremio daemon. Trusting the PID would deadlock startup
    // forever; trusting only an authenticated reply resolves it.
    await fs.mkdir(path.dirname(files.lockFile), { recursive: true });
    await fs.writeFile(
      files.lockFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );

    const result = await acquireSingleInstanceLock(files);
    expect(result.acquired).toBe(true);
  });

  it("does not treat a live but unverified PID as a running daemon", async () => {
    const files = await sandbox();
    // Endpoint points at a closed port: nothing can answer.
    await publishEndpoint(endpoint(1), files.endpointFile);
    await fs.writeFile(
      files.lockFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );

    const result = await acquireSingleInstanceLock(files);
    expect(result.acquired).toBe(true);
  });

  it("releases only its own lock", async () => {
    const files = await sandbox();
    const held = await acquireSingleInstanceLock(files);
    expect(held.acquired).toBe(true);

    // Another daemon replaced the lock while this one was shutting down slowly.
    await fs.writeFile(
      files.lockFile,
      JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }),
      "utf8",
    );
    if (held.acquired) await held.release();

    // The newer owner's lock must survive.
    expect(await fs.readFile(files.lockFile, "utf8")).toContain(String(process.pid + 1));
  });

  it("reports a PID that cannot exist as absent", () => {
    expect(processExists(0)).toBe(false);
    expect(processExists(-1)).toBe(false);
    expect(processExists(process.pid)).toBe(true);
  });

  it("does not confirm a daemon on a dead port", async () => {
    expect(await verifyDaemonAlive(endpoint(1), 400)).toBe(false);
  });
});

describe("discovery file", () => {
  it("round-trips the full handshake record", async () => {
    const files = await sandbox();
    await publishEndpoint(endpoint(4321, "secret"), files.endpointFile);

    const read = await readEndpoint(files.endpointFile);
    expect(read).toMatchObject({ port: 4321, token: "secret", daemonVersion: "test", protocolVersion: 1 });
    expect(read?.startedAt).toBeTruthy();
  });

  it("treats an incomplete record as absent rather than half-usable", async () => {
    const files = await sandbox();
    await fs.mkdir(path.dirname(files.endpointFile), { recursive: true });
    // Missing daemonVersion/protocolVersion: a client must not proceed on it.
    await fs.writeFile(files.endpointFile, JSON.stringify({ port: 1, token: "t", pid: 2 }), "utf8");

    expect(await readEndpoint(files.endpointFile)).toBeUndefined();
  });

  it("does not retract a file that belongs to another process", async () => {
    const files = await sandbox();
    await publishEndpoint({ ...endpoint(1), pid: process.pid + 1 }, files.endpointFile);

    await retractEndpoint(files.endpointFile, process.pid);
    expect(await readEndpoint(files.endpointFile)).toBeDefined();
  });

  it("leaves no temp file behind when the rename fails", async () => {
    const files = await sandbox();
    const directory = path.dirname(files.endpointFile);
    // A directory cannot be renamed over by a file, so this fails the rename
    // without stubbing fs — the same step that fails on Windows when the
    // destination is held open.
    await fs.mkdir(files.endpointFile, { recursive: true });

    await expect(publishEndpoint(endpoint(1), files.endpointFile)).rejects.toThrow();

    const leaked = (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
    expect(leaked).toEqual([]);
  });

  it("sweeps temp files orphaned by a start that died before renaming", async () => {
    const files = await sandbox();
    const directory = path.dirname(files.endpointFile);
    const orphan = `${files.endpointFile}.11111111-2222-3333-4444-555555555555.tmp`;
    await fs.writeFile(orphan, "{}", "utf8");
    // An unrelated file with a similar name must survive the sweep.
    const bystander = path.join(directory, "notes.tmp");
    await fs.writeFile(bystander, "keep me", "utf8");

    const removed = await cleanLeakedEndpointFiles(files.endpointFile);

    expect(removed).toBe(1);
    expect(await fs.readdir(directory)).toContain("notes.tmp");
    expect(await fs.readdir(directory)).not.toContain(path.basename(orphan));
  });
});

describe("daemon lifecycle", () => {
  it("publishes discovery only once the port is live", async () => {
    const files = await sandbox();
    const running = await startDaemon({ version: "test", ...files });
    closers.push(() => running.close());

    const published = await readEndpoint(files.endpointFile);
    expect(published?.port).toBe(running.port);
    expect(await verifyDaemonAlive(published!)).toBe(true);
  });

  it("releases the lock when it cannot publish discovery, so the next start is not refused", async () => {
    const files = await sandbox();
    // Make the rename fail: publishing is the final startup step, and it used
    // to run outside the unwind path, so a failure here left the lock held by
    // a process that was not running. Every later start then reported "already
    // running" forever, which is what a user sees as a permanently dead daemon.
    await fs.mkdir(files.endpointFile, { recursive: true });

    await expect(startDaemon({ version: "test", ...files })).rejects.toThrow();

    // The lock must be gone, so a corrected start can take it.
    await expect(fs.readFile(files.lockFile, "utf8")).rejects.toThrow();

    await fs.rm(files.endpointFile, { recursive: true, force: true });
    const running = await startDaemon({ version: "test", ...files });
    closers.push(() => running.close());
    expect((await daemonStatus({ endpointFile: files.endpointFile })).running).toBe(true);
  });

  it("reports running, then not running after a stop", async () => {
    const files = await sandbox();
    const running = await startDaemon({ version: "test", ...files });

    const before = await daemonStatus({ endpointFile: files.endpointFile });
    expect(before.running).toBe(true);

    await running.close();

    const after = await daemonStatus({ endpointFile: files.endpointFile });
    expect(after.running).toBe(false);
  });

  it("removes discovery and lock on graceful shutdown", async () => {
    const files = await sandbox();
    const running = await startDaemon({ version: "test", ...files });
    await running.close();

    expect(await readEndpoint(files.endpointFile)).toBeUndefined();
    await expect(fs.readFile(files.lockFile, "utf8")).rejects.toThrow();
  });

  it("refuses new runs once shutting down", async () => {
    const files = await sandbox();
    const running = await startDaemon({ version: "test", ...files });
    running.registry.stopAccepting();

    expect(() =>
      running.registry.start({
        mode: "single",
        repoPath: path.join(os.tmpdir(), "nope"),
        prompt: "x",
        agentId: "claude",
      }),
    ).toThrow(/shutting down/);

    await running.close();
  });

  it("stops a running daemon through an authenticated request", async () => {
    const files = await sandbox();
    const running = await startDaemon({ version: "test", ...files });
    void running;

    const outcome = await stopDaemon({ endpointFile: files.endpointFile, lockFile: files.lockFile });
    expect(outcome.stopped).toBe(true);
    expect(await readEndpoint(files.endpointFile)).toBeUndefined();
  });

  it("is idempotent when nothing is running", async () => {
    const files = await sandbox();
    const outcome = await stopDaemon({ endpointFile: files.endpointFile, lockFile: files.lockFile });

    expect(outcome.stopped).toBe(false);
    expect(outcome.detail).toContain("no daemon was running");
  });

  it("cleans a stale endpoint left by a crash", async () => {
    const files = await sandbox();
    await publishEndpoint(endpoint(1), files.endpointFile);
    await fs.writeFile(
      files.lockFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );

    const outcome = await stopDaemon({ endpointFile: files.endpointFile, lockFile: files.lockFile });
    expect(outcome.stopped).toBe(false);
    expect(await readEndpoint(files.endpointFile)).toBeUndefined();
    expect(await clearStaleLock(files)).toBe(false); // already gone
  });
});

describe("startup reconciliation", () => {
  it("marks runs left mid-flight as interrupted, not failed", async () => {
    const files = await sandbox();

    const first = await startDaemon({ version: "test", ...files });
    const run = first.store.createRun({
      id: "stranded",
      mode: "team",
      repositoryPath: "/tmp/repo",
      prompt: "long task",
    });
    first.store.updateRun(run.id, { status: "running" });
    // Close without letting the run finish: the crash case.
    await first.close();

    const second = await startDaemon({ version: "test", ...files });
    closers.push(() => second.close());

    expect(second.reconciled).toContain("stranded");
    const recovered = second.store.getRun("stranded");
    // A daemon dying says nothing about whether the task would have succeeded,
    // so this must not be recorded as a failure.
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.failureCode).toBe("daemon_restart");
    expect(second.store.readEvents("stranded").at(-1)?.type).toBe("interrupted");
  });

  it("leaves already-terminal runs untouched", async () => {
    const files = await sandbox();

    const first = await startDaemon({ version: "test", ...files });
    first.store.createRun({ id: "done", mode: "single", repositoryPath: "/tmp/r", prompt: "p" });
    first.store.updateRun("done", { status: "completed" });
    await first.close();

    const second = await startDaemon({ version: "test", ...files });
    closers.push(() => second.close());

    expect(second.reconciled).not.toContain("done");
    expect(second.store.getRun("done")?.status).toBe("completed");
  });
});
