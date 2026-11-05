import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  HookManager,
  RUN_HOOK_POINTS,
  type HookContext,
  type HookEvaluationResult,
  type HookHandler,
  type HookPoint,
} from "@bremio/adapter-sdk";

/**
 * Lifecycle hooks a user configures for a repository (docs/17 P3-T2).
 *
 * Lives in `.bremio/`, which Bremio git-ignores, so it is the local user's
 * configuration — a cloned repository cannot ship hooks that run on someone
 * else's machine.
 */
export const HOOKS_FILE = path.join(".bremio", "hooks.json");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** Keeps a hook's stdin bounded; a hook needs the gist, not the whole prompt. */
const MAX_PROMPT_CHARS = 4000;

const HookDefinitionSchema = z.object({
  id: z.string().min(1).max(64),
  point: z.enum(RUN_HOOK_POINTS),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  priority: z.number().int().optional(),
  description: z.string().optional(),
});
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;

export function parseHookDefinitions(raw: unknown): HookDefinition[] {
  const parsed = z.array(HookDefinitionSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid ${HOOKS_FILE} at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

/**
 * Run one hook command. Contract (mirrors common agent-hook conventions):
 * the context arrives as JSON on stdin and in `BREMIO_HOOK_POINT`; exit 0
 * allows; any other exit vetoes, with the last stderr line as the reason.
 * A hook that cannot start, crashes or times out vetoes — a broken guard is
 * not a passed guard.
 */
export function commandHookHandler(def: HookDefinition, repoPath: string): HookHandler {
  return (context: HookContext) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (allow: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(allow ? { allow: true } : { allow: false, reason });
      };
      let stderr = "";
      const child = spawn(def.command, def.args, {
        cwd: repoPath,
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        env: { ...process.env, BREMIO_HOOK_POINT: def.point, BREMIO_HOOK_ID: def.id },
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(false, `hook "${def.id}" timed out after ${def.timeoutMs}ms`);
      }, def.timeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      child.on("error", (err) => finish(false, `hook "${def.id}" could not start: ${err.message}`));
      child.on("close", (code, signal) => {
        if (code === 0) return finish(true);
        const last = stderr.trim().split(/\r?\n/).at(-1);
        finish(false, last || `hook "${def.id}" exited with ${code ?? signal}`);
      });
      child.stdin.on("error", () => {
        // A hook that ignores stdin and exits early is fine; its exit code decides.
      });
      const payload = {
        ...context,
        ...(context.prompt ? { prompt: context.prompt.slice(0, MAX_PROMPT_CHARS) } : {}),
      };
      child.stdin.end(JSON.stringify(payload));
    });
}

/** Load `.bremio/hooks.json` into a HookManager. No file → no manager. */
export async function loadHookManager(repoPath: string): Promise<HookManager | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(repoPath, HOOKS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const defs = parseHookDefinitions(JSON.parse(text));
  if (defs.length === 0) return undefined;
  const manager = new HookManager();
  for (const def of defs) {
    manager.register({
      id: def.id,
      hookPoint: def.point,
      handler: commandHookHandler(def, repoPath),
      ...(def.priority !== undefined ? { priority: def.priority } : {}),
      ...(def.description ? { description: def.description } : {}),
    });
  }
  return manager;
}

/**
 * Evaluate one lifecycle point for a repository, for call sites outside a run
 * (apply, merge). A hooks file that cannot be read or parsed denies: the user
 * configured a guard, and an unreadable guard must not mean "no guard".
 */
export async function evaluateRepositoryHook(
  repoPath: string,
  point: HookPoint,
  context: HookContext,
): Promise<HookEvaluationResult> {
  let manager: HookManager | undefined;
  try {
    manager = await loadHookManager(repoPath);
  } catch (err) {
    return { allowed: false, reason: (err as Error).message, deniedBy: HOOKS_FILE };
  }
  if (!manager) return { allowed: true };
  return manager.evaluate(point, { ...context, hookPoint: point, repoPath });
}

/** One-line description of a veto, for errors and events. */
export function describeHookVeto(point: HookPoint, result: HookEvaluationResult): string {
  return `${point} hook${result.deniedBy ? ` "${result.deniedBy}"` : ""} vetoed: ${result.reason ?? "no reason given"}`;
}
