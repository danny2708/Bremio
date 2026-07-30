import { describe, it, expect } from "vitest";
import { InMemoryStore } from "./store";
import { MemoryInjector } from "./injector";
import type { MemoryEntry } from "./types";

function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem-001",
    scope: "project",
    source: { kind: "manual" },
    title: "test memory",
    content: "hello world",
    tags: ["important", "reference"],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("MemoryInjector", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      expect(injector.estimateTokens("")).toBe(0);
    });

    it("returns 1 for 4 characters", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      expect(injector.estimateTokens("abcd")).toBe(1);
    });

    it("rounds up for partial tokens", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      expect(injector.estimateTokens("abcde")).toBe(2);
    });
  });

  describe("estimateEntryTokens", () => {
    it("sums title + content + overhead", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      const entry = makeEntry({ title: "hi", content: "world" });
      // title=1, content=2, overhead=10 => 13
      expect(injector.estimateEntryTokens(entry)).toBe(13);
    });
  });

  describe("select", () => {
    it("selects entries that fit within the token budget", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a", content: "short" }));
      await store.store(makeEntry({ id: "b", content: "tiny" }));
      const injector = new MemoryInjector(store);
      // each entry: title=1 + content=2 + overhead=10 = 13; budget=30 fits 2
      const result = await injector.select({ maxTokens: 30 });
      expect(result).toHaveLength(2);
    });

    it("stops adding entries when budget is exhausted", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a", content: "short" }));
      await store.store(makeEntry({ id: "b", content: "tiny" }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 15 });
      expect(result).toHaveLength(1);
    });

    it("respects scopes filter", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a", scope: "project" }));
      await store.store(makeEntry({ id: "b", scope: "user" }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100, scopes: ["user"] });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("b");
    });

    it("defaults to project and user scopes", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a", scope: "project" }));
      await store.store(makeEntry({ id: "b", scope: "user" }));
      await store.store(makeEntry({ id: "c", scope: "session" }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100 });
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id).sort()).toEqual(["a", "b"]);
    });

    it("respects tags filter", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a", tags: ["important"] }));
      await store.store(makeEntry({ id: "b", tags: ["trivial"] }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100, tags: ["important"] });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a");
    });

    it("respects maxEntries cap", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a" }));
      await store.store(makeEntry({ id: "b" }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100, maxEntries: 1 });
      expect(result).toHaveLength(1);
    });

    it("sorts by updatedAt descending (newest first)", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "old", updatedAt: "2026-07-01T00:00:00.000Z" }));
      await store.store(makeEntry({ id: "new", updatedAt: "2026-07-30T00:00:00.000Z" }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100 });
      expect(result[0]!.id).toBe("new");
      expect(result[1]!.id).toBe("old");
    });

    it("throws for zero maxTokens", async () => {
      const injector = new MemoryInjector(new InMemoryStore());
      await expect(injector.select({ maxTokens: 0 })).rejects.toThrow(
        "maxTokens must be a positive number",
      );
    });

    it("throws for negative maxTokens", async () => {
      const injector = new MemoryInjector(new InMemoryStore());
      await expect(injector.select({ maxTokens: -1 })).rejects.toThrow(
        "maxTokens must be a positive number",
      );
    });

    it("excludes proposals from selection", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a" }));
      await store.store(makeEntry({ id: "prop", source: { kind: "proposal" } }));
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100 });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a");
    });

    it("excludes expired entries", async () => {
      const store = new InMemoryStore();
      await store.store(makeEntry({ id: "a" }));
      await store.store(
        makeEntry({
          id: "expired",
          expiresAt: "2026-07-01T00:00:00.000Z",
        }),
      );
      const injector = new MemoryInjector(store);
      const result = await injector.select({ maxTokens: 100 });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a");
    });
  });

  describe("formatInjection", () => {
    it("returns empty string for empty entries", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      expect(injector.formatInjection([])).toBe("");
    });

    it("formats a single entry", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      const entry = makeEntry({ scope: "project", title: "my memory", tags: ["ref"], content: "some info" });
      const result = injector.formatInjection([entry]);
      expect(result).toContain("<memory>");
      expect(result).toContain('scope="project"');
      expect(result).toContain('title="my memory"');
      expect(result).toContain("<tags>ref</tags>");
      expect(result).toContain("<content>some info</content>");
      expect(result).toContain("</memory>");
    });

    it("formats multiple entries", async () => {
      const injector = new MemoryInjector(new InMemoryStore());
      const a = makeEntry({ id: "a", title: "first" });
      const b = makeEntry({ id: "b", title: "second" });
      const result = injector.formatInjection([a, b]);
      expect(result).toContain('title="first"');
      expect(result).toContain('title="second"');
      const lines = result.split("\n");
      const memoryLines = lines.filter((l) => l.includes("<entry"));
      expect(memoryLines).toHaveLength(2);
    });

    it("escapes special characters in title and content", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      const entry = makeEntry({
        title: 'he said "hello"',
        content: "a < b && b > c",
        tags: ["a&b"],
      });
      const result = injector.formatInjection([entry]);
      expect(result).toContain("&quot;");
      expect(result).toContain("&lt;");
      expect(result).toContain("&gt;");
      expect(result).toContain("&amp;");
      expect(result).not.toContain('"hello"');
      expect(result).not.toContain("a < b");
    });

    it("omits tags section when entry has no tags", () => {
      const injector = new MemoryInjector(new InMemoryStore());
      const entry = makeEntry({ tags: [] });
      const result = injector.formatInjection([entry]);
      expect(result).not.toContain("<tags>");
    });
  });
});
