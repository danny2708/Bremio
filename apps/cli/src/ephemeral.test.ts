import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runViaEphemeralDaemon, type EphemeralRunParams } from "./ephemeral";

const mockHandle = vi.hoisted(() => ({
  port: 9999,
  server: vi.fn() as unknown,
  registry: vi.fn() as unknown,
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockDaemonClient = vi.hoisted(() => ({
  DaemonClient: vi.fn(),
  DaemonUnavailableError: class extends Error {
    override name = "DaemonUnavailableError";
  },
}));

vi.mock("@bremio/daemon", async () => {
  const actual = await vi.importActual<typeof import("@bremio/daemon")>("@bremio/daemon");
  return {
    ...actual,
    startDaemonServer: vi.fn().mockResolvedValue(mockHandle),
  };
});

vi.mock("@bremio/daemon-client", () => mockDaemonClient);

const baseParams: EphemeralRunParams = {
  mode: "single",
  repoPath: process.cwd(),
  prompt: "test prompt",
  agentId: "claude",
};

afterEach(() => {
  // Reset per-test mock clients but do NOT call restoreAllMocks — that would
  // reset the vi.fn() inside the vi.mock factory, breaking the default mocks.
});

describe("runViaEphemeralDaemon (S4-T5)", () => {
  function makeMockClient() {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn().mockResolvedValue({ run: { id: "ephemeral-run-001" } }),
      streamEvents: vi.fn().mockResolvedValue(undefined),
      runDetail: vi.fn().mockResolvedValue({
        run: { id: "ephemeral-run-001", status: "completed" },
        events: [],
      }),
      cancelRun: vi.fn().mockResolvedValue({ cancelled: true }),
    };
    mockDaemonClient.DaemonClient.mockReturnValue(client);
    return client;
  }

  it("starts a daemon, runs through it, and cleans up", { timeout: 15_000 }, async () => {
    makeMockClient();
    const testTmp = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ephemeral-test-"));
    const result = await runViaEphemeralDaemon(
      { ...baseParams, tmpRoot: testTmp },
      false,
      "test",
    );
    expect(result).toBe(true);
    // The ephemeral temp dir is removed.
    const entries = await fs.readdir(testTmp);
    expect(entries).toHaveLength(0);
    await fs.rm(testTmp, { recursive: true, force: true });
  });

  it("cleans up when startDaemonServer throws", { timeout: 15_000 }, async () => {
    makeMockClient();
    const daemonModule = await import("@bremio/daemon");
    vi.mocked(daemonModule.startDaemonServer).mockRejectedValueOnce(new Error("bind failed"));

    const testTmp = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ephemeral-test-"));
    const result = await runViaEphemeralDaemon(
      { ...baseParams, tmpRoot: testTmp },
      false,
      "test",
    );
    expect(result).toBe(false);
    const entries = await fs.readdir(testTmp);
    expect(entries).toHaveLength(0);
    await fs.rm(testTmp, { recursive: true, force: true });
  });

  it("cleans up when DaemonClient.connect throws", { timeout: 15_000 }, async () => {
    const client = makeMockClient();
    client.connect.mockRejectedValue(new mockDaemonClient.DaemonUnavailableError("not available"));

    const testTmp = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ephemeral-test-"));
    const result = await runViaEphemeralDaemon(
      { ...baseParams, tmpRoot: testTmp },
      false,
      "test",
    );
    expect(result).toBe(false);
    const entries = await fs.readdir(testTmp);
    expect(entries).toHaveLength(0);
    await fs.rm(testTmp, { recursive: true, force: true });
  });
});
