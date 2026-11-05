import { promises as fs } from "node:fs";
import path from "node:path";
import { HOOKS_FILE, MCP_MANIFEST_FILE, trustConfig } from "@bremio/orchestrator";

/** Only files that make Bremio spawn host processes are trust-gated. */
const TRUSTABLE = new Map<string, string>([
  [HOOKS_FILE.split(path.sep).join("/"), HOOKS_FILE],
  [MCP_MANIFEST_FILE.split(path.sep).join("/"), MCP_MANIFEST_FILE],
]);

export const TRUST_USAGE = `trust     record a reviewed repository config file as trusted
  bremio trust <.bremio/hooks.json|.bremio/mcp-servers.json> [--repo <path>]
  Prints the file, then trusts its exact bytes for this repository. Any later
  change (pull, agent, edit) makes Bremio refuse it until trusted again.`;

export async function trustCommandFromCli(
  values: { repo?: string },
  positionals: string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  const requested = positionals[1]?.replace(/\\/g, "/").replace(/^\.\//, "");
  const relative = requested ? TRUSTABLE.get(requested) : undefined;
  if (!relative) {
    log(`usage: bremio trust <${[...TRUSTABLE.keys()].join("|")}> [--repo <path>]`);
    return 2;
  }
  const repoPath = path.resolve(values.repo ?? process.cwd());
  let text: string;
  try {
    text = await fs.readFile(path.join(repoPath, relative), "utf8");
  } catch (err) {
    log(`cannot read ${path.join(repoPath, relative)}: ${(err as Error).message}`);
    return 1;
  }
  log(`--- ${requested} (${repoPath})`);
  log(text.trimEnd());
  log("---");
  const digest = await trustConfig(repoPath, relative);
  log(`trusted sha256 ${digest} — every command above may now run on this machine.`);
  return 0;
}
