import type { Plan, Task } from "@bremio/protocol";

/**
 * A lenient-but-guiding JSON Schema for the lead's plan output, passed to
 * adapters as `outputSchema` (Codex `--output-schema`, Claude `outputFormat`).
 * It steers the model toward the right shape; the authoritative validation is
 * still `PlanSchema.parse` in the lead-manager, so provider quirks in schema
 * enforcement never corrupt the result.
 */
export const planJsonSchema: Record<string, unknown> = {
  type: "object",
  required: ["summary", "leadAgentId", "tasks"],
  properties: {
    summary: { type: "string" },
    leadAgentId: { type: "string" },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "title", "kind", "risk"],
        properties: {
          id: { type: "string", description: "e.g. TASK-001" },
          title: { type: "string" },
          kind: {
            type: "string",
            enum: ["analysis", "implementation", "review", "test", "documentation", "other"],
          },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          requiredCapabilities: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "repository.read",
                "repository.write",
                "shell",
                "test",
                "review",
                "browser",
                "vision",
              ],
            },
          },
          preferredAgents: { type: "array", items: { type: "string" } },
          dependencies: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
      },
    },
  },
};

/** Short role framing used as the lead's system-prompt append (Claude only). */
export const LEAD_SYSTEM_PROMPT =
  "You are the LEAD planner coordinating a team of AI coding agents. " +
  "You analyze the repository and the request, then return a structured plan. " +
  "You do not implement the change yourself in this step.";

/** Build the full planning instruction (works for both Claude and Codex). */
export function buildPlanningPrompt(userPrompt: string): string {
  return [
    "You are the LEAD planner for a team of AI coding agents working on the repository in the current working directory.",
    "Analyze the repository and the user's request below, then produce a PLAN.",
    "",
    "USER REQUEST:",
    userPrompt,
    "",
    "PLAN RULES:",
    "- Decompose into a SMALL number of concrete tasks (1-4). Prefer fewer tasks.",
    "- Include at least one `implementation` task that another agent can execute to make the actual code change.",
    "- Each task needs: id (e.g. \"TASK-001\"), title, kind (analysis|implementation|review|test|documentation|other), risk (low|medium|high), requiredCapabilities (subset of repository.read, repository.write, shell, test, review, browser, vision), preferredAgents (e.g. [\"codex\"]), dependencies (ids of prerequisite tasks, [] if none), acceptanceCriteria (concrete, checkable strings). Optionally add `description` with implementation context.",
    "- Order tasks so that any task's dependencies appear before it.",
    "- Set leadAgentId to your own provider id.",
    "",
    "OUTPUT:",
    "Return ONLY a single JSON object for the plan. No prose, no explanation, no markdown code fences.",
  ].join("\n");
}

/** Build a repair prompt after an invalid plan attempt. */
export function buildRepairPrompt(userPrompt: string, error: string): string {
  return [
    buildPlanningPrompt(userPrompt),
    "",
    "IMPORTANT: your previous attempt was INVALID and could not be parsed:",
    error,
    "Return corrected JSON only.",
  ].join("\n");
}

/** Build the instruction handed to a worker for one task. */
export function buildTaskPrompt(plan: Plan, task: Task): string {
  const readOnly = task.kind === "review" || task.kind === "analysis";
  const lines = [
    "You are executing ONE task within a larger plan, in an isolated git worktree (the current working directory).",
    "",
    `OVERALL GOAL: ${plan.summary}`,
    "",
    `YOUR TASK (${task.id} — ${task.kind}): ${task.title}`,
  ];
  if (task.description) lines.push("", task.description);
  if (task.acceptanceCriteria.length > 0) {
    lines.push("", "ACCEPTANCE CRITERIA:");
    for (const c of task.acceptanceCriteria) lines.push(`- ${c}`);
  }
  lines.push("");
  if (readOnly) {
    lines.push(
      "This is a READ-ONLY task. Do NOT modify files. Analyze and report your findings and any blockers.",
    );
  } else {
    lines.push(
      "Make the necessary code changes directly in this working directory to satisfy the acceptance criteria.",
      "Keep changes minimal and focused on this task. Do not commit — Bremio captures the diff for you.",
      "When finished, briefly summarize what you changed.",
    );
  }
  return lines.join("\n");
}
