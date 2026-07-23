import path from "node:path";
import { daemonStatus, defaultDatabasePath, RunStore } from "@bremio/daemon";
import { renderEvent } from "@bremio/event-view";
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
    console.log(`\n${c.bold(`Turn ${turn.turnIndex + 1}`)} ${c.dim(`(run ${turn.runId})`)}`);
    console.log(` Prompt: ${c.bold(turn.prompt)}`);
    if (turn.model || turn.reasoningLevel) {
      console.log(
        ` Model: ${c.dim(turn.model ?? "not reported")}${turn.reasoningLevel ? c.dim(` [${turn.reasoningLevel}]`) : ""}`,
      );
    }

    const events = runEventsMap.get(turn.runId) ?? [];
    const totalEvents = events.length;

    let displayEvents = events;
    let elided = 0;
    if (maxEvents > 0 && totalEvents > maxEvents) {
      displayEvents = events.slice(0, maxEvents);
      elided = totalEvents - maxEvents;
    }

    if (displayEvents.length > 0) {
      console.log(` Process:`);
      for (const ev of displayEvents) {
        const agentEv =
          typeof ev.data === "object" && ev.data !== null
            ? { type: ev.kind ?? "log", ...ev.data }
            : { type: ev.kind ?? "log", text: ev.message, message: ev.message };
        const view = renderEvent(agentEv as any);
        console.log(`   ${formatEventView(view)}`);
      }
      if (elided > 0) {
        console.log(
          c.yellow(
            `   ... elided ${elided} long transcript event(s). Use --max-events ${totalEvents} (or 0) to view full transcript.`,
          ),
        );
      }
    }

    console.log(` Outcome: ${statusGlyph(turn.status)}`);
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
  console.error(
    c.red(`error: unknown session subcommand '${subCommand ?? ""}'; expected 'list' or 'show'`),
  );
  return 2;
}
