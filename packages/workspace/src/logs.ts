import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "@bremio/protocol";

const MAX_TEXT = 2000;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TEXT ? `${oneLine.slice(0, MAX_TEXT)}…` : oneLine;
}

function hhmmss(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/** Render one normalized AgentEvent as a single human-readable log line. */
export function formatEvent(e: AgentEvent): string {
  const t = hhmmss(e.ts);
  switch (e.type) {
    case "started":
      return `[${t}] ── run started (${e.runId})`;
    case "message":
      return `[${t}] assistant: ${clip(e.text)}`;
    case "thinking":
      return `[${t}] thinking: ${clip(e.text)}`;
    case "tool_use":
      return `[${t}] tool_use ${e.name}${e.input ? `: ${clip(JSON.stringify(e.input))}` : ""}`;
    case "tool_result":
      return `[${t}] tool_result ${e.name} ${e.ok ? "ok" : "FAILED"}${e.detail ? `: ${clip(e.detail)}` : ""}`;
    case "log":
      return `[${t}] log[${e.level}] ${clip(e.message)}`;
    case "usage":
      return `[${t}] usage in=${e.inputTokens ?? "?"} out=${e.outputTokens ?? "?"}${e.costUsd != null ? ` $${e.costUsd.toFixed(4)}` : ""}`;
    case "error":
      return `[${t}] ERROR${e.fatal ? " (fatal)" : ""}: ${clip(e.message)}`;
    case "completed":
      return `[${t}] ══ completed status=${e.outcome.status}${e.outcome.error ? ` error=${clip(e.outcome.error)}` : ""}`;
    case "guard_decision":
      return `[${t}] guard [${e.decision.level}] action=${e.decision.action} reason=${e.decision.reasonCode}`;
  }
}

/**
 * A single task's (or the lead's) log file. Every AgentEvent from the run is
 * appended here so a failed run is debuggable — one of the Phase 1 done-criteria.
 */
export class TaskLog {
  readonly path: string;
  private readonly stream: WriteStream;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.path = path.join(dir, `${name}.log`);
    this.stream = createWriteStream(this.path, { flags: "a" });
  }

  line(text: string): void {
    this.stream.write(`${text}\n`);
  }

  event(e: AgentEvent): void {
    this.line(formatEvent(e));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
