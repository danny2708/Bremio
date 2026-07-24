import path from "node:path";
import { AntigravityAdapter } from "@bremio/adapter-antigravity";
import { ClaudeAdapter } from "@bremio/adapter-claude";
import { CodexAdapter } from "@bremio/adapter-codex";
import { OpenCodeAdapter } from "@bremio/adapter-opencode";
import { daemonStatus, defaultDatabasePath, RunStore } from "@bremio/daemon";
import { extractResponse, renderEvent } from "@bremio/event-view";
import { createRegistry, runBremio, runSingleAgent } from "@bremio/orchestrator";
import { c, formatEventView, statusGlyph } from "./ui";

export interface SessionListOptions {
  repoPath?: string;
  json?: boolean;
  databasePath?: string;
}

export interface SessionShowOptions {
  id: string;
  json?: boolean;
  databasePath?: string;
  maxEvents?: number;
}

export async function listSessionsCommand(options: SessionListOptions): Promise<number> {
  const repoPath = path.resolve(options.repoPath ?? ".");

  let sessions: any[] = [];
  if (options.databasePath) {
    sessions = await listSessionsFromStore(repoPath, options.databasePath);
  } else {
    const status = await daemonStatus();
    if (status.running) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${status.endpoint.port}/sessions?repo=${encodeURIComponent(repoPath)}`,
          { headers: { "x-bremio-token": status.endpoint.token } },
        );
        if (res.ok) {
          const data = (await res.json()) as { sessions: any[] };
          sessions = data.sessions ?? [];
        } else {
          sessions = await listSessionsFromStore(repoPath, options.databasePath);
        }
      } catch {
        sessions = await listSessionsFromStore(repoPath, options.databasePath);
      }
    } else {
      sessions = await listSessionsFromStore(repoPath, options.databasePath);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ sessions }, null, 2));
    return 0;
  }

  if (sessions.length === 0) {
    console.log(c.dim(`No sessions found for repository: ${repoPath}`));
    return 0;
  }

  const line = "─".repeat(70);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Sessions")} (${c.dim(repoPath)})`);
  console.log(line);

  for (const s of sessions) {
    const turnsText = `${s.turnCount ?? 1} turn${(s.turnCount ?? 1) === 1 ? "" : "s"}`;
    const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
    const stGlyph = s.status ? statusGlyph(s.status) : "";
    console.log(
      `  ${c.cyan(s.id)}  ${c.bold(s.title || "Untitled")}  ${c.dim(`[${turnsText}]`)}  ${stGlyph}  ${c.dim(updated)}`,
    );
  }
  console.log(line);
  return 0;
}

async function listSessionsFromStore(repoPath: string, dbPath?: string) {
  try {
    const store = await RunStore.open(dbPath ?? defaultDatabasePath());
    try {
      return store.listSessions(repoPath);
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
}

export async function showSessionCommand(options: SessionShowOptions): Promise<number> {
  const { id } = options;
  if (!id) {
    console.error(c.red("error: session id is required"));
    return 1;
  }

  let sessionDetail: any | undefined;
  let runEventsMap = new Map<string, any[]>();

  if (options.databasePath) {
    const resFromStore = await showSessionFromStore(id, options.databasePath);
    if (!resFromStore) {
      console.error(c.red(`error: unknown session: ${id}`));
      return 1;
    }
    sessionDetail = resFromStore.sessionDetail;
    runEventsMap = resFromStore.runEventsMap;
  } else {
    const status = await daemonStatus();
    if (status.running) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${status.endpoint.port}/sessions/${encodeURIComponent(id)}`,
          { headers: { "x-bremio-token": status.endpoint.token } },
        );
        if (res.ok) {
          const data = (await res.json()) as { session: any };
          sessionDetail = data.session;

          for (const turn of sessionDetail.turns ?? []) {
            const runRes = await fetch(
              `http://127.0.0.1:${status.endpoint.port}/runs/${encodeURIComponent(turn.runId)}`,
              { headers: { "x-bremio-token": status.endpoint.token } },
            );
            if (runRes.ok) {
              const runData = (await runRes.json()) as { events?: any[] };
              runEventsMap.set(turn.runId, runData.events ?? []);
            }
          }
        } else {
          const resFromStore = await showSessionFromStore(id, options.databasePath);
          if (resFromStore) {
            sessionDetail = resFromStore.sessionDetail;
            runEventsMap = resFromStore.runEventsMap;
          }
        }
      } catch {
        const resFromStore = await showSessionFromStore(id, options.databasePath);
        if (resFromStore) {
          sessionDetail = resFromStore.sessionDetail;
          runEventsMap = resFromStore.runEventsMap;
        }
      }
    } else {
      const resFromStore = await showSessionFromStore(id, options.databasePath);
      if (resFromStore) {
        sessionDetail = resFromStore.sessionDetail;
        runEventsMap = resFromStore.runEventsMap;
      }
    }
  }

  if (!sessionDetail) {
    console.error(c.red(`error: unknown session: ${id}`));
    return 1;
  }

  if (options.json) {
    const jsonTurns = (sessionDetail.turns ?? []).map((turn: any) => ({
      ...turn,
      events: runEventsMap.get(turn.runId) ?? [],
    }));
    console.log(JSON.stringify({ session: { ...sessionDetail, turns: jsonTurns } }, null, 2));
    return 0;
  }

  const line = "─".repeat(70);
  console.log(`\n${line}`);
  console.log(` ${c.bold("Session")}  ${c.dim(sessionDetail.id)} — ${c.bold(sessionDetail.title)}`);
  console.log(` repo: ${c.dim(sessionDetail.repositoryPath)}`);
  console.log(line);

  const maxEvents = options.maxEvents ?? 100;

  for (const turn of sessionDetail.turns ?? []) {
    const events = runEventsMap.get(turn.runId) ?? [];
    const agentEvents = events.map((ev) =>
      typeof ev.data === "object" && ev.data !== null
        ? { type: ev.kind ?? "log", ...ev.data }
        : { type: ev.kind ?? "log", text: ev.message, message: ev.message },
    );

    // Attributed like a conversation rather than labelled like a record: the
    // prompt is something the user said and the response is the agent's reply.
    console.log(`\n${c.bold("You")} ${c.dim(`· turn ${turn.turnIndex + 1}`)}`);
    for (const promptLine of turn.prompt.split("\n")) console.log(`  ${promptLine}`);

    const who = turn.model ?? "Agent";
    console.log(
      `\n${c.bold(who)}${turn.reasoningLevel ? c.dim(` · ${turn.reasoningLevel}`) : ""}`,
    );

    const totalEvents = events.length;
    let displayEvents = agentEvents;
    let elided = 0;
    if (maxEvents > 0 && totalEvents > maxEvents) {
      displayEvents = agentEvents.slice(0, maxEvents);
      elided = totalEvents - maxEvents;
    }

    // The work the agent did, dimmed and subordinate. The answer itself is
    // printed after it, undimmed — it is what the user asked for, and until
    // now no surface showed it at all.
    for (const agentEv of displayEvents) {
      if (agentEv.type === "message" || agentEv.type === "completed") continue;
      console.log(`  ${c.dim(formatEventView(renderEvent(agentEv as any)))}`);
    }
    if (elided > 0) {
      console.log(
        c.yellow(
          `  ... elided ${elided} long transcript event(s). Use --max-events ${totalEvents} (or 0) to view full transcript.`,
        ),
      );
    }

    const response = extractResponse(agentEvents);
    if (response) {
      console.log("");
      for (const responseLine of response.split("\n")) console.log(`  ${responseLine}`);
    } else {
      console.log(`  ${c.dim("(no response recorded)")}`);
    }

    console.log(`\n  ${c.dim(`${statusGlyph(turn.status)} ${turn.status}`)}`);
  }

  console.log(line);
  return 0;
}

async function showSessionFromStore(id: string, dbPath?: string) {
  try {
    const store = await RunStore.open(dbPath ?? defaultDatabasePath());
    try {
      const sessionDetail = store.sessionDetail(id);
      if (!sessionDetail) return undefined;

      const runEventsMap = new Map<string, any[]>();
      for (const turn of sessionDetail.turns) {
        const persistedEvents = store.readEvents(turn.runId);
        const wireEvents = persistedEvents.map((e) => ({
          seq: e.seq,
          ts: Date.parse(e.timestamp),
          kind: e.type,
          message: (e.payload as any)?.message ?? "",
          data: (e.payload as any)?.data ?? e.payload,
        }));
        runEventsMap.set(turn.runId, wireEvents);
      }

      return { sessionDetail, runEventsMap };
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

/** A turn, reduced to the fields that identify how it ran. */
export interface SessionIdentityTurn {
  leadProvider?: string;
  workerProviders?: string[];
  mode?: "single" | "team";
  /** Provider-confirmed model. Present only to be *ignored* — see below. */
  model?: string;
}

export type SessionIdentity =
  | { ok: true; mode: "single" | "team"; primaryAgent: string; workerAgent?: string }
  | { ok: false; error: string };

/**
 * Work out which agent and collaboration mode a session must resume on.
 *
 * This exists because the previous expression was
 * `latestTurn?.model?.split("/")[0] ?? "claude"`, which is wrong twice over.
 * `model` is a provider-*confirmed* runtime fact, not the agent that was
 * requested, so parsing it conflates the two. And it is never populated: it is
 * read from `usage` events, of which the real database contains zero across 897
 * events. The parse therefore never ran, and every session — Antigravity,
 * Codex, OpenCode, Team — silently resumed on Claude.
 *
 * The rule now: identity comes only from what was persisted at creation, and
 * anything unknown stops the resume rather than guessing. A wrong provider is
 * worse than a refusal, because the user is billed for it and the answer looks
 * legitimate.
 */
export function resolveSessionIdentity(input: {
  sessionId: string;
  turns: readonly SessionIdentityTurn[];
  availableAgentIds: readonly string[];
}): SessionIdentity {
  const { sessionId, turns, availableAgentIds } = input;
  const latest = turns.at(-1);

  if (!latest) {
    return { ok: false, error: `cannot resume session ${sessionId}: it has no recorded turns.` };
  }

  const mode = latest.mode;
  if (mode !== "single" && mode !== "team") {
    return {
      ok: false,
      error:
        `cannot resume session ${sessionId}: collaboration mode is missing from the stored run. ` +
        `Start a new run and choose Single or Team explicitly.`,
    };
  }

  const primaryAgent = latest.leadProvider;
  if (!primaryAgent) {
    return {
      ok: false,
      error:
        `cannot resume session ${sessionId}: the agent it originally ran on was not recorded. ` +
        `Start a new run and choose the agent explicitly — it was not switched to another provider.`,
    };
  }

  if (!availableAgentIds.includes(primaryAgent)) {
    return {
      ok: false,
      error:
        `cannot resume session ${sessionId}: agent "${primaryAgent}" is not available ` +
        `(registered: ${[...availableAgentIds].sort().join(", ") || "none"}). ` +
        `The session was not switched to another provider.`,
    };
  }

  const workerAgent = latest.workerProviders?.[0];
  if (mode === "team" && workerAgent && !availableAgentIds.includes(workerAgent)) {
    return {
      ok: false,
      error:
        `cannot resume session ${sessionId}: worker agent "${workerAgent}" is not available. ` +
        `The session was not switched to another provider.`,
    };
  }

  return { ok: true, mode, primaryAgent, ...(workerAgent ? { workerAgent } : {}) };
}

export async function continueSessionCommand(options: {
  id: string;
  prompt: string;
  repoPath?: string;
  databasePath?: string;
}): Promise<number> {
  const { id, prompt } = options;
  if (!id) {
    console.error(c.red("error: session id is required for 'bremio session continue <id>'"));
    return 1;
  }
  if (!prompt) {
    console.error(c.red("error: prompt is required to continue a session"));
    return 1;
  }

  const store = await RunStore.open(options.databasePath ?? defaultDatabasePath());
  let detail: any;
  try {
    detail = store.sessionDetail(id);
  } finally {
    store.close();
  }

  if (!detail) {
    console.error(c.red(`error: session not found: ${id}`));
    return 1;
  }

  const priorTurns = (detail.turns ?? []).map((t: any) => ({
    turnIndex: t.turnIndex,
    prompt: t.prompt,
    finalText: t.summary,
    summary: t.summary,
  }));

  const latestTurn = (detail.turns ?? []).at(-1);
  const providerSessionId = latestTurn?.sessionId;

  const repoPath = path.resolve(options.repoPath ?? detail.repositoryPath ?? ".");
  const registry = createRegistry([
    new ClaudeAdapter(),
    new CodexAdapter(),
    new AntigravityAdapter(),
    new OpenCodeAdapter(),
  ]);

  const resolved = resolveSessionIdentity({
    sessionId: id,
    turns: detail.turns ?? [],
    availableAgentIds: [...registry.keys()],
  });
  if (!resolved.ok) {
    console.error(c.red(`error: ${resolved.error}`));
    return 1;
  }
  const { mode, primaryAgent } = resolved;
  const turnIndex = (detail.turns ?? []).length;

  console.log(`Continuing session ${id} (turn ${turnIndex}) in ${mode} mode on ${primaryAgent}...`);

  if (mode === "single") {
    const report = await runSingleAgent({
      primaryAgentId: primaryAgent,
      repoPath,
      prompt,
      registry,
      sessionId: id,
      turnIndex,
      priorTurns,
      providerSessionId,
    });
    console.log(`Turn ${turnIndex} status: ${statusGlyph(report.result.status)}`);
    if (report.mechanismDecision) {
      console.log(`Mechanism used: ${report.mechanismDecision.mechanism} (${report.mechanismDecision.reason})`);
    }
  } else {
    const report = await runBremio({
      leadId: primaryAgent,
      // Carried forward for the same reason as the lead: the worker was chosen
      // once and must not be re-picked from whatever happens to be registered.
      ...(resolved.workerAgent ? { workerId: resolved.workerAgent } : {}),
      repoPath,
      prompt,
      registry,
      sessionId: id,
      turnIndex,
      priorTurns,
      providerSessionId,
    });
    const status = report.mode === "single" ? report.result.status : report.qualityGate.status === "passed" ? "completed" : "failed";
    console.log(`Turn ${turnIndex} status: ${statusGlyph(status)}`);
  }

  return 0;
}

export async function sessionCommandFromCli(
  values: Record<string, unknown>,
  positionals: string[],
): Promise<number> {
  const subCommand = positionals[1];
  if (subCommand === "list") {
    const repoPath = values.repo ? path.resolve(values.repo as string) : process.cwd();
    return listSessionsCommand({
      repoPath,
      json: values.json === true,
      ...(values.db ? { databasePath: path.resolve(values.db as string) } : {}),
    });
  }
  if (subCommand === "show") {
    const id = positionals[2];
    if (!id) {
      console.error(c.red("error: session id is required for 'bremio session show <id>'"));
      return 2;
    }
    const maxEvents =
      values["max-events"] !== undefined ? Number(values["max-events"]) : undefined;
    return showSessionCommand({
      id,
      json: values.json === true,
      ...(maxEvents !== undefined && Number.isFinite(maxEvents) ? { maxEvents } : {}),
      ...(values.db ? { databasePath: path.resolve(values.db as string) } : {}),
    });
  }
  if (subCommand === "continue") {
    const id = positionals[2];
    const prompt = positionals.slice(3).join(" ") || (values.prompt as string) || "";
    return continueSessionCommand({
      id: id ?? "",
      prompt,
      ...(values.repo ? { repoPath: path.resolve(values.repo as string) } : {}),
      ...(values.db ? { databasePath: path.resolve(values.db as string) } : {}),
    });
  }
  console.error(
    c.red(`error: unknown session subcommand '${subCommand ?? ""}'; expected 'list', 'show', or 'continue'`),
  );
  return 2;
}
