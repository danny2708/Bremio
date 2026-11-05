import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHookManager } from "@bremio/orchestrator";
import { trustCommandFromCli } from "./trust";

const dirs: string[] = [];
beforeEach(async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-cli-trust-"));
  dirs.push(d);
  process.env.BREMIO_TRUST_FILE = path.join(d, "store.json");
});
afterEach(async () => {
  delete process.env.BREMIO_TRUST_FILE;
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function repoWithHooks(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-cli-trust-repo-"));
  dirs.push(repo);
  await fs.mkdir(path.join(repo, ".bremio"));
  await fs.writeFile(
    path.join(repo, ".bremio", "hooks.json"),
    JSON.stringify([{ id: "ok", point: "run:pre-merge", command: process.execPath, args: ["-e", "0"] }]),
  );
  return repo;
}

describe("bremio trust", () => {
  it("shows the file and trusts its bytes so the next load accepts it", async () => {
    const repo = await repoWithHooks();
    const lines: string[] = [];
    expect(await trustCommandFromCli({ repo }, ["trust", ".bremio/hooks.json"], (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain('"id":"ok"');
    expect(await loadHookManager(repo)).toBeDefined();
  });

  it("refuses files that are not trust-gated configs", async () => {
    const repo = await repoWithHooks();
    for (const file of [".bremio/skills/x.md", "../outside.json", undefined]) {
      const code = await trustCommandFromCli({ repo }, ["trust", ...(file ? [file] : [])], () => {});
      expect(code).toBe(2);
    }
    await expect(loadHookManager(repo)).rejects.toThrow(/not trusted/);
  });
});
