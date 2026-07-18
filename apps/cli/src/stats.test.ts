import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendLedgerEntry, ledgerPathFor } from "@bremio/orchestrator";
import { statsCommand } from "./stats";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("statsCommand", () => {
  it("shows a coordination-only failed run instead of claiming the ledger is empty", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-stats-"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));
    try {
      await appendLedgerEntry(ledgerPathFor(repo), {
        ts: new Date().toISOString(),
        runId: "run-failed-plan",
        taskId: "run-failed-plan::lead",
        scope: "coordination",
        provider: "claude",
        role: "planner",
        kind: "planning",
        status: "failed",
        filesChanged: 0,
        usage: { inputTokens: 10 },
      });

      expect(await statsCommand({ repoPath: repo })).toBe(0);
      expect(lines.join("\n")).toContain("tasks:           0");
      expect(lines.join("\n")).toContain("coordination:    1 planning run(s) (1 failed)");
      expect(lines.join("\n")).not.toContain("no ledger entries");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
