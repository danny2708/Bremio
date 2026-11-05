import { promises as fs } from "node:fs";
import path from "node:path";
import { estimateTokens } from "@bremio/harness";

/**
 * Playbooks: prompt-level skills (docs/17 P3-T3, Devin's "Playbooks").
 *
 * Distinct from Sprint 8's executable `Skill` (a function Bremio runs): a
 * playbook is guidance the agent reads. A run opts in by name; the content is
 * injected into every agent prompt of that run under a token budget.
 *
 * Source: `.bremio/skills/<name>.md` or `.bremio/skills/<name>/SKILL.md`.
 */
export const PLAYBOOK_DIR = path.join(".bremio", "skills");

/** Total budget for injected playbooks unless the caller sets another. */
export const DEFAULT_PLAYBOOK_TOKEN_BUDGET = 4000;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface Playbook {
  name: string;
  content: string;
  /** Path relative to the repository, for provenance in events. */
  source: string;
}

export interface PlaybookSelection {
  playbooks: Playbook[];
  /** Estimated tokens of the formatted injection (4 chars/token heuristic). */
  tokens: number;
  method: "estimated";
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Load the named playbooks. An unknown or empty playbook is an error, not a skip. */
export async function loadPlaybooks(repoPath: string, names: readonly string[]): Promise<Playbook[]> {
  const out: Playbook[] = [];
  for (const name of new Set(names)) {
    if (!NAME.test(name)) {
      throw new Error(`invalid playbook name "${name}": use 1-64 characters of A-Z, a-z, 0-9, _ or -`);
    }
    const candidates = [path.join(PLAYBOOK_DIR, `${name}.md`), path.join(PLAYBOOK_DIR, name, "SKILL.md")];
    let found: Playbook | undefined;
    for (const rel of candidates) {
      const content = await readIfExists(path.join(repoPath, rel));
      if (content !== undefined) {
        found = { name, content: content.trim(), source: rel.split(path.sep).join("/") };
        break;
      }
    }
    if (!found) {
      throw new Error(`playbook "${name}" not found (looked for ${candidates.map((c) => c.split(path.sep).join("/")).join(" and ")})`);
    }
    if (!found.content) throw new Error(`playbook "${name}" (${found.source}) is empty`);
    out.push(found);
  }
  return out;
}

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The text prepended to agent prompts. Content is escaped like memory
 * injection, so a playbook cannot close its own block and forge another.
 */
export function formatPlaybooks(playbooks: readonly Playbook[]): string {
  if (playbooks.length === 0) return "";
  const parts = [
    "<playbooks>",
    "The user attached these playbooks to this run. Follow them where they apply to your task; your task instructions below take precedence if they conflict.",
  ];
  for (const p of playbooks) {
    parts.push(`<playbook name="${escape(p.name)}" source="${escape(p.source)}">`, escape(p.content), "</playbook>");
  }
  parts.push("</playbooks>");
  return parts.join("\n");
}

/**
 * Load, measure and budget-check a run's playbooks. Over budget is a refusal
 * with the numbers, never a silent truncation: a half-injected playbook is a
 * different playbook than the one the user wrote.
 */
export async function selectPlaybooks(
  repoPath: string,
  names: readonly string[] | undefined,
  maxTokens = DEFAULT_PLAYBOOK_TOKEN_BUDGET,
): Promise<PlaybookSelection> {
  if (!names || names.length === 0) return { playbooks: [], tokens: 0, method: "estimated" };
  const playbooks = await loadPlaybooks(repoPath, names);
  const { tokens } = estimateTokens(formatPlaybooks(playbooks));
  if (tokens > maxTokens) {
    throw new Error(
      `playbooks ${playbooks.map((p) => p.name).join(", ")} need ~${tokens} tokens (estimated), over the ${maxTokens}-token playbook budget`,
    );
  }
  return { playbooks, tokens, method: "estimated" };
}
