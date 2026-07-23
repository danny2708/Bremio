import type { AgentAdapter } from "@bremio/adapter-sdk";
import { prepareTurnExecution } from "@bremio/harness";
import {
  PlanSchema,
  type AgentEvent,
  type Plan,
  type ReasoningLevel,
  type TaskStatus,
} from "@bremio/protocol";
import { TaskLog } from "@bremio/workspace";
import {
  LEAD_SYSTEM_PROMPT,
  buildPlanningPrompt,
  buildRepairPrompt,
  planJsonSchema,
} from "./plan-schema";
import { collectRun, type CollectedRun } from "./stream";

export class LeadPlanError extends Error {
  readonly status: Exclude<TaskStatus, "completed">;

  constructor(message: string, status: Exclude<TaskStatus, "completed"> = "failed") {
    super(message);
    this.name = "LeadPlanError";
    this.status = status;
  }
}

export interface CreatePlanOptions {
  prompt: string;
  cwd: string;
  runId: string;
  runDir: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  maxTurns?: number;
  /** Hard timeout for each provider planning attempt. */
  timeoutMs?: number;
  /** Optional semantic validator; failures enter the same one-repair loop. */
  validate?: (plan: Plan) => void;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  sessionId?: string;
  turnIndex?: number;
  priorTurns?: Array<{
    turnIndex: number;
    prompt: string;
    finalText?: string;
    summary?: string;
    measuredInputTokens?: number;
  }>;
  providerSessionId?: string;
}

export interface CreatePlanResult {
  plan: Plan;
  logsPath: string;
  attempts: number;
}

/**
 * Invoke the chosen lead to produce a Plan. Parses the lead's structured output
 * (or its final text), and on failure runs ONE repair attempt telling the lead
 * what was wrong. Every event is logged to `<runDir>/lead-<id>.log`.
 */
export async function createPlan(
  lead: AgentAdapter,
  opts: CreatePlanOptions,
): Promise<CreatePlanResult> {
  const log = new TaskLog(opts.runDir, `lead-${lead.id}`);
  log.line(`# Lead planning run — agent=${lead.id} cwd=${opts.cwd}`);

  try {
    const first = await runLead(lead, opts, buildPlanningPrompt(opts.prompt), `${opts.runId}-plan-1`, log);
    assertLeadRunCompleted(first, lead.id);
    const parsed1 = validateParsedPlan(parsePlan(first, lead.id), opts.validate);
    if (parsed1.ok) return { plan: parsed1.plan, logsPath: log.path, attempts: 1 };

    log.line(`# First plan invalid: ${parsed1.error}. Retrying once.`);
    const second = await runLead(
      lead,
      opts,
      buildRepairPrompt(opts.prompt, parsed1.error),
      `${opts.runId}-plan-2`,
      log,
    );
    assertLeadRunCompleted(second, lead.id);
    const parsed2 = validateParsedPlan(parsePlan(second, lead.id), opts.validate);
    if (parsed2.ok) return { plan: parsed2.plan, logsPath: log.path, attempts: 2 };

    throw new LeadPlanError(
      `Lead "${lead.id}" did not return a valid plan after 2 attempts. Last error: ${parsed2.error}`,
    );
  } finally {
    await log.close();
  }
}

/**
 * Schema repair is useful only when a provider completed successfully but
 * returned malformed output. Provider failures (quota, auth, cancellation,
 * runtime errors) must retain their real cause and must not spend a retry.
 */
function assertLeadRunCompleted(run: CollectedRun, leadId: string): void {
  if (run.outcome.status === "completed") return;

  const detail = [run.outcome.finalText, run.outcome.error, run.assistantText]
    .map((value) => value?.trim())
    .find((value) => value);
  const status = run.outcome.status === "cancelled" ? "was cancelled" : "failed";
  throw new LeadPlanError(
    `Lead "${leadId}" ${status} during planning${detail ? `: ${detail}` : "."}`,
    run.outcome.status,
  );
}

async function runLead(
  lead: AgentAdapter,
  opts: CreatePlanOptions,
  prompt: string,
  runId: string,
  log: TaskLog,
): Promise<CollectedRun> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
        void lead.cancelRun(runId).catch(() => {});
      }, opts.timeoutMs)
    : undefined;

  let events: AsyncIterable<AgentEvent>;
  if (opts.priorTurns && opts.priorTurns.length > 0) {
    const execution = await prepareTurnExecution({
      adapter: lead,
      sessionId: opts.sessionId ?? opts.runId,
      turnIndex: opts.turnIndex ?? opts.priorTurns.length,
      priorTurns: opts.priorTurns,
      providerSessionId: opts.providerSessionId,
      newPrompt: prompt,
      request: {
        runId,
        role: "planner",
        cwd: opts.cwd,
        permission: "read-only",
        systemPrompt: LEAD_SYSTEM_PROMPT,
        outputSchema: planJsonSchema,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
        maxTurns: opts.maxTurns ?? 30,
        signal: controller.signal,
      },
    });
    events = execution.run();
  } else {
    events = lead.startRun({
      runId,
      role: "planner",
      prompt,
      cwd: opts.cwd,
      permission: "read-only",
      systemPrompt: LEAD_SYSTEM_PROMPT,
      outputSchema: planJsonSchema,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
      maxTurns: opts.maxTurns ?? 30,
      signal: controller.signal,
    });
  }
  try {
    const run = await collectRun(events, { log, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) });
    if (!timedOut) return run;
    return {
      ...run,
      outcome: {
        ...run.outcome,
        status: "cancelled",
        finalText: undefined,
        error: `planning attempt timed out after ${opts.timeoutMs}ms`,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

type ParseResult = { ok: true; plan: Plan } | { ok: false; error: string };

function validateParsedPlan(
  parsed: ParseResult,
  validate: CreatePlanOptions["validate"],
): ParseResult {
  if (!parsed.ok || !validate) return parsed;
  try {
    validate(parsed.plan);
    return parsed;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Parse a plan from a run's structured output or final text. */
export function parsePlan(run: CollectedRun, leadId: string): ParseResult {
  const candidates: unknown[] = [];
  if (run.outcome.structured !== undefined) candidates.push(run.outcome.structured);
  const jsonText = run.outcome.finalText ?? run.assistantText;
  const extracted = extractJsonObject(jsonText);
  if (extracted !== undefined) candidates.push(extracted);

  let lastError = "no JSON object found in the lead's output";
  for (const candidate of candidates) {
    const withLead = injectLeadId(candidate, leadId);
    const result = PlanSchema.safeParse(withLead);
    if (result.success) return { ok: true, plan: result.data };
    lastError = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return { ok: false, error: lastError };
}

/** Default a missing leadAgentId to the actual lead so plans still validate. */
function injectLeadId(candidate: unknown, leadId: string): unknown {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const obj = candidate as Record<string, unknown>;
    if (!obj.leadAgentId) return { ...obj, leadAgentId: leadId };
  }
  return candidate;
}

/**
 * Extract the first complete JSON object from free text: strips ``` fences,
 * then scans from the first `{` to its matching `}` (string-aware).
 */
export function extractJsonObject(text: string): unknown {
  if (!text) return undefined;
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = unfenced.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
