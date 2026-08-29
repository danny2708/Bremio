/**
 * Bundle the extension for the VS Code extension host (CommonJS, node).
 *
 * The protocol version and the extension version are inlined here rather than
 * imported. The extension deliberately depends on no `@bremio/*` package — the
 * extension host is shared with the editor — but the protocol version must
 * still have exactly one declaration, so it is read from the protocol package
 * at build time instead of being copied into the source.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const protocolPath = path.resolve(extensionDir, "../../packages/protocol/src/version.ts");
const packageJsonPath = path.resolve(extensionDir, "package.json");

const protocolSource = readFileSync(protocolPath, "utf8");
const protocolVersion = Number(
  /export const PROTOCOL_VERSION = (\d+)/.exec(protocolSource)?.[1],
);
if (!Number.isInteger(protocolVersion)) {
  throw new Error("could not read PROTOCOL_VERSION from @bremio/protocol");
}
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));

await build({
  entryPoints: [path.join(extensionDir, "src/extension.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(extensionDir, "dist/extension.js"),
  // VS Code supplies this at runtime; bundling it would break activation.
  external: ["vscode"],
  define: {
    __BREMIO_PROTOCOL_VERSION__: String(protocolVersion),
    __BREMIO_EXTENSION_VERSION__: JSON.stringify(version),
  },
  sourcemap: true,
  logLevel: "info",
});
console.log(`  protocol ${protocolVersion} · extension ${version}`);
