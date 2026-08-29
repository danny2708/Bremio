import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION, checkProtocolCompatibility } from "@bremio/protocol";
import type { MemoryEntry, MemoryQuery } from "@bremio/memory";

export interface DaemonEndpoint {
  port: number;
  token: string;
  pid: number;
  startedAt?: string;
  daemonVersion?: string;
  protocolVersion?: number;
}

export interface DaemonMeta {
  daemonVersion: string;
  protocolVersion: number;
  minimumClientProtocol: number;
  capabilities: Record<string, boolean>;
}

export type RemedyKind =
  | "install-cli"
  | "update-cli"
  | "update-extension"
  | "restart-daemon";

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export class ProtocolMismatchError extends DaemonUnavailableError {
  constructor(
    readonly daemonProtocol: number,
    readonly requiredClientProtocol: number,
    readonly remedy: RemedyKind,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolMismatchError";
  }
}

export function daemonEndpointPath(home = os.homedir()): string {
  return path.join(home, ".bremio", "daemon.json");
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

/** One in-flight run as `/active` reports it (S10-T4). */
export interface ActiveRunSummary {
  runId: string;
  sessionId?: string;
  repositoryPath: string;
  mode: "single" | "team";
  status: string;
  prompt: string;
  startedAt?: string;
  leadProvider?: string;
  workerProviders: string[];
  tasksInFlight: Array<{ taskId: string; title: string; agentId?: string; since: number }>;
}

export interface StartRunRequest {
  mode: "single" | "team" | "auto";
  repoPath: string;
  prompt: string;
  agentId: string;
  workerId?: string;
  model?: string;
  reasoningLevel?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  comparisonId?: string;
  sessionId?: string;
  workspaceStrategy?: "direct-workspace" | "isolated-worktree";
  controlMode?: string;
}

async function readEndpointFile(file: string): Promise<DaemonEndpoint | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DaemonEndpoint>;
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return undefined;
    return parsed as DaemonEndpoint;
  } catch {
    return undefined;
  }
}

export class DaemonClient {
  readonly clientProtocolVersion: number;
  #endpoint: DaemonEndpoint | undefined;
  #meta: DaemonMeta | undefined;
  #file: string;

  constructor(options: { endpointPath?: string; clientProtocolVersion?: number } = {}) {
    this.#file = options.endpointPath ?? daemonEndpointPath();
    this.clientProtocolVersion = options.clientProtocolVersion ?? PROTOCOL_VERSION;
  }

  get endpoint(): DaemonEndpoint | undefined {
    return this.#endpoint;
  }

  get meta(): DaemonMeta | undefined {
    return this.#meta;
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

  async get<T>(route: string): Promise<T> {
    return this.#call<T>(route);
  }

  async post<T>(route: string, body?: unknown): Promise<T> {
    return this.#call<T>(route, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async connect(timeoutMs = 2_000): Promise<DaemonEndpoint> {
    const endpoint = await readEndpointFile(this.#file);
    if (!endpoint) {
      throw new DaemonUnavailableError("the Bremio daemon is not running");
    }
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

  async waitUntilReady(totalMs = 20_000): Promise<DaemonEndpoint> {
    const deadline = Date.now() + totalMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const endpoint = await this.connect(1_000);
        const ready = await this.#fetch(endpoint, "/ready", {
          signal: AbortSignal.timeout(1_000),
        });
        if (ready.ok) return endpoint;
      } catch (err) {
        if (err instanceof ProtocolMismatchError) throw err;
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw lastError instanceof Error
      ? lastError
      : new DaemonUnavailableError("timed out waiting for the daemon to become ready");
  }

  async handshake(): Promise<DaemonMeta> {
    const meta = await this.get<DaemonMeta>("/meta");

    const compatibility = checkProtocolCompatibility({
      clientProtocol: this.clientProtocolVersion,
      daemonProtocol: meta.protocolVersion,
      daemonMinimumClient: meta.minimumClientProtocol,
    });

    if (!compatibility.compatible) {
      const remedy: RemedyKind = compatibility.outdated === "client" ? "update-extension" : "update-cli";
      throw new ProtocolMismatchError(
        meta.protocolVersion,
        this.clientProtocolVersion,
        remedy,
        compatibility.reason,
      );
    }

    this.#meta = meta;
    return meta;
  }

  async startRun(request: StartRunRequest): Promise<{ run: { id: string } }> {
    return this.post<{ run: { id: string } }>("/runs", request);
  }

  async cancelApprovalRequest(id: string, cancelledBy?: string): Promise<{ request: unknown }> {
    return this.post<{ request: unknown }>(`/approvals/${encodeURIComponent(id)}/cancel`, { cancelledBy });
  }

  async getMemory(id: string): Promise<{ memory: MemoryEntry } | undefined> {
    try {
      return await this.get<{ memory: MemoryEntry }>(`/memory/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return undefined;
      throw err;
    }
  }

  async storeMemory(entry: MemoryEntry): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>("/memory", entry);
  }

  async deleteMemory(id: string): Promise<{ ok: boolean }> {
    return this.#call<{ ok: boolean }>(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async reviewMemory(
    id: string,
    decision: { state: "approved" | "rejected"; reviewer: string; note?: string },
  ): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>(`/memory/${encodeURIComponent(id)}/review`, decision);
  }

  async queryMemory(filter: MemoryQuery & { repository?: string }): Promise<{ memory: MemoryEntry[] }> {
    const params = new URLSearchParams();
    if (filter.scopes) filter.scopes.forEach(s => params.append("scope", s));
    if (filter.tags) filter.tags.forEach(t => params.append("tag", t));
    if (filter.ids) filter.ids.forEach(id => params.append("id", id));
    if (filter.repository) params.append("repo", filter.repository);
    return this.get<{ memory: MemoryEntry[] }>(`/memory?${params.toString()}`);
  }

  async cancelRun(id: string): Promise<{ cancelled: boolean }> {
    return this.post<{ cancelled: boolean }>(`/runs/${encodeURIComponent(id)}/cancel`);
  }

  /** Runs in flight across every repository, with who is working on what. */
  async activeRuns(): Promise<{ active: ActiveRunSummary[] }> {
    return this.get<{ active: ActiveRunSummary[] }>("/active");
  }

  async applyPatch(request: {
    repoPath: string;
    runId: string;
    taskId?: string;
    filePath?: string;
    force?: boolean;
  }): Promise<{ ok: boolean; output?: string; error?: string; conflictedFiles?: Array<{ file: string; status: string }>; recoveryPatch?: string }> {
    return this.post("/apply", request);
  }

  async revertPatch(request: {
    repoPath: string;
    runId: string;
    taskId?: string;
    filePath?: string;
    force?: boolean;
  }): Promise<{ ok: boolean; output?: string; error?: string; conflictedFiles?: Array<{ file: string; status: string }>; recoveryPatch?: string }> {
    return this.post("/revert", request);
  }

  async runDetail(id: string, repoPath: string): Promise<{
    run?: { id: string; status: string };
    events?: RunEvent[];
  }> {
    return this.get<{
      run?: { id: string; status: string };
      events?: RunEvent[];
    }>(`/runs/${encodeURIComponent(id)}?repo=${encodeURIComponent(repoPath)}`);
  }

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
