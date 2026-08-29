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
import { assembleTurnInspection } from "./turn-inspector";
import { assemblePlanChecklist, extractResponse, panelHtml, renderEvent } from "./webview";

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

  // `.git/HEAD` is rewritten by every checkout, so it is the exact signal that
  // the branch changed underneath us — rather than polling, or trusting a
  // label captured once when the panel opened (S10-T9).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder && typeof vscode.workspace.createFileSystemWatcher === "function") {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".git/HEAD"),
    );
    watcher.onDidChange(() => void sendRepoState());
    watcher.onDidCreate(() => void sendRepoState());
    context.subscriptions.push(watcher);
  }
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
 * The file a per-file apply/revert names, or undefined for the whole run.
 *
 * An empty string must not become a filePath: the daemon would look for a file
 * called "" in the patch and refuse, when the user meant the whole diff.
 */
/** The paths a git action names, keeping only real strings. */
function pathsOf(message: Record<string, unknown>): string[] {
  return Array.isArray(message.paths)
    ? (message.paths as unknown[]).filter((p): p is string => typeof p === "string" && p !== "")
    : [];
}

function filePathOf(message: Record<string, unknown>): string | undefined {
  const file = typeof message.filePath === "string" ? message.filePath.trim() : "";
  return file === "" ? undefined : file;
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
        if (message.tab === "runs") {
          await sendRuns();
          await sendActiveRuns();
        }
        if (message.tab === "sessions") await sendSessions();
        if (message.tab === "git") await sendGitStatus();
        if (message.tab === "doctor") await sendAdapters();
        return;
      case "refreshActive":
        await sendActiveRuns();
        return;
      case "gitRefresh":
        await sendGitStatus();
        return;
      case "gitStage":
        await gitStage(pathsOf(message), message.unstage === true);
        return;
      case "gitCommit":
        await gitCommit(String(message.message ?? ""));
        return;
      case "gitBranch":
        await gitBranch(String(message.name ?? ""), message.create === true);
        return;
      case "gitPush":
        await gitPush(message.setUpstream === true);
        return;
      case "gitPull":
        await gitPull(message.rebase === true);
        return;
      case "gitCreatePr":
        await gitCreatePr({
          title: String(message.title ?? ""),
          body: typeof message.body === "string" ? message.body : undefined,
          draft: message.draft === true,
          base: typeof message.base === "string" ? message.base : undefined,
          head: typeof message.head === "string" ? message.head : undefined,
        });
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
        await applyDiff(String(message.runId ?? ""), false, filePathOf(message));
        return;
      case "forceApplyDiff":
        await applyDiff(String(message.runId ?? ""), true, filePathOf(message));
        return;
      case "forceRevertDiff":
        await revertDiff(String(message.runId ?? ""), true, filePathOf(message));
        return;
      case "revertDiff":
        await revertDiff(String(message.runId ?? ""), false, filePathOf(message));
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
      case "addContextItem":
        if (typeof message.sessionId === "string" && typeof message.type === "string" && typeof message.source === "string") {
          await addContextItem(message.sessionId, message.type, message.source);
        }
        return;
      case "addContextFile":
        if (typeof message.sessionId === "string") {
          await addContextFile(message.sessionId);
        }
        return;
      case "addContextImage":
        if (typeof message.sessionId === "string") {
          await addContextImage(message.sessionId);
        }
        return;
      case "pasteImage":
        if (typeof message.sessionId === "string" && typeof message.dataUrl === "string" && typeof message.fileName === "string") {
          await handlePasteImage(message.sessionId, message.dataUrl, message.fileName);
        }
        return;
      case "removeQueued":
        if (typeof message.sessionId === "string" && typeof message.runId === "string") {
          await removeQueued(message.sessionId, message.runId);
        }
        return;
      case "releaseQueued":
        if (typeof message.sessionId === "string" && typeof message.runId === "string") {
          await releaseQueued(message.sessionId, message.runId);
        }
        return;
      case "removeContextItem":
        if (typeof message.sessionId === "string" && typeof message.itemId === "string") {
          await removeContextItem(message.sessionId, message.itemId);
        }
        return;
      case "toggleContextItem":
        if (typeof message.sessionId === "string" && typeof message.itemId === "string" && typeof message.enabled === "boolean") {
          await toggleContextItem(message.sessionId, message.itemId, message.enabled);
        }
        return;
      case "compactSession":
        if (typeof message.sessionId === "string") {
          await compactSession(message.sessionId);
        }
        return;
      case "forkSession":
        if (typeof message.sessionId === "string" && typeof message.turnIndex === "number") {
          await forkSession(message.sessionId, message.turnIndex);
        }
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
  await sendSessions();
  await sendActiveRuns();
  await sendRepoState();
}

async function sendAdapters(): Promise<void> {
  post({ type: "adapters", ...(await client.adapters()) });
}

async function sendSessions(): Promise<void> {
  try {
    const { groups } = await client.groupedSessions();
    post({ type: "sessions", groups });
  } catch {
    const repoPath = currentRepo();
    if (!repoPath) return post({ type: "sessions", sessions: [], groups: [] });
    const { sessions } = await client.sessions(repoPath);
    post({ type: "sessions", sessions, groups: [] });
  }
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
      let runRecord: Record<string, unknown> | undefined;
      try {
        const detail = await client.run(turn.runId, repoPath);
        events = (detail.events ?? []) as unknown as Array<Record<string, unknown>>;
        runRecord = detail.run as Record<string, unknown> | undefined;
      } catch {
      }
      const agentEvents = events.map((event) =>
        typeof event.data === "object" && event.data !== null
          ? { kind: event.kind, ...(event.data as Record<string, unknown>) }
          : { kind: event.kind, text: event.message },
      );
      return {
        ...turn,
        events: agentEvents.map((event) =>
          renderEvent({ type: String(event.kind ?? "log"), ...event } as never),
        ),
        response: extractResponse(agentEvents),
        // Built from the raw events, which still carry `taskId` and the plan
        // payload — `agentEvents` above has already flattened `data` away.
        plan: assemblePlanChecklist(events as never),
        inspection: assembleTurnInspection(events as never, runRecord as never),
      };
    }),
  );

  let contextItems: Array<{ id: string; type: string; source: string; enabled: boolean; preview?: string }> = [];
  try {
    const result = await client.contextItems(sessionId);
    contextItems = await withImagePreviews(result.contextItems);
  } catch {
    // context items are optional — session may have none
  }

  post({ type: "sessionDetail", session, turns, contextItems, queued: await queuedFor(sessionId) });
}

/** Prompts waiting behind this session's active turn; [] on any failure. */
async function queuedFor(sessionId: string): Promise<Array<{ id: string; prompt: string }>> {
  try {
    return (await client.sessionQueue(sessionId)).queued;
  } catch {
    // A daemon too old to know the route must not blank the transcript.
    return [];
  }
}

async function sendQueue(sessionId: string): Promise<void> {
  post({ type: "queueUpdated", sessionId, queued: await queuedFor(sessionId) });
}

async function removeQueued(sessionId: string, runId: string): Promise<void> {
  const result = await client.removeQueuedRun(runId);
  if (result.error) post({ type: "error", message: result.error });
  await sendQueue(sessionId);
}

async function releaseQueued(sessionId: string, runId: string): Promise<void> {
  const result = await client.releaseQueuedRun(runId);
  if (result.error) post({ type: "error", message: result.error });
  await sendQueue(sessionId);
}

async function forkSession(sessionId: string, turnIndex: number): Promise<void> {
  const result = await client.forkSession(sessionId, turnIndex);
  if (result.session) {
    await sendSessions();
    await sendSessionDetail(result.session.id);
  }
}

async function sendCapacity(): Promise<void> {
  post({ type: "capacity", capacity: await client.capacity(true) });
}

async function sendRuns(): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) return post({ type: "runs", runs: { runs: [], legacyReports: [] } });
  post({ type: "runs", runs: await client.runs(repoPath) });
}

/** Working-tree status and branches for the Git tab (S10-T10, S10-T11). */
async function sendGitStatus(): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) return post({ type: "gitStatus", git: { entries: [] } });
  try {
    const [git, branchList] = await Promise.all([
      client.gitStatus(repoPath),
      client.gitBranches(repoPath).catch(() => ({ branches: [] })),
    ]);
    post({ type: "gitStatus", git: { ...git, branches: branchList.branches } });
  } catch (err) {
    post({ type: "gitStatus", git: { entries: [], error: (err as Error).message } });
  }
}

/**
 * Create a branch, or move to one (S10-T11).
 *
 * A refusal here is expected traffic, not a fault: switching with uncommitted
 * changes is exactly what this must not do silently, so the daemon's named
 * reason is surfaced verbatim.
 */
async function gitBranch(name: string, create: boolean): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  if (!name.trim()) {
    post({ type: "gitResult", ok: false, detail: "Enter a branch name first." });
    return;
  }
  const result = await client.gitBranch({ repo: repoPath, name: name.trim(), create });
  post({
    type: "gitResult",
    ok: result.ok,
    detail: result.ok
      ? `${create ? "Created and switched to" : "Switched to"} ${name.trim()}.`
      : (result.error ?? "branch change refused"),
  });
  await sendGitStatus();
  await sendRepoState();
}

/**
 * Stage or unstage the paths the user selected — and only those (S10-T10).
 *
 * `docs/15` §2.4.1 pins the rule this obeys: never `git add -A`. The S5 review
 * removed exactly that call for flattening a partially staged index, and
 * staging is where it would be most tempting to bring back.
 */
async function gitStage(paths: string[], unstage: boolean): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  if (paths.length === 0) {
    post({ type: "gitResult", ok: false, detail: "Select at least one file first." });
    return;
  }
  const result = await client.gitStage({ repo: repoPath, paths, unstage });
  if (!result.ok) post({ type: "gitResult", ok: false, detail: result.error ?? "staging refused" });
  await sendGitStatus();
}

async function gitCommit(message: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  const result = await client.gitCommit({ repo: repoPath, message });
  post({
    type: "gitResult",
    ok: result.ok,
    detail: result.ok
      ? `Committed ${result.hash?.slice(0, 8)} — ${result.summary}`
      : (result.error ?? "commit refused"),
  });
  await sendGitStatus();
  // A commit does not move the branch pointer to a different branch, but it
  // does change what the branch is, and the panel shows it.
  await sendRepoState();
}

async function gitPush(setUpstream: boolean): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  const result = await client.gitPush({ repo: repoPath, setUpstream });
  post({
    type: "gitResult",
    ok: result.ok,
    detail: result.ok
      ? (result.summary ?? `Pushed ${result.branch} to ${result.remote}`)
      : (result.error ?? "push refused"),
  });
  await sendGitStatus();
  await sendRepoState();
}

async function gitPull(rebase: boolean): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  const result = await client.gitPull({ repo: repoPath, rebase });
  post({
    type: "gitResult",
    ok: result.ok,
    detail: result.ok
      ? (result.summary ?? `Pulled ${result.branch} from ${result.remote}`)
      : (result.error ?? "pull refused"),
  });
  await sendGitStatus();
  await sendRepoState();
}

async function gitCreatePr(options: {
  title: string;
  body?: string;
  draft?: boolean;
  base?: string;
  head?: string;
}): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");
  if (!options.title.trim()) {
    post({ type: "gitResult", ok: false, detail: "A pull request title is required." });
    return;
  }
  const result = await client.gitCreatePr({
    repo: repoPath,
    title: options.title,
    body: options.body,
    draft: options.draft,
    base: options.base,
    head: options.head,
  });
  post({
    type: "gitResult",
    ok: result.ok,
    detail: result.ok
      ? `Created pull request: ${result.url}`
      : (result.error ?? "pull request creation refused"),
  });
}

/**
 * The repository's current branch (S10-T9).
 *
 * Apply, revert and merge all act relative to whatever is checked out, so the
 * panel showing the wrong branch is worse than showing none — it would let a
 * user approve a merge believing it lands somewhere it does not. On any
 * failure the panel is told there is no branch rather than keeping the last
 * one it saw.
 */
async function sendRepoState(): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) return post({ type: "repoState", repoState: {} });
  try {
    post({ type: "repoState", repoState: await client.repoState(repoPath) });
  } catch {
    post({ type: "repoState", repoState: {} });
  }
}

/**
 * Who is working right now (S10-T4).
 *
 * Unfiltered by repository on purpose: a run started from another window is
 * precisely the one the user has no other way of knowing about, and hiding it
 * would let two windows drive the same daemon while each believed it was idle.
 */
async function sendActiveRuns(): Promise<void> {
  try {
    post({ type: "activeRuns", ...(await client.activeRuns()) });
  } catch {
    // An older daemon has no /active route. Report nothing rather than an
    // error: the panel works without this panelled view.
    post({ type: "activeRuns", active: [] });
  }
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

/** Biggest image we will inline into the panel. Screenshots are far smaller. */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

const PREVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * Read image context items into `data:` URIs the panel can render.
 *
 * The panel showed images as filename chips and nothing else, so a pasted
 * screenshot was a name and a token count. It cannot load them by path:
 * `localResourceRoots` is deliberately scoped to the extension's own `media`
 * folder, and context images live in the workspace (or anywhere the file
 * picker went). Inlining keeps that scope intact.
 *
 * A missing or oversized file yields no preview rather than an error — the
 * chip still lists it, which is the pre-existing behaviour.
 */
async function withImagePreviews<T extends { type: string; source: string }>(
  items: readonly T[],
): Promise<Array<T & { preview?: string }>> {
  return Promise.all(
    items.map(async (item) => {
      if (item.type !== "image") return item;
      const mime = PREVIEW_MIME[path.extname(item.source).toLowerCase()];
      if (!mime) return item;
      try {
        const uri = vscode.Uri.file(item.source);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_PREVIEW_BYTES) return item;
        const bytes = await vscode.workspace.fs.readFile(uri);
        return {
          ...item,
          preview: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
        };
      } catch {
        return item;
      }
    }),
  );
}

/** Send the session's context items to the panel, images included. */
async function postContextItems(sessionId: string): Promise<void> {
  const result = await client.contextItems(sessionId);
  post({
    type: "contextItemsUpdated",
    contextItems: await withImagePreviews(result.contextItems),
  });
}

function describeFile(uri: vscode.Uri): { path: string; label: string } {
  const repoPath = currentRepo();
  const full = uri.fsPath;
  // Show the workspace-relative name; send the absolute path, since the agent
  // resolves it from its own working directory.
  return { path: full, label: repoPath ? path.relative(repoPath, full) || full : full };
}

async function addContextItem(sessionId: string, type: string, source: string): Promise<void> {
  if (!source) {
    // empty source means let user pick a file
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true });
    if (!uris || uris.length === 0 || !uris[0]) return;
    const desc = describeFile(uris[0]);
    await client.createContextItem(sessionId, "file", desc.path);
  } else {
    await client.createContextItem(sessionId, type, source);
  }
  await postContextItems(sessionId);
}

export async function addContextFile(sessionId: string): Promise<void> {
  // "Add Current File" means the current file. This opened a file picker,
  // which is the one thing that button promises you will not have to do.
  // `resolveActiveAttachment` is the same resolution the composer's attach
  // button uses, including the `lastActiveEditor` fallback that matters here:
  // clicking into the Bremio panel clears `activeTextEditor`, so without it
  // the answer is always "no file open".
  const result = resolveActiveAttachment(
    vscode.window.activeTextEditor,
    lastActiveEditor,
    currentRepo(),
  );
  if ("error" in result) {
    void vscode.window.showWarningMessage(
      "Bremio: no file is open in the editor. Open one, then use Add Current File.",
    );
    return;
  }
  await client.createContextItem(sessionId, "file", result.files[0]!.path);
  await postContextItems(sessionId);
}

async function addContextImage(sessionId: string): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    filters: { Images: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"] },
  });
  if (!uris || uris.length === 0 || !uris[0]) return;
  const desc = describeFile(uris[0]);
  await client.createContextItem(sessionId, "image", desc.path);
  await postContextItems(sessionId);
}

async function handlePasteImage(sessionId: string, dataUrl: string, fileName: string): Promise<void> {
  // Save the pasted/dropped image to the workspace's .bremio/context-images/ folder.
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const buf = Buffer.from(base64, "base64");
  const repoPath = currentRepo();
  if (!repoPath) return;
  const imagesDir = path.join(repoPath, ".bremio", "context-images");
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));
  const target = path.join(imagesDir, fileName);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(target), new Uint8Array(buf));
  await client.createContextItem(sessionId, "image", target);
  await postContextItems(sessionId);
}

async function removeContextItem(sessionId: string, itemId: string): Promise<void> {
  await client.deleteContextItem(sessionId, itemId);
  await postContextItems(sessionId);
}

async function toggleContextItem(sessionId: string, itemId: string, enabled: boolean): Promise<void> {
  await client.updateContextItemEnabled(sessionId, itemId, enabled);
  await postContextItems(sessionId);
}

async function compactSession(sessionId: string): Promise<void> {
  await client.compactSession(sessionId);
  // Refresh the session detail to update context items / compacts
  await sendSessionDetail(sessionId);
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

  // Collect enabled context items of type "image" for vision-gated inclusion
  const sessionId = typeof message.sessionId === "string" && message.sessionId ? message.sessionId : "";
  let imageContextPaths: string[] = [];
  if (sessionId) {
    try {
      const { contextItems } = await client.contextItems(sessionId);
      imageContextPaths = contextItems
        .filter((item) => item.type === "image" && item.enabled)
        .map((item) => item.source);
    } catch {
      // context items are optional
    }
  }
  const hasImages = imageContextPaths.length > 0;
  const agentId = String(message.agentId ?? "claude");
  // Ask what this agent can actually do. The note below used to assert "this
  // provider does not have vision" unconditionally — true of every adapter
  // shipped today, and a lie the first time one reports otherwise. S7-T3 asked
  // for a vision *gate*; a constant is not one.
  let agentHasVision = false;
  if (hasImages) {
    try {
      const { adapters } = await client.adapters();
      agentHasVision = Boolean(adapters.find((a) => a.id === agentId)?.capabilities?.vision);
    } catch {
      // Unknown capability is not evidence of vision — keep the degraded path.
    }
  }
  const promptLines = [typed];
  if (attached.length > 0) {
    promptLines.push("", "Context files (read these first):");
    promptLines.push(...attached.map((file) => `- ${file}`));
  }
  if (hasImages) {
    promptLines.push(
      "",
      agentHasVision
        ? "Image context files:"
        : "Image context files (attached as file references — this provider does not have vision, so these files will be read as text/referenced by path):",
    );
    promptLines.push(...imageContextPaths.map((file) => `- ${file}`));
  }
  const prompt = promptLines.join("\n");

  // An unrecognised mode falls back to Single rather than to whatever the
  // daemon would default to — but `auto` must survive, or the panel would
  // quietly run Single while its button said Auto.
  const mode =
    message.mode === "team" ? "team" : message.mode === "auto" ? "auto" : "single";

  const { run } = await client.startRun({
    mode,
    repoPath,
    prompt,
    agentId,
    ...(Array.isArray(message.workerIds)
      ? { workerIds: (message.workerIds as string[]).map(String) }
      : message.workerId
        ? { workerId: String(message.workerId) }
        : {}),
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

  const state = detail.run?.status ?? "completed";
  post({
    type: "runFinished",
    state,
    runId,
    recovery: detail.recovery,
    failureMessage: detail.run?.failureMessage,
    gate,
    fallbackReason,
    autoModeReason,
  });
  await sendRuns();

  // This turn ending is exactly when the queue either advances or is held, so
  // the panel is told which. `held` mirrors the daemon's rule: only a completed
  // turn releases the next prompt on its own.
  const sessionId = (detail.run as { sessionId?: string } | undefined)?.sessionId;
  if (sessionId) {
    post({
      type: "queueUpdated",
      sessionId,
      queued: await queuedFor(sessionId),
      held: state !== "completed",
    });
  }
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
  // A merge can leave the repository on a different branch than the label the
  // panel is currently showing.
  await sendRepoState();
}

/**
 * Apply a run's stored diff, or just one file of it (S10-T5).
 *
 * The daemon and CLI have taken a `filePath` since S5-T5; the panel simply
 * never sent one, so its Apply was all-or-nothing.
 */
async function applyDiff(runId: string, force = false, filePath?: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const result = await client.applyPatch({
    repoPath,
    runId,
    force,
    ...(filePath ? { filePath } : {}),
  });
  post({
    type: "applyResult",
    ok: result.ok,
    ...(filePath ? { filePath } : {}),
    detail: result.ok
      ? `Changes applied${filePath ? ` to ${filePath}` : ""}.`
      : (result.error ?? "apply refused"),
    conflictedFiles: result.conflictedFiles,
    // Where `--force` put the user's overwritten edits. The CLI has printed
    // this since the S5 review; the panel silently dropped it, which is the
    // surface where force is one click away.
    recoveryPatch: result.recoveryPatch,
  });
}

/** Revert a run's stored diff, or just one file of it (S10-T5). */
async function revertDiff(runId: string, force = false, filePath?: string): Promise<void> {
  const repoPath = currentRepo();
  if (!repoPath) throw new Error("no workspace folder is open");

  const result = await client.revertPatch({
    repoPath,
    runId,
    force,
    ...(filePath ? { filePath } : {}),
  });
  post({
    type: "revertResult",
    ok: result.ok,
    ...(filePath ? { filePath } : {}),
    detail: result.ok
      ? `Changes reverted${filePath ? ` from ${filePath}` : ""}.`
      : (result.error ?? "revert refused"),
    conflictedFiles: result.conflictedFiles,
    recoveryPatch: result.recoveryPatch,
  });
}
