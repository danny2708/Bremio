import { describe, it, expect } from "vitest";
import {
  type MemoryEntry,
  type MemoryScope,
  getScopeConfig,
  resolveStorageDir,
  SCOPE_CONFIG,
} from "./types";

describe("MemoryScope", () => {
  const SCOPES: MemoryScope[] = ["session", "project", "user"];

  it("has exactly three values", () => {
    expect(SCOPES).toHaveLength(3);
  });
});

describe("SCOPE_CONFIG", () => {
  it("has entries for all three scopes", () => {
    expect(SCOPE_CONFIG.session).toBeDefined();
    expect(SCOPE_CONFIG.project).toBeDefined();
    expect(SCOPE_CONFIG.user).toBeDefined();
  });

  it("session is ephemeral and transient with empty storageDir", () => {
    const cfg = SCOPE_CONFIG.session;
    expect(cfg.scope).toBe("session");
    expect(cfg.visibility).toBe("ephemeral");
    expect(cfg.persistence).toBe("transient");
    expect(cfg.storageDir).toBe("");
  });

  it("project is shared and persistent with .bremio/memory/project path", () => {
    const cfg = SCOPE_CONFIG.project;
    expect(cfg.scope).toBe("project");
    expect(cfg.visibility).toBe("shared");
    expect(cfg.persistence).toBe("persistent");
    expect(cfg.storageDir).toBe(".bremio/memory/project");
  });

  it("user is private and persistent with memory/user path", () => {
    const cfg = SCOPE_CONFIG.user;
    expect(cfg.scope).toBe("user");
    expect(cfg.visibility).toBe("private");
    expect(cfg.persistence).toBe("persistent");
    expect(cfg.storageDir).toBe("memory/user");
  });
});

describe("getScopeConfig", () => {
  it("returns the session config", () => {
    expect(getScopeConfig("session").scope).toBe("session");
  });

  it("returns the project config", () => {
    expect(getScopeConfig("project").scope).toBe("project");
  });

  it("returns the user config", () => {
    expect(getScopeConfig("user").scope).toBe("user");
  });

  it("throws for an unknown scope", () => {
    expect(() => getScopeConfig("unknown" as MemoryScope)).toThrow("Unknown memory scope: unknown");
  });
});

describe("resolveStorageDir", () => {
  it("resolves empty for session", () => {
    expect(resolveStorageDir("session")).toBe("");
  });

  it("resolves .bremio/memory/project for project", () => {
    expect(resolveStorageDir("project")).toBe(".bremio/memory/project");
  });

  it("resolves memory/user for user", () => {
    expect(resolveStorageDir("user")).toBe("memory/user");
  });
});

describe("MemoryEntry", () => {
  const BASE: MemoryEntry = {
    id: "mem-001",
    scope: "session",
    source: { kind: "session", sessionId: "sess-001" },
    title: "test memory",
    content: "some content",
    tags: [],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    metadata: {},
  };

  it("can be created with session scope", () => {
    const entry: MemoryEntry = { ...BASE };
    expect(entry.scope).toBe("session");
    expect(entry.source.kind).toBe("session");
  });

  it("can be created with project scope", () => {
    const entry: MemoryEntry = { ...BASE, scope: "project" };
    expect(entry.scope).toBe("project");
  });

  it("can be created with user scope", () => {
    const entry: MemoryEntry = { ...BASE, scope: "user" };
    expect(entry.scope).toBe("user");
  });

  it("can have a manual source", () => {
    const entry: MemoryEntry = { ...BASE, source: { kind: "manual" } };
    expect(entry.source.kind).toBe("manual");
  });

  it("can have a proposal source", () => {
    const entry: MemoryEntry = { ...BASE, source: { kind: "proposal" } };
    expect(entry.source.kind).toBe("proposal");
  });

  it("can have an import source", () => {
    const entry: MemoryEntry = { ...BASE, source: { kind: "import" } };
    expect(entry.source.kind).toBe("import");
  });

  it("session source can include runId", () => {
    const entry: MemoryEntry = {
      ...BASE,
      source: { kind: "session", sessionId: "sess-001", runId: "run-001" },
    };
    expect(entry.source.kind).toBe("session");
    if (entry.source.kind === "session") {
      expect(entry.source.runId).toBe("run-001");
    }
  });

  it("can have an expiry date", () => {
    const entry: MemoryEntry = {
      ...BASE,
      expiresAt: "2026-07-30T01:00:00.000Z",
    };
    expect(entry.expiresAt).toBeDefined();
    expect(new Date(entry.expiresAt!).getTime()).toBeGreaterThan(
      new Date(entry.createdAt).getTime(),
    );
  });
});
