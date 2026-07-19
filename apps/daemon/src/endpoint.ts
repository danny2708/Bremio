import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Endpoint discovery for the daemon, mirroring the trust model Bremio already
 * relies on for AI-Quota-Tray: bind loopback on an ephemeral port, mint a token
 * per launch, and publish both to a file only this user can read.
 *
 * A caller must already be able to read the user's home directory — the same
 * boundary that protects the repos the daemon can write to.
 */

// The protocol version is declared once, in @bremio/protocol, so the daemon
// and the extension cannot drift apart on what it is.
export { MINIMUM_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "@bremio/protocol";

const EndpointSchema = z.object({
  port: z.number().int().positive().max(65535),
  token: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  daemonVersion: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});
export type DaemonEndpoint = z.infer<typeof EndpointSchema>;

export function daemonEndpointPath(home = os.homedir()): string {
  return path.join(home, ".bremio", "daemon.json");
}

export function mintToken(): string {
  return randomUUID();
}

export async function publishEndpoint(
  endpoint: DaemonEndpoint,
  file = daemonEndpointPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a reader never observes a half-written file, and mode
  // 0600 so the token is not world-readable on POSIX. (Windows ignores the
  // mode; there the user profile directory is the boundary.)
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(endpoint, null, 2), "utf8");
    // Flush before the rename: a crash between write and rename must not leave
    // a valid-looking file with no contents.
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function readEndpoint(
  file = daemonEndpointPath(),
): Promise<DaemonEndpoint | undefined> {
  try {
    const parsed = EndpointSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the discovery file, but only when it still describes this process.
 * A slow shutdown must not delete the file a newer daemon just published.
 */
export async function retractEndpoint(
  file = daemonEndpointPath(),
  pid = process.pid,
): Promise<void> {
  const current = await readEndpoint(file);
  if (current && current.pid !== pid) return;
  await fs.rm(file, { force: true }).catch(() => {});
}
