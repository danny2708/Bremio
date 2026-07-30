import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { InMemoryStore } from "./store";
import { FsMemoryStore } from "./fs-store";
import { MemoryProposalLifecycle } from "./proposal";
import type { MemoryEntry } from "./types";

function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "prop-001",
    scope: "session",
    source: { kind: "session", sessionId: "sess-001" },
    title: "proposed memory",
    content: "content to remember",
    tags: ["test"],
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("MemoryProposalLifecycle (InMemoryStore)", () => {
  function createLifecycle() {
    const store = new InMemoryStore();
    return new MemoryProposalLifecycle(store);
  }

  it("proposes an entry with source kind proposal and pending status", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    const proposals = await lc.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.source.kind).toBe("proposal");
    expect(proposals[0]!.metadata.reviewStatus).toBe("pending");
  });

  it("propose records the proposer when provided", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry(), "agent-alice");
    const proposals = await lc.listProposals();
    expect(proposals[0]!.metadata.proposedBy).toBe("agent-alice");
  });

  it("propose overwrites the original source with proposal", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry({ source: { kind: "manual" } }));
    const proposals = await lc.listProposals();
    expect(proposals[0]!.source.kind).toBe("proposal");
  });

  it("listProposals returns only proposals among other entries", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry({ id: "a" }));
    await lc.propose(makeEntry({ id: "b" }));
    const all = (lc as any).store as InMemoryStore;
    await all.store(makeEntry({ id: "c", source: { kind: "manual" } }));
    const proposals = await lc.listProposals();
    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("listProposals filters by scope", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry({ id: "a", scope: "session" }));
    await lc.propose(makeEntry({ id: "b", scope: "project" }));
    const sessionProps = await lc.listProposals("session");
    expect(sessionProps).toHaveLength(1);
    expect(sessionProps[0]!.id).toBe("a");
  });

  it("listProposals returns empty when no proposals exist", async () => {
    const lc = createLifecycle();
    await expect(lc.listProposals()).resolves.toHaveLength(0);
  });

  it("accept changes source to manual by default", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    await lc.review("prop-001", { decision: "accept" });
    const proposals = await lc.listProposals();
    expect(proposals).toHaveLength(0);
    const store = (lc as any).store as InMemoryStore;
    const entry = await store.get("prop-001");
    expect(entry).toBeDefined();
    expect(entry!.source.kind).toBe("manual");
    expect(entry!.metadata.reviewStatus).toBe("accepted");
  });

  it("accept with custom targetSource", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    await lc.review("prop-001", {
      decision: "accept",
      targetSource: { kind: "session", sessionId: "sess-002" },
    });
    const store = (lc as any).store as InMemoryStore;
    const entry = await store.get("prop-001");
    expect(entry!.source.kind).toBe("session");
    if (entry!.source.kind === "session") {
      expect(entry!.source.sessionId).toBe("sess-002");
    }
  });

  it("accept records reviewer and notes in metadata", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    await lc.review("prop-001", {
      decision: "accept",
      reviewer: "user-bob",
      notes: "looks good",
    });
    const store = (lc as any).store as InMemoryStore;
    const entry = await store.get("prop-001");
    expect(entry!.metadata.reviewedBy).toBe("user-bob");
    expect(entry!.metadata.reviewNotes).toBe("looks good");
    expect(entry!.metadata.reviewedAt).toBeDefined();
  });

  it("reject marks the proposal as rejected but keeps source kind", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    await lc.review("prop-001", { decision: "reject", notes: "not relevant" });
    const pending = await lc.listProposals();
    expect(pending).toHaveLength(0);
    const store = (lc as any).store as InMemoryStore;
    const entry = await store.get("prop-001");
    expect(entry).toBeDefined();
    expect(entry!.source.kind).toBe("proposal");
    expect(entry!.metadata.reviewStatus).toBe("rejected");
  });

  it("review throws for non-existent proposal", async () => {
    const lc = createLifecycle();
    await expect(lc.review("nonexistent", { decision: "accept" })).rejects.toThrow(
      "Proposal not found: nonexistent",
    );
  });

  it("review throws for entry that is not a proposal", async () => {
    const lc = createLifecycle();
    const store = (lc as any).store as InMemoryStore;
    await store.store(makeEntry({ id: "not-prop", source: { kind: "manual" } }));
    await expect(lc.review("not-prop", { decision: "accept" })).rejects.toThrow(
      "Entry not-prop is not a proposal",
    );
  });

  it("review throws for already-reviewed proposal", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    await lc.review("prop-001", { decision: "reject" });
    await expect(lc.review("prop-001", { decision: "reject" })).rejects.toThrow(
      "Proposal prop-001 has already been reviewed",
    );
  });

  it("accept updates the updatedAt timestamp", async () => {
    const lc = createLifecycle();
    await lc.propose(makeEntry());
    const before = new Date("2026-07-30T00:00:00.000Z");
    await lc.review("prop-001", { decision: "accept" });
    const store = (lc as any).store as InMemoryStore;
    const entry = await store.get("prop-001");
    expect(new Date(entry!.updatedAt).getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("MemoryProposalLifecycle (FsMemoryStore)", () => {
  async function createLifecycle() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-prop-"));
    const store = new FsMemoryStore(tmpDir);
    return { lc: new MemoryProposalLifecycle(store), tmpDir };
  }

  it("propose and accept round-trip through filesystem", async () => {
    const { lc, tmpDir } = await createLifecycle();
    await lc.propose(makeEntry({ id: "fs-prop", scope: "project" }));
    let proposals = await lc.listProposals();
    expect(proposals).toHaveLength(1);
    await lc.review("fs-prop", { decision: "accept", reviewer: "reviewer" });
    proposals = await lc.listProposals();
    expect(proposals).toHaveLength(0);
    const store = (lc as any).store as FsMemoryStore;
    const entry = await store.get("fs-prop");
    expect(entry).toBeDefined();
    expect(entry!.source.kind).toBe("manual");
    expect(entry!.metadata.reviewStatus).toBe("accepted");
    expect(entry!.metadata.reviewedBy).toBe("reviewer");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
