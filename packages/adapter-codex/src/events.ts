import type { AgentEvent } from "@bremio/protocol";

/** Compact a value to a single-line string for logging. */
function compact(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Map one line of `codex exec --json` output to normalized AgentEvent(s).
 *
 * The exact JSONL schema is provider-internal and may shift between Codex
 * versions, so this mapper is deliberately tolerant: it recognizes the common
 * shapes (reasoning, assistant message, command execution, token usage, error)
 * and falls back to a debug `log` event carrying the raw line for anything
 * else — so nothing is ever silently dropped from the task log. The
 * authoritative final message is read from the `--output-last-message` file,
 * not from this stream, so mapper gaps never corrupt the result.
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

  const rec = obj as Record<string, unknown>;
  const msg = (rec.msg ?? {}) as Record<string, unknown>;
  const item = (rec.item ?? {}) as Record<string, unknown>;
  const kind = String(
    firstString(rec.type as string, msg.type as string, item.type as string) ??
      "",
  ).toLowerCase();

  const text = firstString(
    rec.text as string,
    msg.text as string,
    msg.message as string,
    item.text as string,
    (rec.delta as string) ?? undefined,
  );
  const command = firstString(
    rec.command as string,
    msg.command as string,
    item.command as string,
    Array.isArray(item.command) ? item.command.join(" ") : undefined,
  );

  const events: AgentEvent[] = [];

  if (kind.includes("reasoning") || kind.includes("thinking")) {
    if (text) events.push({ type: "thinking", runId, ts, text });
  } else if (
    kind.includes("agent_message") ||
    kind.includes("assistant") ||
    (kind.includes("message") && !kind.includes("user"))
  ) {
    if (text) events.push({ type: "message", runId, ts, role: "assistant", text });
  } else if (
    kind.includes("command") ||
    kind.includes("exec") ||
    kind.includes("tool")
  ) {
    events.push({
      type: "tool_use",
      runId,
      ts,
      name: "shell",
      ...(command ? { input: { command } } : {}),
    });
  } else if (kind.includes("token") || kind.includes("usage")) {
    const inputTokens = Number(msg.input_tokens ?? rec.input_tokens);
    const outputTokens = Number(msg.output_tokens ?? rec.output_tokens);
    events.push({
      type: "usage",
      runId,
      ts,
      ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    });
  } else if (kind.includes("error")) {
    events.push({
      type: "error",
      runId,
      ts,
      message: firstString(text, compact(obj)) ?? "codex error",
      fatal: false,
    });
  }

  if (events.length === 0) {
    events.push({ type: "log", runId, ts, level: "debug", message: compact(obj) });
  }
  return events;
}
