import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "./storage";
import { RunRegistry } from "./runs";

const dirs: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

async function sandbox(): Promise<{ repoPath: string; registry: RunRegistry }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-auto-"));
  dirs.push(dir);
  const repoPath = path.join(dir, "repo");
  await fs.mkdir(repoPath, { recursive: true });
  const store = await RunStore.open(path.join(dir, "bremio.db"));
  stores.push(store);
  return { repoPath, registry: new RunRegistry(store) };
}

describe("auto mode is resolved by the daemon, not by each client", () => {
  it("records a concrete mode, never 'auto', so history says what actually ran", async () => {
    const { repoPath, registry } = await sandbox();

    const run = registry.start({
      mode: "auto",
      repoPath,
      prompt: "do the thing",
      agentId: "claude",
    });

    // With no ledger the calibration gate has no evidence, so auto must fail
    // closed to Single rather than gamble on Team's coordination cost.
    expect(run.mode).toBe("single");
    registry.cancel(run.id);
  });

  it("states the reason in the run's own event log", async () => {
    const { repoPath, registry } = await sandbox();

    const run = registry.start({
      mode: "auto",
      repoPath,
      prompt: "do the thing",
      agentId: "claude",
    });

    // The decision has to survive into history: someone looking at an old run
    // must be able to see why it went the way it did, not just what it did.
    const reasons = registry
      .events(run.id)
      .filter((event) => typeof event.message === "string" && event.message.startsWith("auto:"));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.message).toContain("Single");
    registry.cancel(run.id);
  });

  it("leaves an explicit mode exactly as asked", async () => {
    const { repoPath, registry } = await sandbox();

    const run = registry.start({
      mode: "team",
      repoPath,
      prompt: "do the thing",
      agentId: "claude",
      workerId: "codex",
    });

    expect(run.mode).toBe("team");
    // No auto reason, because nothing was decided on the user's behalf.
    expect(
      registry.events(run.id).filter((e) => String(e.message ?? "").startsWith("auto:")),
    ).toHaveLength(0);
    registry.cancel(run.id);
  });
});

describe("continuing a session", () => {
  it("appends the run to the given session as its next turn", async () => {
    const { repoPath, registry } = await sandbox();

    const first = registry.start({
      mode: "single",
      repoPath,
      prompt: "first question",
      agentId: "claude",
    });
    expect(first.turnIndex).toBe(0);

    const second = registry.start({
      mode: "single",
      repoPath,
      prompt: "follow up",
      agentId: "claude",
      sessionId: first.sessionId!,
    });

    // Same session, next turn — this is what makes the panel's follow-up box a
    // continuation rather than a second unrelated run.
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turnIndex).toBe(1);

    const detail = registry.sessionDetail(first.sessionId!);
    expect(detail?.turns.map((turn) => turn.prompt)).toEqual(["first question", "follow up"]);

    registry.cancel(first.id);
    registry.cancel(second.id);
  });

  it("starts a new session when none is given", async () => {
    const { repoPath, registry } = await sandbox();

    const a = registry.start({ mode: "single", repoPath, prompt: "one", agentId: "claude" });
    const b = registry.start({ mode: "single", repoPath, prompt: "two", agentId: "claude" });

    expect(a.sessionId).not.toBe(b.sessionId);
    registry.cancel(a.id);
    registry.cancel(b.id);
  });
});
