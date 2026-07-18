import type { AgentEvent, RunOutcome, TestRun } from "@bremio/protocol";
import type { TaskLog } from "@bremio/workspace";

export interface CollectedRun {
  outcome: RunOutcome;
  /** Concatenated assistant text across the run. */
  assistantText: string;
  /** Shell commands the agent ran (best-effort, for the report). */
  commands: string[];
  /** Shell command outcomes paired from tool_use/tool_result events. */
  tests: TestRun[];
}

const SHELL_TOOLS = new Set(["shell", "bash", "Bash"]);

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
    } else if (event.type === "tool_result" && SHELL_TOOLS.has(event.name)) {
      const command = pendingShellCommands.shift() ?? event.name;
      const exitCode = event.exitCode ?? (event.ok ? 0 : 1);
      tests.push({
        command,
        passed: exitCode === 0 ? 1 : 0,
        failed: exitCode === 0 ? 0 : 1,
        exitCode,
      });
    } else if (event.type === "completed") {
      outcome = event.outcome;
    }
  }

  return {
    outcome: outcome ?? { status: "failed", error: "run ended without a completed event" },
    assistantText: textParts.join("\n").trim(),
    commands,
    tests,
  };
}
