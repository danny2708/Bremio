import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { evaluate, type ControlMode } from "@bremio/policy";
import {
  isValidMcpServerId,
  type McpPermissionCheck,
  type McpServerManifest,
} from "@bremio/adapter-sdk";

/**
 * Where a project's MCP servers are declared. The same file `bremio mcp list`
 * reads (S8-T3). `.bremio/` is git-ignored by Bremio itself, so this is local
 * user configuration, not something a cloned repository can ship.
 */
export const MCP_MANIFEST_FILE = path.join(".bremio", "mcp-servers.json");

const TransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("sse"), url: z.string().url() }),
  z.object({ type: z.literal("streamable-http"), url: z.string().url() }),
]);

const ManifestSchema = z.object({
  id: z.string().refine(isValidMcpServerId, {
    message: "id must be 1-64 characters of A-Z, a-z, 0-9, _ or -",
  }),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: TransportSchema,
});

/** Parse and validate a manifest list. Throws with the offending entry named. */
export function parseMcpManifests(raw: unknown): McpServerManifest[] {
  const parsed = z.array(ManifestSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid MCP manifest at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "unknown error"}`,
    );
  }
  const seen = new Set<string>();
  for (const m of parsed.data) {
    if (seen.has(m.id)) throw new Error(`invalid MCP manifest: duplicate server id "${m.id}"`);
    seen.add(m.id);
  }
  return parsed.data as McpServerManifest[];
}

/** Read `<repo>/.bremio/mcp-servers.json`. A missing file is an empty list. */
export async function loadMcpManifests(repoPath: string): Promise<McpServerManifest[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(repoPath, MCP_MANIFEST_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseMcpManifests(JSON.parse(text));
}

/**
 * Resolve the servers a run opted into. Opt-in is by id and explicit: no
 * request means no servers, never "everything in the manifest". An unknown id
 * is an error rather than a skip — the user asked for a tool the run would
 * silently lack.
 */
export function selectMcpServers(
  manifests: readonly McpServerManifest[],
  requested: readonly string[] | undefined,
): McpServerManifest[] {
  if (!requested || requested.length === 0) return [];
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const selected: McpServerManifest[] = [];
  for (const id of new Set(requested)) {
    const m = byId.get(id);
    if (!m) {
      const known = [...byId.keys()].join(", ") || "none";
      throw new Error(`MCP server "${id}" is not declared in ${MCP_MANIFEST_FILE} (declared: ${known})`);
    }
    selected.push(m);
  }
  return selected;
}

/** The run's MCP policy as the per-call gate adapters consult. */
export function mcpPolicyGate(controlMode: ControlMode): (toolName: string) => McpPermissionCheck {
  return () => {
    const e = evaluate(controlMode, "mcp-tool");
    return { allowed: e.allowed, approvalRequired: e.approvalRequired, reason: e.reason };
  };
}

/**
 * Refuse a run that asked for MCP servers it could never use. Plan mode
 * prohibits MCP calls; approve mode requires a per-call approval that no
 * in-run surface can grant yet. Starting such a run would attach servers whose
 * every call is denied — refuse up front with the reason instead.
 */
export function assertMcpRequestUsable(controlMode: ControlMode, servers: readonly McpServerManifest[]): void {
  if (servers.length === 0) return;
  const e = evaluate(controlMode, "mcp-tool");
  if (!e.allowed) {
    throw new Error(`MCP servers were requested but ${e.reason}`);
  }
  if (e.approvalRequired !== "none") {
    throw new Error(
      `MCP servers were requested but ${controlMode} mode requires ${e.approvalRequired} approval for each MCP call, which runs cannot grant yet; use autopilot or drop --mcp`,
    );
  }
}
