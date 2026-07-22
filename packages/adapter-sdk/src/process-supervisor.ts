import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Central owner of everything a run spawns.
 *
 * Adapters used to each keep their own child map and call `child.kill()`, which
 * only reaches the process they started. `codex` and `agy` spawn their own
 * children, so those grandchildren survived cancellation and kept writing to a
 * worktree the user believed was finished. Ownership lives here instead, keyed
 * by run, so a cancellation can address the whole tree.
 *
 * Two kinds of work are supervised:
 *   - spawned processes, terminated by process group (POSIX) or `taskkill /T`
 *     (Windows, since a real Job Object would need a native addon);
 *   - cooperative work such as the Claude SDK, which owns no process and can
 *     only be asked to stop through an AbortSignal.
 *
 * Termination is never assumed to have worked. The tree is enumerated before
 * signalling and re-checked afterwards, and an unconfirmed stop is reported as
 * a failure rather than quietly called cancelled.
 */

export interface TerminateOptions {
  /** How long a process gets to exit politely before escalating. */
  graceMs?: number;
  /** How long to wait for the forced kill to take effect. */
  forceMs?: number;
}

export type TerminationOutcome =
  | { stopped: true; escalated: boolean; killedPids: number[]; durationMs: number }
  | {
      stopped: false;
      reason: string;
      survivingPids: number[];
      escalated: boolean;
      durationMs: number;
    };

/**
 * In-process work that owns no child process, such as an SDK call.
 *
 * Aborting only *requests* a stop. The call keeps running until its promise
 * settles, so `settled` is what proves it actually ended — the absence of a
 * child process proves nothing at all.
 */
interface CooperativeWork {
  controller: AbortController;
  settled: Promise<void>;
  isSettled: boolean;
  label: string;
}

interface Supervised {
  children: Set<ChildProcess>;
  cooperative: Set<CooperativeWork>;
  /**
   * Absolute directory this run works in, when known. Used only to look for
   * survivors after a termination that otherwise looked clean — see
   * `findWorkspaceStrays`.
   */
  workspacePath?: string;
  /** When supervision began; a stray must have started after this. */
  startedAtMs: number;
}

const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_FORCE_MS = 5_000;

export interface ProcessSupervisorOptions {
  /**
   * How the process table is read when looking for orphaned survivors.
   * Defaults to the real enumeration; injectable so the wiring can be tested
   * without depending on a live process table, which is best-effort and goes
   * quiet under load.
   */
  readProcessDetails?: () => Promise<ProcessDetail[]>;
}

export class ProcessSupervisor {
  readonly #runs = new Map<string, Supervised>();
  readonly #readProcessDetails: () => Promise<ProcessDetail[]>;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.#readProcessDetails = options.readProcessDetails ?? readProcessDetails;
  }

  #entry(runId: string): Supervised {
    let entry = this.#runs.get(runId);
    if (!entry) {
      entry = { children: new Set(), cooperative: new Set(), startedAtMs: Date.now() };
      this.#runs.set(runId, entry);
    }
    return entry;
  }

  /**
   * Spawn a process owned by `runId`.
   *
   * On POSIX the child is detached so it leads its own process group, which is
   * what makes `kill(-pgid)` reach its descendants. On Windows `detached` opens
   * a new console instead, so it is deliberately not set there; the tree is
   * handled by `taskkill /T`.
   */
  spawn(runId: string, command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    const child = spawn(command, args, {
      ...options,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.adopt(runId, child, typeof options.cwd === "string" ? options.cwd : undefined);
    return child;
  }

  /**
   * Take ownership of a process spawned elsewhere.
   *
   * `workspacePath` is optional but worth passing: it is the only handle on a
   * survivor that has been orphaned and can no longer be found by walking the
   * process tree.
   */
  adopt(runId: string, child: ChildProcess, workspacePath?: string): void {
    const entry = this.#entry(runId);
    entry.children.add(child);
    if (workspacePath) entry.workspacePath = path.resolve(workspacePath);
    child.once("close", () => entry.children.delete(child));
  }

  /**
   * Register cooperative work that owns no process, such as an SDK call.
   *
   * Returns the function the caller MUST invoke when its execution finishes —
   * whether it completed, threw, or honoured the abort. Until that is called,
   * the supervisor treats the work as still running, because an abort request
   * is not evidence that anything stopped.
   */
  registerCancellable(
    runId: string,
    controller: AbortController,
    label = "sdk call",
  ): () => void {
    let markSettled!: () => void;
    const work: CooperativeWork = {
      controller,
      isSettled: false,
      label,
      settled: new Promise<void>((resolve) => {
        markSettled = () => {
          work.isSettled = true;
          resolve();
        };
      }),
    };
    this.#entry(runId).cooperative.add(work);
    return markSettled;
  }

  /** Forget a run once it has finished on its own. */
  release(runId: string): void {
    this.#runs.delete(runId);
  }

  isSupervised(runId: string): boolean {
    const entry = this.#runs.get(runId);
    return Boolean(entry && (entry.children.size > 0 || entry.cooperative.size > 0));
  }

  livePids(runId: string): number[] {
    const entry = this.#runs.get(runId);
    if (!entry) return [];
    return [...entry.children]
      .map((child) => child.pid)
      .filter((pid): pid is number => typeof pid === "number" && !Number.isNaN(pid));
  }

  /**
   * Stop everything owned by `runId` and confirm it actually stopped.
   *
   * Polite first, forced second, verified last. The caller is expected to treat
   * `stopped: false` as a real outcome — reporting a run cancelled while its
   * processes still run is exactly the lie this exists to prevent.
   */
  async terminate(runId: string, options: TerminateOptions = {}): Promise<TerminationOutcome> {
    const started = Date.now();
    const entry = this.#runs.get(runId);
    if (!entry) {
      return { stopped: true, escalated: false, killedPids: [], durationMs: 0 };
    }

    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

    // Ask cooperative work to stop. This is only a request: an SDK call keeps
    // running until its own promise settles, and there is no second lever —
    // nothing can be signalled or killed.
    for (const work of entry.cooperative) {
      if (!work.controller.signal.aborted) work.controller.abort();
    }

    const roots = this.livePids(runId);
    // Snapshot descendants before signalling: afterwards the parent links are
    // gone and there would be no way to prove the tree died.
    const tree = await collectTree(roots);

    let escalated = false;
    let surviving: number[] = [];

    if (roots.length > 0) {
      await Promise.all(roots.map((pid) => signalTree(pid, false)));
      surviving = await waitForExit(tree, graceMs);

      if (surviving.length > 0) {
        escalated = true;
        await Promise.all(roots.map((pid) => signalTree(pid, true)));
        surviving = await waitForExit(surviving, options.forceMs ?? DEFAULT_FORCE_MS);
      }
    }

    // Wait for the abort to actually take effect. An SDK that ignores its
    // AbortSignal will still be running here, and saying "cancelled" then
    // would tell the user work had stopped while it carried on.
    const unsettled = await waitForCooperative(entry.cooperative, graceMs);

    // Everything we could see is gone — but a process born between the tree
    // snapshot and `taskkill /T` completing was never in the snapshot, and once
    // its parent died it was reparented, so no walk from the roots can reach it
    // (docs/07 §Known limitations). We cannot kill what we cannot find, but we
    // can refuse to call this a confirmed stop: anything still pointing at this
    // run's workspace, started after supervision began, is reported instead of
    // silently left behind.
    const strays =
      surviving.length === 0 && unsettled.length === 0 && entry.workspacePath
        ? await findWorkspaceStrays(
            entry.workspacePath,
            entry.startedAtMs,
            this.#readProcessDetails,
          )
        : [];
    const durationMs = Date.now() - started;

    if (surviving.length > 0 || unsettled.length > 0 || strays.length > 0) {
      const reasons: string[] = [];
      if (surviving.length > 0) reasons.push(`${surviving.length} process(es) survived termination`);
      if (unsettled.length > 0) {
        reasons.push(
          `${unsettled.length} in-process call(s) did not stop after abort (${unsettled.join(", ")})`,
        );
      }
      if (strays.length > 0) {
        reasons.push(
          `${strays.length} process(es) still reference the run workspace (${strays.join(", ")})`,
        );
      }
      return {
        stopped: false,
        reason: reasons.join("; "),
        survivingPids: [...surviving, ...strays],
        escalated,
        durationMs,
      };
    }

    this.release(runId);
    return { stopped: true, escalated, killedPids: tree, durationMs };
  }

  /** Terminate every supervised run, for a graceful daemon shutdown. */
  async terminateAll(
    options: TerminateOptions = {},
  ): Promise<Map<string, TerminationOutcome>> {
    const results = new Map<string, TerminationOutcome>();
    // Windows termination performs process-tree discovery followed by
    // taskkill /T. Running several of those sequences concurrently contends
    // on WMI/taskkill and intermittently leaves one otherwise-owned process
    // alive past the verification window. Shutdown is a correctness boundary,
    // not a throughput path, so terminate each owned run deterministically.
    for (const runId of [...this.#runs.keys()]) {
      results.set(runId, await this.terminate(runId, options));
    }
    return results;
  }
}

/** Whether a pid exists. EPERM means it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Every pid in the trees rooted at `roots`, including the roots.
 *
 * Used both to know what to verify and to report what survived. Failure to
 * enumerate degrades to just the roots rather than throwing: a best-effort
 * snapshot is better than refusing to cancel.
 */
export async function collectTree(roots: number[]): Promise<number[]> {
  if (roots.length === 0) return [];
  try {
    const parents = await readProcessParents();
    const byParent = new Map<number, number[]>();
    for (const [pid, ppid] of parents) {
      byParent.set(ppid, [...(byParent.get(ppid) ?? []), pid]);
    }

    const seen = new Set<number>();
    const queue = [...roots];
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const child of byParent.get(pid) ?? []) queue.push(child);
    }
    return [...seen];
  } catch {
    return [...roots];
  }
}

/** One row of the process table, enough to identify an orphaned survivor. */
export interface ProcessDetail {
  pid: number;
  ppid: number;
  commandLine: string;
  /** Epoch ms the process started, or `undefined` when it could not be read. */
  startedAtMs: number | undefined;
}

/**
 * Processes that still reference `workspacePath` and cannot be explained.
 *
 * This is the honesty backstop for the one gap the tree walk cannot close. It
 * deliberately biases towards silence: this repository's whole cancellation
 * contract rests on `cancelled` being trustworthy, and a false alarm would
 * destroy that signal just as effectively as a false success. So a candidate is
 * only reported when every exclusion is satisfiable —
 *
 *   - it is not this process, nor any ancestor of it (the CLI or daemon whose
 *     own command line legitimately names the repository);
 *   - it demonstrably started *after* supervision began, which rules out a
 *     second Bremio invocation working in the same repository;
 *   - its start time is actually known — an unreadable timestamp means "cannot
 *     rule this out", and the run is given the benefit of the doubt.
 *
 * Enumeration failure returns nothing rather than throwing: a cancellation must
 * never be blocked by a diagnostic.
 */
export async function findWorkspaceStrays(
  workspacePath: string,
  startedAtMs: number,
  readDetails: () => Promise<ProcessDetail[]> = readProcessDetails,
): Promise<number[]> {
  let rows: ProcessDetail[];
  try {
    rows = await readDetails();
  } catch {
    return [];
  }

  const excluded = ancestryOf(process.pid, rows);
  const needle = path.resolve(workspacePath).toLowerCase();

  return rows
    .filter((row) =>
      !excluded.has(row.pid) &&
      row.startedAtMs !== undefined &&
      row.startedAtMs >= startedAtMs &&
      row.commandLine.toLowerCase().includes(needle))
    .map((row) => row.pid)
    .filter(pidAlive);
}

/** A pid and every ancestor above it, so none of them is mistaken for a stray. */
function ancestryOf(pid: number, rows: readonly ProcessDetail[]): Set<number> {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid] as const));
  const seen = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 0 && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current);
  }
  return seen;
}

/**
 * Epoch ms from whatever the host's JSON writer produced for a `DateTime`.
 *
 * Verified against the real thing rather than assumed: Windows PowerShell 5.1
 * emits Microsoft's `"/Date(1784682460722)/"` (optionally with a trailing
 * offset), not ISO 8601, so `Date.parse` alone returns NaN — which, under the
 * "unknown start time is not a stray" rule, would have made this whole check
 * silently inert on the one platform that needs it.
 */
export function parseWindowsDate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const microsoft = /\/Date\((-?\d+)/.exec(value);
  if (microsoft?.[1]) {
    const ms = Number(microsoft[1]);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const iso = Date.parse(value);
  return Number.isFinite(iso) ? iso : undefined;
}

/** pid, ppid, command line and start time for every process visible to this user. */
export async function readProcessDetails(): Promise<ProcessDetail[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 2",
      ],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    // A single result serializes as an object rather than an array.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((raw): ProcessDetail[] => {
      const row = raw as Record<string, unknown>;
      const pid = Number(row.ProcessId);
      if (!Number.isFinite(pid)) return [];
      return [{
        pid,
        ppid: Number(row.ParentProcessId) || 0,
        commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "",
        startedAtMs: parseWindowsDate(row.CreationDate),
      }];
    });
  }

  // `etimes` is elapsed seconds, which is stable across timezones and locales.
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,etimes=,args="], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const now = Date.now();
  return stdout
    .split("\n")
    .flatMap((line): ProcessDetail[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) return [];
      const [, pid, ppid, elapsed, args] = match;
      return [{
        pid: Number(pid),
        ppid: Number(ppid),
        commandLine: args ?? "",
        startedAtMs: now - Number(elapsed) * 1000,
      }];
    });
}

/** pid -> ppid for every process visible to this user. */
async function readProcessParents(): Promise<Array<[number, number]>> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation",
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.replace(/"/g, "").split(","))
      .filter((parts) => parts.length >= 2)
      .map(([pid, ppid]) => [Number(pid), Number(ppid)] as [number, number])
      .filter(([pid, ppid]) => Number.isFinite(pid) && Number.isFinite(ppid));
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([pid, ppid]) => [Number(pid), Number(ppid)] as [number, number])
    .filter(([pid, ppid]) => Number.isFinite(pid) && Number.isFinite(ppid));
}

/**
 * Signal a whole tree.
 *
 * POSIX kills the negative pid, which addresses the process group the child
 * leads — that is why `spawn` detaches. Windows has no process groups in that
 * sense, so `taskkill /T` walks the tree instead; a real Job Object would be
 * stronger but needs a native addon Bremio deliberately does not carry.
 */
async function signalTree(pid: number, force: boolean): Promise<void> {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    try {
      await execFileAsync("taskkill.exe", args, { windowsHide: true });
    } catch {
      // taskkill exits non-zero when the process is already gone, which is the
      // outcome we wanted anyway. Verification below is what decides.
    }
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal); // negative pid = the whole process group
  } catch {
    try {
      process.kill(pid, signal); // not a group leader after all
    } catch {
      // already gone
    }
  }
}

/**
 * Wait for aborted in-process work to actually finish, returning the labels of
 * whatever is still running when the grace period expires.
 *
 * This is the only evidence available that an SDK honoured its AbortSignal.
 * Without it, "no child process" would be mistaken for "nothing is running".
 */
async function waitForCooperative(
  work: Iterable<CooperativeWork>,
  timeoutMs: number,
): Promise<string[]> {
  const pending = [...work].filter((item) => !item.isSettled);
  if (pending.length === 0) return [];

  await Promise.race([
    Promise.all(pending.map((item) => item.settled)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  return pending.filter((item) => !item.isSettled).map((item) => item.label);
}

/** Poll until every pid is gone, returning whichever are still alive. */
async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(pidAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = remaining.filter(pidAlive);
  }
  return remaining;
}

/**
 * Shared instance used by the adapters.
 *
 * A singleton because adapters are constructed independently but their
 * processes all belong to the same run; tests construct their own supervisor.
 */
export const processSupervisor = new ProcessSupervisor();
