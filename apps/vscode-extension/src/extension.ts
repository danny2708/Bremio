import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import {
  BremioClient,
  BremioSetupError,
  DaemonUnavailableError,
  EXTENSION_VERSION,
  ProtocolMismatchError,
  type RemedyKind,
  type RunEvent,
} from "./client";
import { CliNotFoundError, launchCli } from "./cli-launcher";
import { extractResponse, panelHtml, renderEvent } from "./webview";

let panel: vscode.WebviewPanel | undefined;
let daemonProcess: ChildProcess | undefined;
let streamAbort: AbortController | undefined;
let lastActiveEditor: vscode.TextEditor | undefined;
const client = new BremioClient();
const output = vscode.window.createOutputChannel("Bremio");

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === "file") lastActiveEditor = editor;
    }),
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
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel("bremio", "Bremio", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    // Scope asset access to the media folder rather than the whole extension.
    localResourceRoots: [mediaRoot],
  });
  panel.iconPath = vscode.Uri.joinPath(mediaRoot, "icon.png");
  const nonce = randomBytes(16).toString("base64");
  panel.webview.html = panelHtml(
    nonce,
    panel.webview.cspSource,
    panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "icon.png")).toString(),
  );
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
      // Not something a retry or a panel reload can fix, so name the side that
      // is behind and what to run.
      reportSetupError(err);
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
  let spawnFailure: BremioSetupError | undefined;

  try {
    const { child, resolved } = launchCli(cli, ["daemon"]);
    output.appendLine(`starting daemon: ${resolved} daemon`);
    daemonProcess = child;
  } catch (err) {
    // Genuinely absent, as opposed to present but unlaunchable — the case that
    // used to be reported as "not installed" on every Windows machine.
    if (!(err instanceof CliNotFoundError)) throw err;
    spawnFailure = new BremioSetupError(
      "install-cli",
      `The Bremio CLI was not found (tried "${cli}").`,
      'Install it with "npm i -g bremio", or set "bremio.cliPath" to its full path.',
    );
    output.appendLine(spawnFailure.message);
    reportSetupError(spawnFailure);
    return false;
  }

  daemonProcess.stdout?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
  daemonProcess.stderr?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
  daemonProcess.on("error", (error) => {
    spawnFailure = new BremioSetupError(
      "restart-daemon",
      `The Bremio daemon failed to start: ${error.message}`,
    );
    output.appendLine(spawnFailure.message);
    reportSetupError(spawnFailure);
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
    // A spawn failure is more specific than "it never became ready", so it
    // wins: the user needs to hear "the CLI is not installed", not a timeout.
    if (spawnFailure) return false;
    reportSetupError(
      err instanceof BremioSetupError
        ? err
        : new BremioSetupError(
            "restart-daemon",
            `The Bremio daemon did not become ready: ${(err as Error).message}`,
          ),
    );
    return false;
  }
}

/** Remedies the panel can act on, in the user's words rather than an error code. */
const REMEDY_ACTIONS: Record<RemedyKind, string> = {
  "install-cli": 'Run "npm i -g bremio" in a terminal, then reopen this panel.',
  "update-cli": 'Run "npm i -g bremio" to update the CLI, then "bremio daemon restart".',
  "update-extension": "Update the Bremio extension from the Extensions view, then reload the window.",
  "restart-daemon": 'Run "bremio daemon restart" in a terminal, then reopen this panel.',
};

function reportSetupError(error: BremioSetupError): void {
  post({ type: "daemon", live: false, detail: shortLabel(error.remedy) });
  post({
    type: "error",
    kind: "setup",
    remedy: error.remedy,
    message: error.message,
    detail: [error.detail, REMEDY_ACTIONS[error.remedy]].filter(Boolean).join(" "),
    versions: { extension: EXTENSION_VERSION },
  });
}

function shortLabel(remedy: RemedyKind): string {
  switch (remedy) {
    case "install-cli":
      return "Bremio CLI not installed";
    case "update-cli":
      return "daemon is out of date";
    case "update-extension":
      return "extension is out of date";
    case "restart-daemon":
      return "daemon not responding";
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
        // Tell the panel which folder is open so the repository field starts
        // filled in. It already defaults to this on submit; showing it means
        // the user can see what will be used instead of guessing.
        post({ type: "workspace", repoPath: currentRepo() ?? "" });
        if (await ensureDaemon()) await refreshAll();
        return;
      case "reconnect":
        // `explicit` so this works even with autoStartDaemon off: the user
        // asking for a reconnect is as explicit as the intent gets.
        if (await ensureDaemon(true)) await refreshAll();
        return;
      case "tab":
        if (message.tab === "capacity") await sendCapacity();
        if (message.tab === "runs") await sendRuns();
        if (message.tab === "sessions") await sendSessions();
        if (message.tab === "doctor") await sendAdapters();
        return;
      case "openSession":
        if (typeof message.sessionId === "string") await sendSessionDetail(message.sessionId);
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
      case "applyDiff":
        await applyDiff(String(message.runId ?? ""));
        return;
      case "revertDiff":
        await revertDiff(String(message.runId ?? ""));
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
      case "pickFiles":
        await pickAttachments();
        return;
      case "attachActiveFile":
        attachActiveFile();
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

async function sendSessions(): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) return post({ type: "sessions", sessions: [] });
  post({ type: "sessions", ...(await client.sessions(repoPath)) });
}

/**
 * Send one session as a conversation: each turn with the work it did and the
 * answer it gave.
 *
 * The response is derived here rather than in the webview so the panel and the
 * CLI read the same events through the same rule.
 */
async function sendSessionDetail(sessionId: string): Promise<void> {
  const repoPath = currentRepo() ?? "";
  const { session } = await client.session(sessionId);

  const turns = await Promise.all(
    (session.turns ?? []).map(async (turn) => {
      let events: Array<Record<string, unknown>> = [];
      try {
        const detail = await client.run(turn.runId, repoPath);
        events = (detail.events ?? []) as unknown as Array<Record<string, unknown>>;
      } catch {
        // A turn whose run was pruned still belongs in the transcript; it
        // simply has no process detail left to show.
      }
      // Persisted events keep the agent payload under `data`; the answer lives
      // there, not in the envelope the daemon wraps around it.
      const agentEvents = events.map((event) =>
        typeof event.data === "object" && event.data !== null
          ? { kind: event.kind, ...(event.data as Record<string, unknown>) }
          : { kind: event.kind, text: event.message },
      );
      return {
        ...turn,
        // `renderEvent` returns its own `kind` (the display category, e.g.
        // "tool_use"), which is the one the transcript filters on.
        events: agentEvents.map((event) =>
          renderEvent({ type: String(event.kind ?? "log"), ...event } as never),
        ),
        response: extractResponse(agentEvents),
      };
    }),
  );

  post({ type: "sessionDetail", session, turns });
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

/**
 * Let the user attach workspace files as context for the prompt.
 *
 * VS Code's own picker is used rather than a webview file input: it respects
 * the workspace root, handles remote and virtual filesystems, and never copies
 * file contents through the webview.
 */
async function pickAttachments(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Attach as context",
    ...(currentRepo() ? { defaultUri: vscode.Uri.file(currentRepo() as string) } : {}),
  });
  if (picked?.length) post({ type: "attachments", files: picked.map(describeFile) });
}

export interface AttachmentFileEditor {
  readonly document: {
    readonly uri: { readonly scheme: string; readonly fsPath: string };
  };
}

/** Pure decision: return the file to attach, or an error. */
export function resolveActiveAttachment(
  editor: AttachmentFileEditor | undefined,
  lastEditor: AttachmentFileEditor | undefined,
  repoPath: string | undefined,
): { files: Array<{ path: string; label: string }> } | { error: string } {
  const active = editor ?? lastEditor;
  if (!active) return { error: "No file is open in the editor to attach." };
  if (active.document.uri.scheme !== "file") return { error: "No file is open in the editor to attach." };
  const full = active.document.uri.fsPath;
  return { files: [{ path: full, label: repoPath ? path.relative(repoPath, full) || full : full }] };
}

/** Attach whatever is open in the editor — the most common case, one click. */
function attachActiveFile(): void {
  const result = resolveActiveAttachment(
    vscode.window.activeTextEditor,
    lastActiveEditor,
    currentRepo(),
  );
  if ("error" in result) {
    post({ type: "error", message: result.error });
    return;
  }
  post({ type: "attachments", files: result.files });
}

function describeFile(uri: vscode.Uri): { path: string; label: string } {
  const repoPath = currentRepo();
  const full = uri.fsPath;
  // Show the workspace-relative name; send the absolute path, since the agent
  // resolves it from its own working directory.
  return { path: full, label: repoPath ? path.relative(repoPath, full) || full : full };
}

async function startRun(message: Record<string, unknown>): Promise<void> {
  const repoPath = String(message.repoPath ?? "").trim() || currentRepo();
  const typed = String(message.prompt ?? "").trim();
  if (!repoPath) throw new Error("open a folder or type a repository path first");
  if (!typed) throw new Error("a prompt is required");

  // Attachments are appended as paths for the agent to read itself. Adapters
  // already have file access, so this works for every provider — and for
  // images with providers that can open them — without inlining contents.
  const attached = Array.isArray(message.attachments)
    ? (message.attachments as string[]).filter((entry) => typeof entry === "string")
    : [];
  const prompt = attached.length
    ? [typed, "", "Context files (read these first):", ...attached.map((file) => `- ${file}`)].join(
        "\n",
      )
    : typed;

  // An unrecognised mode falls back to Single rather than to whatever the
  // daemon would default to — but `auto` must survive, or the panel would
  // quietly run Single while its button said Auto.
  const mode =
    message.mode === "team" ? "team" : message.mode === "auto" ? "auto" : "single";

  const { run } = await client.startRun({
    mode,
    repoPath,
    prompt,
    agentId: String(message.agentId ?? "claude"),
    ...(message.workerId ? { workerId: String(message.workerId) } : {}),
    ...(typeof message.maxConcurrency === "number"
      ? { maxConcurrency: message.maxConcurrency }
      : {}),
    ...(typeof message.sessionId === "string" && message.sessionId
      ? { sessionId: message.sessionId }
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
  const data = finished?.data as Record<string, unknown> | undefined;
  const gate = (data as { qualityGate?: unknown } | undefined)?.qualityGate;
  const fallbackReason = (data as { fallback?: { reason?: string } } | undefined)?.fallback?.reason;
  const autoModeReason = (data as { autoModeReason?: string } | undefined)?.autoModeReason;

  post({
    type: "runFinished",
    state: detail.run?.status ?? "completed",
    runId,
    recovery: detail.recovery,
    failureMessage: detail.run?.failureMessage,
    gate,
    fallbackReason,
    autoModeReason,
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

  post({ type: "runStarted", id: runId, prompt: detail.run.prompt, status: detail.run.status });
  const events = detail.events ?? [];
  if (events.length === 0) {
    post({ type: "runEmpty", id: runId });
  } else {
    for (const event of events) post({ type: "runEvent", event });
  }

  if (detail.run.status === "running" || detail.run.status === "queued") {
    // Still live: pick the stream back up from where the replay ended.
    const lastSeq = events.at(-1)?.seq ?? 0;
    await follow(runId, repoPath, lastSeq);
    return;
  }
  const finished = [...(detail.events ?? [])].reverse().find((e) => e.kind === "finished");
  const data = finished?.data as Record<string, unknown> | undefined;
  const gate2 = (data as { qualityGate?: unknown } | undefined)?.qualityGate;
  const fallbackReason2 = (data as { fallback?: { reason?: string } } | undefined)?.fallback?.reason;
  const autoModeReason2 = (data as { autoModeReason?: string } | undefined)?.autoModeReason;
  post({
    type: "runFinished",
    state: detail.run.status,
    runId,
    recovery: detail.recovery,
    failureMessage: detail.run.failureMessage,
    gate: gate2,
    fallbackReason: fallbackReason2,
    autoModeReason: autoModeReason2,
  });
}

/** Show the run's diff inline in the panel. */
async function viewDiff(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  const detail = (await client.run(runId, repoPath)) as Record<string, unknown>;
  const report = detail?.report as Record<string, unknown> | undefined;
  let diff: { stat: string; patch: string } | undefined;

  // Try reading the diff from the report (S5-T3 stores it on result/task results).
  if (report) {
    const result = report.result as Record<string, unknown> | undefined;
    if (result?.diff) diff = result.diff as { stat: string; patch: string };
    if (!diff) {
      const tasks = report.tasks as Array<Record<string, unknown>> | undefined;
      if (tasks) {
        for (const task of tasks) {
          const taskResult = task.result as Record<string, unknown> | undefined;
          if (taskResult?.diff) {
            diff = taskResult.diff as { stat: string; patch: string };
            break;
          }
        }
      }
    }
  }

  // Fall back to daemon /diff endpoint (pre-S5-T3 reports).
  if (!diff) {
    const tasks = report?.tasks as Array<{ result?: { branch?: string } }> | undefined;
    const branch = tasks?.find((t) => t.result?.branch)?.result?.branch;
    if (!branch) throw new Error("this run has no diff data or task branch");
    const daemonDiff = await client.diff(repoPath, branch);
    if (daemonDiff.error) throw new Error(daemonDiff.error);
    diff = daemonDiff;
  }

  post({ type: "showDiff", diff });
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

/** Apply a run's stored diff to the working tree. */
async function applyDiff(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const result = await client.applyPatch({ repoPath, runId });
  post({
    type: "applyResult",
    ok: result.ok,
    detail: result.ok
      ? "Changes applied."
      : (result.error ?? "apply refused"),
  });
}

/** Revert a run's stored diff from the working tree. */
async function revertDiff(runId: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const result = await client.revertPatch({ repoPath, runId });
  post({
    type: "revertResult",
    ok: result.ok,
    detail: result.ok
      ? "Changes reverted."
      : (result.error ?? "revert refused"),
  });
}
