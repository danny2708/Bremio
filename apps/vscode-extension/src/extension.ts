import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BremioClient, DaemonUnavailableError, type RunEvent } from "./client";
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
    post({ type: "daemon", live: true, detail: `daemon v${endpoint.version ?? "?"} · :${endpoint.port}` });
    return true;
  } catch (err) {
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
    post({ type: "daemon", live: true, detail: `daemon v${endpoint.version ?? "?"} · :${endpoint.port}` });
    return true;
  } catch (err) {
    post({ type: "daemon", live: false, detail: (err as Error).message });
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
  if (!repoPath) return post({ type: "runs", runs: { live: [], stored: [] } });
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
  streamAbort?.abort();
  streamAbort = new AbortController();

  let lastSeq = 0;
  await client.streamEvents(
    run.id,
    (event: RunEvent) => {
      lastSeq = event.seq;
      post({ type: "runEvent", event });
    },
    streamAbort.signal,
  );
  void lastSeq;

  const detail = (await client.run(run.id, repoPath)) as {
    run?: { state?: string; report?: { qualityGate?: unknown; runId?: string } };
  };
  const report = detail.run?.report;
  post({
    type: "runFinished",
    state: detail.run?.state ?? "completed",
    runId: report?.runId ?? run.id,
    gate: report?.qualityGate,
  });
  await sendRuns();
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
