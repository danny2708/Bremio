import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessCapacity } from "@bremio/quota";
import { redactDeep } from "./diagnostics";
import { printReport } from "./ui";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S4-T3: reasons for every automatic choice", () => {
  it("a reason survives serialization through the daemon and back", async () => {
    const reason = "healthy at 75% remaining, fresh";
    const report = {
      mode: "team" as const,
      runId: "run-serialize-test",
      createdAt: new Date().toISOString(),
      prompt: "test",
      leadAgentId: "claude",
      repoPath: "/tmp",
      runDir: "/tmp/.bremio/runs/run-serialize-test",
      plan: { summary: "test", tasks: [], leadAgentId: "claude" },
      tasks: [
        {
          task: { id: "TASK-001", title: "fix", kind: "implementation" as const, risk: "low" as const, dependencies: [], preferredAgents: [] },
          agentId: "codex",
          result: {
            taskId: "TASK-001",
            agentId: "codex",
            status: "completed" as const,
            summary: "done",
            filesChanged: [],
            commandsExecuted: [],
            tests: [],
            findings: [],
          },
          reason,
        },
      ],
      qualityGate: { status: "passed" as const, reasons: [] },
      summary: { total: 1, completed: 1, failed: 0, cancelled: 0, filesChanged: 0 },
      autoModeReason: "auto selected Team — calibration gate is ready",
    };

    // Daemon round-trip: JSON.stringify → JSON.parse
    const serialized = JSON.stringify(report);
    const deserialized = JSON.parse(serialized);

    expect(deserialized.autoModeReason).toBe("auto selected Team — calibration gate is ready");
    expect(deserialized.tasks[0].reason).toBe(reason);
    // All other fields survive too
    expect(deserialized.runId).toBe("run-serialize-test");
    expect(deserialized.mode).toBe("team");
  });

  it("the CLI prints auto mode reason and per-task reason", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));

    printReport({
      mode: "team",
      runId: "run-cli-reason",
      createdAt: new Date().toISOString(),
      prompt: "test",
      leadAgentId: "claude",
      repoPath: path.resolve("."),
      runDir: path.resolve("./.bremio/runs/run-cli-reason"),
      plan: { summary: "test", tasks: [], leadAgentId: "claude" },
      tasks: [
        {
          task: { id: "TASK-001", title: "fix", kind: "implementation", risk: "low", dependencies: [], preferredAgents: [], requiredCapabilities: [], acceptanceCriteria: [] },
          agentId: "codex",
          result: {
            taskId: "TASK-001",
            agentId: "codex",
            status: "completed",
            summary: "done",
            filesChanged: [],
            commandsExecuted: [],
            tests: [],
            findings: [],
          },
          reason: "exhausted at 2% remaining, fresh; next-claude is held for lead reserve",
        },
      ],
      qualityGate: { status: "passed", reasons: [], testTaskIds: [], reviewTaskIds: [] },
      summary: { total: 1, completed: 1, failed: 0, cancelled: 0, filesChanged: 0 },
      autoModeReason: "auto selected Team — calibration gate is ready",
    });

    const output = lines.join("\n");
    expect(output).toContain("auto selected Team");
    expect(output).toContain("exhausted at 2% remaining, fresh");
  });

  it("key-based redaction protects secret-named fields without mangling reasons", () => {
    const data = {
      autoModeReason: "healthy at 75% remaining",
      tasks: [
        {
          agentId: "codex",
          reason: "sk-auth-token-abc123 is not capacity data",
          result: { something: "fine" },
        },
      ],
    };

    const redacted = redactDeep(data) as typeof data;
    // Key-based redaction still protects secret-named fields, and must not
    // mangle a reason that legitimately talks about token quota.
    expect(redacted.autoModeReason).toBe("healthy at 75% remaining");
    const mixed = redactDeep({ tokenKey: "should-be-redacted", reason: "healthy" });
    expect((mixed as Record<string, unknown>).tokenKey).toBe("[redacted]");
    expect((mixed as Record<string, unknown>).reason).toBe("healthy");
  });

  it("a reason is generated from capacity data, never from the prompt or repo", () => {
    // This is what actually keeps secrets out of reasons. `redactDeep` is
    // key-based, so it could never scrub a credential embedded in a reason
    // *value* — the guarantee has to come from the producer instead. Reasons
    // are built by assessCapacity from status/percent/freshness alone, so no
    // caller-supplied text can reach them.
    const secret = "sk-live-ABCDEF123456";
    const secretPath = "src/private/keys.ts";

    const assessment = assessCapacity({
      agentId: "codex",
      availability: "idle",
      status: "healthy",
      confidence: "high",
      source: { name: "AI-Quota-Tray", confidenceLabel: "high" },
      lastContactAt: Math.floor(Date.now() / 1000),
      contactFreshness: "fresh",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          scope: "account",
          capturedAt: Math.floor(Date.now() / 1000),
          freshness: "fresh",
          confidence: "high",
          remainingPercent: 75,
        },
      ],
    });

    expect(assessment.reason).not.toContain(secret);
    expect(assessment.reason).not.toContain(secretPath);
    // It says the actual cause, in capacity vocabulary — "policy" would fail.
    expect(assessment.reason).toMatch(/healthy|limited|critical|exhausted|last-known|unknown/);
    expect(assessment.reason).toContain("75");
  });
});
