import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { InMemoryStore, type MemoryQuery } from "./store";
import { FsMemoryStore } from "./fs-store";
import { createMemoryStore } from "./factory";
import { type MemoryEntry } from "./types";

function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem-001",
    scope: "session",
    source: { kind: "session", sessionId: "sess-001" },
    title: "test entry",
    content: "some content",
    tags: ["test", "demo"],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("InMemoryStore", () => {
  it("stores and retrieves an entry", async () => {
    const store = new InMemoryStore();
    const entry = makeEntry();
    await store.store(entry);
    const retrieved = await store.get("mem-001");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("mem-001");
    expect(retrieved!.title).toBe("test entry");
    expect(retrieved!.content).toBe("some content");
  });

  it("returns a copy, not the original reference", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry());
    const retrieved = await store.get("mem-001");
    retrieved!.title = "mutated";
    const second = await store.get("mem-001");
    expect(second!.title).toBe("test entry");
  });

  it("returns undefined for a missing entry", async () => {
    const store = new InMemoryStore();
    await expect(store.get("nonexistent")).resolves.toBeUndefined();
  });

  it("overwrites an existing entry on store", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ title: "original" }));
    await store.store(makeEntry({ title: "updated" }));
    const retrieved = await store.get("mem-001");
    expect(retrieved!.title).toBe("updated");
  });

  it("queries by scope", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ id: "a", scope: "session" }));
    await store.store(makeEntry({ id: "b", scope: "project" }));
    await store.store(makeEntry({ id: "c", scope: "user" }));
    const sessionEntries = await store.query({ scopes: ["session"] });
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0]!.id).toBe("a");
  });

  it("queries by tags", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ id: "a", tags: ["important"] }));
    await store.store(makeEntry({ id: "b", tags: ["trivial"] }));
    const tagged = await store.query({ tags: ["important"] });
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.id).toBe("a");
  });

  it("queries by sourceKind", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ id: "a", source: { kind: "session", sessionId: "s1" } }));
    await store.store(makeEntry({ id: "b", source: { kind: "manual" } }));
    const manuals = await store.query({ sourceKinds: ["manual"] });
    expect(manuals).toHaveLength(1);
    expect(manuals[0]!.id).toBe("b");
  });

  it("queries with limit", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ id: "a" }));
    await store.store(makeEntry({ id: "b" }));
    await store.store(makeEntry({ id: "c" }));
    const limited = await store.query({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("queries by ids", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ id: "a" }));
    await store.store(makeEntry({ id: "b" }));
    await store.store(makeEntry({ id: "c" }));
    const filtered = await store.query({ ids: ["a", "c"] });
    expect(filtered).toHaveLength(2);
  });

  it("deletes an existing entry", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry());
    const deleted = await store.delete("mem-001");
    expect(deleted).toBe(true);
    await expect(store.get("mem-001")).resolves.toBeUndefined();
  });

  it("returns false when deleting a non-existing entry", async () => {
    const store = new InMemoryStore();
    await expect(store.delete("nonexistent")).resolves.toBe(false);
  });

  it("lists entries by scope", async () => {
    const store = new InMemoryStore();
    await store.store(makeEntry({ id: "a", scope: "session" }));
    await store.store(makeEntry({ id: "b", scope: "project" }));
    const sessionEntries = await store.list("session");
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0]!.id).toBe("a");
  });
});

describe("FsMemoryStore", () => {
  let tmpDir: string;

  async function makeFsStore(): Promise<FsMemoryStore> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-memory-"));
    return new FsMemoryStore(tmpDir);
  }

  it("stores an entry as a JSON file", async () => {
    const store = await makeFsStore();
    const entry = makeEntry({ id: "fs-001", scope: "project" });
    await store.store(entry);
    const retrieved = await store.get("fs-001");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("fs-001");
    expect(retrieved!.title).toBe("test entry");
  });

  it("creates nested directories on store", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "nested", scope: "project" }));
    const filePath = path.join(tmpDir, ".bremio/memory/project/nested.json");
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it("returns undefined for a missing entry", async () => {
    const store = await makeFsStore();
    await expect(store.get("nonexistent")).resolves.toBeUndefined();
  });

  it("stores in per-scope directories", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "p1", scope: "project" }));
    await store.store(makeEntry({ id: "u1", scope: "user" }));
    const projectPath = path.join(tmpDir, ".bremio/memory/project/p1.json");
    const userPath = path.join(tmpDir, "memory/user/u1.json");
    await expect(fs.stat(projectPath)).resolves.toBeDefined();
    await expect(fs.stat(userPath)).resolves.toBeDefined();
  });

  it("deletes an existing entry", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "del-001", scope: "project" }));
    const deleted = await store.delete("del-001");
    expect(deleted).toBe(true);
    await expect(store.get("del-001")).resolves.toBeUndefined();
  });

  it("returns false when deleting a non-existing entry", async () => {
    const store = await makeFsStore();
    await expect(store.delete("nonexistent")).resolves.toBe(false);
  });

  it("lists entries by scope", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "a", scope: "project" }));
    await store.store(makeEntry({ id: "b", scope: "user" }));
    const projectEntries = await store.list("project");
    expect(projectEntries).toHaveLength(1);
    expect(projectEntries[0]!.id).toBe("a");
  });

  it("queries by tags across scopes", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "a", scope: "project", tags: ["important"] }));
    await store.store(makeEntry({ id: "b", scope: "project", tags: ["trivial"] }));
    await store.store(makeEntry({ id: "c", scope: "user", tags: ["important"] }));
    const important = await store.query({ tags: ["important"] });
    expect(important).toHaveLength(2);
  });

  it("queries by sourceKind", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "a", scope: "project", source: { kind: "manual" } }));
    await store.store(makeEntry({ id: "b", scope: "project", source: { kind: "session", sessionId: "s1" } }));
    const manuals = await store.query({ sourceKinds: ["manual"] });
    expect(manuals).toHaveLength(1);
    expect(manuals[0]!.id).toBe("a");
  });

  it("queries with limit", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "a", scope: "project" }));
    await store.store(makeEntry({ id: "b", scope: "project" }));
    await store.store(makeEntry({ id: "c", scope: "project" }));
    const limited = await store.query({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("get searches across all scope directories", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "cross", scope: "user" }));
    const retrieved = await store.get("cross");
    expect(retrieved).toBeDefined();
    expect(retrieved!.scope).toBe("user");
  });

  it("throws if constructed without a root directory", async () => {
    expect(() => new FsMemoryStore("")).toThrow("FsMemoryStore requires a root directory");
  });

  it("store overwrites an existing file", async () => {
    const store = await makeFsStore();
    await store.store(makeEntry({ id: "over", scope: "project", title: "first" }));
    await store.store(makeEntry({ id: "over", scope: "project", title: "second" }));
    const retrieved = await store.get("over");
    expect(retrieved!.title).toBe("second");
  });
});

describe("createMemoryStore", () => {
  it("returns InMemoryStore for session scope", () => {
    const store = createMemoryStore("session");
    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("returns FsMemoryStore for project scope", () => {
    const store = createMemoryStore("project", { projectDir: "/tmp" });
    expect(store).toBeInstanceOf(FsMemoryStore);
  });

  it("returns FsMemoryStore for user scope", () => {
    const store = createMemoryStore("user", { userDir: "/tmp" });
    expect(store).toBeInstanceOf(FsMemoryStore);
  });

  it("throws for project scope without projectDir", () => {
    expect(() => createMemoryStore("project")).toThrow("projectDir is required");
  });

  it("throws for user scope without userDir", () => {
    expect(() => createMemoryStore("user")).toThrow("userDir is required");
  });
});

describe("FsMemoryStore refuses ids that escape the store", () => {
  // The proposal lifecycle exists so an *agent* can suggest entries, which
  // makes the entry id untrusted input. `path.join(root, dir, id + ".json")`
  // walks out of the store on a `../` id, turning `store()` into an
  // arbitrary-file-write — the `outside-workspace` action class that is denied
  // even under autopilot.
  const TRAVERSALS = [
    "../escaped",
    "../../../../escaped",
    "nested/escaped",
    "..\\escaped",
  ];

  it.each(TRAVERSALS)("refuses to store an entry with id %j", async (id) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-mem-esc-"));
    const store = new FsMemoryStore(tmpDir);

    await expect(
      store.store(makeEntry({ id, scope: "project" })),
    ).rejects.toThrow(/outside the project memory directory/);
  });

  it("leaves no file behind when it refuses", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-mem-esc-"));
    const outside = path.join(tmpDir, "outside.json");
    const store = new FsMemoryStore(path.join(tmpDir, "root"));

    await expect(
      store.store(makeEntry({ id: "../../outside", scope: "project" })),
    ).rejects.toThrow();

    // The refusal has to happen before the write, not after.
    await expect(fs.readFile(outside, "utf-8")).rejects.toThrow();
  });

  it("still accepts an ordinary id", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-mem-ok-"));
    const store = new FsMemoryStore(tmpDir);

    await store.store(makeEntry({ id: "ordinary-id", scope: "project" }));

    expect(await store.get("ordinary-id")).toBeDefined();
  });
});
