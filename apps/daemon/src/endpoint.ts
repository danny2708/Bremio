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

const EndpointSchema = z.object({
  port: z.number().int().positive().max(65535),
  token: z.string().min(1),
  pid: z.number().int().positive(),
  version: z.string().optional(),
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
  // Write-then-rename so a reader never observes a half-written file.
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(endpoint, null, 2), "utf8");
  await fs.rename(temporary, file);
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
 * Best-effort cleanup. Consumers must still confirm liveness by connecting:
 * the file outlives a crash, so its presence proves nothing.
 */
export async function retractEndpoint(file = daemonEndpointPath()): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => {});
}
