import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliPath } from "./cli-launcher";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function binDir(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-bin-"));
  dirs.push(dir);
  for (const file of files) await fs.writeFile(path.join(dir, file), "", "utf8");
  return dir;
}

const onWindows = process.platform === "win32";

describe("CLI resolution", () => {
  it.runIf(onWindows)("finds the .cmd shim npm actually installs", async () => {
    // npm i -g writes bremio.cmd but no bremio.exe, so a lookup that only
    // considers exact names reports the CLI missing on every Windows machine.
    const dir = await binDir(["bremio.cmd", "bremio.ps1", "bremio"]);
    const resolved = resolveCliPath("bremio", { PATH: dir });

    expect(resolved?.toLowerCase().endsWith(".cmd")).toBe(true);
  });

  it.runIf(onWindows)("prefers a real executable over the batch shim", async () => {
    const dir = await binDir(["bremio.cmd", "bremio.exe"]);
    const resolved = resolveCliPath("bremio", { PATH: dir, PATHEXT: ".EXE;.CMD" });

    expect(resolved?.toLowerCase().endsWith(".exe")).toBe(true);
  });

  it.runIf(onWindows)("still finds the shim when PATHEXT omits .CMD", async () => {
    const dir = await binDir(["bremio.cmd"]);
    expect(resolveCliPath("bremio", { PATH: dir, PATHEXT: ".EXE" })).toBeTruthy();
  });

  it("searches every PATH entry in order", async () => {
    const empty = await binDir([]);
    const real = await binDir([onWindows ? "bremio.cmd" : "bremio"]);
    const resolved = resolveCliPath("bremio", { PATH: [empty, real].join(path.delimiter) });

    expect(resolved?.startsWith(real)).toBe(true);
  });

  it("returns undefined when the CLI is genuinely absent", async () => {
    const dir = await binDir(["something-else"]);
    expect(resolveCliPath("bremio", { PATH: dir })).toBeUndefined();
  });

  it("accepts an explicit path from settings", async () => {
    const dir = await binDir([onWindows ? "bremio.cmd" : "bremio"]);
    const explicit = path.join(dir, "bremio");
    expect(resolveCliPath(explicit, {})).toBeTruthy();
  });

  it("rejects an explicit path that does not exist", () => {
    expect(resolveCliPath(path.join(os.tmpdir(), "nope", "bremio"), {})).toBeUndefined();
  });
});
