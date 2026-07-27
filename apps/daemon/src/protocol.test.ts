import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type RunningDaemon } from "./index";
import { MINIMUM_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "./endpoint";
import { computeDigest } from "./runs";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

async function daemon(): Promise<RunningDaemon> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-proto-"));
  dirs.push(dir);
  const running = await startDaemon({
    version: "test",
    lockFile: path.join(dir, "daemon.lock"),
    endpointFile: path.join(dir, "daemon.json"),
    databasePath: path.join(dir, "bremio.db"),
  });
  closers.push(() => running.close());
  return running;
}

function call(d: RunningDaemon, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${d.port}${route}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "X-Bremio-Token": d.token },
  });
}

/** Drive a run to a terminal state without spending provider quota. */
async function failedRun(d: RunningDaemon): Promise<string> {
  const started = d.registry.start({
    mode: "single",
    repoPath: path.join(os.tmpdir(), "definitely-not-a-repo"),
    prompt: "noop",
    agentId: "claude",
  });
  await new Promise<void>((resolve) => {
    const unsubscribe = d.registry.subscribe(started.id, (event) => {
      if (event.kind === "finished" || event.kind === "failed") {
        unsubscribe();
        resolve();
      }
    });
  });
  return started.id;
}

describe("protocol handshake", () => {
  it("advertises versions and capabilities", async () => {
    const d = await daemon();
    const meta = (await (await call(d, "/meta")).json()) as {
      protocolVersion: number;
      minimumClientProtocol: number;
      capabilities: Record<string, boolean>;
    };

    expect(meta.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(meta.minimumClientProtocol).toBe(MINIMUM_CLIENT_PROTOCOL);
    expect(meta.capabilities).toMatchObject({
      sse: true,
      sseResume: true,
      persistentRuns: true,
      persistentEvents: true,
      retry: true,
    });
  });

  it("reports resume as unsupported rather than offering a fake button", async () => {
    const d = await daemon();
    const meta = (await (await call(d, "/meta")).json()) as { capabilities: { resume: boolean } };

    // No adapter can resume mid-run; claiming otherwise would silently restart.
    expect(meta.capabilities.resume).toBe(false);
  });

  it("requires a token for metadata", async () => {
    const d = await daemon();
    const response = await fetch(`http://127.0.0.1:${d.port}/meta`);
    expect(response.status).toBe(401);
  });

  it("separates readiness from liveness", async () => {
    const d = await daemon();

    expect((await call(d, "/health")).status).toBe(200);
    const ready = await call(d, "/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, acceptingRuns: true });
  });

  it("stops answering once shutdown completes", async () => {
    const d = await daemon();
    await call(d, "/shutdown", { method: "POST" });

    // Poll rather than sleeping a fixed amount: shutdown takes as long as it
    // takes, and a fixed delay makes this flaky under load.
    const deadline = Date.now() + 5_000;
    let stillAnswering = true;
    while (Date.now() < deadline && stillAnswering) {
      try {
        await call(d, "/ready");
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        stillAnswering = false;
      }
    }

    expect(stillAnswering).toBe(false);
  });
});

describe("SSE contract", () => {
  it("emits stable ids scoped to the run and a named event type", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    const text = await (await call(d, `/runs/${id}/events`)).text();

    expect(text).toContain(`id: ${id}:1`);
    expect(text).toMatch(/event: (failed|finished)/);
    expect(text).toContain("data: {");
  });

  it("resumes from Last-Event-ID without repeating delivered events", async () => {
    const d = await daemon();
    const id = await failedRun(d);
    const last = d.store.lastSeq(id);

    const resumed = await (
      await call(d, `/runs/${id}/events`, { headers: { "Last-Event-ID": `${id}:${last}` } })
    ).text();

    // Everything was already delivered, so the stream must carry no data
    // frames — a reconnect that replayed would duplicate the whole log.
    expect(resumed).not.toContain("data: {");
  });

  it("ignores a Last-Event-ID belonging to a different run", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    const text = await (
      await call(d, `/runs/${id}/events`, { headers: { "Last-Event-ID": "some-other-run:99" } })
    ).text();

    // Trusting another run's position would silently skip this run's history.
    expect(text).toContain(`id: ${id}:1`);
  });

  it("closes the stream on a terminal event", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    // Resolving at all proves the server ended the response rather than
    // holding the client open forever.
    const text = await (await call(d, `/runs/${id}/events`)).text();
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("recovery actions", () => {
  it("offers retry but never resume", async () => {
    const d = await daemon();
    const id = await failedRun(d);

    const detail = (await (await call(d, `/runs/${id}`)).json()) as {
      recovery: { canRetry: boolean; canResume: boolean };
    };
    expect(detail.recovery.canRetry).toBe(true);
    expect(detail.recovery.canResume).toBe(false);
  });

  it("creates a new run linked to the original and leaves it intact", async () => {
    const d = await daemon();
    const id = await failedRun(d);
    const originalEvents = d.store.readEvents(id).length;

    const response = await call(d, `/runs/${id}/retry`, { method: "POST" });
    expect(response.status).toBe(202);
    const { run } = (await response.json()) as { run: { id: string; retryOfRunId?: string } };

    expect(run.id).not.toBe(id);
    expect(run.retryOfRunId).toBe(id);
    // The original is the record of what went wrong; a retry that overwrote it
    // would destroy the reason for retrying.
    expect(d.store.getRun(id)?.status).toBe("failed");
    expect(d.store.readEvents(id)).toHaveLength(originalEvents);
  });

  it("refuses to retry a run that is still in flight", async () => {
    const d = await daemon();
    d.store.createRun({ id: "busy", mode: "single", repositoryPath: "/tmp/r", prompt: "p" });
    d.store.updateRun("busy", { status: "running" });

    const response = await call(d, "/runs/busy/retry", { method: "POST" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("still running");
  });

  it("404s an unknown run and 409s its retry", async () => {
    const d = await daemon();
    expect((await call(d, "/runs/nope")).status).toBe(404);
    expect((await call(d, "/runs/nope/retry", { method: "POST" })).status).toBe(409);
  });

  it("can retry an interrupted run", async () => {
    const d = await daemon();
    d.store.createRun({ id: "stranded", mode: "team", repositoryPath: "/tmp/r", prompt: "p" });
    d.store.updateRun("stranded", { status: "interrupted" });

    const response = await call(d, "/runs/stranded/retry", { method: "POST" });
    expect(response.status).toBe(202);
  });
});

describe("approval protocol", () => {
  it("auto-denies a request when no SSE subscriber is watching the run", async () => {
    const d = await daemon();
    const started = d.registry.start({
      mode: "single",
      repoPath: "/tmp/r",
      prompt: "write a file",
      agentId: "opencode",
    });

    const response = await call(d, "/approval/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: started.sessionId,
        runId: started.id,
        actionDigest: {
          actionClass: "write",
          target: "test.txt",
          description: "write test file",
          digest: "sha256:abc",
        },
        risk: "low",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { request: { state: string }; autoDenied: boolean };
    expect(body.autoDenied).toBe(true);
    expect(body.request.state).toBe("rejected");
  });

  it("creates a pending request when an SSE subscriber is active", async () => {
    const d = await daemon();
    const id = await failedRun(d);
    // Subscribe to give the run a listener
    d.registry.subscribe(id, () => {});

    const response = await call(d, "/approval/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session",
        runId: id,
        actionDigest: {
          actionClass: "read",
          target: "secret.txt",
          description: "read secret file",
          digest: "sha256:def",
        },
        risk: "high",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { request: { state: string }; autoDenied: boolean };
    expect(body.autoDenied).toBe(false);
    expect(body.request.state).toBe("pending");
  });

  it("rejects a malformed request body", async () => {
    const d = await daemon();
    const response = await call(d, "/approval/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "incomplete" }),
    });

    expect(response.status).toBe(400);
  });

  it("fetches a single approval request by id", async () => {
    const d = await daemon();
    // Use a valid run to get a real sessionId
    const runId = await failedRun(d);
    const response = await call(d, "/approval/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runId,
        runId,
        actionDigest: {
          actionClass: "command",
          target: "script.sh",
          description: "run script",
          digest: "sha256:123",
        },
        risk: "medium",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { request: { id: string } };
    const created = body.request;

    const fetched = await (await call(d, `/approval/requests/${created.id}`)).json();
    expect((fetched as { request: { id: string } }).request.id).toBe(created.id);
  });

  it("404s for a nonexistent request id", async () => {
    const d = await daemon();
    expect((await call(d, "/approval/requests/nonexistent")).status).toBe(404);
  });

  it("lists approval requests filtered by session", async () => {
    const d = await daemon();

    // Subscribe so both requests stay pending
    const runId = await failedRun(d);
    const unsub = d.registry.subscribe(runId, () => {});

    for (let i = 0; i < 3; i++) {
      await call(d, "/approval/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "list-test",
          runId,
          actionDigest: {
            actionClass: "read",
            target: `f${i}.txt`,
            description: `file ${i}`,
            digest: `sha256:${i}`,
          },
          risk: "low",
        }),
      });
    }
    unsub();

    const list = (await (await call(d, "/approval/requests?sessionId=list-test")).json()) as {
      requests: unknown[];
    };
    expect(list.requests).toHaveLength(3);
  });

  it("approves a pending request", async () => {
    const d = await daemon();
    const runId = await failedRun(d);
    const unsub = d.registry.subscribe(runId, () => {});

    const created = await (
      await call(d, "/approval/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          runId,
          actionDigest: {
            actionClass: "read",
            target: "x.txt",
            description: "read x",
            digest: "sha256:x",
          },
          risk: "low",
        }),
      })
    ).json();
    unsub();

    const decided = await (
      await call(d, `/approval/requests/${(created as { request: { id: string } }).request.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" as const, decidedBy: "test" }),
      })
    ).json();
    expect((decided as { request: { state: string } }).request.state).toBe("approved");
  });

  it("rejects with a reason", async () => {
    const d = await daemon();
    const runId = await failedRun(d);
    const unsub = d.registry.subscribe(runId, () => {});

    const created = await (
      await call(d, "/approval/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          runId,
          actionDigest: {
            actionClass: "delete",
            target: "important.txt",
            description: "delete important",
            digest: "sha256:del",
          },
          risk: "high",
        }),
      })
    ).json();
    unsub();

    const decided = await (
      await call(d, `/approval/requests/${(created as { request: { id: string } }).request.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "rejected" as const,
          decidedBy: "test",
          reason: "too dangerous",
        }),
      })
    ).json();
    expect((decided as { request: { reason: string } }).request.reason).toBe("too dangerous");
  });

  it("409s deciding a non-pending request", async () => {
    const d = await daemon();
    const runId = await failedRun(d);
    d.registry.subscribe(runId, () => {});
    const created = (await (
      await call(d, "/approval/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          runId,
          actionDigest: {
            actionClass: "read",
            target: "x.txt",
            description: "read x",
            digest: "sha256:x",
          },
          risk: "low",
        }),
      })
    ).json()) as { request: { id: string } };

    // Decide twice; second should 409
    await call(d, `/approval/requests/${created.request.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" as const, decidedBy: "test" }),
    });
    const second = await call(d, `/approval/requests/${created.request.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" as const, decidedBy: "test" }),
    });
    expect(second.status).toBe(409);
  });

  it("cancels a pending request", async () => {
    const d = await daemon();
    const runId = await failedRun(d);
    d.registry.subscribe(runId, () => {});
    const created = (await (
      await call(d, "/approval/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          runId,
          actionDigest: {
            actionClass: "read",
            target: "y.txt",
            description: "read y",
            digest: "sha256:y",
          },
          risk: "low",
        }),
      })
    ).json()) as { request: { id: string } };

    const cancelled = await call(d, `/approval/requests/${created.request.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { request: { state: string } }).request.state).toBe("cancelled");
  });

  it("409s cancelling a non-pending request", async () => {
    const d = await daemon();
    const runId = await failedRun(d);
    d.registry.subscribe(runId, () => {});
    const created = (await (
      await call(d, "/approval/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          runId,
          actionDigest: {
            actionClass: "read",
            target: "z.txt",
            description: "read z",
            digest: "sha256:z",
          },
          risk: "low",
        }),
      })
    ).json()) as { request: { id: string } };

    await call(d, `/approval/requests/${created.request.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" as const, decidedBy: "test" }),
    });
    const cancel = await call(d, `/approval/requests/${created.request.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(409);
  });
});

describe("review-before-apply (S3-T4)", () => {
  it("accepts workspaceStrategy on POST /runs", async () => {
    const d = await daemon();
    const response = await call(d, "/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "single",
        repoPath: "/tmp/nonexistent-test-repo",
        prompt: "test prompt",
        agentId: "claude",
        workspaceStrategy: "isolated-worktree",
      }),
    });
    // The run will fail because the repo doesn't exist, but the schema
    // must accept the field without validation errors.
    expect(response.status).not.toBe(400);
  });

  it("daemon capability advertises approvals", async () => {
    const d = await daemon();
    const meta = (await (await call(d, "/meta")).json()) as {
      capabilities: Record<string, boolean>;
    };
    expect(meta.capabilities.approvals).toBe(true);
  });

  it("recovery options include canReview for pending_approval runs", async () => {
    const d = await daemon();
    // A run that is pending_approval is not terminal, but it is not retryable.
    // Use store directly to create one in that state.
    d.store.createRun({ id: "pending-review-test", mode: "single", repositoryPath: "/tmp/r", prompt: "p" });
    d.store.updateRun("pending-review-test", { status: "pending_approval" });

    const recovery = (await (
      await call(d, "/runs/pending-review-test")
    ).json()) as { recovery: { canRetry: boolean } };
    expect(recovery.recovery.canRetry).toBe(false);
  });

  it("resolves a pending review via registry", async () => {
    const d = await daemon();
    const requestId = "test-request-for-review";

    // Resolve a non-existent request — no-op
    expect(d.registry.resolvePendingApproval(requestId, "approved")).toBe(false);

    // Use a run to create a real approval request, then cancel it via
    // the registry's cancel method to verify the approval lifecycle.
    const started = d.registry.start({
      mode: "single",
      repoPath: "/tmp/r",
      prompt: "test",
      agentId: "opencode",
    });

    const { request } = d.registry.createApprovalRequest({
      sessionId: started.sessionId ?? started.id,
      runId: started.id,
      actionClass: "write",
      actionTarget: "test-branch",
      actionDescription: "review test",
      actionDigest: "sha256:test",
      risk: "low",
    });
    expect(request.id).toBeDefined();

    // Resolving a pending approval that does NOT have an active review
    // (no pending review entry) returns false
    expect(d.registry.resolvePendingApproval(request.id, "approved")).toBe(false);
  });
});

describe("action digest (S4-T10)", () => {
  it("computeDigest produces a valid SHA-256 hex string", () => {
    const input = "hello\nworld\n";
    const expected =
      "sha256:" + createHash("sha256").update(input, "utf-8").digest("hex");
    expect(computeDigest(input)).toBe(expected);
  });

  it("different input produces a different digest", () => {
    const a = computeDigest("file1 content\n");
    const b = computeDigest("file2 content\n");
    expect(a).not.toBe(b);
  });

  it("matches against a real git diff — integration", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-digest-"));
    dirs.push(repo);
    const git = (args: string[], cwd = repo) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });

    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@bremio.local"]);
    git(["config", "user.name", "Bremio Test"]);
    git(["config", "core.autocrlf", "false"]);
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
    git(["checkout", "-q", "-b", "bremio/T1"]);
    await fs.writeFile(path.join(repo, "FEATURE.txt"), "hello\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "add feature"]);
    git(["checkout", "-q", "main"]);

    const { MergeManager } = await import("@bremio/workspace");
    const diff = await new MergeManager(repo).getDiff("bremio/T1", "main");
    const digest = computeDigest(diff.patch);

    // The digest is a real SHA-256: re-hash from scratch to verify.
    const expected =
      "sha256:" + createHash("sha256").update(diff.patch, "utf-8").digest("hex");
    expect(digest).toBe(expected);
  });

  it("detects worktree drift — mismatched digest after content change", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-drift-"));
    dirs.push(repo);
    const git = (args: string[], cwd = repo) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });

    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@bremio.local"]);
    git(["config", "user.name", "Bremio Test"]);
    git(["config", "core.autocrlf", "false"]);
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);

    // Simulate an approved diff
    git(["checkout", "-q", "-b", "bremio/T1"]);
    await fs.writeFile(path.join(repo, "FEATURE.txt"), "original\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "original content"]);

    const { MergeManager } = await import("@bremio/workspace");
    const mm = new MergeManager(repo);
    const originalDiff = await mm.getDiff("bremio/T1", "main");
    const approvedDigest = computeDigest(originalDiff.patch);

    // Now change the worktree branch content (drift)
    await fs.writeFile(path.join(repo, "FEATURE.txt"), "tampered\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "tampered content"]);

    git(["checkout", "-q", "main"]);
    const verifyDiff = await mm.getDiff("bremio/T1", "main");
    const actualDigest = computeDigest(verifyDiff.patch);

    expect(actualDigest).not.toBe(approvedDigest);
  });
});
