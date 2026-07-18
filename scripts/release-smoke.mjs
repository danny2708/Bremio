import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const scratch = await mkdtemp(path.join(os.tmpdir(), "bremio-release-smoke-"));

try {
  const pack = runPackageManager(["pack", "--json", "--pack-destination", scratch], repoRoot);
  const jsonStart = pack.stdout.indexOf("[");
  if (jsonStart < 0) throw new Error(`package manager returned invalid pack output: ${pack.stdout}`);
  const packResult = JSON.parse(pack.stdout.slice(jsonStart));
  const filename = packResult[0]?.filename;
  if (!filename) throw new Error(`package manager returned no tarball name: ${pack.stdout}`);
  const tarball = path.join(scratch, filename);

  await writeFile(
    path.join(scratch, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
    "utf8",
  );
  runPackageManager([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], scratch);

  const installedRoot = path.join(scratch, "node_modules", "bremio");
  for (const relative of [
    "dist/bremio.js",
    "dist/bremio.js.map",
    "dist/sidecar.py",
    "dist/antigravity-requirements.txt",
  ]) {
    if (!existsSync(path.join(installedRoot, relative))) {
      throw new Error(`packed artifact is missing ${relative}`);
    }
  }

  const bin = process.platform === "win32"
    ? path.join(scratch, "node_modules", ".bin", "bremio.cmd")
    : path.join(scratch, "node_modules", ".bin", "bremio");
  if (!existsSync(bin)) throw new Error(`package install did not create CLI shim: ${bin}`);
  const installedCli = path.join(installedRoot, "dist", "bremio.js");
  const version = run(process.execPath, [installedCli, "--version"], scratch).stdout.trim();
  if (version !== packageJson.version) {
    throw new Error(`installed CLI reported ${version}; expected ${packageJson.version}`);
  }
  const help = run(process.execPath, [installedCli, "--help"], scratch).stdout;
  if (!help.includes("provider-agnostic orchestrator")) {
    throw new Error("installed CLI help output is incomplete");
  }
  const doctorResult = run(process.execPath, [installedCli, "doctor"], scratch);
  if (doctorResult.stderr.includes("DEP0190")) {
    throw new Error("installed CLI doctor invoked a provider through shell:true");
  }
  const doctor = doctorResult.stdout;
  for (const adapter of ["claude", "codex", "antigravity"]) {
    if (!doctor.includes(adapter)) throw new Error(`doctor omitted ${adapter}`);
  }

  console.log(`PASS clean packed install: bremio ${version}`);
} finally {
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedScratch = path.resolve(scratch);
  if (path.dirname(resolvedScratch) === tempRoot && path.basename(resolvedScratch).startsWith("bremio-release-smoke-")) {
    await rm(resolvedScratch, { recursive: true, force: true });
  }
}

function runPackageManager(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  const candidates = [
    npmExecPath && path.basename(npmExecPath) === "npm-cli.js" ? npmExecPath : undefined,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) {
    throw new Error("could not locate npm-cli.js next to the active Node installation");
  }
  return run(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    shell: false,
    windowsHide: true,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}
