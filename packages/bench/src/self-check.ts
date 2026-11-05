import os from "node:os";
import type { LoadedCase, VerifyCommandResult } from "./schema";
import { runVerification } from "./verify";
import { installHidden, materializeCase, overlay, removeWorkdir } from "./workspace";

export interface SelfCheckResult {
  caseId: string;
  /** Must be false: an unsolved repo that already passes measures nothing. */
  baselinePasses: boolean;
  /** Must be true: a case its own reference cannot solve is broken. */
  solutionPasses: boolean;
  ok: boolean;
  baseline: VerifyCommandResult[];
  solution: VerifyCommandResult[];
}

/**
 * Prove a case is a fair test: the baseline repo fails hidden verification and
 * the repo plus the reference solution passes it.
 */
export async function selfCheckCase(
  benchCase: LoadedCase,
  workRoot: string = os.tmpdir(),
): Promise<SelfCheckResult> {
  const baselineDir = await materializeCase(benchCase, workRoot);
  const solutionDir = await materializeCase(benchCase, workRoot);
  try {
    await installHidden(benchCase, baselineDir);
    const baseline = await runVerification(baselineDir, benchCase.definition.verify);

    await overlay(benchCase.solutionDir, solutionDir);
    await installHidden(benchCase, solutionDir);
    const solution = await runVerification(solutionDir, benchCase.definition.verify);

    return {
      caseId: benchCase.definition.id,
      baselinePasses: baseline.ok,
      solutionPasses: solution.ok,
      ok: !baseline.ok && solution.ok,
      baseline: baseline.commands,
      solution: solution.commands,
    };
  } finally {
    await removeWorkdir(baselineDir).catch(() => {});
    await removeWorkdir(solutionDir).catch(() => {});
  }
}
