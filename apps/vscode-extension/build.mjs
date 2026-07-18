/** Bundle the extension for the VS Code extension host (CommonJS, node). */
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  // VS Code supplies this at runtime; bundling it would break activation.
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});
