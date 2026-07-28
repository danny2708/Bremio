/**
 * @bremio/daemon — the local process that holds run state and streams events.
 *
 * Both the CLI and the VS Code extension are clients: neither owns the
 * orchestrator, so a run started in one surface is visible from the other.
 *
 * Streaming is Server-Sent Events rather than the WebSocket named in
 * docs/03-modules.md. The only streaming direction is server to client, and
 * every command (start, cancel, shutdown) is a plain POST, so SSE covers the
 * need on node:http with no added dependency. Swap it for a WebSocket if a
 * genuinely bidirectional feature arrives.
 */
import { startDaemonServer, type DaemonHandle } from "./server";
import { RunRegistry } from "./runs";
import { RunStore, defaultDatabasePath } from "./storage";
import {
  MINIMUM_CLIENT_PROTOCOL,
  PROTOCOL_VERSION,
  cleanLeakedEndpointFiles,
  daemonEndpointPath,
  mintToken,
  publishEndpoint,
  readEndpoint,
  retractEndpoint,
  type DaemonEndpoint,
} from "./endpoint";
import {
  acquireSingleInstanceLock,
  clearStaleLock,
  lockPath,
  verifyDaemonAlive,
  type LockResult,
} from "./lock";

export { RunRegistry, type RunEvent, type RunStatus, type SessionEvent, type StartRunInput } from "./runs";
export {
  RunStore,
  defaultDatabasePath,
  isTerminal,
  TERMINAL_STATUSES,
  type PersistedRun,
  type PersistedRunEvent,
  type PersistedArtifact,
  type PersistedContextItem,
  type ContextItemType,
} from "./storage";
export { startDaemonServer, type DaemonHandle, type DaemonServerOptions } from "./server";
export { mergeRun, type MergeRequest, type MergeOutcome, type MergeTaskOutcome } from "./merge";
export {
  MINIMUM_CLIENT_PROTOCOL,
  PROTOCOL_VERSION,
  daemonEndpointPath,
  readEndpoint,
  retractEndpoint,
  type DaemonEndpoint,
} from "./endpoint";
export {
  acquireSingleInstanceLock,
  clearStaleLock,
  lockPath,
  processExists,
  verifyDaemonAlive,
  type LockResult,
} from "./lock";

/** Terminal runs older than this are pruned at startup. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Always keep at least this many of the newest runs, whatever their age. */
export const DEFAULT_RETENTION_MINIMUM = 50;

export interface StartDaemonOptions {
  version: string;
  retentionDays?: number;
  retentionMinimumRuns?: number;
  /** Overrides exist so tests never touch the real user-level files. */
  endpointFile?: string;
  lockFile?: string;
  databasePath?: string;
}

export interface RunningDaemon extends DaemonHandle {
  token: string;
  endpointFile: string;
  store: RunStore;
  /** Runs marked interrupted or supervision_lost because a previous process died mid-flight. */
  reconciled: string[];
  /** How many old terminal runs were trimmed at startup. */
  pruned: number;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly existing: DaemonEndpoint | undefined, message: string) {
    super(message);
    this.name = "DaemonAlreadyRunningError";
  }
}

/**
 * Start the daemon: take the single-instance lock, open durable storage,
 * reconcile anything left mid-flight, bind, then publish the endpoint.
 *
 * The endpoint is published last on purpose. A client that finds the file must
 * be able to connect immediately, so it is written only once the port is real.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<RunningDaemon> {
  const endpointFile = options.endpointFile ?? daemonEndpointPath();
  const lockFile = options.lockFile ?? lockPath();

  const lock: LockResult = await acquireSingleInstanceLock({ lockFile, endpointFile });
  if (!lock.acquired) {
    throw new DaemonAlreadyRunningError(lock.endpoint, lock.reason);
  }
  // Captured here because narrowing of a union does not reach into the nested
  // shutdown closure below.
  const releaseLock = lock.release;

  // Safe here and only here: holding the lock means no other daemon has a temp
  // file in flight, so anything matching the pattern was orphaned by a death.
  await cleanLeakedEndpointFiles(endpointFile);

  const store = await RunStore.open(options.databasePath ?? defaultDatabasePath());
  const registry = new RunRegistry(store);
  const reconciled = registry.reconcileOnStartup().map((run) => run.id);

  // Trim old terminal runs at startup rather than on a timer: it is the one
  // moment nothing is streaming, and an event log that only ever grows would
  // eventually make history unusable.
  const pruned = store.pruneRuns({
    olderThan: new Date(Date.now() - (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86_400_000),
    keepMinimum: options.retentionMinimumRuns ?? DEFAULT_RETENTION_MINIMUM,
  });

  const token = mintToken();
  let stopping = false;
  let handle: DaemonHandle;
  try {
    handle = await startDaemonServer({
      token,
      version: options.version,
      registry,
      onShutdown: () => void shutdown(),
      // Storage is already open and reconciled by this point; readiness only
      // goes false again once shutdown begins.
      isReady: () => !stopping,
    });
  } catch (err) {
    store.close();
    await releaseLock();
    throw err;
  }

  const endpoint: DaemonEndpoint = {
    port: handle.port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    daemonVersion: options.version,
    protocolVersion: PROTOCOL_VERSION,
  };
  try {
    await publishEndpoint(endpoint, endpointFile);
  } catch (err) {
    // Publishing is the last step, which made it easy to miss that it can fail
    // — a rename onto a locked destination does on Windows. Unwound like any
    // other startup failure: a daemon that never became discoverable must not
    // keep the single-instance lock, or every later start is refused by a
    // process that is not running.
    await handle.close();
    store.close();
    await releaseLock();
    throw err;
  }

  /**
   * Graceful shutdown, in the order that avoids losing work: refuse new runs,
   * withdraw discovery so nothing new connects, cancel what is in flight, then
   * close sockets and storage. The lock is released last so no other daemon can
   * take over while this one is still writing.
   */
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    registry.stopAccepting();
    await retractEndpoint(endpointFile);

    // Cancel through the same supervisor a user-initiated cancel uses, and
    // wait for it. Exiting while child processes are still being torn down is
    // how orphans outlive the daemon that started them.
    registry.cancelAll();
    const outcomes = await registry.awaitCancellations();
    const survivors = outcomes.filter((outcome) => !outcome.stopped);
    if (survivors.length > 0) {
      // Recorded rather than silently swallowed: the runs are already marked
      // cancellation_failed, and the operator deserves to hear it here too.
      console.error(
        `warning: ${survivors.length} run(s) left processes running after shutdown`,
      );
    }

    await handle.close();
    store.close();
    await releaseLock();
  }

  return {
    ...handle,
    token,
    endpointFile,
    store,
    reconciled,
    pruned,
    close: shutdown,
  };
}

export type DaemonStatus =
  | { running: true; endpoint: DaemonEndpoint }
  | { running: false; staleEndpoint: boolean; detail: string };

/**
 * Report whether a daemon is genuinely running.
 *
 * The discovery file surviving a crash is exactly why liveness is proven by an
 * authenticated request rather than by the file existing or a PID being alive.
 */
export async function daemonStatus(
  options: { endpointFile?: string } = {},
): Promise<DaemonStatus> {
  const endpoint = await readEndpoint(options.endpointFile);
  if (!endpoint) {
    return { running: false, staleEndpoint: false, detail: "no daemon endpoint published" };
  }
  if (await verifyDaemonAlive(endpoint)) return { running: true, endpoint };
  return {
    running: false,
    staleEndpoint: true,
    detail: "an endpoint is published but no daemon answered; it likely crashed",
  };
}

export type StopOutcome =
  | { stopped: true; detail: string }
  | { stopped: false; cleaned: boolean; detail: string };

/**
 * Ask a running daemon to stop, or clean up after one that already died.
 *
 * Idempotent by design, and it never signals a PID: an authenticated shutdown
 * request is the only way a process is asked to exit, so a recycled PID
 * belonging to something else can never be killed by mistake.
 */
export async function stopDaemon(
  options: { endpointFile?: string; lockFile?: string; timeoutMs?: number } = {},
): Promise<StopOutcome> {
  const endpointFile = options.endpointFile ?? daemonEndpointPath();
  const lockFile = options.lockFile ?? lockPath();
  const endpoint = await readEndpoint(endpointFile);

  if (endpoint) {
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, {
        method: "POST",
        headers: { "X-Bremio-Token": endpoint.token },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (response.ok || response.status === 202) {
        await waitUntilGone(endpoint, options.timeoutMs ?? 5_000);
        return { stopped: true, detail: `daemon on port ${endpoint.port} stopped` };
      }
    } catch {
      // No answer: fall through and treat the endpoint as stale.
    }
  }

  const cleaned = (await clearStaleLock({ lockFile, endpointFile })) || Boolean(endpoint);
  if (endpoint) await retractEndpoint(endpointFile, endpoint.pid);
  return {
    stopped: false,
    cleaned,
    detail: cleaned
      ? "no daemon was running; cleaned up a stale endpoint"
      : "no daemon was running",
  };
}

async function waitUntilGone(endpoint: DaemonEndpoint, totalMs: number): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (!(await verifyDaemonAlive(endpoint, 500))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Poll until a freshly spawned daemon answers, with a bounded wait. */
export async function waitForDaemon(
  options: { endpointFile?: string; totalMs?: number } = {},
): Promise<DaemonEndpoint> {
  const deadline = Date.now() + (options.totalMs ?? 15_000);
  while (Date.now() < deadline) {
    const status = await daemonStatus(
      options.endpointFile ? { endpointFile: options.endpointFile } : {},
    );
    if (status.running) return status.endpoint;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timed out waiting for the Bremio daemon to become ready");
}
