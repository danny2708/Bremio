import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Client for the Bremio daemon.
 *
 * Deliberately depends on nothing from the Bremio workspace: the extension host
 * is a shared process, so pulling the adapters in would let one hung provider
 * take VS Code down with it. Everything here is plain Node plus fetch.
 */

export interface DaemonEndpoint {
  port: number;
  token: string;
  pid: number;
  version?: string;
}

export interface RunEvent {
  seq: number;
  ts: number;
  kind: string;
  message: string;
  taskId?: string;
  agentId?: string;
  data?: unknown;
}

export interface StartRunRequest {
  mode: "single" | "team";
  repoPath: string;
  prompt: string;
  agentId: string;
  workerId?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
}

export function endpointPath(home = os.homedir()): string {
  return path.join(home, ".bremio", "daemon.json");
}

export async function readEndpoint(file = endpointPath()): Promise<DaemonEndpoint | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DaemonEndpoint>;
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return undefined;
    return parsed as DaemonEndpoint;
  } catch {
    return undefined;
  }
}

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export class BremioClient {
  #endpoint: DaemonEndpoint | undefined;

  constructor(private readonly file = endpointPath()) {}

  /**
   * Resolve a live endpoint. The discovery file outlives a crash, so liveness
   * is proven by connecting rather than by the file existing.
   */
  async connect(timeoutMs = 2_000): Promise<DaemonEndpoint> {
    const endpoint = await readEndpoint(this.file);
    if (!endpoint) throw new DaemonUnavailableError("the Bremio daemon is not running");
    try {
      const response = await this.#fetch(endpoint, "/health", {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new DaemonUnavailableError(`daemon health check returned ${response.status}`);
      }
    } catch (err) {
      if (err instanceof DaemonUnavailableError) throw err;
      throw new DaemonUnavailableError(
        "the Bremio daemon published an endpoint but is not responding",
      );
    }
    this.#endpoint = endpoint;
    return endpoint;
  }

  /** Poll until the daemon answers, for use right after spawning it. */
  async waitUntilReady(totalMs = 15_000): Promise<DaemonEndpoint> {
    const deadline = Date.now() + totalMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.connect(1_000);
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new DaemonUnavailableError("timed out waiting for the daemon");
  }

  #fetch(endpoint: DaemonEndpoint, route: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        "X-Bremio-Token": endpoint.token,
      },
    });
  }

  async #call<T>(route: string, init: RequestInit = {}): Promise<T> {
    const endpoint = this.#endpoint ?? (await this.connect());
    const response = await this.#fetch(endpoint, route, init);
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok && response.status !== 409) {
      throw new Error(body.error ?? `daemon returned ${response.status}`);
    }
    return body;
  }

  adapters(): Promise<{ adapters: Array<{ id: string; health: { status: string; detail?: string }; leadEligible: boolean }> }> {
    return this.#call("/adapters");
  }

  capacity(refresh = true): Promise<Record<string, unknown>> {
    return this.#call(`/capacity?refresh=${refresh ? "true" : "false"}`);
  }

  runs(repoPath: string): Promise<{ live: unknown[]; stored: unknown[] }> {
    return this.#call(`/runs?repo=${encodeURIComponent(repoPath)}`);
  }

  run(id: string, repoPath: string): Promise<Record<string, unknown>> {
    return this.#call(`/runs/${encodeURIComponent(id)}?repo=${encodeURIComponent(repoPath)}`);
  }

  startRun(request: StartRunRequest): Promise<{ run: { id: string } }> {
    return this.#call("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  cancelRun(id: string): Promise<{ cancelled: boolean }> {
    return this.#call(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  diff(repoPath: string, branch: string, commit?: string): Promise<{ stat: string; patch: string; error?: string }> {
    const params = new URLSearchParams({ repo: repoPath, branch });
    if (commit) params.set("commit", commit);
    return this.#call(`/diff?${params.toString()}`);
  }

  merge(request: {
    repoPath: string;
    taskId?: string;
    runId?: string;
    strategy?: "merge" | "cherry-pick";
  }): Promise<{ ok: boolean; merged: number; tasks: unknown[]; error?: string }> {
    return this.#call("/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  /**
   * Consume a run's event stream. Resumes from `afterSeq` so a reconnect never
   * replays what the caller already rendered.
   */
  async streamEvents(
    id: string,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
    afterSeq = 0,
  ): Promise<void> {
    const endpoint = this.#endpoint ?? (await this.connect());
    const response = await this.#fetch(
      endpoint,
      `/runs/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}`,
      { signal },
    );
    if (!response.ok || !response.body) {
      throw new Error(`could not stream run ${id}: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a partial frame stays in the
      // buffer until the rest arrives.
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            onEvent(JSON.parse(data) as RunEvent);
          } catch {
            // a malformed frame must not kill the stream
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  }
}
