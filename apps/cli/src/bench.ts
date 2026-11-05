import path from "node:path";
import {
  formatBenchReport,
  loadCases,
  runBench,
  selfCheckCase,
  type BenchCaseResult,
  type LoadedCase,
} from "@bremio/bench";
import { ReasoningLevelSchema } from "@bremio/protocol";
import { createCLIPluginManager, KNOWN_ADAPTER_IDS } from "./tui/data";
import { c } from "./ui";

/** The subset of parsed CLI values `bremio bench` reads. */
export interface BenchCliValues {
  mode?: string;
  agent?: string;
  lead?: string;
  worker?: string | string[];
  model?: string;
  reasoning?: string;
  timeout?: string;
  cases?: string;
  "cases-dir"?: string;
  "out-dir"?: string;
  compare?: string;
  keep?: boolean;
  json?: boolean;
}

export const BENCH_USAGE = `${c.bold("bench")}    measure task success on the fixed bremio-bench suite (docs/18)
  bremio bench run --mode single --agent <agent> [--cases a,b] [--timeout <s>] [--json]
  bremio bench run --mode team --lead <agent> [--worker <agent>] [--cases a,b] [--json]
  bremio bench report [<benchRunId>] [--compare <idA> <idB>] [--json]
  bremio bench check [--cases a,b]        self-check cases (no agent, no quota)
  --cases-dir <path>      Case directory (default: ./bench/cases).
  --out-dir <path>        Results directory (default: ./.bremio/bench).
  --keep                  Keep every case workdir, not only failed ones.
  Real runs spend provider quota: one full agent run per case.`;

function defaults(values: BenchCliValues): { casesDir: string; outputDir: string } {
  return {
    casesDir: path.resolve(values["cases-dir"] ?? path.join("bench", "cases")),
    outputDir: path.resolve(values["out-dir"] ?? path.join(".bremio", "bench")),
  };
}

function caseIds(values: BenchCliValues): string[] | undefined {
  const ids = values.cases?.split(",").map((s) => s.trim()).filter(Boolean);
  return ids && ids.length > 0 ? ids : undefined;
}

function workers(values: BenchCliValues): string[] {
  return values.worker ? (Array.isArray(values.worker) ? values.worker : [values.worker]) : [];
}

/** Validate `bench run` arguments; returns error strings (empty = valid). */
export function validateBenchRun(values: BenchCliValues): string[] {
  const errors: string[] = [];
  const known = [...KNOWN_ADAPTER_IDS].sort().join(", ");
  if (values.mode !== "single" && values.mode !== "team") {
    errors.push("--mode must be single or team");
  }
  if (values.mode === "single") {
    if (!values.agent) errors.push("--agent <agent> is required for single mode");
    else if (!KNOWN_ADAPTER_IDS.has(values.agent)) errors.push(`--agent must be one of: ${known}`);
    if (values.lead || workers(values).length) errors.push("--lead/--worker apply to team mode only");
  }
  if (values.mode === "team") {
    if (!values.lead) errors.push("--lead <agent> is required for team mode");
    else if (!KNOWN_ADAPTER_IDS.has(values.lead)) errors.push(`--lead must be one of: ${known}`);
    for (const w of workers(values)) {
      if (!KNOWN_ADAPTER_IDS.has(w)) errors.push(`--worker must be one of: ${known}`);
      if (w === values.lead) errors.push("--worker must differ from --lead");
    }
    if (values.agent) errors.push("--agent applies to single mode only; use --lead");
  }
  if (values.timeout !== undefined) {
    const n = Number(values.timeout);
    if (!Number.isInteger(n) || n <= 0) errors.push("--timeout must be a positive whole number of seconds");
  }
  if (values.reasoning !== undefined && !ReasoningLevelSchema.safeParse(values.reasoning).success) {
    errors.push(`--reasoning must be one of: ${ReasoningLevelSchema.options.join(", ")}`);
  }
  return errors;
}

function caseLine(r: BenchCaseResult, index: number, total: number): string {
  const glyph = r.resolved ? c.green("✓") : c.red("✗");
  const extra = r.error ? c.dim(`  ${r.error.slice(0, 120)}`) : "";
  return `${glyph} [${index + 1}/${total}] ${r.caseId} ${c.dim(`(${r.runStatus}, ${(r.wallTimeMs / 1000).toFixed(1)}s)`)}${extra}`;
}

async function benchRun(values: BenchCliValues): Promise<number> {
  const errors = validateBenchRun(values);
  if (errors.length > 0) {
    for (const e of errors) console.error(c.red(`error: ${e}`));
    return 2;
  }
  const { casesDir, outputDir } = defaults(values);
  let cases: LoadedCase[];
  try {
    cases = await loadCases(casesDir, caseIds(values));
  } catch (err) {
    console.error(c.red(`error: ${(err as Error).message}`));
    return 2;
  }

  const registry = (await createCLIPluginManager()).getRegistry();
  const controller = new AbortController();
  const onInterrupt = (): void => {
    if (controller.signal.aborted) process.exit(130);
    console.error(c.yellow("\n⚠ cancelling the current case (Ctrl+C again to force)…"));
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);

  const mode = values.mode as "single" | "team";
  if (!values.json) {
    console.error(c.dim(`bremio-bench: ${cases.length} case(s), ${mode} mode — this spends provider quota.`));
  }
  try {
    const result = await runBench({
      cases,
      mode,
      registry,
      ...(mode === "single" ? { agentId: values.agent as string } : { leadId: values.lead as string }),
      ...(mode === "team" && workers(values).length ? { workerIds: workers(values) } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.reasoning ? { reasoningLevel: ReasoningLevelSchema.parse(values.reasoning) } : {}),
      ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}),
      outputDir,
      keepAll: values.keep === true,
      signal: controller.signal,
      ...(values.json
        ? {}
        : {
            onCaseStart: (bc: LoadedCase, i: number, n: number) =>
              console.error(c.dim(`… [${i + 1}/${n}] ${bc.definition.id}`)),
            onCaseEnd: (r: BenchCaseResult, i: number, n: number) => console.error(caseLine(r, i, n)),
          }),
    });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n${formatBenchReport(result)}`);
      console.log(c.dim(`\nsaved ${path.join(outputDir, `${result.benchRunId}.json`)}`));
      for (const r of result.cases) {
        if (r.workdir) console.log(c.dim(`kept ${r.caseId}: ${r.workdir}`));
      }
    }
    return 0;
  } catch (err) {
    console.error(c.red(`error: ${(err as Error).message}`));
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

async function benchCheck(values: BenchCliValues): Promise<number> {
  const { casesDir } = defaults(values);
  let cases: LoadedCase[];
  try {
    cases = await loadCases(casesDir, caseIds(values));
  } catch (err) {
    console.error(c.red(`error: ${(err as Error).message}`));
    return 2;
  }
  let failed = 0;
  for (const bc of cases) {
    const r = await selfCheckCase(bc);
    if (r.ok) {
      console.log(`${c.green("✓")} ${r.caseId}`);
      continue;
    }
    failed += 1;
    const why = r.baselinePasses ? "baseline already passes" : "reference solution fails";
    console.log(`${c.red("✗")} ${r.caseId}  ${c.red(why)}`);
    const tail = (r.baselinePasses ? r.baseline : r.solution).at(-1)?.outputTail;
    if (tail) console.log(c.dim(tail.split("\n").slice(-10).map((l) => `    ${l}`).join("\n")));
  }
  console.log(`\n${cases.length - failed}/${cases.length} cases are fair tests`);
  return failed === 0 ? 0 : 1;
}

/** `bremio bench <run|report|check>`. */
export async function benchCommandFromCli(
  values: BenchCliValues,
  positionals: string[],
): Promise<number> {
  const sub = positionals[1];
  switch (sub) {
    case "run":
      return benchRun(values);
    case "check":
      return benchCheck(values);
    default:
      console.error(c.red(sub ? `unknown bench command: ${sub}` : "missing bench command"));
      console.log(BENCH_USAGE);
      return 2;
  }
}
