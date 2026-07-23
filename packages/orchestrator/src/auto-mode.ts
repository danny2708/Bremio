import { evaluateCalibrationReadiness, type CalibrationPolicyInput } from "./calibration";
import type { LedgerEntry } from "./ledger";

export interface AutoModePolicy {
  preferTeamWhenReady: boolean;
}

export const DEFAULT_AUTO_MODE_POLICY: AutoModePolicy = {
  preferTeamWhenReady: true,
};

export interface AutoModeResult {
  mode: "single" | "team";
  reason: string;
}

export function resolveAutoMode(
  entries: readonly LedgerEntry[],
  policy: AutoModePolicy = DEFAULT_AUTO_MODE_POLICY,
  calibrationPolicyInput?: CalibrationPolicyInput,
): AutoModeResult {
  const readiness = evaluateCalibrationReadiness(entries, calibrationPolicyInput);

  if (readiness.status === "insufficient-evidence") {
    const detail = readiness.blockers.length > 0
      ? `calibration insufficient: ${readiness.blockers.join("; ")}`
      : "calibration gate has no evidence";
    return {
      mode: "single",
      reason: `auto selected Single — ${detail}`,
    };
  }

  if (policy.preferTeamWhenReady) {
    return {
      mode: "team",
      reason: "auto selected Team — calibration gate is ready",
    };
  }

  return {
    mode: "single",
    reason: "auto selected Single — preferTeamWhenReady policy is disabled",
  };
}
