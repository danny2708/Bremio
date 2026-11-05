import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { DaemonClient } from "@bremio/daemon-client";
import type { PlanCheckpointDecision } from "@bremio/orchestrator";
import type { Plan } from "@bremio/protocol";

/**
 * `--review-plan` for the CLI (P2-T2).
 *
 * Interactive terminals get approve / reject / edit. Anything else fails
 * closed (docs/14 ADR-4): a checkpoint the user asked for but cannot answer
 * must not turn into an approval on their behalf.
 */

export const NON_INTERACTIVE_REASON =
  "--review-plan needs an interactive terminal to answer; failing closed (rerun in a terminal, or without --review-plan)";

export interface PlanPromptIo {
  interactive: boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
  /** Directory for the editable plan file (tests pass a temp dir). */
  editDir?: string;
}

export function terminalIo(): PlanPromptIo {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    print: (line) => console.log(line),
  };
}

export function formatPlanForReview(plan: Plan): string[] {
  const lines = [`plan: ${plan.summary}  (${plan.tasks.length} task(s), lead ${plan.leadAgentId})`];
  for (const task of plan.tasks) {
    const deps = task.dependencies.length > 0 ? `  ← ${task.dependencies.join(", ")}` : "";
    lines.push(`  ${task.id} [${task.kind}/${task.risk}] ${task.title}${deps}`);
    for (const criterion of task.acceptanceCriteria) lines.push(`      ✓ ${criterion}`);
  }
  return lines;
}

/** Ask for a decision on one plan. Never approves without a person saying so. */
export async function promptPlanDecision(plan: Plan, io: PlanPromptIo): Promise<PlanCheckpointDecision> {
  if (!io.interactive) return { decision: "reject", reason: NON_INTERACTIVE_REASON, decidedBy: "cli" };
  for (const line of formatPlanForReview(plan)) io.print(line);
  for (;;) {
    const answer = (await io.ask("\nplan checkpoint — [a]pprove, [r]eject, [e]dit? ")).trim().toLowerCase();
    if (answer === "a" || answer === "approve") return { decision: "approve", decidedBy: "cli" };
    if (answer === "r" || answer === "reject") {
      return { decision: "reject", reason: "rejected at the CLI", decidedBy: "cli" };
    }
    if (answer === "e" || answer === "edit") return editPlan(plan, io);
  }
}

async function editPlan(plan: Plan, io: PlanPromptIo): Promise<PlanCheckpointDecision> {
  const dir = await fs.mkdtemp(path.join(io.editDir ?? os.tmpdir(), "bremio-plan-"));
  const file = path.join(dir, "plan.json");
  try {
    await fs.writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    io.print(`edit the plan in ${file}`);
    await io.ask("press Enter when saved… ");
    const text = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // Hand it on anyway: the orchestrator's validator names the problem and
      // fails the run before anything executes.
      parsed = { invalidJson: (err as Error).message };
    }
    return { decision: "edit", plan: parsed, decidedBy: "cli" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Answer a daemon `plan-checkpoint` event. The CLI is a subscriber, so the
 * daemon will not fail closed on its own: the CLI must decide, and when it
 * cannot ask, it rejects.
 */
export async function answerDaemonCheckpoint(
  client: Pick<DaemonClient, "post">,
  event: { kind: string; data?: unknown },
  io: PlanPromptIo,
): Promise<boolean> {
  if (event.kind !== "plan-checkpoint") return false;
  const data = event.data as { requestId?: string; plan?: Plan } | undefined;
  if (!data?.requestId || !data.plan) return false;
  const decision = await promptPlanDecision(data.plan, io);
  const id = encodeURIComponent(data.requestId);
  if (decision.decision === "edit") {
    await client.post(`/approval/requests/${id}/edit-plan`, { plan: decision.plan, decidedBy: "cli" });
  } else {
    await client.post(`/approval/requests/${id}/decide`, {
      decision: decision.decision === "approve" ? "approved" : "rejected",
      decidedBy: "cli",
      ...(decision.decision === "reject" ? { reason: decision.reason } : {}),
    });
  }
  return true;
}
