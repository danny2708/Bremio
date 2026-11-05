import { promises as fs } from "node:fs";
import path from "node:path";
import { BenchCaseSchema, HIDDEN_DIR, type LoadedCase } from "./schema";

export class BenchCaseError extends Error {
  constructor(readonly caseDir: string, message: string) {
    super(`${path.basename(caseDir)}: ${message}`);
    this.name = "BenchCaseError";
  }
}

/** Every file under `dir`, as forward-slash paths relative to it. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}

async function isDir(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

/**
 * Load and validate one case directory. Structural rules are enforced here,
 * not by convention, because each one protects the benchmark's honesty:
 * hidden files must live under {@link HIDDEN_DIR} (so the runner can wipe a
 * planted copy), the repo must not already contain that directory, and the
 * prompt must not point the agent at the hidden tests.
 */
export async function loadCase(caseDir: string): Promise<LoadedCase> {
  const dir = path.resolve(caseDir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "case.json"), "utf8");
  } catch {
    throw new BenchCaseError(dir, "missing case.json");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new BenchCaseError(dir, `case.json is not JSON: ${(err as Error).message}`);
  }
  const parsed = BenchCaseSchema.safeParse(json);
  if (!parsed.success) {
    throw new BenchCaseError(dir, `invalid case.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const definition = parsed.data;
  if (definition.id !== path.basename(dir)) {
    throw new BenchCaseError(dir, `id "${definition.id}" must match its directory name`);
  }

  const repoDir = path.join(dir, "repo");
  const hiddenDir = path.join(dir, "hidden");
  const solutionDir = path.join(dir, "solution");
  for (const [name, p] of [["repo", repoDir], ["hidden", hiddenDir], ["solution", solutionDir]] as const) {
    if (!(await isDir(p))) throw new BenchCaseError(dir, `missing ${name}/ directory`);
  }

  const hiddenFiles = await listFiles(hiddenDir);
  if (hiddenFiles.length === 0) throw new BenchCaseError(dir, "hidden/ has no files");
  const stray = hiddenFiles.filter((f) => !f.startsWith(`${HIDDEN_DIR}/`));
  if (stray.length > 0) {
    throw new BenchCaseError(dir, `hidden files must live under hidden/${HIDDEN_DIR}/: ${stray.join(", ")}`);
  }
  const repoFiles = await listFiles(repoDir);
  if (repoFiles.length === 0) throw new BenchCaseError(dir, "repo/ has no files");
  if (repoFiles.some((f) => f.startsWith(`${HIDDEN_DIR}/`) || f.startsWith(".git/"))) {
    throw new BenchCaseError(dir, `repo/ must not contain ${HIDDEN_DIR}/ or .git/`);
  }
  if ((await listFiles(solutionDir)).length === 0) {
    throw new BenchCaseError(dir, "solution/ has no files");
  }
  if (definition.prompt.includes(HIDDEN_DIR) || /\bhidden\b/i.test(definition.prompt)) {
    throw new BenchCaseError(dir, "prompt must not reference hidden verification");
  }

  return { definition, dir, repoDir, hiddenDir, solutionDir };
}

/**
 * Load every case under `casesDir` (each subdirectory with a case.json), or
 * only `ids` — in which case an unknown id is an error, never a silent skip.
 */
export async function loadCases(casesDir: string, ids?: readonly string[]): Promise<LoadedCase[]> {
  const root = path.resolve(casesDir);
  if (!(await isDir(root))) throw new Error(`bench cases directory not found: ${root}`);
  const names = (await fs.readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (ids && ids.length > 0) {
    const missing = ids.filter((id) => !names.includes(id));
    if (missing.length > 0) throw new Error(`unknown bench case(s): ${missing.join(", ")}`);
    return Promise.all(ids.map((id) => loadCase(path.join(root, id))));
  }
  return Promise.all(names.map((name) => loadCase(path.join(root, name))));
}
