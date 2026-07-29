import { readFile } from "node:fs/promises";
import { McpDiscovery, type McpServerManifest } from "@bremio/adapter-sdk";
import { c } from "./ui";

function printUsage(): void {
  console.log(`Usage: bremio mcp <subcommand> [options]

Subcommands:
  discover  --manifest <file>   Connect to MCP servers and list their tools
  list                           Alias for discover (uses .bremio/mcp-servers.json)

Options:
  --manifest <file>   Path to a JSON file containing an array of McpServerManifest
  --json              Output as JSON`);
}

async function discoverCommand(options: {
  manifest?: string;
  json?: boolean;
}): Promise<number> {
  let manifests: McpServerManifest[];

  if (options.manifest) {
    const content = await readFile(options.manifest, "utf-8");
    manifests = JSON.parse(content) as McpServerManifest[];
  } else {
    try {
      const content = await readFile(".bremio/mcp-servers.json", "utf-8");
      manifests = JSON.parse(content) as McpServerManifest[];
    } catch {
      console.error(c.red("error: no --manifest given and .bremio/mcp-servers.json not found"));
      console.log(c.dim("  Create .bremio/mcp-servers.json or pass --manifest <file>"));
      return 1;
    }
  }

  if (!Array.isArray(manifests) || manifests.length === 0) {
    console.error(c.red("error: no MCP server manifests provided"));
    return 1;
  }

  const discovery = new McpDiscovery();
  const results = await discovery.discover(manifests);

  if (results.length === 0) {
    console.log(c.yellow("No MCP servers could be reached."));
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return 0;
  }

  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log(` ${c.bold("MCP servers discovered")}  ${c.dim(String(results.length))}`);
  console.log(line);

  for (const r of results) {
    console.log(`\n  ${c.cyan(r.serverName)} ${c.dim(`v${r.serverVersion}`)}`);
    console.log(`  ${c.dim(r.manifest.id)}`);

    if (r.tools.length > 0) {
      console.log(`    ${c.bold("Tools:")}`);
      for (const t of r.tools) {
        const desc = t.description ? ` — ${t.description}` : "";
        console.log(`      ${c.green(t.name)}${c.dim(desc)}`);
      }
    }

    if (r.resources.length > 0) {
      console.log(`    ${c.bold("Resources:")}`);
      for (const res of r.resources) {
        console.log(`      ${c.green(res.uri)}${c.dim(` (${res.name})`)}`);
      }
    }

    if (r.prompts.length > 0) {
      console.log(`    ${c.bold("Prompts:")}`);
      for (const p of r.prompts) {
        console.log(`      ${c.green(p.name)}`);
      }
    }
  }

  console.log(`\n${line}\n`);
  return 0;
}

export async function mcpCommandFromCli(
  values: Record<string, unknown>,
  positionals: string[],
): Promise<number> {
  const subCommand = positionals[1];

  if (!subCommand || subCommand === "--help" || subCommand === "-h" || values.help) {
    printUsage();
    return 0;
  }

  const json = values.json === true;

  if (subCommand === "discover" || subCommand === "list") {
    return discoverCommand({
      manifest: values.manifest as string | undefined,
      json,
    });
  }

  console.error(c.red(`error: unknown mcp subcommand '${subCommand}'`));
  printUsage();
  return 2;
}
