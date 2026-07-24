import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { AntigravityAdapter, buildAgyInvocation } from "./antigravity-adapter";

const fakeAgy = fileURLToPath(new URL("../test-fixtures/fake-agy.mjs", import.meta.url));

/** Drive the fake CLI through node so tests never spend real subscription quota. */
function adapter(): AntigravityAdapter {
  return new AntigravityAdapter({
    agyBin: process.execPath,
    agyArgs: [fakeAgy],
    // These tests exercise writable runs, which now require the bypass to be
    // asked for. The opt-in is stated here rather than defaulted on, which is
    // exactly the property the containment tests below pin.
    allowDangerousPermissionBypass: true,
  });
}

/** The default construction a caller gets when they say nothing about permissions. */
function defaultAdapter(): AntigravityAdapter {
  return new AntigravityAdapter({ agyBin: process.execPath, agyArgs: [fakeAgy] });
}

/** `buildAgyInvocation` with the bypass granted, for tests not about permissions. */
function invocationWithBypass(overrides: Partial<AgentRunRequest> = {}) {
  return buildAgyInvocation(request(overrides), { allowDangerousPermissionBypass: true });
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: "run:test",
    role: "implementer",
    prompt: "implement it",
    cwd: process.cwd(),
    permission: "workspace-write",
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("buildAgyInvocation", () => {
  it("always passes --add-dir because agy ignores the process cwd", () => {
    const { args, workspace } = invocationWithBypass();
    expect(args[args.indexOf("--add-dir") + 1]).toBe(workspace);
    // The prompt restates the workspace so the agent cannot drift to its scratch dir.
    expect(args[args.indexOf("-p") + 1]).toContain(workspace);
  });

  it("maps read-only to plan mode without any permission bypass", () => {
    const readOnly = buildAgyInvocation(request({ permission: "read-only" })).args;
    expect(readOnly[readOnly.indexOf("--mode") + 1]).toBe("plan");
    expect(readOnly).not.toContain("--dangerously-skip-permissions");
  });

  it("passes an explicit model label and a print timeout", () => {
    const args = invocationWithBypass({ model: "Gemini 3.1 Pro (High)" }).args;
    expect(args[args.indexOf("--model") + 1]).toBe("Gemini 3.1 Pro (High)");
    expect(args[args.indexOf("--print-timeout") + 1]).toMatch(/^\d+s$/);
  });
});

describe("being writable must not silently grant every permission", () => {
  it("refuses a writable run rather than passing the bypass by default", () => {
    // The whole containment: workspace-write used to imply
    // --dangerously-skip-permissions, so a task allowed to edit one file was
    // also allowed to run any command, silently.
    expect(() => buildAgyInvocation(request())).toThrow(/dangerously-skip-permissions/);
  });

  it("names the consequence and the opt-in, not just the failure", () => {
    let message = "";
    try {
      buildAgyInvocation(request());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("shell commands");
    expect(message).toContain("allowDangerousPermissionBypass");
  });

  it("passes the bypass only when it was explicitly granted", () => {
    const args = buildAgyInvocation(request(), { allowDangerousPermissionBypass: true }).args;
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("never downgrades a refused writable run to read-only", () => {
    // Silently running read-only would surface as the agent claiming it could
    // not edit the file — a capability problem the user cannot diagnose.
    let args: string[] | undefined;
    try {
      args = buildAgyInvocation(request()).args;
    } catch {
      args = undefined;
    }
    expect(args).toBeUndefined();
  });

  it("still allows read-only work with no opt-in at all", () => {
    expect(() => buildAgyInvocation(request({ permission: "read-only" }))).not.toThrow();
  });

  it("reports the refusal as a failed run instead of throwing at the caller", async () => {
    // startRun is an async generator; a throw would escape as an unhandled
    // rejection the orchestrator could not attribute to a task.
    const events = await collect(defaultAdapter().startRun(request()));
    const completed = events.find((event) => event.type === "completed");
    expect(completed?.outcome.status).toBe("failed");
    expect(completed?.outcome.error).toContain("allowDangerousPermissionBypass");
  });
});

describe("AntigravityAdapter", () => {
  it("is worker-capable but not lead- or test-gate eligible", async () => {
    const caps = await adapter().getCapabilities();
    // agy --print emits prose only, so it can never satisfy the lead contract.
    expect(caps.structuredOutput).toBe(false);
    expect(caps.planning).toBe(false);
    expect(caps.testing).toBe(false);
    expect(caps.repositoryWrite).toBe(true);
    expect(caps.shell).toBe(true);
    expect(caps.resumableSessions).toBe(false);
  });

  it("explicitly rejects resumeRun", () => {
    expect(() => adapter().resumeRun("s-123", request())).toThrow(/not implemented/i);
  });

  it("reports the agy version from healthCheck", async () => {
    const health = await adapter().healthCheck();
    // ok vs degraded depends on whether this machine has completed sign-in.
    expect(["ok", "degraded"]).toContain(health.status);
    expect(health.detail).toContain("1.1.4");
  });

  it("reports unavailable with an install hint when agy is missing", async () => {
    const health = await new AntigravityAdapter({ agyBin: "/nonexistent/agy" }).healthCheck();
    expect(health.status).toBe("unavailable");
    expect(health.detail).toMatch(/not found/i);
  });

  it("streams prose lines as message events and completes", async () => {
    const events = await collect(adapter().startRun(request()));
    expect(events[0]?.type).toBe("started");
    expect(events.filter((event) => event.type === "message").length).toBeGreaterThan(0);

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("completed");
    if (terminal?.type === "completed") {
      expect(terminal.outcome.status).toBe("completed");
      expect(terminal.outcome.finalText).toContain("task complete");
    }
  });

  it("surfaces a non-zero exit as a failed outcome", async () => {
    const events = await collect(adapter().startRun(request({ prompt: "FAIL_PLEASE" })));
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("completed");
    if (terminal?.type === "completed") {
      expect(terminal.outcome.status).toBe("failed");
      expect(terminal.outcome.error).toMatch(/exited with code 3/);
    }
  });
});
