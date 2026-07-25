import { describe, expect, it } from "vitest";
import type { AgentCapabilities } from "@bremio/adapter-sdk";
import type { Plan, Task } from "@bremio/protocol";
import type { AgentCapacitySnapshot } from "@bremio/quota";
import { assessCapacity, ANTIGRAVITY_MODEL_MAP } from "@bremio/quota";
import { resolveAutoMode } from "./auto-mode";
import { evaluateCalibrationReadiness } from "./calibration";
import { computeNetGain } from "./net-gain";
import { assignAgents, type AssignAgentsOptions } from "./router";
import { resolveEscalationApproval, shouldEscalate, type SingleRunReport } from "./single-run";

// Shared helpers -----------------------------------------------------------

function plan(tasks: Task[]): Plan {
  return { summary: "test", tasks, leadAgentId: "claude" };
}

let _taskId = 0;
function task(kind: Task["kind"], overrides: Partial<Task> = {}): Task {
  _taskId++;
  return {
    id: `TASK-${String(_taskId).padStart(3, "0")}`,
    title: "test",
    kind,
    risk: "low",
    dependencies: [],
    preferredAgents: [],
    requiredCapabilities: [],
    acceptanceCriteria: [],
    ...overrides,
  };
}

const ALL_CAPS: AgentCapabilities = {
  planning: true, structuredOutput: true,
  repositoryRead: true, repositoryWrite: true,
  shell: true, testing: true,
  browser: false, vision: false, resumableSessions: true, readOnlyEnforcement: "provider-native",
};

const LEAD_CAPS: AgentCapabilities = {
  planning: true, structuredOutput: true,
  repositoryRead: true, repositoryWrite: true,
  shell: false, testing: false,
  browser: false, vision: false, resumableSessions: true, readOnlyEnforcement: "provider-native",
};

const WORKER_CAPS: AgentCapabilities = {
  planning: false, structuredOutput: false,
  repositoryRead: true, repositoryWrite: true,
  shell: true, testing: true,
  browser: false, vision: false, resumableSessions: true, readOnlyEnforcement: "provider-native",
};

function snapshot(overrides: Partial<AgentCapacitySnapshot> = {}): AgentCapacitySnapshot {
  return {
    agentId: "claude",
    availability: "idle",
    status: "healthy",
    confidence: "high",
    source: { name: "AI-Quota-Tray", confidenceLabel: "high" },
    lastContactAt: Math.floor(Date.now() / 1000),
    contactFreshness: "fresh",
    windows: [],
    ...overrides,
  };
}

function windowStaleExhausted(): AgentCapacitySnapshot["windows"] {
  return [{
    id: "weekly", label: "Weekly",
    scope: "account",
    capturedAt: Math.floor(Date.now() / 1000) - 7200,
    freshness: "stale",
    confidence: "low",
    remainingPercent: 0,
  }];
}

function windowStale(): AgentCapacitySnapshot["windows"] {
  return [{
    id: "weekly", label: "Weekly",
    scope: "account",
    capturedAt: Math.floor(Date.now() / 1000) - 7200,
    freshness: "stale",
    confidence: "low",
    remainingPercent: 2,
  }];
}

function windowModelScope(): AgentCapacitySnapshot["windows"] {
  return [{
    id: "gemini-pro-high", label: "Gemini Pro High",
    scope: "model",
    capturedAt: Math.floor(Date.now() / 1000),
    freshness: "fresh",
    confidence: "high",
    remainingPercent: 80,
    modelId: "gemini-3.1-pro",
  }];
}

describe("fail-closed properties hold in combination", () => {
  // ── Property 1 ─────────────────────────────────────────────────────
  it("uncalibrated --mode auto never selects Team", () => {
    const result = resolveAutoMode([]);
    expect(result.mode).toBe("single");
    expect(result.reason).toMatch(/calibration/);

    const onePair = [
      summary("s-1", "c1", "single-agent"),
      summary("m-1", "c1", "multi-agent", true),
    ];
    const stillInsufficient = evaluateCalibrationReadiness(onePair);
    expect(stillInsufficient.status).toBe("insufficient-evidence");
  });

  // ── Property 2 ─────────────────────────────────────────────────────
  it("stale or unknown quota never hard-excludes an agent", () => {
    const staleExhausted = assessCapacity(
      snapshot({ windows: windowStaleExhausted() }),
    );
    expect(staleExhausted.hardExcluded).toBe(false);
    expect(staleExhausted.status).toBe("exhausted");
    expect(staleExhausted.reason).toMatch(/last-known/);

    const noSnapshot = assessCapacity(undefined);
    expect(noSnapshot.hardExcluded).toBe(false);
    expect(noSnapshot.status).toBe("unknown");
    expect(noSnapshot.reason).toMatch(/no capacity snapshot/);

    const staleSnapshot = snapshot({
      agentId: "codex",
      windows: windowStale(),
    });
    const opts: AssignAgentsOptions = {
      capabilitiesByAgent: new Map([
        ["claude", LEAD_CAPS],
        ["codex", WORKER_CAPS],
      ]),
      capacityByAgent: new Map([["codex", staleSnapshot]]),
    };
    const p = plan([task("implementation")]);
    const assign = assignAgents(p, "claude", "codex", opts);
    const codexAssigned = [...assign.values()].includes("codex");
    expect(codexAssigned).toBe(true);
  });

  // ── Property 3 ─────────────────────────────────────────────────────
  it("incomplete cost data never fires the kill-switch", () => {
    const entries = [
      { ts: "2026-07-18T00:00:00.000Z", runId: "single-1", taskId: "single-1::summary", scope: "run" as const, provider: "bremio", role: "orchestrator" as const, kind: "run-summary" as const, status: "completed" as const, filesChanged: 0, flowMode: "single-agent" as const, comparisonId: "c1", outcomeVerified: true },
      { ts: "2026-07-18T00:00:00.000Z", runId: "single-1", taskId: "single-1::task", scope: "task" as const, provider: "claude", role: "implementer" as const, kind: "single-run" as const, status: "completed" as const, filesChanged: 1, usage: {} },
      { ts: "2026-07-18T00:00:00.000Z", runId: "multi-1", taskId: "multi-1::summary", scope: "run" as const, provider: "bremio", role: "orchestrator" as const, kind: "run-summary" as const, status: "completed" as const, filesChanged: 0, flowMode: "multi-agent" as const, comparisonId: "c1", outcomeVerified: true, qualityGatePassed: true },
      { ts: "2026-07-18T00:00:00.000Z", runId: "multi-1", taskId: "multi-1::task", scope: "task" as const, provider: "codex", role: "implementer" as const, kind: "implementation" as const, status: "completed" as const, filesChanged: 1, usage: { costUsd: 0.5 } },
      { ts: "2026-07-18T00:00:00.000Z", runId: "multi-1", taskId: "multi-1::lead", scope: "coordination" as const, provider: "claude", role: "planner" as const, kind: "planning" as const, status: "completed" as const, filesChanged: 0, usage: { costUsd: 0.1 } },
    ];
    const result = computeNetGain(entries, "c1");
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toMatch(/costUsd/);
    }
  });

  // ── Property 4 ─────────────────────────────────────────────────────
  it("escalation never runs without approval", () => {
    const crashed: SingleRunReport = {
      mode: "single", runId: "r1", createdAt: new Date().toISOString(),
      prompt: "test", primaryAgentId: "claude", repoPath: "/tmp", runDir: "/tmp/r1",
      result: {
        status: "failed", summary: "crashed", filesChanged: [], commandsExecuted: [],
        tests: [], logsPath: "/tmp/r1/log", durationMs: 50, error: "agent failed",
      },
      verification: { status: "failed", reasons: ["agent run failed"] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
    };
    expect(shouldEscalate(crashed)).toBe(false);

    const passed: SingleRunReport = {
      mode: "single", runId: "r2", createdAt: new Date().toISOString(),
      prompt: "test", primaryAgentId: "claude", repoPath: "/tmp", runDir: "/tmp/r2",
      result: {
        status: "completed", summary: "ok", filesChanged: [], commandsExecuted: [],
        tests: [{ command: "pnpm test", passed: 1, failed: 0, exitCode: 0 }],
        logsPath: "/tmp/r2/log", durationMs: 100,
      },
      verification: { status: "passed", reasons: [] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
    };
    expect(shouldEscalate(passed)).toBe(false);

    // Eligibility is not authority. A run that *does* qualify still must not
    // escalate on its own — this is the half that actually guards the double
    // pay in docs/05 R5, and the half a test of shouldEscalate alone misses.
    const eligible: SingleRunReport = {
      ...crashed,
      runId: "r3",
      result: { ...crashed.result, status: "completed", error: undefined },
      verification: { status: "failed", reasons: ["verification command exited 1: pnpm test"] },
    };
    expect(shouldEscalate(eligible)).toBe(true);

    // Fail closed: no flag and no terminal to ask in means no escalation.
    const unattended = resolveEscalationApproval({ escalateFlag: false, interactive: false });
    expect(unattended.approved).toBe(false);
    if (!unattended.approved) expect(unattended.reason).toMatch(/--escalate/);

    // A terminal alone is not approval either; silence and "n" both decline.
    expect(resolveEscalationApproval({ escalateFlag: false, interactive: true }).approved).toBe(false);
    expect(
      resolveEscalationApproval({ escalateFlag: false, interactive: true, answer: "n" }).approved,
    ).toBe(false);

    // Only an explicit yes, or the explicit flag, authorises the second run.
    expect(resolveEscalationApproval({ escalateFlag: true, interactive: false })).toEqual({
      approved: true,
      via: "flag",
    });
    expect(
      resolveEscalationApproval({ escalateFlag: false, interactive: true, answer: "y" }),
    ).toEqual({ approved: true, via: "prompt" });
  });

  // ── Property 5 ─────────────────────────────────────────────────────
  it("an agent without repositoryWrite never receives a write task", () => {
    const caps: AgentCapabilities = {
      ...ALL_CAPS, repositoryWrite: false, planning: true,
    };
    const opts: AssignAgentsOptions = {
      capabilitiesByAgent: new Map([
        ["claude", caps],
        ["codex", ALL_CAPS],
      ]),
    };
    const p = plan([task("implementation"), task("analysis")]);
    const [implTask, analysisTask] = p.tasks;
    const assign = assignAgents(p, "claude", "codex", opts);
    expect(assign.get(implTask!.id)).toBe("codex");
    expect(assign.get(analysisTask!.id)).toBe("claude");
  });

  // ── Property 6 ─────────────────────────────────────────────────────
  it("an unmapped Antigravity bucket is never routed on", () => {
    expect(ANTIGRAVITY_MODEL_MAP["gemini-pro-high"]).toBe("gemini-3.1-pro");
    expect(ANTIGRAVITY_MODEL_MAP["unknown-bucket"]).toBeUndefined();

    const result = assessCapacity(
      snapshot({
        agentId: "antigravity",
        source: { name: "Antigravity", confidenceLabel: "high" },
        windows: windowModelScope(),
      }),
      { modelId: "unknown-model" },
    );
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toMatch(/no capacity window matches model/);
    }
  });
});

// Helper for property 1
function summary(
  runId: string,
  comparisonId: string,
  flowMode: "single-agent" | "multi-agent",
  qualityGatePassed?: boolean,
) {
  return {
    ts: "2026-07-18T00:00:00.000Z",
    runId,
    taskId: `${runId}::summary`,
    scope: "run" as const,
    provider: "bremio" as const,
    role: "orchestrator" as const,
    kind: "run-summary" as const,
    status: "completed" as const,
    filesChanged: 0,
    flowMode,
    comparisonId,
    outcomeVerified: true,
    ...(flowMode === "multi-agent" ? { qualityGatePassed: qualityGatePassed ?? true } : {}),
  };
}
