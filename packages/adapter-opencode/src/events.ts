import type { AgentEvent } from "@bremio/protocol";

export function mapOpenCodeLine(line: string, runId: string): AgentEvent[] {
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

  if (type === "step_start") {
    return [{ type: "log", runId, ts, level: "debug", message: `step started` }];
  }

  if (type === "step_finish") {
    const part = asRecord(rec.part);
    const tokens = asRecord(part.tokens);
    const events: AgentEvent[] = [];

    if (tokens && typeof tokens.total === "number") {
      events.push({
        type: "usage",
        runId,
        ts,
        inputTokens: Number(tokens.input) || undefined,
        outputTokens: Number(tokens.output) || undefined,
      });
    }

    return events;
  }

  if (type === "text") {
    const part = asRecord(rec.part);
    const text = String(part.text ?? "");
    if (text) {
      return [{ type: "message", runId, ts, role: "assistant", text }];
    }
    return [];
  }

  if (type === "tool_use") {
    const part = asRecord(rec.part);
    const state = asRecord(part.state);
    const tool = String(part.tool ?? "");
    const input = state.input;
    const status = String(state.status ?? "");

    const events: AgentEvent[] = [];

    if (tool === "write" || tool === "edit" || tool === "patch") {
      const metadata = asRecord(state.metadata);
      const filepath = String(metadata.filepath ?? "");
      events.push({
        type: "tool_use",
        runId,
        ts,
        name: "edit",
        ...(filepath ? { input: { filepath } } : {}),
      });
    } else if (tool === "bash") {
      events.push({
        type: "tool_use",
        runId,
        ts,
        name: "shell",
        ...(input ? { input } : {}),
      });
    } else if (tool === "read") {
      events.push({
        type: "tool_use",
        runId,
        ts,
        name: "read",
        ...(input ? { input } : {}),
      });
    } else if (tool === "glob" || tool === "grep") {
      events.push({
        type: "tool_use",
        runId,
        ts,
        name: tool,
        ...(input ? { input } : {}),
      });
    } else {
      events.push({
        type: "log",
        runId,
        ts,
        level: "debug",
        message: `tool: ${tool}`,
      });
    }

    if (status === "completed" || status === "failed") {
      const ok = status === "completed";
      const output = String(state.output ?? "");
      let detail: string | undefined;
      if (output && output !== "Wrote file successfully.") {
        detail = output;
      }

      if (tool === "bash") {
        const meta = asRecord(state.metadata);
        const exitCode = Number(meta.exit_code ?? state.exit_code);
        events.push({
          type: "tool_result",
          runId,
          ts,
          name: "shell",
          ok,
          ...(Number.isFinite(exitCode) ? { exitCode } : {}),
          ...(detail ? { detail } : {}),
        });
      } else if (tool === "write" || tool === "edit" || tool === "patch") {
        events.push({
          type: "tool_result",
          runId,
          ts,
          name: "edit",
          ok,
          ...(detail ? { detail } : {}),
        });
      } else {
        events.push({
          type: "tool_result",
          runId,
          ts,
          name: tool,
          ok,
          ...(detail ? { detail } : {}),
        });
      }
    }

    return events;
  }

  return [{ type: "log", runId, ts, level: "debug", message: `unhandled: ${type}` }];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
