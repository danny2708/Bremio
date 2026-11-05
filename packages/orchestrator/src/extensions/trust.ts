import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Trust-on-digest for repository files that make Bremio spawn processes on
 * the host (`.bremio/hooks.json`, `.bremio/mcp-servers.json`).
 *
 * `.bremio/` is git-ignored by Bremio, but that does not make its contents the
 * local user's: a repository can commit `.bremio/hooks.json` before Bremio
 * ever writes its `.gitignore` (or force-add it), and an agent running with
 * `workspace-write` can create the file itself. Either way the next run would
 * execute those commands unsandboxed. So a file is honoured only when the
 * user has trusted its exact bytes for this repository; any change — by a
 * pull, an agent, or the user — needs a fresh `bremio trust`.
 *
 * The store lives in the user's home, outside every workspace, so an agent
 * confined to a worktree cannot trust its own file.
 */

const TrustStoreSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ sha256: z.string(), trustedAt: z.string() })),
});
type TrustStore = z.infer<typeof TrustStoreSchema>;

export function trustStorePath(): string {
  return process.env.BREMIO_TRUST_FILE ?? path.join(os.homedir(), ".bremio", "trusted-config.json");
}

export function configDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function entryKey(repoPath: string, relativeFile: string): Promise<string> {
  const repo = await fs.realpath(repoPath).catch(() => path.resolve(repoPath));
  return `${repo}::${relativeFile.split(path.sep).join("/")}`;
}

async function readStore(): Promise<TrustStore> {
  let text: string;
  try {
    text = await fs.readFile(trustStorePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw err;
  }
  const parsed = TrustStoreSchema.safeParse(JSON.parse(text));
  // A store we cannot read trusts nothing; it is never silently reset here.
  if (!parsed.success) throw new Error(`unreadable trust store ${trustStorePath()}`);
  return parsed.data;
}

export class UntrustedConfigError extends Error {
  constructor(
    readonly relativeFile: string,
    readonly sha256: string,
    readonly repoPath: string,
  ) {
    super(
      `${relativeFile} is not trusted for this repository (sha256 ${sha256.slice(0, 12)}…; ` +
        `new, or changed since it was trusted). Review it, then run ` +
        `\`bremio trust ${relativeFile.split(path.sep).join("/")} --repo ${repoPath}\``,
    );
    this.name = "UntrustedConfigError";
  }
}

/** Throws `UntrustedConfigError` unless these exact bytes were trusted for this repo. */
export async function assertTrustedConfig(
  repoPath: string,
  relativeFile: string,
  text: string,
): Promise<void> {
  const digest = configDigest(text);
  const store = await readStore();
  const entry = store.entries[await entryKey(repoPath, relativeFile)];
  if (entry?.sha256 !== digest) throw new UntrustedConfigError(relativeFile, digest, repoPath);
}

/** Record the file's current bytes as trusted. Returns the digest. */
export async function trustConfig(repoPath: string, relativeFile: string): Promise<string> {
  const text = await fs.readFile(path.join(repoPath, relativeFile), "utf8");
  const digest = configDigest(text);
  const store = await readStore();
  store.entries[await entryKey(repoPath, relativeFile)] = {
    sha256: digest,
    trustedAt: new Date().toISOString(),
  };
  const file = trustStorePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  return digest;
}
