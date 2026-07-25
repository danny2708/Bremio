import { describe, it, expect } from "vitest";
import {
  ActionDigest,
  InMemoryApprovalEngine,
  DuplicateDecisionError,
  InvalidTransitionError,
  GrantAlreadyRevokedError,
  GrantAlreadyConsumedError,
  InvalidDigestError,
  getGrantStatus,
} from "./approval";

// ── ActionDigest ───────────────────────────────────────────────────

describe("ActionDigest", () => {
  it("creates a deterministic digest for the same action+target", () => {
    const a = ActionDigest.create("command", "npm install", "Install deps");
    const b = ActionDigest.create("command", "npm install", "Install deps");
    expect(a.digest).toBe(b.digest);
  });

  it("produces different digests for different action classes", () => {
    const a = ActionDigest.create("write", "foo.txt", "Write foo");
    const b = ActionDigest.create("delete", "foo.txt", "Delete foo");
    expect(a.digest).not.toBe(b.digest);
  });

  it("produces different digests for different targets", () => {
    const a = ActionDigest.create("write", "foo.txt", "Write foo");
    const b = ActionDigest.create("write", "bar.txt", "Write bar");
    expect(a.digest).not.toBe(b.digest);
  });

  it("verify returns true for an untampered digest", () => {
    const d = ActionDigest.create("command", "rm -rf /", "Dangerous");
    expect(ActionDigest.verify(d)).toBe(true);
  });

  it("verify returns false when target has been tampered with", () => {
    const d = ActionDigest.create("command", "rm -rf /", "Dangerous");
    const tampered = { ...d, target: "rm -rf /home" };
    expect(ActionDigest.verify(tampered)).toBe(false);
  });

  it("verify returns false when actionClass has been tampered with", () => {
    const d = ActionDigest.create("write", "config.json", "Write config");
    const tampered = { ...d, actionClass: "delete" as const };
    expect(ActionDigest.verify(tampered)).toBe(false);
  });
});

// ── InMemoryApprovalEngine — requests ──────────────────────────────

describe("InMemoryApprovalEngine — requests", () => {
  it("creates a request in pending state", () => {
    const engine = new InMemoryApprovalEngine();
    const digest = ActionDigest.create("write", "main.ts", "Write main.ts");
    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: digest,
      risk: "low",
    });

    expect(req.state).toBe("pending");
    expect(req.sessionId).toBe("sess-1");
    expect(req.runId).toBe("run-1");
    expect(req.actionDigest.digest).toBe(digest.digest);
    expect(req.id).toBeTruthy();
    expect(req.requestedAt).toBeTruthy();
  });

  it("throws InvalidDigestError when creating with a tampered digest", () => {
    const engine = new InMemoryApprovalEngine();
    const tampered = ActionDigest.create("write", "safe.txt", "Safe");
    (tampered as { target: string }).target = "unsafe.txt";

    expect(() =>
      engine.createRequest({
        sessionId: "sess-1",
        runId: "run-1",
        actionDigest: tampered,
        risk: "high",
      }),
    ).toThrow(InvalidDigestError);
  });

  it("approves a pending request", () => {
    const engine = new InMemoryApprovalEngine();
    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "x.txt", "Write x"),
      risk: "low",
    });

    const decided = engine.decide({
      requestId: req.id,
      decision: "approved",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
    });

    expect(decided.state).toBe("approved");
    expect(decided.decidedBy).toBe("user-1");
  });

  it("rejects a pending request", () => {
    const engine = new InMemoryApprovalEngine();
    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("command", "rm -rf", "Remove all"),
      risk: "high",
    });

    const decided = engine.decide({
      requestId: req.id,
      decision: "rejected",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
      reason: "Too dangerous",
    });

    expect(decided.state).toBe("rejected");
    expect(decided.reason).toBe("Too dangerous");
  });

  it("cancels a pending request", () => {
    const engine = new InMemoryApprovalEngine();
    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "y.txt", "Write y"),
      risk: "low",
    });

    const cancelled = engine.cancelRequest(req.id);
    expect(cancelled.state).toBe("cancelled");
  });

  it("first-decision-wins: rejects duplicate decision", () => {
    const engine = new InMemoryApprovalEngine();
    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("read", "file.txt", "Read file"),
      risk: "low",
    });

    engine.decide({
      requestId: req.id,
      decision: "approved",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
    });

    expect(() =>
      engine.decide({
        requestId: req.id,
        decision: "rejected",
        decidedBy: "user-2",
        decidedAt: new Date().toISOString(),
      }),
    ).toThrow(DuplicateDecisionError);
  });

  it("cannot cancel an already-decided request", () => {
    const engine = new InMemoryApprovalEngine();
    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("command", "npm test", "Run tests"),
      risk: "low",
    });

    engine.decide({
      requestId: req.id,
      decision: "approved",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
    });

    expect(() => engine.cancelRequest(req.id)).toThrow(InvalidTransitionError);
  });

  it("expires pending requests older than threshold", () => {
    const engine = new InMemoryApprovalEngine();

    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "a.txt", "Write a"),
      risk: "low",
    });

    const count = engine.expirePendingRequests(0);
    expect(count).toBe(1);
    expect(engine.getRequest(req.id)!.state).toBe("expired");
  });

  it("does not expire already-decided requests", () => {
    const engine = new InMemoryApprovalEngine();

    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "a.txt", "Write a"),
      risk: "low",
    });

    engine.decide({
      requestId: req.id,
      decision: "approved",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
    });

    const count = engine.expirePendingRequests(0);
    expect(count).toBe(0);
  });

  it("getRequestsBySession returns only matching requests", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createRequest({
      sessionId: "sess-a",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "a.txt", "Write a"),
      risk: "low",
    });
    engine.createRequest({
      sessionId: "sess-b",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "b.txt", "Write b"),
      risk: "low",
    });
    engine.createRequest({
      sessionId: "sess-a",
      runId: "run-2",
      actionDigest: ActionDigest.create("write", "c.txt", "Write c"),
      risk: "low",
    });

    const sessA = engine.getRequestsBySession("sess-a");
    expect(sessA).toHaveLength(2);

    const sessB = engine.getRequestsBySession("sess-b");
    expect(sessB).toHaveLength(1);
  });
});

// ── InMemoryApprovalEngine — grants ────────────────────────────────

describe("InMemoryApprovalEngine — grants", () => {
  it("creates a grant and retrieves it", () => {
    const engine = new InMemoryApprovalEngine();
    const digest = ActionDigest.create("write", "src/", "Write to src");
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
      originatingActionDigest: digest,
    });

    expect(grant.id).toBeTruthy();
    expect(grant.scope).toBe("session");
    expect(grant.originatingDigest).toBe(digest.digest);
    expect(grant.revokedAt).toBeUndefined();

    const retrieved = engine.getGrant(grant.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(grant.id);
  });

  it("revokes a grant", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const revoked = engine.revokeGrant(grant.id);
    expect(revoked.revokedAt).toBeTruthy();
  });

  it("throws GrantAlreadyRevokedError on double revoke", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.revokeGrant(grant.id);
    expect(() => engine.revokeGrant(grant.id)).toThrow(GrantAlreadyRevokedError);
  });

  it("pruneExpiredGrants removes expired, non-revoked grants", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: -1,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const count = engine.pruneExpiredGrants();
    expect(count).toBe(1);
  });

  it("findActiveGrant returns null when no matching grant exists", () => {
    const engine = new InMemoryApprovalEngine();
    const result = engine.findActiveGrant("sess-1", "write", "src/");
    expect(result).toBeNull();
  });

  it("findActiveGrant matches by actionClass (with broader scope)", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "workspace",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-1", "write", "any/file.txt", "ws-1");
    expect(result).not.toBeNull();
    expect(result!.actionClass).toBe("write");
    expect(result!.scope).toBe("workspace");
  });

  it("findActiveGrant matches more specific grant when target matches", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "workspace",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "session",
      actionClass: "write",
      target: "specific.ts",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 20,
    });

    const result = engine.findActiveGrant("sess-1", "write", "specific.ts", "ws-1");
    expect(result).not.toBeNull();
    expect(result!.target).toBe("specific.ts");
    expect(result!.precedence).toBe(20);
  });

  it("findActiveGrant prefers higher precedence over lower", () => {
    const engine = new InMemoryApprovalEngine();

    const low = engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "workspace",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 1,
    });

    const high = engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-2",
      precedence: 100,
    });

    const result = engine.findActiveGrant("sess-1", "write", undefined, "ws-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(high.id);
    expect(result!.id).not.toBe(low.id);
  });

  it("findActiveGrant does not return revoked grants", () => {
    const engine = new InMemoryApprovalEngine();

    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.revokeGrant(grant.id);
    const result = engine.findActiveGrant("sess-1", "write");
    expect(result).toBeNull();
  });

  it("findActiveGrant does not return expired grants", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      actionClass: "write",
      ttlMs: -1,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-1", "write");
    expect(result).toBeNull();
  });

  it("findActiveGrant returns grant with no actionClass filter for any action", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-1", "command", "npm run build");
    expect(result).not.toBeNull();
  });

  it("findActiveGrant scoped to a session does not match another session", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-2", "write");
    expect(result).toBeNull();
  });

  it("getGrantsBySession returns only matching grants", () => {
    const engine = new InMemoryApprovalEngine();

    engine.createGrant({
      sessionId: "sess-a",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });
    engine.createGrant({
      sessionId: "sess-b",
      scope: "once",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const grantsA = engine.getGrantsBySession("sess-a");
    expect(grantsA).toHaveLength(1);
    expect(grantsA[0]!.scope).toBe("session");

    const grantsB = engine.getGrantsBySession("sess-b");
    expect(grantsB).toHaveLength(1);
    expect(grantsB[0]!.scope).toBe("once");
  });
});

// ── Grant scope consumption ────────────────────────────────────────

describe("InMemoryApprovalEngine — grant consumption", () => {
  it("consumes a once-scoped grant", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const consumed = engine.consumeGrant(grant.id);
    expect(consumed.consumedAt).toBeTruthy();
    expect(getGrantStatus(consumed)).toBe("consumed");
  });

  it("throws GrantAlreadyConsumedError on double consume", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.consumeGrant(grant.id);
    expect(() => engine.consumeGrant(grant.id)).toThrow(GrantAlreadyConsumedError);
  });

  it("throws GrantAlreadyRevokedError when consuming a revoked grant", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.revokeGrant(grant.id);
    expect(() => engine.consumeGrant(grant.id)).toThrow(GrantAlreadyRevokedError);
  });

  it("findActiveGrant excludes consumed grants", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.consumeGrant(grant.id);
    const result = engine.findActiveGrant("sess-1", "write");
    expect(result).toBeNull();
  });

  it("revokeGrant refuses consumed grants", () => {
    const engine = new InMemoryApprovalEngine();
    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.consumeGrant(grant.id);
    expect(() => engine.revokeGrant(grant.id)).toThrow(GrantAlreadyConsumedError);
  });

  it("emits grant-consumed event", () => {
    const engine = new InMemoryApprovalEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));

    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.consumeGrant(grant.id);
    expect(events).toContain("grant-consumed");
  });
});

// ── Workspace-scoped grants ────────────────────────────────────────

describe("InMemoryApprovalEngine — workspace scope", () => {
  it("workspace-scoped grant matches the owning session", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "workspace",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-1", "write", undefined, "ws-1");
    expect(result).not.toBeNull();
    expect(result!.scope).toBe("workspace");
  });

  it("workspace-scoped grant matches a different session in the same workspace", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "workspace",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-2", "write", undefined, "ws-1");
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-1");
  });

  it("workspace-scoped grant does not match outside its workspace", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      scope: "workspace",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-2", "write", undefined, "ws-2");
    expect(result).toBeNull();
  });

  it("workspace-scoped grant without workspaceId never matches cross-session", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({
      sessionId: "sess-1",
      scope: "workspace",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-2", "write", undefined, "ws-1");
    expect(result).toBeNull();
  });

  it("session-scoped grant does not match other sessions", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const result = engine.findActiveGrant("sess-2", "write");
    expect(result).toBeNull();
  });

  it("once-scoped grant only matches its owning session", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({
      sessionId: "sess-1",
      scope: "once",
      actionClass: "write",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    const same = engine.findActiveGrant("sess-1", "write");
    expect(same).not.toBeNull();

    const other = engine.findActiveGrant("sess-2", "write");
    expect(other).toBeNull();
  });
});

// ── Batch revocation ───────────────────────────────────────────────

describe("InMemoryApprovalEngine — batch revocation", () => {
  it("revokeSessionGrants revokes all active grants for a session", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({ sessionId: "sess-1", scope: "session", ttlMs: 60_000, createdBy: "u1", precedence: 10 });
    engine.createGrant({ sessionId: "sess-1", scope: "once", ttlMs: 60_000, createdBy: "u1", precedence: 10 });
    engine.createGrant({ sessionId: "sess-2", scope: "session", ttlMs: 60_000, createdBy: "u1", precedence: 10 });

    const count = engine.revokeSessionGrants("sess-1");
    expect(count).toBe(2);

    const sess1Grants = engine.getGrantsBySession("sess-1");
    for (const g of sess1Grants) {
      expect(getGrantStatus(g)).toBe("revoked");
    }
  });

  it("revokeSessionGrants does not affect revoked or consumed grants", () => {
    const engine = new InMemoryApprovalEngine();
    const g1 = engine.createGrant({ sessionId: "sess-1", scope: "once", ttlMs: 60_000, createdBy: "u1", precedence: 10 });
    const g2 = engine.createGrant({ sessionId: "sess-1", scope: "once", ttlMs: 60_000, createdBy: "u1", precedence: 10 });

    engine.consumeGrant(g1.id);
    engine.revokeGrant(g2.id);

    const count = engine.revokeSessionGrants("sess-1");
    expect(count).toBe(0);
  });

  it("revokeWorkspaceGrants revokes all active workspace-scoped grants", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({ sessionId: "sess-1", workspaceId: "ws-1", scope: "workspace", ttlMs: 60_000, createdBy: "u1", precedence: 10 });
    engine.createGrant({ sessionId: "sess-2", workspaceId: "ws-1", scope: "workspace", ttlMs: 60_000, createdBy: "u1", precedence: 10 });
    engine.createGrant({ sessionId: "sess-3", workspaceId: "ws-2", scope: "workspace", ttlMs: 60_000, createdBy: "u1", precedence: 10 });

    const count = engine.revokeWorkspaceGrants("ws-1");
    expect(count).toBe(2);

    const ws1 = engine.getGrantsByWorkspace("ws-1");
    for (const g of ws1) {
      expect(getGrantStatus(g)).toBe("revoked");
    }

    const ws2 = engine.getGrantsByWorkspace("ws-2");
    expect(getGrantStatus(ws2[0]!)).toBe("active");
  });

  it("revokeWorkspaceGrants skips non-workspace grants", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({ sessionId: "sess-1", workspaceId: "ws-1", scope: "workspace", ttlMs: 60_000, createdBy: "u1", precedence: 10 });
    engine.createGrant({ sessionId: "sess-1", scope: "session", ttlMs: 60_000, createdBy: "u1", precedence: 10 });

    const count = engine.revokeWorkspaceGrants("ws-1");
    expect(count).toBe(1);
  });
});

// ── Grant status helper ────────────────────────────────────────────

describe("getGrantStatus", () => {
  it("returns active for a valid grant", () => {
    const g: Parameters<typeof getGrantStatus>[0] = {
      id: "g1", sessionId: "s1", scope: "session", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(), createdBy: "u1", precedence: 10,
    };
    expect(getGrantStatus(g)).toBe("active");
  });

  it("returns revoked when revokedAt is set", () => {
    const g: Parameters<typeof getGrantStatus>[0] = {
      id: "g1", sessionId: "s1", scope: "session", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), createdBy: "u1", precedence: 10,
    };
    expect(getGrantStatus(g)).toBe("revoked");
  });

  it("returns consumed when consumedAt is set (before expiry)", () => {
    const g: Parameters<typeof getGrantStatus>[0] = {
      id: "g1", sessionId: "s1", scope: "once", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), createdBy: "u1", precedence: 10,
    };
    expect(getGrantStatus(g)).toBe("consumed");
  });

  it("returns expired when past expiry", () => {
    const g: Parameters<typeof getGrantStatus>[0] = {
      id: "g1", sessionId: "s1", scope: "session", expiresAt: new Date(Date.now() - 1).toISOString(),
      createdAt: new Date().toISOString(), createdBy: "u1", precedence: 10,
    };
    expect(getGrantStatus(g)).toBe("expired");
  });
});

// ── Grant pruning with consumed/revoked ────────────────────────────

describe("InMemoryApprovalEngine — pruneExpiredGrants", () => {
  it("does not remove consumed or revoked grants", () => {
    const engine = new InMemoryApprovalEngine();
    const g1 = engine.createGrant({ sessionId: "sess-1", scope: "once", ttlMs: -1, createdBy: "u1", precedence: 10 });
    const g2 = engine.createGrant({ sessionId: "sess-1", scope: "once", ttlMs: -1, createdBy: "u1", precedence: 10 });

    engine.consumeGrant(g1.id);
    engine.revokeGrant(g2.id);

    const count = engine.pruneExpiredGrants();
    expect(count).toBe(0);
  });

  it("removes only truly expired grants", () => {
    const engine = new InMemoryApprovalEngine();
    engine.createGrant({ sessionId: "sess-1", scope: "once", ttlMs: -1, createdBy: "u1", precedence: 10 }); // will be pruned
    engine.createGrant({ sessionId: "sess-1", scope: "session", ttlMs: 60_000, createdBy: "u1", precedence: 10 }); // stays

    const count = engine.pruneExpiredGrants();
    expect(count).toBe(1);
    expect(engine.getGrantsBySession("sess-1")).toHaveLength(1);
  });
});

// ── Event emission ─────────────────────────────────────────────────

describe("InMemoryApprovalEngine — events", () => {
  it("emits request-created on createRequest", () => {
    const engine = new InMemoryApprovalEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));

    engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("read", "x.txt", "Read x"),
      risk: "low",
    });

    expect(events).toContain("request-created");
  });

  it("emits request-decided on decide", () => {
    const engine = new InMemoryApprovalEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));

    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("read", "x.txt", "Read x"),
      risk: "low",
    });

    engine.decide({
      requestId: req.id,
      decision: "approved",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
    });

    expect(events).toContain("request-decided");
  });

  it("emits grant-created on createGrant", () => {
    const engine = new InMemoryApprovalEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));

    engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    expect(events).toContain("grant-created");
  });

  it("emits grant-revoked on revokeGrant", () => {
    const engine = new InMemoryApprovalEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));

    const grant = engine.createGrant({
      sessionId: "sess-1",
      scope: "session",
      ttlMs: 60_000,
      createdBy: "user-1",
      precedence: 10,
    });

    engine.revokeGrant(grant.id);
    expect(events).toContain("grant-revoked");
  });

  it("unsubscribe removes listener", () => {
    const engine = new InMemoryApprovalEngine();
    let callCount = 0;
    const unsub = engine.onEvent(() => {
      callCount++;
    });

    unsub();
    engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("read", "x.txt", "Read x"),
      risk: "low",
    });

    expect(callCount).toBe(0);
  });

  it("event log stores all events", () => {
    const engine = new InMemoryApprovalEngine();

    const req = engine.createRequest({
      sessionId: "sess-1",
      runId: "run-1",
      actionDigest: ActionDigest.create("write", "f.txt", "Write f"),
      risk: "low",
    });

    engine.decide({
      requestId: req.id,
      decision: "approved",
      decidedBy: "user-1",
      decidedAt: new Date().toISOString(),
    });

    expect(engine.eventLog).toHaveLength(2);
    expect(engine.eventLog[0]!.type).toBe("request-created");
    expect(engine.eventLog[1]!.type).toBe("request-decided");
  });
});
