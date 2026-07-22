import type { Plan, Task } from "@bremio/protocol";

/**
 * JSON Schema for the lead's plan output, passed to adapters as `outputSchema`
 * (Codex `--output-schema`, Claude `outputFormat`).
 *
 * Codex enforces OpenAI **strict** structured output: every object must set
 * `additionalProperties: false` and list every property in `required`, and
 * array-size keywords (minItems) are unsupported. So this schema is strict —
 * all fields required, no optional `description`. The authoritative validation
 * is still `PlanSchema.parse` in the lead-manager (which fills array defaults).
 */
export const planJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "leadAgentId", "tasks"],
  properties: {
    summary: { type: "string" },
    leadAgentId: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "kind",
          "risk",
          "requiredCapabilities",
          "preferredAgents",
          "dependencies",
          "acceptanceCriteria",
        ],
        properties: {
          id: { type: "string" },
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
    "- Decompose into a SMALL number of concrete tasks (normally 3-4). Prefer fewer tasks.",
    "- Include at least one `implementation` task that another agent can execute to make the actual code change.",
    "- For every code-changing flow, include a later `test` task and an independent read-only `review` task. Both must depend on the implementation task (or on the final task containing the integrated implementation).",
    "- Analysis, test, and review tasks are READ-ONLY and must never require `repository.write` or create/modify files.",
    "- Any source or test-file creation belongs in an `implementation` task. A later `test` task must only run authoritative verification commands and require `repository.read`, `shell`, and `test`.",
    "- Review tasks must require `repository.read` and `review`, and must not modify files.",
    "- Each task needs: id (e.g. \"TASK-001\"), title, kind (analysis|implementation|review|test|documentation|other), risk (low|medium|high), requiredCapabilities (subset of repository.read, repository.write, shell, test, review, browser, vision), preferredAgents (e.g. [\"codex\"]), dependencies (ids of prerequisite tasks, [] if none), acceptanceCriteria (concrete, checkable strings). Provide every field (use [] for empty arrays).",
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
  const readOnly = task.kind === "review" || task.kind === "analysis" || task.kind === "test";
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
  if (task.kind === "test") {
    lines.push(
      "This is a READ-ONLY TEST GATE. Do NOT modify files.",
      "Run the relevant test or verification commands against the inherited implementation.",
      "Make the final shell command the authoritative pass/fail command; Bremio gates on its exit code.",
    );
  } else if (task.kind === "review") {
    lines.push(
      "This is a READ-ONLY INDEPENDENT REVIEW. Do NOT modify files.",
      "Review the inherited implementation against the acceptance criteria and report every finding.",
      "",
      "Return your review as a JSON object with exactly this structure:",
      "{",
      '  "summary": "concise overall assessment of the changes",',
      '  "findings": [',
      '    { "severity": "info|warning|blocker", "message": "description", "status": "open|fixed" }',
      "  ]",
      "}",
      "Include the JSON object in a ```json code block so it can be parsed.",
    );
  } else if (readOnly) {
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
