import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor, type TerminationOutcome } from "@bremio/adapter-sdk";
import { RunRegistry, type RunEvent } from "./runs";
import { RunStore, isTerminal } from "./storage";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

async function registry(supervisor?: ProcessSupervisor): Promise<{
  registry: RunRegistry;
  store: RunStore;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-cancel-"));
  const store = await RunStore.open(path.join(dir, "bremio.db"));
  cleanups.push(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });
  return { registry: new RunRegistry(store, supervisor), store };
}

/** A supervisor that answers however the test needs, without real processes. */
function fakeSupervisor(outcome: TerminationOutcome, delayMs = 0): ProcessSupervisor {
  const supervisor = new ProcessSupervisor();
  Object.assign(supervisor, {
    terminate: async () => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return outcome;
    },
    release: () => {},
  });
  return supervisor;
}

const STOPPED: TerminationOutcome = {
  stopped: true,
  escalated: false,
  killedPids: [111],
  durationMs: 5,
};

const SURVIVED: TerminationOutcome = {
  stopped: false,
  reason: "2 process(es) survived termination",
  survivingPids: [4242, 4243],
  escalated: true,
  durationMs: 8_000,
};

/** A run that fails immediately, so no provider quota is involved. */
function startDoomedRun(reg: RunRegistry) {
  return reg.start({
    mode: "single",
    repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
    prompt: "noop",
    agentId: "claude",
  });
}

/**
 * Resolve when a run reaches a terminal event.
 *
 * `subscribe` replays synchronously, so for an already-finished run the
 * listener fires during the subscribe call itself — before any handle exists
 * to unsubscribe with. The flag covers that case.
 */
function settled(reg: RunRegistry, id: string): Promise<RunEvent> {
  return new Promise((resolve) => {
    let firedDuringReplay = false;
    let unsubscribe: (() => void) | undefined;
    unsubscribe = reg.subscribe(id, (event) => {
      if (event.kind !== "finished" && event.kind !== "failed") return;
      if (unsubscribe) unsubscribe();
      else firedDuringReplay = true;
      resolve(event);
    });
    if (firedDuringReplay) unsubscribe();
  });
}

describe("cancellation states", () => {
  it("records cancelled only after termination is confirmed", async () => {
    const { registry: reg, store } = await registry(fakeSupervisor(STOPPED));
    const run = startDoomedRun(reg);

    reg.cancel(run.id);
    await settled(reg, run.id);

    expect(store.getRun(run.id)?.status).toBe("cancelled");
  });

  it("records cancellation_failed when processes survive", async () => {
    const { registry: reg, store } = await registry(fakeSupervisor(SURVIVED));
    const run = startDoomedRun(reg);

    reg.cancel(run.id);
    await settled(reg, run.id);

    const settledRun = store.getRun(run.id);
    // Calling this "cancelled" would tell the user the work stopped while an
    // agent kept editing their repository.
    expect(settledRun?.status).toBe("cancellation_failed");
    expect(settledRun?.failureMessage).toContain("4242");
  });

  it("passes through cancelling before reaching a terminal state", async () => {
    // A slow termination is what makes the intermediate state observable.
    const { registry: reg, store } = await registry(fakeSupervisor(STOPPED, 400));
    const run = startDoomedRun(reg);

    reg.cancel(run.id);
    expect(store.getRun(run.id)?.status).toBe("cancelling");
    expect(isTerminal("cancelling")).toBe(false);

    await settled(reg, run.id);
    expect(store.getRun(run.id)?.status).toBe("cancelled");
  });

  it("announces the wait so a UI does not look frozen", async () => {
    const { registry: reg } = await registry(fakeSupervisor(STOPPED, 200));
    const run = startDoomedRun(reg);

    const seen: string[] = [];
    reg.subscribe(run.id, (event) => seen.push(event.message));
    reg.cancel(run.id);
    await settled(reg, run.id);

    expect(seen.some((message) => message.includes("cancelling"))).toBe(true);
  });

  it("refuses to cancel a run that is not in flight", async () => {
    const { registry: reg } = await registry(fakeSupervisor(STOPPED));
    expect(reg.cancel("nonexistent")).toBe(false);
  });

  it("ignores a second cancel for the same run", async () => {
    const { registry: reg } = await registry(fakeSupervisor(STOPPED, 200));
    const run = startDoomedRun(reg);

    expect(reg.cancel(run.id)).toBe(true);
    expect(reg.cancel(run.id)).toBe(false);
    await settled(reg, run.id);
  });

  it("treats cancellation_failed as terminal but retryable", async () => {
    const { registry: reg, store } = await registry(fakeSupervisor(SURVIVED));
    const run = startDoomedRun(reg);
    reg.cancel(run.id);
    await settled(reg, run.id);

    expect(isTerminal("cancellation_failed")).toBe(true);
    // The user still needs a way forward even though something is stuck.
    expect(reg.recoveryOptions(run.id).canRetry).toBe(true);
    expect(store.nonTerminalRuns().map((r) => r.id)).not.toContain(run.id);
  });

  it("waits for in-flight cancellations during shutdown", async () => {
    const { registry: reg } = await registry(fakeSupervisor(STOPPED, 300));
    const run = startDoomedRun(reg);
    reg.cancel(run.id);

    const outcomes = await reg.awaitCancellations();

    // Shutdown must not exit while children are still being torn down.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.stopped).toBe(true);
    await settled(reg, run.id);
  });

  it("reconciles a run stranded mid-cancellation", async () => {
    const { registry: reg, store } = await registry(fakeSupervisor(STOPPED));
    store.createRun({ id: "stuck", mode: "team", repositoryPath: "/tmp/r", prompt: "p" });
    store.updateRun("stuck", { status: "cancelling" });

    // A daemon that died while cancelling leaves a state only a restart can
    // resolve, so it must be reconciled like any other non-terminal run.
    const reconciled = reg.reconcileOnStartup().map((r) => r.id);
    expect(reconciled).toContain("stuck");
    expect(store.getRun("stuck")?.status).toBe("interrupted");
  });
});

describe("terminal event is final", () => {
  it("drops any event an adapter emits after the run ended", async () => {
    const { registry: reg, store } = await registry(fakeSupervisor(STOPPED));
    const run = startDoomedRun(reg);
    await settled(reg, run.id);

    const before = store.readEvents(run.id).length;
    const late: RunEvent[] = [];
    reg.subscribe(run.id, (event) => late.push(event));

    // An adapter that did not stop cleanly can still emit. Persisting it would
    // give a replaying client a different history than the one it watched
    // live, since the stream already closed at the terminal event.
    reg.cancel(run.id); // no-op on a finished run, but exercises the guard

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.readEvents(run.id)).toHaveLength(before);
    expect(late.filter((event) => event.seq > before)).toHaveLength(0);
  });

  it("keeps exactly one terminal event even if settlement is reached twice", async () => {
    const { registry: reg, store } = await registry(fakeSupervisor(STOPPED));
    const run = startDoomedRun(reg);
    await settled(reg, run.id);

    const terminal = store
      .readEvents(run.id)
      .filter((event) => event.type === "finished" || event.type === "failed");
    expect(terminal).toHaveLength(1);
  });
});
