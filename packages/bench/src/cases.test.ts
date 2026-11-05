import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCase, loadCases } from "./cases";
import { HIDDEN_DIR, type LoadedCase } from "./schema";
import { selfCheckCase } from "./self-check";
import { resolvePython } from "./verify";

const CASES_DIR = fileURLToPath(new URL("../../../bench/cases", import.meta.url));

let cases: LoadedCase[];
let workRoot: string;

beforeAll(async () => {
  cases = await loadCases(CASES_DIR);
  workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-bench-selfcheck-"));
});

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

describe("seed suite shape", () => {
  it("has at least 12 cases covering every category and language", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const categories = new Set(cases.map((c) => c.definition.category));
    for (const category of ["bug-fix", "feature", "refactor", "test-writing", "multi-file", "docs"]) {
      expect(categories, category).toContain(category);
    }
    const languages = new Set(cases.map((c) => c.definition.language));
    expect(languages).toEqual(new Set(["javascript", "typescript", "python"]));
  });
});

// The self-check is the proof that each case measures something: an unsolved
// repo must fail its hidden verification and the reference solution must pass.
// Directory names come from disk so a new case is covered without editing this.
const caseIds = (await fs.readdir(CASES_DIR, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const hasPython = resolvePython() !== null;

describe("every case passes its self-check", () => {
  for (const id of caseIds) {
    const isPython = id.startsWith("py-");
    it.skipIf(isPython && !hasPython)(`${id}: baseline fails, solution passes`, async () => {
      const benchCase = cases.find((c) => c.definition.id === id) as LoadedCase;
      const result = await selfCheckCase(benchCase, workRoot);
      const detail = JSON.stringify({ baseline: result.baseline, solution: result.solution }, null, 2);
      expect(result.baselinePasses, `baseline unexpectedly passes\n${detail}`).toBe(false);
      expect(result.solutionPasses, `solution fails\n${detail}`).toBe(true);
    }, 60_000);
  }
});

describe("case loader refuses dishonest cases", () => {
  async function scratchCase(mutate: (dir: string) => Promise<void>): Promise<string> {
    const source = cases.find((c) => c.definition.id === "js-bugfix-range") as LoadedCase;
    const parent = await fs.mkdtemp(path.join(workRoot, "loader-"));
    const dir = path.join(parent, "js-bugfix-range");
    await fs.cp(source.dir, dir, { recursive: true });
    await mutate(dir);
    return dir;
  }

  it("accepts the unmodified case", async () => {
    const dir = await scratchCase(async () => {});
    await expect(loadCase(dir)).resolves.toMatchObject({ definition: { id: "js-bugfix-range" } });
  });

  it("rejects hidden files outside the hidden directory", async () => {
    const dir = await scratchCase(async (d) => {
      await fs.writeFile(path.join(d, "hidden", "stray.test.mjs"), "");
    });
    await expect(loadCase(dir)).rejects.toThrow(`hidden/${HIDDEN_DIR}/`);
  });

  it("rejects a repo that already ships the hidden directory", async () => {
    const dir = await scratchCase(async (d) => {
      await fs.mkdir(path.join(d, "repo", HIDDEN_DIR), { recursive: true });
      await fs.writeFile(path.join(d, "repo", HIDDEN_DIR, "x.mjs"), "");
    });
    await expect(loadCase(dir)).rejects.toThrow(/must not contain/);
  });

  it("rejects a prompt that points at the hidden tests", async () => {
    const dir = await scratchCase(async (d) => {
      const file = path.join(d, "case.json");
      const json = JSON.parse(await fs.readFile(file, "utf8"));
      json.prompt = `${json.prompt} Make the hidden tests pass.`;
      await fs.writeFile(file, JSON.stringify(json));
    });
    await expect(loadCase(dir)).rejects.toThrow(/prompt must not reference/);
  });

  it("rejects an id that does not match its directory", async () => {
    const dir = await scratchCase(async (d) => {
      const file = path.join(d, "case.json");
      const json = JSON.parse(await fs.readFile(file, "utf8"));
      json.id = "some-other-id";
      await fs.writeFile(file, JSON.stringify(json));
    });
    await expect(loadCase(dir)).rejects.toThrow(/must match its directory/);
  });

  it("names unknown case ids instead of skipping them", async () => {
    await expect(loadCases(CASES_DIR, ["js-bugfix-range", "nope"])).rejects.toThrow(/unknown bench case\(s\): nope/);
  });
});
