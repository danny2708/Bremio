/**
 * @bremio/daemon — the local process that holds run state and streams events.
 *
 * Both the CLI and the VS Code extension are clients: neither owns the
 * orchestrator, so a run started in one surface is visible from the other.
 *
 * Streaming is Server-Sent Events rather than the WebSocket named in
 * docs/03-modules.md. The only streaming direction is server to client, and
 * every command (start, cancel) is a plain POST, so SSE covers the need on
 * node:http with no added dependency. Swap it for a WebSocket if a genuinely
 * bidirectional feature arrives.
 */
import { startDaemonServer, type DaemonHandle } from "./server";
import {
  daemonEndpointPath,
  mintToken,
  publishEndpoint,
  readEndpoint,
  retractEndpoint,
  type DaemonEndpoint,
} from "./endpoint";

export { RunRegistry, type DaemonRun, type RunEvent, type RunState, type StartRunInput } from "./runs";
export { startDaemonServer, type DaemonHandle, type DaemonServerOptions } from "./server";
export { mergeRun, type MergeRequest, type MergeOutcome, type MergeTaskOutcome } from "./merge";
export {
  daemonEndpointPath,
  readEndpoint,
  retractEndpoint,
  type DaemonEndpoint,
} from "./endpoint";

export interface StartDaemonOptions {
  version: string;
  /** Override the discovery file; tests use this to stay off the real one. */
  endpointFile?: string;
}

export interface RunningDaemon extends DaemonHandle {
  token: string;
  endpointFile: string;
}

/** Bind, publish the endpoint, and clean up the file on close. */
export async function startDaemon(options: StartDaemonOptions): Promise<RunningDaemon> {
  const token = mintToken();
  const handle = await startDaemonServer({ token, version: options.version });
  const endpointFile = options.endpointFile ?? daemonEndpointPath();
  const endpoint: DaemonEndpoint = {
    port: handle.port,
    token,
    pid: process.pid,
    version: options.version,
  };
  await publishEndpoint(endpoint, endpointFile);

  return {
    ...handle,
    token,
    endpointFile,
    close: async () => {
      await retractEndpoint(endpointFile);
      await handle.close();
    },
  };
}
