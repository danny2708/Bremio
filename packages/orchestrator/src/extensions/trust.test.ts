import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateRepositoryHook, loadHookManager } from "./hooks-config";
import { loadMcpManifests } from "./mcp-config";
import { trustConfig, trustStorePath, UntrustedConfigError } from "./trust";

const tmpDirs: string[] = [];
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-trust-store-"));
  tmpDirs.push(dir);
  process.env.BREMIO_TRUST_FILE = path.join(dir, "trusted-config.json");
});
afterEach(async () => {
  delete process.env.BREMIO_TRUST_FILE;
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const HOOKS = path.join(".bremio", "hooks.json");
const MCP = path.join(".bremio", "mcp-servers.json");

/** A veto hook: if it ever runs, the pre-merge evaluation is denied by "freeze". */
const VETO = [
  { id: "freeze", point: "run:pre-merge", command: process.execPath, args: ["-e", "process.exit(3)"] },
];

async function repoWith(file: string, content: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-trust-repo-"));
  tmpDirs.push(dir);
  await fs.mkdir(path.join(dir, ".bremio"), { recursive: true });
  await fs.writeFile(path.join(dir, file), JSON.stringify(content));
  return dir;
}

describe("repository config trust (docs/17 P3 follow-up)", () => {
  it("refuses a hooks file nobody trusted — a committed or agent-written file never runs", async () => {
    const repo = await repoWith(HOOKS, VETO);
    await expect(loadHookManager(repo)).rejects.toBeInstanceOf(UntrustedConfigError);

    const result = await evaluateRepositoryHook(repo, "run:pre-merge", {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not trusted for this repository/);
    expect(result.reason).toMatch(/bremio trust \.bremio\/hooks\.json/);
  });

  it("honours the exact bytes that were trusted", async () => {
    const repo = await repoWith(HOOKS, VETO);
    await trustConfig(repo, HOOKS);
    const manager = await loadHookManager(repo);
    expect(manager).toBeDefined();
    const result = await evaluateRepositoryHook(repo, "run:pre-merge", {});
    expect(result).toMatchObject({ allowed: false, deniedBy: "freeze" });
  });

  it("revokes trust when the file changes after it was trusted", async () => {
    const repo = await repoWith(HOOKS, VETO);
    await trustConfig(repo, HOOKS);
    await fs.writeFile(
      path.join(repo, HOOKS),
      JSON.stringify([{ ...VETO[0], args: ["-e", "require('fs').writeFileSync('pwned','x')"] }]),
    );
    await expect(loadHookManager(repo)).rejects.toThrow(/changed since it was trusted/);
  });

  it("scopes trust to one repository", async () => {
    const trusted = await repoWith(HOOKS, VETO);
    await trustConfig(trusted, HOOKS);
    const other = await repoWith(HOOKS, VETO);
    await expect(loadHookManager(other)).rejects.toBeInstanceOf(UntrustedConfigError);
  });

  it("applies the same rule to the MCP manifest, whose entries are commands", async () => {
    const manifest = [{ id: "docs", name: "docs", transport: "stdio", command: "node", args: [] }];
    const repo = await repoWith(MCP, manifest);
    await expect(loadMcpManifests(repo)).rejects.toBeInstanceOf(UntrustedConfigError);
  });

  it("keeps the trust store outside the workspace and private to the user", async () => {
    const repo = await repoWith(HOOKS, VETO);
    await trustConfig(repo, HOOKS);
    const store = trustStorePath();
    expect(path.relative(repo, store).startsWith("..")).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(store)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on a corrupt trust store instead of resetting it", async () => {
    const repo = await repoWith(HOOKS, VETO);
    await fs.writeFile(trustStorePath(), "{not json");
    await expect(loadHookManager(repo)).rejects.toThrow();
    expect(await fs.readFile(trustStorePath(), "utf8")).toBe("{not json");
  });
});
