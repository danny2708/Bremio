import { DaemonClient } from "@bremio/daemon-client";
import { c } from "./ui";

const USAGE = `
Usage: bremio memory <command> [options]

Commands:
  list              List memory entries
  accept <id>       Accept a memory proposal
  reject <id>       Reject a memory proposal

Options for list:
  --repo <path>     Filter by repository path
  --scope <scope>   Filter by scope (project, user)
`;

export async function memoryCommandFromCli(values: Values, positionals: string[]): Promise<number> {
  const subcommand = positionals[1];
  if (!subcommand) {
    console.log(USAGE);
    return 2;
  }

  const client = new DaemonClient(Number(process.env.BREMIO_DAEMON_PORT) || 9229);

  try {
    if (subcommand === "list") {
      const repo = values.repo;
      const scopes = values.scope ? (Array.isArray(values.scope) ? values.scope : [values.scope]) : [];
      const { memory } = await client.queryMemory({ repository: repo, scopes: scopes as any[] });

      if (memory.length === 0) {
        console.log("No memory entries found.");
        return 0;
      }

      for (const entry of memory) {
        console.log(c.cyan(entry.id));
        console.log(`  Title:      ${entry.title}`);
        console.log(`  Scope:      ${entry.scope}`);
        console.log(`  State:      ${entry.review?.state || "pending"}`);
        console.log(`  Tags:       ${entry.tags.join(", ") || "none"}`);
        if (entry.provenance) {
          console.log(`  Provenance: ${entry.provenance.sourceTask} (${entry.provenance.sourceRun})`);
        }
        console.log(`  Created:    ${new Date(entry.createdAt).toLocaleString()}`);
        const contentStr = entry.content;
        if (contentStr.length > 500) {
          console.log(`\n${contentStr.slice(0, 500)}...\n  [Truncated: ${contentStr.length} bytes total]\n`);
        } else {
          console.log(`\n${contentStr}\n`);
        }
      }
      return 0;
    }

    if (subcommand === "accept" || subcommand === "reject") {
      const id = positionals[2];
      if (!id) {
        console.error(c.red(`Error: <id> is required for ${subcommand}`));
        return 2;
      }
      
      const note = values.prompt;
      
      await client.reviewMemory(id, {
        state: subcommand === "accept" ? "approved" : "rejected",
        reviewer: process.env.USER || "cli",
        note,
      });
      
      console.log(c.green(`Memory ${id} ${subcommand}ed successfully.`));
      return 0;
    }

    console.error(c.red(`Unknown memory command: ${subcommand}`));
    console.log(USAGE);
    return 2;
  } catch (err) {
    console.error(c.red(`Error: ${(err as Error).message}`));
    return 1;
  }
}
