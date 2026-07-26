import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { createPlan, extractJsonObject, parsePlan } from "./lead-manager";
import type { CollectedRun } from "./stream";

function run(finalText?: string, structured?: unknown): CollectedRun {
  return {
    outcome: {
      status: "completed",
      ...(finalText ? { finalText } : {}),
      ...(structured !== undefined ? { structured } : {}),
    },
    assistantText: finalText ?? "",
    commands: [],
    tests: [],
    filesRead: [],
    filesWritten: [],
  };
}

const validPlanObject = {
  summary: "Add a greeting",
  leadAgentId: "codex",
  tasks: [
    { id: "TASK-001", title: "implement greeting", kind: "implementation", risk: "low" },
  ],
};

describe("extractJsonObject", () => {
  it("extracts a fenced JSON object with surrounding prose", () => {
    const text = 'Here is the plan:\n```json\n{"a":1,"b":{"c":2}}\n```\nDone.';
    expect(extractJsonObject(text)).toEqual({ a: 1, b: { c: 2 } });
  });

  it("handles braces inside strings", () => {
    const text = '{"msg":"a } b","n":3}';
    expect(extractJsonObject(text)).toEqual({ msg: "a } b", n: 3 });
  });

  it("returns undefined when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
  });
});

describe("parsePlan", () => {
  it("parses a plan from final text", () => {
    const result = parsePlan(run(JSON.stringify(validPlanObject)), "codex");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.tasks[0]?.id).toBe("TASK-001");
  });

  it("prefers native structured output when present", () => {
    const result = parsePlan(run("garbage text", validPlanObject), "codex");
    expect(result.ok).toBe(true);
  });

  it("injects the lead id when the model omits leadAgentId", () => {
    const { leadAgentId, ...withoutLead } = validPlanObject;
    void leadAgentId;
    const result = parsePlan(run(JSON.stringify(withoutLead)), "claude");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.leadAgentId).toBe("claude");
  });

  it("reports an error for an unparseable plan", () => {
    const result = parsePlan(run("definitely not a plan"), "codex");
    expect(result.ok).toBe(false);
  });
});

describe("createPlan", () => {
  it("repairs a schema-valid plan that fails semantic validation", async () => {
    const prompts: string[] = [];
    let attempts = 0;
    const invalid = {
      ...validPlanObject,
      tasks: [{
        id: "TASK-001",
        title: "write from test gate",
        kind: "test",
        risk: "low",
        requiredCapabilities: ["repository.write", "shell", "test"],
      }],
    };
    const adapter = {
      id: "codex",
      provider: "openai",
      async *startRun(req: AgentRunRequest): AsyncGenerator<AgentEvent> {
        prompts.push(req.prompt);
        attempts += 1;
        const output = attempts === 1 ? invalid : validPlanObject;
        yield { type: "started", runId: req.runId, ts: Date.now() };
        yield {
          type: "completed",
          runId: req.runId,
          ts: Date.now(),
          outcome: { status: "completed", finalText: JSON.stringify(output) },
        };
      },
    } as unknown as AgentAdapter;
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-lead-repair-"));

    try {
      const result = await createPlan(adapter, {
        prompt: "add a greeting",
        cwd: runDir,
        runDir,
        runId: "run-semantic-repair",
        validate: (candidate) => {
          if (candidate.tasks[0]?.requiredCapabilities.includes("repository.write")) {
            throw new Error("test tasks are read-only");
          }
        },
      });

      expect(result.attempts).toBe(2);
      expect(prompts[1]).toContain("test tasks are read-only");
      expect(result.plan.tasks[0]?.kind).toBe("implementation");
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });

  it("preserves a provider failure and does not waste a schema-repair retry", async () => {
    let attempts = 0;
    const providerError = "You've hit your session limit · resets 2:20pm (Asia/Saigon)";
    const adapter = {
      id: "claude",
      provider: "anthropic",
      async *startRun(req: AgentRunRequest): AsyncGenerator<AgentEvent> {
        attempts += 1;
        const ts = Date.now();
        yield { type: "started", runId: req.runId, ts };
        yield { type: "message", runId: req.runId, ts, role: "assistant", text: providerError };
        yield {
          type: "completed",
          runId: req.runId,
          ts,
          outcome: { status: "failed", error: providerError },
        };
      },
    } as unknown as AgentAdapter;
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-lead-error-"));

    try {
      await expect(
        createPlan(adapter, {
          prompt: "add a greeting",
          cwd: runDir,
          runDir,
          runId: "run-provider-failure",
        }),
      ).rejects.toThrow(`Lead "claude" failed during planning: ${providerError}`);
      expect(attempts).toBe(1);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });

  it("cancels a timed-out planning attempt and does not retry it", async () => {
    let attempts = 0;
    const adapter = {
      id: "claude",
      provider: "anthropic",
      async *startRun(req: AgentRunRequest): AsyncGenerator<AgentEvent> {
        attempts += 1;
        yield { type: "started", runId: req.runId, ts: Date.now() };
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "completed",
          runId: req.runId,
          ts: Date.now(),
          outcome: { status: "cancelled", error: "provider cancelled" },
        };
      },
      async cancelRun(): Promise<void> {},
    } as unknown as AgentAdapter;
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-lead-timeout-"));

    try {
      await expect(
        createPlan(adapter, {
          prompt: "add a greeting",
          cwd: runDir,
          runDir,
          runId: "run-timeout",
          timeoutMs: 20,
        }),
      ).rejects.toThrow("planning attempt timed out after 20ms");
      expect(attempts).toBe(1);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });
});
