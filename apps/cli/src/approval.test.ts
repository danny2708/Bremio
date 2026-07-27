import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mocks — top-level vi.mock is hoisted by vitest                    */
/* ------------------------------------------------------------------ */

const mockDaemonStatus = () => ({
  running: true,
  endpoint: { port: 9999, token: "test-token", pid: 12345, startedAt: "2025-01-01T00:00:00.000Z", daemonVersion: "1.0.0", protocolVersion: 1 },
});

vi.mock("@bremio/daemon", () => ({
  daemonStatus: () => Promise.resolve(mockDaemonStatus()),
  defaultDatabasePath: () => "/tmp/test-bremio.db",
}));

import { approvalCommandFromCli } from "./approval";

/** Install a global fetch mock that returns JSON. */
function mockFetch(responseBody: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: vi.fn().mockResolvedValue(
        status >= 200 && status < 300 ? JSON.stringify(responseBody) : String(responseBody),
      ),
    }),
  );
}

describe("approval CLI — request subcommands", () => {
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
    vi.spyOn(console, "error").mockImplementation((msg) => errs.push(String(msg)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("1. list shows all requests", async () => {
    mockFetch({
      requests: [
        { id: "req-1", state: "pending", actionClass: "write", actionTarget: "src/main.ts", risk: "medium", requestedAt: new Date().toISOString() },
        { id: "req-2", state: "approved", actionClass: "delete", actionTarget: "tmp/", risk: "high", requestedAt: new Date().toISOString(), reason: "cleanup" },
      ],
    });
    const code = await approvalCommandFromCli({ json: false }, ["approval", "list"]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("req-1");
    expect(out).toContain("req-2");
    expect(out).toContain("pending");
    expect(out).toContain("approved");
  });

  it("2. show renders a single request", async () => {
    mockFetch({
      request: { id: "req-1", state: "pending", actionClass: "write", actionTarget: "src/main.ts", risk: "low", sessionId: "ses-1", requestedAt: new Date().toISOString() },
    });
    const code = await approvalCommandFromCli({ json: false }, ["approval", "show", "req-1"]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("req-1");
    expect(out).toContain("pending");
    expect(out).toContain("src/main.ts");
  });

  it("3. show returns 1 on unknown id", async () => {
    mockFetch("unknown approval request: req-missing", 404);
    const code = await approvalCommandFromCli({ json: false }, ["approval", "show", "req-missing"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("req-missing");
  });

  it("4. approve sends decision and prints success", async () => {
    mockFetch({ request: { id: "req-1", state: "approved", reason: "looks good" } });
    const code = await approvalCommandFromCli(
      { json: false, reason: "looks good" },
      ["approval", "approve", "req-1"],
    );
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Approved");
    expect(out).toContain("req-1");
    expect(out).toContain("looks good");
  });

  it("5. reject sends decision and prints success", async () => {
    mockFetch({ request: { id: "req-1", state: "rejected" } });
    const code = await approvalCommandFromCli({ json: false }, ["approval", "reject", "req-1"]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Rejected");
    expect(out).toContain("req-1");
  });

  it("6. approve returns 1 on 409 conflict", async () => {
    mockFetch("request is not pending", 409);
    const code = await approvalCommandFromCli({ json: false }, ["approval", "approve", "req-1"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("not in a pending state");
  });

  it("7. cancel returns 1 on missing id", async () => {
    const code = await approvalCommandFromCli({ json: false }, ["approval", "cancel"]);
    expect(code).toBe(2);
  });
});

describe("approval CLI — --json output", () => {
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
    vi.spyOn(console, "error").mockImplementation((msg) => errs.push(String(msg)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("list --json returns structured JSON", async () => {
    mockFetch({ requests: [{ id: "req-1", state: "pending" }] });
    const code = await approvalCommandFromCli({ json: true }, ["approval", "list"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.requests).toHaveLength(1);
  });

  it("show --json returns structured JSON", async () => {
    mockFetch({ request: { id: "req-1", state: "approved" } });
    const code = await approvalCommandFromCli({ json: true }, ["approval", "show", "req-1"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.request.id).toBe("req-1");
  });
});

describe("approval CLI — unknown subcommand", () => {
  let errs: string[];

  beforeEach(() => {
    errs = [];
    vi.spyOn(console, "error").mockImplementation((msg) => errs.push(String(msg)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 2 for unknown subcommand", async () => {
    const code = await approvalCommandFromCli({ json: false }, ["approval", "bogus"]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown approval subcommand");
  });

  it("returns 2 for removed grants subcommand", async () => {
    const code = await approvalCommandFromCli({ json: false }, ["approval", "grants", "list"]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown approval subcommand");
  });
});
