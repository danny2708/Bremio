import type {
  AgentEvent,
  ReasoningLevel,
  RunOutcome,
  TestRun,
  UsageSummary,
} from "@bremio/protocol";
import type { TaskLog } from "@bremio/workspace";

export interface CollectedRun {
  outcome: RunOutcome;
  /** Concatenated assistant text across the run. */
  assistantText: string;
  /** Shell commands the agent ran (best-effort, for the report). */
  commands: string[];
  /** Shell command outcomes paired from tool_use/tool_result events. */
  tests: TestRun[];
  /** File paths the agent read (from tool_use events with read-like tool names). */
  filesRead: string[];
  /** File paths the agent wrote/edited (from tool_use events with write-like tool names). */
  filesWritten: string[];
  /** Sum of provider-reported usage events; missing dimensions stay unknown. */
  usage?: UsageSummary;
  /** Provider-confirmed identity, omitted if unavailable or inconsistent. */
  actualModel?: string;
  actualReasoningLevel?: ReasoningLevel;
}

const SHELL_TOOLS = new Set(["shell", "bash", "Bash", "run_command"]);

/** Tool names that indicate the agent read a file. */
const READ_TOOLS = new Set(["read", "Read", "view", "View", "grep", "Grep", "glob", "Glob"]);

/** Tool names that indicate the agent wrote or edited a file. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "edit"]);

/**
 * Drain an adapter's event stream: mirror every event to the task log and an
 * optional live callback, and collect the final outcome, assistant text, and
 * shell commands. If the stream ends without a `completed` event, a failed
 * outcome is synthesized so callers always get a definite result.
 */
export async function collectRun(
  events: AsyncIterable<AgentEvent>,
  opts: { log?: TaskLog; onEvent?: (event: AgentEvent) => void } = {},
): Promise<CollectedRun> {
  let outcome: RunOutcome | undefined;
  const textParts: string[] = [];
  const commands: string[] = [];
  const pendingShellCommands: string[] = [];
  const tests: TestRun[] = [];
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let costUsd: number | undefined;
  const models = new Set<string>();
  const reasoningLevels = new Set<ReasoningLevel>();

  for await (const event of events) {
    opts.log?.event(event);
    opts.onEvent?.(event);

    if (event.type === "message") {
      textParts.push(event.text);
    } else if (event.type === "tool_use" && SHELL_TOOLS.has(event.name)) {
      const cmd = (event.input as { command?: unknown } | undefined)?.command;
      if (typeof cmd === "string" && cmd.trim()) {
        const command = cmd.trim();
        commands.push(command);
        pendingShellCommands.push(command);
      }
    } else if (event.type === "tool_use" && READ_TOOLS.has(event.name)) {
      const input = event.input as Record<string, unknown> | undefined;
      const fp = typeof input?.file_path === "string"
        ? input.file_path
        : typeof input?.filepath === "string"
          ? input.filepath
          : typeof input?.path === "string"
            ? input.path
            : undefined;
      if (typeof fp === "string" && fp.trim()) {
        filesRead.push(fp.trim());
      }
    } else if (event.type === "tool_use" && WRITE_TOOLS.has(event.name)) {
      const input = event.input as Record<string, unknown> | undefined;
      const fp = typeof input?.file_path === "string"
        ? input.file_path
        : typeof input?.filepath === "string"
          ? input.filepath
          : typeof input?.path === "string"
            ? input.path
            : undefined;
      if (typeof fp === "string" && fp.trim()) {
        filesWritten.push(fp.trim());
      }
    } else if (event.type === "tool_result" && SHELL_TOOLS.has(event.name)) {
      const command = pendingShellCommands.shift() ?? event.name;
      const exitCode = event.exitCode ?? (event.ok ? 0 : 1);
      tests.push({
        command,
        passed: exitCode === 0 ? 1 : 0,
        failed: exitCode === 0 ? 0 : 1,
        exitCode,
      });
    } else if (event.type === "usage") {
      if (event.model) models.add(event.model);
      if (event.reasoningLevel) reasoningLevels.add(event.reasoningLevel);
      if (event.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + event.inputTokens;
      if (event.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + event.outputTokens;
      if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
    } else if (event.type === "completed") {
      outcome = event.outcome;
    }
  }

  return {
    outcome: outcome ?? { status: "failed", error: "run ended without a completed event" },
    assistantText: textParts.join("\n").trim(),
    commands,
    tests,
    filesRead,
    filesWritten,
    ...(inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          },
        }
      : {}),
    ...(models.size === 1 ? { actualModel: [...models][0] } : {}),
    ...(reasoningLevels.size === 1
      ? { actualReasoningLevel: [...reasoningLevels][0] }
      : {}),
  };
}
