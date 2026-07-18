import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  BremioClient,
  DaemonUnavailableError,
  ProtocolMismatchError,
  type RunEvent,
} from "./client";
import { panelHtml } from "./webview";

let panel: vscode.WebviewPanel | undefined;
let daemonProcess: ChildProcess | undefined;
let streamAbort: AbortController | undefined;
const client = new BremioClient();
const output = vscode.window.createOutputChannel("Bremio");

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("bremio.open", () => openPanel(context)),
    vscode.commands.registerCommand("bremio.startDaemon", () => ensureDaemon(true)),
    vscode.commands.registerCommand("bremio.stopDaemon", stopDaemon),
    output,
  );
}

export function deactivate(): void {
  streamAbort?.abort();
  stopDaemon();
}

function openPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel("bremio", "Bremio", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const nonce = randomBytes(16).toString("base64");
  panel.webview.html = panelHtml(nonce, panel.webview.cspSource);
  panel.onDidDispose(() => {
    streamAbort?.abort();
    panel = undefined;
  }, undefined, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    (message: Record<string, unknown>) => void handleMessage(message),
    undefined,
    context.subscriptions,
  );
}

function post(message: Record<string, unknown>): void {
  void panel?.webview.postMessage(message);
}

/**
 * Ensure a daemon is reachable, starting one if configured to.
 *
 * The daemon is spawned rather than run in-process on purpose: the extension
 * host is shared with the rest of VS Code, and a hung provider must not be able
 * to take the editor down with it.
 */
async function ensureDaemon(explicit = false): Promise<boolean> {
  try {
    const endpoint = await client.connect();
    await client.checkProtocol();
    post({
      type: "daemon",
      live: true,
      detail: `daemon v${endpoint.daemonVersion ?? "?"} · protocol ${endpoint.protocolVersion ?? "?"} · :${endpoint.port}`,
    });
    return true;
  } catch (err) {
    if (err instanceof ProtocolMismatchError) {
      // Not something a retry or a restart of the panel can fix, so say
      // exactly what is wrong instead of appearing merely offline.
      post({ type: "daemon", live: false, detail: "protocol mismatch" });
      post({ type: "error", message: err.message, kind: "protocol" });
      return false;
    }
    if (!(err instanceof DaemonUnavailableError)) throw err;
  }

  const autoStart = vscode.workspace.getConfiguration("bremio").get<boolean>("autoStartDaemon", true);
  if (!autoStart && !explicit) {
    post({ type: "daemon", live: false, detail: "daemon not running" });
    return false;
  }

  const cli = vscode.workspace.getConfiguration("bremio").get<string>("cliPath", "bremio");
  output.appendLine(`starting daemon: ${cli} daemon`);
  daemonProcess = spawn(cli, ["daemon"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  daemonProcess.stdout?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
  daemonProcess.stderr?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
  daemonProcess.on("error", (error) => {
    output.appendLine(`daemon failed to start: ${error.message}`);
    post({
      type: "daemon",
      live: false,
      detail: `cannot start daemon (check bremio.cliPath)`,
    });
  });

  try {
    const endpoint = await client.waitUntilReady();
    await client.checkProtocol();
    post({
      type: "daemon",
      live: true,
      detail: `daemon v${endpoint.daemonVersion ?? "?"} · protocol ${endpoint.protocolVersion ?? "?"} · :${endpoint.port}`,
    });
    return true;
  } catch (err) {
    const kind = err instanceof ProtocolMismatchError ? "protocol" : "daemon";
    post({ type: "daemon", live: false, detail: (err as Error).message });
    post({ type: "error", message: (err as Error).message, kind });
    return false;
  }
}

function stopDaemon(): void {
  daemonProcess?.kill();
  daemonProcess = undefined;
}

async function handleMessage(message: Record<string, unknown>): Promise<void> {
  try {
    switch (message.type) {
      case "ready":
        if (await ensureDaemon()) await refreshAll();
        return;
      case "tab":
        if (message.tab === "capacity") await sendCapacity();
        if (message.tab === "runs") await sendRuns();
        if (message.tab === "doctor") await sendAdapters();
        return;
      case "startRun":
        await startRun(message);
        return;
      case "cancelRun":
        if (typeof message.id === "string") await client.cancelRun(message.id);
        return;
      case "viewDiff":
        await viewDiff(String(message.runId ?? ""));
        return;
      case "merge":
        await merge(String(message.runId ?? ""));
        return;
      case "retry":
        await retryRun(String(message.runId ?? ""));
        return;
      case "openRun":
        await reattach(String(message.runId ?? ""));
        return;
    }
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
    output.appendLine(`error: ${(err as Error).stack ?? (err as Error).message}`);
  }
}

async function refreshAll(): Promise<void> {
  await sendAdapters();
  await sendRuns();
}

async function sendAdapters(): Promise<void> {
  post({ type: "adapters", ...(await client.adapters()) });
}

async function sendCapacity(): Promise<void> {
  post({ type: "capacity", capacity: await client.capacity(true) });
}

async function sendRuns(): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) return post({ type: "runs", runs: { runs: [], legacyReports: [] } });
  post({ type: "runs", runs: await client.runs(repoPath) });
}

function currentRepo(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function startRun(message: Record<string, unknown>): Promise<void> {
  const repoPath = String(message.repoPath ?? "").trim() || currentRepo();
  const prompt = String(message.prompt ?? "").trim();
  if (!repoPath) throw new Error("open a folder or type a repository path first");
  if (!prompt) throw new Error("a prompt is required");

  const { run } = await client.startRun({
    mode: message.mode === "team" ? "team" : "single",
    repoPath,
    prompt,
    agentId: String(message.agentId ?? "claude"),
    ...(message.workerId ? { workerId: String(message.workerId) } : {}),
    ...(typeof message.maxConcurrency === "number"
      ? { maxConcurrency: message.maxConcurrency }
      : {}),
  });

  post({ type: "runStarted", id: run.id });
  await follow(run.id, repoPath);
}

/**
 * Follow a run's stream to completion, resuming across drops.
 *
 * `lastSeq` is what makes a reconnect safe: without it a dropped stream would
 * either replay the whole log into the panel or silently skip whatever arrived
 * while it was disconnected.
 */
async function follow(runId: string, repoPath: string, resumeFrom = 0): Promise<void> {
  streamAbort?.abort();
  const abort = new AbortController();
  streamAbort = abort;

  let lastSeq = resumeFrom;
  const deadline = Date.now() + 6 * 60 * 60 * 1000;

  while (!abort.signal.aborted && Date.now() < deadline) {
    try {
      await client.streamEvents(
        runId,
        (event: RunEvent) => {
          if (event.seq <= lastSeq) return; // never render the same line twice
          lastSeq = event.seq;
          post({ type: "runEvent", event });
        },
        abort.signal,
        lastSeq,
      );
      break; // the daemon closed the stream, which it only does when terminal
    } catch (err) {
      if (abort.signal.aborted) return;
      output.appendLine(`stream dropped at seq ${lastSeq}: ${(err as Error).message}`);
      post({ type: "streamReconnecting", seq: lastSeq });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  const detail = await client.run(runId, repoPath);
  // The quality gate lives in the orchestrator's report, which rides along on
  // the terminal event rather than on the run row.
  const finished = [...(detail.events ?? [])].reverse().find((event) => event.kind === "finished");
  const gate = (finished?.data as { qualityGate?: unknown } | undefined)?.qualityGate;

  post({
    type: "runFinished",
    state: detail.run?.status ?? "completed",
    runId,
    recovery: detail.recovery,
    failureMessage: detail.run?.failureMessage,
    gate,
  });
  await sendRuns();
}

/**
 * Retry a finished run. The daemon creates a new run linked to the original,
 * so the history that explains the failure is preserved.
 */
async function retryRun(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const result = await client.retry(runId);
  if (!result.run) throw new Error(result.error ?? "the daemon refused to retry this run");

  post({ type: "runStarted", id: result.run.id });
  await follow(result.run.id, repoPath);
}

/**
 * Re-open a run the panel is not currently following — after a reload, or when
 * picking one out of history. Replays from the store, so nothing is lost.
 */
async function reattach(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const detail = await client.run(runId, repoPath);
  if (!detail.run) throw new Error(`run ${runId} is not in the daemon's history`);

  post({ type: "runStarted", id: runId });
  for (const event of detail.events ?? []) post({ type: "runEvent", event });

  if (detail.run.status === "running" || detail.run.status === "queued") {
    // Still live: pick the stream back up from where the replay ended.
    const lastSeq = detail.events?.at(-1)?.seq ?? 0;
    await follow(runId, repoPath, lastSeq);
    return;
  }
  const finished = [...(detail.events ?? [])].reverse().find((e) => e.kind === "finished");
  post({
    type: "runFinished",
    state: detail.run.status,
    runId,
    recovery: detail.recovery,
    failureMessage: detail.run.failureMessage,
    gate: (finished?.data as { qualityGate?: unknown } | undefined)?.qualityGate,
  });
}

/** Show the run's diff in a real editor tab rather than a cramped webview pane. */
async function viewDiff(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  const detail = (await client.run(runId, repoPath)) as {
    report?: { tasks?: Array<{ result?: { branch?: string; commitHash?: string } }> };
  };
  const branch = detail.report?.tasks?.find((task) => task.result?.branch)?.result?.branch;
  if (!branch) throw new Error("this run has no task branch to diff");

  const diff = await client.diff(repoPath, branch);
  if (diff.error) throw new Error(diff.error);
  const document = await vscode.workspace.openTextDocument({
    content: diff.patch || "(no changes)",
    language: "diff",
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Merge behind an explicit confirmation. The daemon independently enforces the
 * quality gate, so this dialog is the human check, not the only check.
 */
async function merge(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const choice = await vscode.window.showWarningMessage(
    `Merge run ${runId} into the base branch?`,
    { modal: true, detail: "Bremio never merges without confirmation." },
    "Merge",
  );
  if (choice !== "Merge") return;

  const result = await client.merge({ repoPath, runId });
  post({
    type: "mergeResult",
    ok: result.ok,
    detail: result.ok
      ? `Merged ${result.merged} task branch(es).`
      : (result.error ?? "merge refused"),
  });
  await sendRuns();
}
