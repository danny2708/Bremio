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
  try {
    await fs.rename(temporary, file);
  } catch (err) {
    // The temp file is this call's private garbage. Leaving it behind means
    // ~/.bremio accumulates one dead file per failed start, forever, with a
    // name nothing else ever looks at or cleans.
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
  await fs.chmod(file, 0o600).catch(() => {});
}

/**
 * Delete `daemon.json.<uuid>.tmp` files left by a start that died between
 * writing the temp file and renaming it into place.
 *
 * Nothing else ever reads these names, so a leaked one is invisible until the
 * directory is listed by hand. Startup is the safe moment to sweep: this
 * process holds the single-instance lock, so no other daemon owns a temp file
 * in flight.
 */
export async function cleanLeakedEndpointFiles(file = daemonEndpointPath()): Promise<number> {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let removed = 0;
  try {
    for (const entry of await fs.readdir(directory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
      await fs.rm(path.join(directory, entry), { force: true }).catch(() => {});
      removed += 1;
    }
  } catch {
    // The directory not being readable is not a reason to refuse to start.
  }
  return removed;
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
