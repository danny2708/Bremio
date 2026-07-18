import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor, collectTree, pidAlive } from "./process-supervisor";

const dirs: string[] = [];
const supervisors: ProcessSupervisor[] = [];

afterEach(async () => {
  // Never leave a test's processes behind, whatever the assertions did.
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.terminateAll({ graceMs: 500, forceMs: 2_000 }).catch(() => {});
  }
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

function supervisor(): ProcessSupervisor {
  const created = new ProcessSupervisor();
  supervisors.push(created);
  return created;
}

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-proc-"));
  dirs.push(dir);
  return dir;
}

/**
 * A parent that spawns a grandchild, both writing heartbeats.
 *
 * This is the shape `child.kill()` failed on: killing the parent leaves the
 * grandchild running, and only a tree-aware termination reaches it.
 */
async function treeScript(dir: string): Promise<{ parent: string; markerFile: string }> {
  const markerFile = path.join(dir, "grandchild.log");
  const grandchild = path.join(dir, "grandchild.mjs");
  const parent = path.join(dir, "parent.mjs");

  await fs.writeFile(
    grandchild,
    `import { appendFileSync } from "node:fs";
setInterval(() => appendFileSync(${JSON.stringify(markerFile)}, "tick\\n"), 50);
process.stdout.write(String(process.pid) + "\\n");
`,
    "utf8",
  );
  await fs.writeFile(
    parent,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write("parent " + process.pid + " child " + child.pid + "\\n");
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  return { parent, markerFile };
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("process supervisor", () => {
  it("reports a stop when a run owns nothing", async () => {
    const outcome = await supervisor().terminate("never-started");
    expect(outcome.stopped).toBe(true);
  });

  it("terminates a single spawned process and confirms it is gone", async () => {
    const s = supervisor();
    const child = s.spawn("run-1", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid as number;
    expect(await waitFor(() => pidAlive(pid))).toBe(true);

    const outcome = await s.terminate("run-1", { graceMs: 1_000, forceMs: 3_000 });

    expect(outcome.stopped).toBe(true);
    expect(pidAlive(pid)).toBe(false);
  });

  it("kills a grandchild, not just the process it spawned", async () => {
    const dir = await scratch();
    const { parent, markerFile } = await treeScript(dir);
    const s = supervisor();

    const child = s.spawn("run-tree", process.execPath, [parent], { stdio: "ignore" });
    const parentPid = child.pid as number;

    // Wait until the grandchild is genuinely running: it only writes once it
    // is alive, so this proves the tree exists before we tear it down.
    expect(
      await waitFor(() => {
        try {
          return require("node:fs").statSync(markerFile).size > 0;
        } catch {
          return false;
        }
      }, 10_000),
    ).toBe(true);

    const tree = await collectTree([parentPid]);
    expect(tree.length).toBeGreaterThan(1); // parent + grandchild

    const outcome = await s.terminate("run-tree", { graceMs: 1_500, forceMs: 5_000 });
    expect(outcome.stopped).toBe(true);

    // Every pid in the snapshot must be gone — the grandchild included.
    for (const pid of tree) expect(pidAlive(pid)).toBe(false);

    // And it must have stopped writing: a surviving grandchild would keep
    // appending to a worktree the user believes is finished.
    const sizeAfterKill = (await fs.stat(markerFile)).size;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await fs.stat(markerFile)).size).toBe(sizeAfterKill);
  }, 30_000);

  it("escalates when a process ignores the polite signal", async () => {
    const s = supervisor();
    // Trap SIGTERM so only a forced kill can end it. On Windows there is no
    // SIGTERM to trap, but taskkill without /F is likewise ignorable.
    const child = s.spawn(
      "stubborn",
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const pid = child.pid as number;
    expect(await waitFor(() => pidAlive(pid))).toBe(true);

    const outcome = await s.terminate("stubborn", { graceMs: 600, forceMs: 5_000 });

    expect(outcome.stopped).toBe(true);
    expect(pidAlive(pid)).toBe(false);
  }, 20_000);

  it("delivers the abort to cooperative work but does not call that a stop", async () => {
    const s = supervisor();
    const controller = new AbortController();
    s.registerCancellable("sdk-run", controller);

    const outcome = await s.terminate("sdk-run", { graceMs: 300 });

    // The abort is delivered, but an in-process call keeps running until its
    // own promise settles. Owning no child process proves nothing about
    // whether it stopped, so this must not report success.
    expect(controller.signal.aborted).toBe(true);
    expect(outcome.stopped).toBe(false);
  });

  it("stops tracking a run once it exits by itself", async () => {
    const s = supervisor();
    const child = s.spawn("quick", process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("close", resolve));

    expect(s.livePids("quick")).toHaveLength(0);
  });

  it("terminates every supervised run for a shutdown", async () => {
    const s = supervisor();
    const first = s.spawn("a", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const second = s.spawn("b", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pids = [first.pid as number, second.pid as number];
    expect(await waitFor(() => pids.every(pidAlive))).toBe(true);

    const results = await s.terminateAll({ graceMs: 1_000, forceMs: 3_000 });

    expect([...results.values()].every((outcome) => outcome.stopped)).toBe(true);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
  }, 20_000);

  it("treats an impossible pid as absent", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("degrades to the roots when the tree cannot be enumerated", async () => {
    // A pid that does not exist has no descendants to find; the call must
    // still answer rather than throw, so cancellation is never blocked by it.
    const tree = await collectTree([999_999_99]);
    expect(Array.isArray(tree)).toBe(true);
  });
});

describe("cooperative (SDK) cancellation", () => {
  /** Stand-in for an SDK call: aborts or ignores, settles fast or slow. */
  function sdkCall(
    s: ProcessSupervisor,
    runId: string,
    behaviour: { respectsAbort: boolean; settleAfterMs?: number },
  ): { controller: AbortController; done: Promise<void> } {
    const controller = new AbortController();
    const markSettled = s.registerCancellable(runId, controller, `sdk ${runId}`);

    const done = new Promise<void>((resolve) => {
      const finish = () => {
        markSettled();
        resolve();
      };
      if (behaviour.respectsAbort) {
        controller.signal.addEventListener(
          "abort",
          () => setTimeout(finish, behaviour.settleAfterMs ?? 0),
          { once: true },
        );
      }
      // An SDK that ignores the signal never calls finish, which is exactly
      // the case that must not be reported as cancelled.
    });
    return { controller, done };
  }

  it("confirms a stop when the SDK honours the abort", async () => {
    const s = supervisor();
    const call = sdkCall(s, "respects", { respectsAbort: true });

    const outcome = await s.terminate("respects", { graceMs: 1_000 });
    await call.done;

    expect(call.controller.signal.aborted).toBe(true);
    expect(outcome.stopped).toBe(true);
  });

  it("refuses to claim a stop when the SDK ignores the abort", async () => {
    const s = supervisor();
    sdkCall(s, "ignores", { respectsAbort: false });

    const outcome = await s.terminate("ignores", { graceMs: 400 });

    // No child process exists here. Treating that absence as proof of a stop
    // was the original bug: the SDK call is still running.
    expect(outcome.stopped).toBe(false);
    if (!outcome.stopped) {
      expect(outcome.reason).toContain("did not stop after abort");
      expect(outcome.survivingPids).toEqual([]);
    }
  });

  it("waits out an SDK that settles slowly but within the grace period", async () => {
    const s = supervisor();
    const call = sdkCall(s, "slow", { respectsAbort: true, settleAfterMs: 300 });

    const outcome = await s.terminate("slow", { graceMs: 2_000 });
    await call.done;

    // Slow is not the same as stuck; the grace period exists for exactly this.
    expect(outcome.stopped).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(250);
  });

  it("reports a stop for work that already finished before the cancel", async () => {
    const s = supervisor();
    const call = sdkCall(s, "already-done", { respectsAbort: true });
    call.controller.abort();
    await call.done;

    const outcome = await s.terminate("already-done", { graceMs: 500 });
    expect(outcome.stopped).toBe(true);
  });
});
