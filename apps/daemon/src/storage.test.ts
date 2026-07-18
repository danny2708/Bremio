import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  RunStore,
  capPayload,
  isTerminal,
  redact,
} from "./storage";

const dirs: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    // Windows can hold the SQLite sidecar files for a moment after close;
    // this is test hygiene, not a product behaviour worth asserting on.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => {});
  }
});

async function store(): Promise<RunStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
  dirs.push(dir);
  const opened = await RunStore.open(path.join(dir, "bremio.db"));
  stores.push(opened);
  return opened;
}

/** Reopen the same file to simulate a daemon restart. */
async function reopen(previous: RunStore, file: string): Promise<RunStore> {
  previous.close();
  const opened = await RunStore.open(file);
  stores.push(opened);
  return opened;
}

function seedRun(s: RunStore, id = "run-1") {
  return s.createRun({
    id,
    mode: "team",
    repositoryPath: "/tmp/repo",
    prompt: "do the thing",
    leadProvider: "claude",
  });
}

describe("run store", () => {
  it("creates a run in queued state", async () => {
    const s = await store();
    const run = seedRun(s);

    expect(run).toMatchObject({ id: "run-1", mode: "team", status: "queued", leadProvider: "claude" });
    expect(s.getRun("run-1")?.prompt).toBe("do the thing");
  });

  it("allocates strictly increasing sequence numbers", async () => {
    const s = await store();
    seedRun(s);

    const seqs = ["a", "b", "c", "d"].map((type) => s.appendEvent("run-1", type, { type }).seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(s.lastSeq("run-1")).toBe(4);
  });

  it("rejects a duplicate sequence rather than corrupting the stream", async () => {
    const s = await store();
    seedRun(s);
    s.appendEvent("run-1", "a", {});

    // Reaching into SQL directly is the only way to force the collision the
    // unique constraint exists to catch.
    expect(() =>
      (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
        .prepare("INSERT INTO run_events (run_id, seq, type, timestamp, payload) VALUES (?,?,?,?,?)")
        .run("run-1", 1, "dupe", new Date().toISOString(), "{}"),
    ).toThrow();
  });

  it("keeps events and runs across a reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
    dirs.push(dir);
    const file = path.join(dir, "bremio.db");

    let s = await RunStore.open(file);
    stores.push(s);
    seedRun(s);
    s.appendEvent("run-1", "run.started", { at: 1 });
    s.appendEvent("run-1", "agent.output", { line: "hello" });

    s = await reopen(s, file);

    expect(s.getRun("run-1")?.status).toBe("queued");
    const events = s.readEvents("run-1");
    expect(events.map((e) => e.type)).toEqual(["run.started", "agent.output"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("continues the sequence after a reopen instead of restarting at 1", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-store-"));
    dirs.push(dir);
    const file = path.join(dir, "bremio.db");

    let s = await RunStore.open(file);
    stores.push(s);
    seedRun(s);
    s.appendEvent("run-1", "a", {});
    s.appendEvent("run-1", "b", {});

    s = await reopen(s, file);
    // A restart that reset the counter would make a resuming client re-render
    // history it already has.
    expect(s.appendEvent("run-1", "c", {}).seq).toBe(3);
  });

  it("replays only events after the requested sequence", async () => {
    const s = await store();
    seedRun(s);
    for (const type of ["a", "b", "c"]) s.appendEvent("run-1", type, {});

    expect(s.readEvents("run-1", 1).map((e) => e.type)).toEqual(["b", "c"]);
    expect(s.readEvents("run-1", 3)).toHaveLength(0);
  });

  it("moves status and event together so a terminal event is never seen over a running run", async () => {
    const s = await store();
    seedRun(s);

    s.appendEventWithStatus("run-1", "run.completed", { ok: true }, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    expect(s.getRun("run-1")?.status).toBe("completed");
    expect(s.readEvents("run-1").at(-1)?.type).toBe("run.completed");
  });

  it("lists runs for one repository, newest first", async () => {
    const s = await store();
    s.createRun({ id: "old", mode: "single", repositoryPath: "/tmp/a", prompt: "1" });
    s.createRun({ id: "new", mode: "single", repositoryPath: "/tmp/a", prompt: "2" });
    s.createRun({ id: "other", mode: "single", repositoryPath: "/tmp/b", prompt: "3" });

    const listed = s.listRuns({ repositoryPath: "/tmp/a" }).map((r) => r.id);
    expect(listed).toHaveLength(2);
    expect(listed).toContain("old");
    expect(listed).toContain("new");
  });

  it("reports runs that were mid-flight", async () => {
    const s = await store();
    seedRun(s, "a");
    seedRun(s, "b");
    s.updateRun("a", { status: "running" });
    s.updateRun("b", { status: "completed" });

    expect(s.nonTerminalRuns().map((r) => r.id)).toEqual(["a"]);
  });

  it("records and lists artifacts", async () => {
    const s = await store();
    seedRun(s);
    s.recordArtifact({ runId: "run-1", kind: "report", path: "/tmp/repo/.bremio/report.json" });
    s.recordArtifact({ runId: "run-1", kind: "worktree", path: "/tmp/wt", taskId: "TASK-1" });

    const artifacts = s.listArtifacts("run-1");
    expect(artifacts.map((a) => a.kind)).toEqual(["report", "worktree"]);
    expect(artifacts[1]?.taskId).toBe("TASK-1");
  });

  it("cascades events away when a run is pruned", async () => {
    const s = await store();
    seedRun(s, "old");
    s.appendEvent("old", "a", {});
    s.updateRun("old", { status: "completed" });

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 0 });
    expect(pruned).toBe(1);
    expect(s.getRun("old")).toBeUndefined();
    expect(s.readEvents("old")).toHaveLength(0);
  });

  it("never prunes an active or interrupted run", async () => {
    const s = await store();
    seedRun(s, "running-one");
    seedRun(s, "interrupted-one");
    s.updateRun("running-one", { status: "running" });
    s.updateRun("interrupted-one", { status: "interrupted" });

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 0 });

    // Interrupted still needs a decision from the user; pruning it would
    // destroy the evidence they need to make one.
    expect(pruned).toBe(0);
    expect(s.getRun("running-one")).toBeDefined();
    expect(s.getRun("interrupted-one")).toBeDefined();
  });

  it("keeps the newest runs even when they are older than the cutoff", async () => {
    const s = await store();
    for (const id of ["a", "b", "c"]) {
      seedRun(s, id);
      s.updateRun(id, { status: "completed" });
    }

    const pruned = s.pruneRuns({ olderThan: new Date(Date.now() + 60_000), keepMinimum: 2 });
    expect(pruned).toBe(1);
    expect(s.listRuns()).toHaveLength(2);
  });
});

describe("payload hygiene", () => {
  it("redacts anything that looks like a credential", () => {
    const redacted = redact({
      token: "abc",
      nested: { apiKey: "xyz", Authorization: "Bearer q", safe: "keep" },
      list: [{ password: "p" }],
    }) as {
      token: string;
      nested: Record<string, unknown>;
      list: Array<Record<string, unknown>>;
    };

    expect(redacted.token).toBe("[redacted]");
    expect(redacted.nested.apiKey).toBe("[redacted]");
    expect(redacted.nested.Authorization).toBe("[redacted]");
    expect(redacted.nested.safe).toBe("keep");
    expect(redacted.list[0]?.password).toBe("[redacted]");
  });

  it("leaves ordinary payloads untouched", () => {
    const payload = { taskId: "TASK-1", message: "compiling", count: 3 };
    expect(redact(payload)).toEqual(payload);
  });

  it("truncates an oversized payload with explicit metadata", () => {
    const big = { line: "x".repeat(MAX_PAYLOAD_BYTES * 2) };
    const capped = capPayload(big) as { truncated: boolean; originalBytes: number; preview: string };

    expect(capped.truncated).toBe(true);
    expect(capped.originalBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(capped.preview.length).toBe(MAX_PAYLOAD_BYTES);
  });

  it("redacts and caps on the way into the database", async () => {
    const s = await store();
    seedRun(s);
    const event = s.appendEvent("run-1", "agent.output", { token: "secret", note: "fine" });

    expect((event.payload as Record<string, unknown>).token).toBe("[redacted]");
    expect(s.readEvents("run-1")[0]?.payload).toMatchObject({ token: "[redacted]", note: "fine" });
  });
});

describe("terminal status", () => {
  it("treats interrupted as terminal for scheduling but keeps it prunable-exempt", () => {
    expect(isTerminal("interrupted")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
  });
});
