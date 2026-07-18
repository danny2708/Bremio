import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEndpoint, type DaemonEndpoint } from "./endpoint";

/**
 * Single-instance guard for the daemon.
 *
 * Two daemons publishing to the same discovery file would hand clients a port
 * and token that disagree with each other, so exactly one may hold it per user.
 *
 * A PID alone is not evidence. The operating system reuses PIDs, so a lock left
 * by a crashed daemon can point at an unrelated process that started later.
 * Ownership is therefore proven by an authenticated request to the port the
 * discovery file advertises: only a real Bremio daemon can answer it. Anything
 * else is treated as stale — and nothing is ever killed on the strength of a
 * PID alone.
 */

export function lockPath(home = os.homedir()): string {
  return path.join(home, ".bremio", "daemon.lock");
}

export interface LockRecord {
  pid: number;
  startedAt: string;
}

export interface LockHeld {
  acquired: true;
  release(): Promise<void>;
}

export interface LockBusy {
  acquired: false;
  /** The daemon that answered, when one did. */
  endpoint?: DaemonEndpoint;
  record?: LockRecord;
  reason: string;
}

export type LockResult = LockHeld | LockBusy;

/** Whether a PID exists at all. True does not mean it is *our* daemon. */
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ask the advertised port whether a Bremio daemon is really there.
 *
 * This is what separates "a live daemon" from "a recycled PID": an unrelated
 * process will not answer /health with the daemon's token.
 */
export async function verifyDaemonAlive(
  endpoint: DaemonEndpoint,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
      headers: { "X-Bremio-Token": endpoint.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { app?: string };
    return body.app === "bremio-daemon";
  } catch {
    return false;
  }
}

async function readLock(file: string): Promise<LockRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number") return undefined;
    return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "") };
  } catch {
    return undefined;
  }
}

async function writeLockExclusive(file: string, record: LockRecord): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    // "wx" fails if the file exists, which is what makes this a lock and not a
    // last-writer-wins overwrite. Two simultaneous starts cannot both succeed.
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Take the single-instance lock, clearing it first if the holder is provably
 * gone. Returns a release handle, or the reason another daemon owns it.
 */
export async function acquireSingleInstanceLock(options: {
  lockFile?: string;
  endpointFile?: string;
} = {}): Promise<LockResult> {
  const file = options.lockFile ?? lockPath();
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };

  const release = async (): Promise<void> => {
    // Only drop the lock if it is still ours: a slow shutdown must not delete
    // a lock that a newer daemon has since taken.
    const current = await readLock(file);
    if (current?.pid === process.pid) await fs.rm(file, { force: true }).catch(() => {});
  };

  if (await writeLockExclusive(file, record)) return { acquired: true, release };

  // Someone holds it. Decide whether they are actually alive.
  const existing = await readLock(file);
  const endpoint = await readEndpoint(options.endpointFile);

  if (endpoint && (await verifyDaemonAlive(endpoint))) {
    return {
      acquired: false,
      endpoint,
      ...(existing ? { record: existing } : {}),
      reason: "another Bremio daemon is already running",
    };
  }

  // Nothing answered. Either the daemon died, or its PID now belongs to an
  // unrelated process. Both mean the lock is stale, so it is cleared — but the
  // process behind that PID is never signalled, because a live PID is not
  // evidence that it is ours.
  await fs.rm(file, { force: true }).catch(() => {});
  if (await writeLockExclusive(file, record)) return { acquired: true, release };

  // Lost a race with another starter that cleaned up at the same instant.
  return {
    acquired: false,
    ...(existing ? { record: existing } : {}),
    reason: "another process took the daemon lock first",
  };
}

/** Remove a lock whose owner is provably gone. Used by `daemon stop`. */
export async function clearStaleLock(options: {
  lockFile?: string;
  endpointFile?: string;
} = {}): Promise<boolean> {
  const file = options.lockFile ?? lockPath();
  const existing = await readLock(file);
  if (!existing) return false;

  const endpoint = await readEndpoint(options.endpointFile);
  if (endpoint && (await verifyDaemonAlive(endpoint))) return false; // genuinely running

  await fs.rm(file, { force: true }).catch(() => {});
  return true;
}
