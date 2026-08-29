/**
 * Turn inspector data extraction (Sprint 10 — S10-T6).
 *
 * Extracts what a turn actually did:
 * - Worktree path where execution occurred
 * - Commands run by agents during the turn
 * - Files changed or touched during the turn
 */

export interface TurnInspection {
  runId: string;
  worktreePath?: string;
  commandsRun: string[];
  filesChanged: string[];
}

export function assembleTurnInspection(
  rawEvents: Array<Record<string, unknown>>,
  runRecord?: { id?: string; worktree_path?: string },
): TurnInspection {
  const commandsRun: string[] = [];
  const filesChanged: string[] = [];

  for (const ev of rawEvents ?? []) {
    const data = (typeof ev.data === "object" && ev.data !== null ? ev.data : {}) as Record<string, unknown>;

    // Commands executed
    const cmd = data.command ?? data.cmd ?? (typeof data.input === "object" && data.input !== null ? (data.input as Record<string, unknown>).command : undefined);
    if (typeof cmd === "string" && cmd.trim() && !commandsRun.includes(cmd.trim())) {
      commandsRun.push(cmd.trim());
    }

    // Files modified or referenced
    const file = data.file ?? data.path ?? data.filePath ?? (typeof data.input === "object" && data.input !== null ? ((data.input as Record<string, unknown>).path ?? (data.input as Record<string, unknown>).file_path) : undefined);
    if (typeof file === "string" && file.trim() && !filesChanged.includes(file.trim())) {
      filesChanged.push(file.trim());
    }
    if (Array.isArray(data.files)) {
      for (const f of data.files) {
        if (typeof f === "string" && f.trim() && !filesChanged.includes(f.trim())) {
          filesChanged.push(f.trim());
        }
      }
    }
  }

  return {
    runId: String(runRecord?.id ?? ""),
    worktreePath: runRecord?.worktree_path || undefined,
    commandsRun,
    filesChanged,
  };
}
