import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProcessSupervisor } from "./process-supervisor";
import { CommandTool } from "./command-tool";

/** Long-running node command used by timeout/cancellation tests. */
const SLEEP = `node -e "setTimeout(() => {}, 90000)"`;

describe("CommandTool", () => {
  let supervisor: ProcessSupervisor;
  let tool: CommandTool;

  beforeEach(() => {
    supervisor = new ProcessSupervisor();
    tool = new CommandTool(supervisor, () => ({ allowed: true, reason: "test" }));
  });

  it("executes a simple command and captures stdout", async () => {
    const result = await tool.execute("node", ["-e", "process.stdout.write('hello')"], {
      runId: "test-exec",
    });
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr separately from stdout", async () => {
    const result = await tool.execute(
      "node",
      ["-e", "process.stderr.write('error msg'); process.stdout.write('output')"],
      { runId: "test-stderr" },
    );
    expect(result.stderr).toBe("error msg");
    expect(result.stdout).toBe("output");
    expect(result.exitCode).toBe(0);
  });

  it("reports non-zero exit code", async () => {
    const result = await tool.execute("node", ["-e", "process.exit(42)"], {
      runId: "test-exit",
    });
    expect(result.exitCode).toBe(42);
    expect(result.killed).toBe(false);
  });

  it("passes arguments to the command", async () => {
    const result = await tool.execute(
      "node",
      ["-e", "process.stdout.write(process.argv[1])", "hello-arg"],
      { runId: "test-args" },
    );
    expect(result.stdout).toBe("hello-arg");
  });

  it("runs the command in the specified working directory", async () => {
    const tmpDir = process.env.TEMP || "/tmp";
    const result = await tool.execute("node", ["-e", "process.stdout.write(process.cwd())"], {
      runId: "test-cwd",
      cwd: tmpDir,
    });
    expect(result.stdout).toBe(tmpDir);
  });

  it("passes custom environment variables", async () => {
    const result = await tool.execute(
      "node",
      ["-e", "process.stdout.write(process.env.CMD_TOOL_TEST || 'missing')"],
      { runId: "test-env", env: { CMD_TOOL_TEST: "works" } },
    );
    expect(result.stdout).toBe("works");
  });

  it("times out and kills the process when timeout is exceeded", async () => {
    const result = await tool.execute("node", ["-e", "setTimeout(() => {}, 90000)"], {
      runId: "test-timeout",
      timeout: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.duration).toBeLessThan(10000);
  });

  it("cancels via external AbortSignal", async () => {
    const controller = new AbortController();
    const promise = tool.execute("node", ["-e", "setTimeout(() => {}, 90000)"], {
      runId: "test-signal",
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 200);
    const result = await promise;

    expect(result.killed).toBe(true);
    expect(result.duration).toBeLessThan(10000);
  });

  it("tracks the child in the supervisor during execution and releases on completion", async () => {
    const runId = "test-release";

    // Start a command that runs long enough to verify supervision
    const promise = tool.execute("node", ["-e", "setTimeout(() => process.exit(0), 500)"], {
      runId,
    });
    expect(supervisor.isSupervised(runId)).toBe(true);
    expect(supervisor.livePids(runId).length).toBe(1);
    const pidsDuring = supervisor.livePids(runId);

    await promise;

    expect(supervisor.isSupervised(runId)).toBe(false);
    expect(supervisor.livePids(runId)).toEqual([]);
    // The pid that was tracked during execution should no longer be alive
    for (const pid of pidsDuring) {
      expect(pid).toBeGreaterThan(0);
    }
  });

  it("tracks multiple concurrent commands under different runIds", async () => {
    const [r1, r2] = await Promise.all([
      tool.execute("node", ["-e", "process.stdout.write('first')"], { runId: "conc-1" }),
      tool.execute("node", ["-e", "process.stdout.write('second')"], { runId: "conc-2" }),
    ]);

    expect(r1.stdout).toBe("first");
    expect(r2.stdout).toBe("second");
    expect(supervisor.isSupervised("conc-1")).toBe(false);
    expect(supervisor.isSupervised("conc-2")).toBe(false);
  });

  describe("command permission gate", () => {
    it("never spawns a denied command", async () => {
      const denying = new CommandTool(supervisor, () => ({
        allowed: false,
        reason: "commands are denied in plan mode",
      }));
      const sentinel = path.join(os.tmpdir(), `bremio-cmd-gate-${Date.now()}.txt`);

      await expect(
        denying.execute("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`], {
          runId: "denied-run",
        }),
      ).rejects.toThrow(/commands are denied in plan mode/);

      // The refusal has to happen before the spawn, not after: the proof is
      // that the process left no trace behind.
      expect(existsSync(sentinel)).toBe(false);
      expect(supervisor.isSupervised("denied-run")).toBe(false);
    });

    it("asks about the actual command and arguments", async () => {
      const check = vi.fn().mockReturnValue({ allowed: true, reason: "ok" });
      const gated = new CommandTool(supervisor, check);

      await gated.execute("node", ["-e", "process.stdout.write('x')"], { runId: "asked" });

      expect(check).toHaveBeenCalledWith("command", "node", ["-e", "process.stdout.write('x')"]);
    });
  });
});
