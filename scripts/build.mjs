import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

if (path.dirname(distDir) !== repoRoot || path.basename(distDir) !== "dist") {
  throw new Error(`refusing to clean unexpected build directory: ${distDir}`);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, "apps", "cli", "src", "index.ts")],
  outfile: path.join(distDir, "bremio.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  define: { __BREMIO_VERSION__: JSON.stringify(packageJson.version) },
  external: [
    "@anthropic-ai/claude-agent-sdk",
    "pino",
    "simple-git",
    "zod",
  ],
});

// The Antigravity adapter drives the installed `agy` CLI, so the bundle ships
// no Python sidecar or requirements file.

if (process.platform !== "win32") {
  await chmod(path.join(distDir, "bremio.js"), 0o755);
}

console.log(`Built Bremio ${packageJson.version} in ${distDir}`);
