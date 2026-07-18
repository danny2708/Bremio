import type { AgentEvent } from "@bremio/protocol";

/**
 * Map one line of `codex exec --json` output to normalized AgentEvent(s).
 *
 * Grounded in the real codex-cli 0.144.5 stream shape:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.completed","item":{"type":"agent_message"|
 *       "reasoning"|"command_execution"|...,"text":...,"command":...}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,...}}
 *
 * Unknown shapes fall back to a debug `log` event carrying the raw line, so
 * nothing is silently dropped. The authoritative final message is read from
 * the `--output-last-message` file, never from this stream.
 */
export function mapCodexLine(line: string, runId: string): AgentEvent[] {
  const ts = Date.now();
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [{ type: "log", runId, ts, level: "debug", message: trimmed }];
  }

  const rec = asRecord(obj);
  const type = String(rec.type ?? "");

  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    return mapItem(type, asRecord(rec.item), runId, ts);
  }
  if (type === "thread.started") {
    return [
      { type: "log", runId, ts, level: "info", message: `thread started ${String(rec.thread_id ?? "")}`.trim() },
    ];
  }
  if (type === "turn.completed") {
    const usage = asRecord(rec.usage);
    const inputTokens = Number(usage.input_tokens);
    const outputTokens = Number(usage.output_tokens);
    return [
      {
        type: "usage",
        runId,
        ts,
        ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
        ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
      },
    ];
  }
  if (type === "turn.started") return [];
  if (type.includes("error") || type === "turn.failed") {
    return [
      {
        type: "error",
        runId,
        ts,
        message: firstString(rec.message as string, compact(obj)) ?? "codex error",
        fatal: false,
      },
    ];
  }
  return [{ type: "log", runId, ts, level: "debug", message: compact(obj) }];
}

function mapItem(
  topType: string,
  item: Record<string, unknown>,
  runId: string,
  ts: number,
): AgentEvent[] {
  const itemType = String(item.type ?? "");
  const completed = topType === "item.completed";
  const text = firstString(item.text as string, item.message as string);
  const command = firstString(
    item.command as string,
    Array.isArray(item.command) ? (item.command as unknown[]).join(" ") : undefined,
  );

  if (itemType === "agent_message" || itemType === "assistant_message") {
    return completed && text ? [{ type: "message", runId, ts, role: "assistant", text }] : [];
  }
  if (itemType === "reasoning") {
    return completed && text ? [{ type: "thinking", runId, ts, text }] : [];
  }
  if (itemType.includes("command")) {
    // item.started → the command began; item.completed → its result.
    if (!completed) {
      return [{ type: "tool_use", runId, ts, name: "shell", ...(command ? { input: { command } } : {}) }];
    }
    const exit = Number(item.exit_code);
    const ok = Number.isFinite(exit) ? exit === 0 : true;
    const detail = firstString(item.aggregated_output as string, item.output as string, command);
    return [
      {
        type: "tool_result",
        runId,
        ts,
        name: "shell",
        ok,
        ...(Number.isFinite(exit) ? { exitCode: exit } : {}),
        ...(detail ? { detail } : {}),
      },
    ];
  }
  if (itemType.includes("file") || itemType.includes("patch")) {
    return completed ? [{ type: "tool_use", runId, ts, name: "edit", input: item }] : [];
  }
  return completed ? [{ type: "log", runId, ts, level: "debug", message: compact(item) }] : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function compact(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
