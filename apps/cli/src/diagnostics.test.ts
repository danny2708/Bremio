import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentCapabilities, AgentHealth } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { collectDiagnostics, exportDiagnostics, redactDeep } from "./diagnostics";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-diag-"));
  dirs.push(dir);
  return dir;
}

const CAPS: AgentCapabilities = {
  planning: true, structuredOutput: true, repositoryRead: true, repositoryWrite: true,
  shell: true, testing: true, browser: false, vision: false, resumableSessions: false,
};

/** A stand-in adapter so diagnostics never touch a real provider. */
class FakeAdapter implements AgentAdapter {
  constructor(readonly id: string, private readonly health: AgentHealth) {}
  readonly provider = "test";
  async getCapabilities() { return CAPS; }
  async listModels() { return []; }
  async healthCheck() { return this.health; }
  startRun(): AsyncIterable<AgentEvent> { throw new Error("not used"); }
  resumeRun(): AsyncIterable<AgentEvent> { throw new Error("not used"); }
  async cancelRun() {}
}

const adapters = [
  new FakeAdapter("claude", { status: "ok", detail: "ready" }),
  new FakeAdapter("codex", { status: "unavailable", detail: "not signed in" }),
];

describe("diagnostics bundle", () => {
  it("reports versions, runtime and adapter health", async () => {
    const diag = await collectDiagnostics({ version: "9.9.9-test", adapters });

    expect(diag.bremio.cliVersion).toBe("9.9.9-test");
    expect(diag.bremio.protocolVersion).toBeGreaterThan(0);
    expect(diag.runtime.platform).toBe(process.platform);
    expect(diag.runtime.node).toBe(process.version);
    expect(diag.adapters.map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(diag.adapters[1]?.status).toBe("unavailable");
  });

  it("says when the run database is absent rather than failing", async () => {
    const diag = await collectDiagnostics({
      version: "test",
      adapters,
      databasePath: path.join(await scratch(), "absent.db"),
    });

    expect(diag.storage.present).toBe(false);
  });

  it("redacts anything credential-shaped", () => {
    const redacted = redactDeep({
      token: "abc",
      nested: { apiKey: "k", Authorization: "Bearer x", port: 1234 },
      list: [{ password: "p", safe: "keep" }],
    }) as {
      token: string;
      nested: Record<string, unknown>;
      list: Array<Record<string, unknown>>;
    };

    expect(redacted.token).toBe("[redacted]");
    expect(redacted.nested.apiKey).toBe("[redacted]");
    expect(redacted.nested.Authorization).toBe("[redacted]");
    // Non-secret siblings must survive, or the bundle stops being useful.
    expect(redacted.nested.port).toBe(1234);
    expect(redacted.list[0]?.safe).toBe("keep");
  });

  it("writes a bundle carrying no daemon token", async () => {
    const target = path.join(await scratch(), "bundle.json");
    await exportDiagnostics({ version: "test", adapters, outputPath: target });

    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { daemon: Record<string, unknown> };

    // The bundle exists to be pasted into a bug report, so a leaked token here
    // would travel further than one in a log file.
    expect(raw).not.toMatch(/"token"\s*:\s*"(?!\[redacted\])/);
    expect(parsed.daemon).toBeDefined();
  });

  it("never includes prompts or repository contents", async () => {
    const target = path.join(await scratch(), "bundle.json");
    await exportDiagnostics({ version: "test", adapters, outputPath: target });
    const raw = await fs.readFile(target, "utf8");

    // Someone reporting a daemon problem should not have to publish what they
    // were working on.
    expect(raw).not.toContain("\"prompt\"");
    expect(raw).not.toContain("\"finalSummary\"");
  });
});
