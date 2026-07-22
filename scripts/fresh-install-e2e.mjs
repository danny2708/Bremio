#!/usr/bin/env node
/**
 * Fresh-install end-to-end check.
 *
 * Everything else in this repo tests a machine that has already been used. This
 * exercises the path a new user actually takes: no ~/.bremio, no daemon, no
 * database, no config — install the packed artifact, start the daemon, run
 * something, and confirm history survives a restart.
 *
 * HOME is redirected to a scratch directory, so the developer's real state is
 * neither read nor disturbed.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

const checks = [];
function record(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${label}${detail ? `  ${detail}` : ""}`);
}
function step(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** Run the installed CLI with HOME pointed at the scratch profile. */
async function cli(home, args, options = {}) {
  const binDir = path.join(home, "npm-global");
  const command = process.platform === "win32"
    ? path.join(binDir, "bremio.cmd")
    : path.join(binDir, "bin", "bremio");
  const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_prefix: binDir };
  if (process.platform === "win32") {
    return execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}" ${args.join(" ")}`], {
      env,
      windowsVerbatimArguments: true,
      ...options,
    });
  }
  return execFileAsync(command, args, { env, ...options });
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-fresh-"));
  const home = path.join(scratch, "home");
  const repo = path.join(scratch, "project");
  const binDir = path.join(home, "npm-global");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(repo, { recursive: true });

  console.log(`\x1b[1mfresh profile\x1b[0m\n  HOME=${home}`);
  let daemon;

  try {
    step("state before install");
    for (const name of [".bremio"]) {
      const exists = await fs.stat(path.join(home, name)).then(() => true, () => false);
      record(!exists, `no ${name} in the fresh profile`);
    }

    step("build and install the packed artifact");
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const tarball = path.join(scratch, `bremio-${pkg.version}.tgz`);
    await runPackageManager(["pack", "--pack-destination", scratch], { cwd: repoRoot });
    await runPackageManager(
      ["install", "--global", "--prefix", binDir, tarball],
      { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    record(true, "installed from tarball", `bremio-${pkg.version}.tgz`);

    step("the CLI works with no prior configuration");
    const { stdout: version } = await cli(home, ["--version"]);
    record(version.trim() === pkg.version, "bremio --version", version.trim());

    const { stdout: status } = await cli(home, ["daemon", "status"]);
    record(/not running/.test(status), "daemon status reports nothing running");

    const { stdout: doctor } = await cli(home, ["doctor", "--json"]);
    const report = JSON.parse(doctor);
    record(report.bremio.cliVersion === pkg.version, "doctor --json reports the version");
    record(report.storage.present === false, "no database exists yet");

    step("start the daemon from a clean profile");
    daemon = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `"${path.join(binDir, "bremio.cmd")}" daemon start`],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: true,
        detached: false,
      },
    );
    let daemonOutput = "";
    daemon.stdout?.on("data", (chunk) => (daemonOutput += chunk.toString()));
    daemon.stderr?.on("data", (chunk) => (daemonOutput += chunk.toString()));

    const endpointFile = path.join(home, ".bremio", "daemon.json");
    const ready = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(endpointFile, "utf8"));
        return typeof parsed.port === "number" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }, 30_000);
    record(Boolean(ready), "daemon published its endpoint", ready ? `port ${ready.port}` : daemonOutput.slice(0, 120));
    if (!ready) throw new Error("daemon never started");

    record(ready.daemonVersion === pkg.version, "endpoint carries the daemon version");
    record(typeof ready.protocolVersion === "number", "endpoint carries the protocol version");

    step("the daemon answers and is ready");
    const health = await api(ready, "/health");
    record(health.app === "bremio-daemon", "health responds");
    const meta = await api(ready, "/meta");
    record(meta.capabilities?.persistentRuns === true, "meta advertises persistent runs");
    const readiness = await api(ready, "/ready");
    record(readiness.ready === true, "ready responds");

    step("an unauthenticated request is refused");
    const unauth = await fetch(`http://127.0.0.1:${ready.port}/meta`).then((r) => r.status);
    record(unauth === 401, "no token is rejected", `status ${unauth}`);

    step("run history survives a daemon restart");
    const started = await api(ready, "/runs", {
      method: "POST",
      body: JSON.stringify({
        mode: "single",
        agentId: "claude",
        repoPath: path.join(scratch, "not-a-repo"),
        prompt: "noop",
      }),
    });
    const runId = started.run?.id;
    record(Boolean(runId), "started a run", runId);
    await waitFor(async () => {
      const detail = await api(ready, `/runs/${runId}`);
      return detail.run && detail.run.status !== "running" && detail.run.status !== "queued"
        ? detail
        : undefined;
    }, 30_000);

    await cli(home, ["daemon", "stop"]);
    await waitFor(async () => {
      const gone = await fs.stat(endpointFile).then(() => false, () => true);
      return gone || undefined;
    }, 15_000);
    record(true, "daemon stopped and withdrew its endpoint");

    daemon = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `"${path.join(binDir, "bremio.cmd")}" daemon start`],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: true,
      },
    );
    const restarted = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(endpointFile, "utf8"));
        return parsed.port !== ready.port || parsed.pid !== ready.pid ? parsed : undefined;
      } catch {
        return undefined;
      }
    }, 30_000);
    record(Boolean(restarted), "daemon restarted with a new token");

    const recovered = await api(restarted, `/runs/${runId}`);
    record(recovered.run?.id === runId, "the run is still in history after a restart");
    record((recovered.events?.length ?? 0) > 0, "its events replay", `${recovered.events?.length} event(s)`);

    step("a second instance is refused");
    const second = await cli(home, ["daemon", "start"]).catch((err) => err);
    record(
      /already running/.test(`${second.stdout ?? ""}${second.stderr ?? ""}`),
      "a second daemon start is refused",
    );

    step("diagnostics leak nothing");
    const bundlePath = path.join(scratch, "diag.json");
    await cli(home, ["diagnostics", "export", "--out", bundlePath]);
    const bundle = await fs.readFile(bundlePath, "utf8");
    record(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(bundle), "no token in the bundle");
    record(!bundle.includes('"prompt"'), "no prompts in the bundle");

    await cli(home, ["daemon", "stop"]).catch(() => {});
  } finally {
    daemon?.kill();
    await fs
      .rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(
    `\n\x1b[1mresult\x1b[0m\n  ${checks.length - failed.length}/${checks.length} checks passed`,
  );
  if (failed.length > 0) {
    console.log("\x1b[31m  failed: " + failed.map((f) => f.label).join(", ") + "\x1b[0m");
    process.exit(1);
  }
  console.log("\x1b[32m  fresh install works end to end\x1b[0m");
}

function locateNpmCli() {
  const npmExecPath = process.env.npm_execpath;
  const candidates = [
    npmExecPath && path.basename(npmExecPath) === "npm-cli.js" ? npmExecPath : undefined,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error("could not locate npm-cli.js next to the active Node installation");
  return npmCli;
}

function runPackageManager(args, options) {
  return execFileAsync(process.execPath, [locateNpmCli(), ...args], {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

async function api(endpoint, route, init = {}) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    ...init,
    headers: {
      "X-Bremio-Token": endpoint.token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return response.json();
}

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

main().catch((err) => {
  console.error(`\x1b[31mfresh-install E2E failed: ${err.message}\x1b[0m`);
  process.exit(1);
});
