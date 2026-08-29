import { describe, expect, it } from "vitest";
import { assembleTurnInspection } from "./turn-inspector";

describe("assembleTurnInspection", () => {
  it("extracts worktree path, commands, and files from raw events and run record", () => {
    const rawEvents = [
      { kind: "tool", data: { command: "git status", path: "src/index.ts" } },
      { kind: "tool", data: { cmd: "npm test", files: ["src/app.ts", "src/index.ts"] } },
      { kind: "tool", data: { input: { command: "npm run build", file_path: "package.json" } } },
    ];

    const inspection = assembleTurnInspection(rawEvents, {
      id: "run-001",
      worktree_path: "/tmp/bremio-worktree-123",
    });

    expect(inspection.runId).toBe("run-001");
    expect(inspection.worktreePath).toBe("/tmp/bremio-worktree-123");
    expect(inspection.commandsRun).toEqual(["git status", "npm test", "npm run build"]);
    expect(inspection.filesChanged).toEqual(["src/index.ts", "src/app.ts", "package.json"]);
  });

  it("handles empty events and undefined worktree gracefully", () => {
    const inspection = assembleTurnInspection([], { id: "run-002" });
    expect(inspection.runId).toBe("run-002");
    expect(inspection.worktreePath).toBeUndefined();
    expect(inspection.commandsRun).toEqual([]);
    expect(inspection.filesChanged).toEqual([]);
  });

  it("deduplicates repeated commands and files", () => {
    const rawEvents = [
      { kind: "tool", data: { command: "npm test", file: "a.ts" } },
      { kind: "tool", data: { command: "npm test", file: "a.ts" } },
    ];
    const inspection = assembleTurnInspection(rawEvents);
    expect(inspection.commandsRun).toEqual(["npm test"]);
    expect(inspection.filesChanged).toEqual(["a.ts"]);
  });
});
