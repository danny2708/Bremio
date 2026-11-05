import { spawn, spawnSync } from "node:child_process";
import type { VerifyCommand, VerifyCommandResult } from "./schema";

const DEFAULT_TIMEOUT_SEC = 120;
const OUTPUT_TAIL_CHARS = 4000;

let cachedPython: string | null | undefined;

/**
 * The Python interpreter for `python` verify commands, or `null` if none is
 * installed. `BREMIO_BENCH_PYTHON` wins; otherwise `python3` then `python`,
 * because Windows usually only has the latter and Debian only the former.
 */
export function resolvePython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  const candidates = [process.env.BREMIO_BENCH_PYTHON, "python3", "python"].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 && /Python 3\./.test(`${probe.stdout}${probe.stderr}`)) {
      cachedPython = candidate;
      return candidate;
    }
  }
  cachedPython = null;
  return null;
}

function resolveCommand(command: string): string {
  if (command === "node") return process.execPath;
  if (command === "python") {
    const python = resolvePython();
    if (!python) throw new Error("no Python 3 interpreter found (set BREMIO_BENCH_PYTHON)");
    return python;
  }
  return command;
}

function runOne(cwd: string, cmd: VerifyCommand): Promise<VerifyCommandResult> {
  const started = Date.now();
  const timeoutMs = (cmd.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
    };
    let executable: string;
    try {
      executable = resolveCommand(cmd.command);
    } catch (err) {
      resolve({
        command: cmd.command,
        args: cmd.args,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        outputTail: (err as Error).message,
      });
      return;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", NODE_NO_WARNINGS: "1" };
    // Inherited from a parent `node --test`, this makes a child test run
    // report to that parent and exit 0 even when its tests fail.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(executable, cmd.args, { cwd, shell: false, windowsHide: true, env });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      output += `\n${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: cmd.command,
        args: cmd.args,
        exitCode: timedOut ? null : code,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: output.slice(-OUTPUT_TAIL_CHARS),
      });
    });
  });
}

/** Run every verify command in order; the case passes only if all exit 0. */
export async function runVerification(
  cwd: string,
  commands: readonly VerifyCommand[],
): Promise<{ ok: boolean; commands: VerifyCommandResult[] }> {
  const results: VerifyCommandResult[] = [];
  for (const cmd of commands) {
    const result = await runOne(cwd, cmd);
    results.push(result);
    if (result.exitCode !== 0) break; // later commands assume earlier ones held
  }
  return {
    ok: results.length === commands.length && results.every((r) => r.exitCode === 0),
    commands: results,
  };
}
