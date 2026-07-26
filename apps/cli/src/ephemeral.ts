import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RunRegistry,
  RunStore,
  startDaemonServer,
  type DaemonHandle,
} from "@bremio/daemon";
import {
  DaemonClient,
  type RunEvent,
} from "@bremio/daemon-client";
import { c, formatEventView, renderRunEvent, statusGlyph } from "./ui";
import type { TaskStatus } from "@bremio/protocol";

export interface EphemeralRunParams {
  mode: "single" | "team";
  repoPath: string;
  prompt: string;
  agentId: string;
  workerId?: string;
  model?: string;
  reasoningLevel?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  comparisonId?: string;
  workspaceStrategy?: "direct-workspace" | "isolated-worktree";
  /**
   * Override the temporary directory root.  Only used in tests to avoid
   * polluting the real os.tmpdir() with daemon artifacts.
   */
  tmpRoot?: string;
}

/**
 * Start an ephemeral daemon in-process, run through it via the daemon protocol,
 * then shut it down.  Used when no persistent daemon is running (CI, one-shot).
 *
 * The ephemeral daemon uses the exact same POST /runs + SSE protocol path as
 * the persistent daemon — there is no second implementation (docs/15 §5).
 */
export async function runViaEphemeralDaemon(
  params: EphemeralRunParams,
  json: boolean,
  version: string,
): Promise<boolean> {
  const tmpDir = await fs.mkdtemp(
    path.join(params.tmpRoot ?? os.tmpdir(), "bremio-ephemeral-"),
  );
  const dbPath = path.join(tmpDir, "bremio.db");
  const endpointFile = path.join(tmpDir, "daemon.json");

  let store: RunStore | undefined;
  let registry: RunRegistry | undefined;
  let handle: DaemonHandle | undefined;

  try {
    store = await RunStore.open(dbPath);
    registry = new RunRegistry(store);

    const token = randomUUID();
    handle = await startDaemonServer({
      token,
      version,
      registry,
      isReady: () => true,
    });

    await fs.writeFile(
      endpointFile,
      JSON.stringify({
        port: handle.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        daemonVersion: version,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );

    const client = new DaemonClient({ endpointPath: endpointFile });
    await client.connect();

    const ac = new AbortController();
    let cancelling = false;
    let runId: string | undefined;
    const collectedEvents: RunEvent[] = [];

    const onInt = () => {
      if (cancelling) {
        console.error(c.red("\nforce exit"));
        process.exit(130);
      }
      cancelling = true;
      console.error(c.yellow("\n⚠ cancelling run (Ctrl+C again to force)…"));
      ac.abort();
      if (runId) client.cancelRun(runId).catch(() => {});
    };

    process.on("SIGINT", onInt);

    try {
      const { run } = await client.startRun(params);
      runId = run.id;
      if (!json) console.log(c.dim(`ephemeral daemon started run (id: ${runId})`));

      await client.streamEvents(runId, (event) => {
        if (json) {
          collectedEvents.push(event);
          return;
        }
        console.log(renderRunEvent(event));
      }, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error(c.red(`\ndaemon run failed: ${(err as Error).message}`));
        return true;
      }
    } finally {
      process.off("SIGINT", onInt);
    }

    if (runId) {
      try {
        const detail = await client.runDetail(runId, params.repoPath);
        if (json) {
          console.log(JSON.stringify({ run: detail.run, events: collectedEvents }, null, 2));
        } else if (detail.run?.status) {
          const glyph = statusGlyph(detail.run.status as TaskStatus);
          const events = detail.events;
          const fileCount = events?.filter((e) => e.kind === "task-complete").length ?? 0;
          console.log(`  ${glyph} ${c.dim(`${fileCount > 0 ? `${fileCount} file(s), ` : ""}run: ${detail.run.id}`)}`);
        }
      } catch {
        // best-effort
      }
    }

    return true;
  } catch (err) {
    console.error(c.red(`\nephemeral daemon error: ${(err as Error).message}`));
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (store) store.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
