import type { CoverageMode } from "../config/arthur-check.js";
import { getCheckers, type CheckerDefinition, type CheckerInput, type CheckerResult } from "./registry.js";
import { clearImportCaches } from "./import-checker.js";
import { clearApiCaches } from "./package-api-checker.js";

export interface CheckerRun {
  checker: CheckerDefinition;
  result: CheckerResult;
}

export interface SkippedChecker {
  checker: CheckerDefinition;
  result: CheckerResult;
  reason: string;
}

export interface CheckerRunSummary {
  checkerResults: CheckerRun[];
  skippedCheckers: SkippedChecker[];
  totalChecked: number;
  totalFindings: number;
}

export interface CoverageGateResult {
  mode: CoverageMode;
  minCheckedRefs: number;
  triggered: boolean;
  message?: string;
}

interface RunAllOptions {
  includeExperimental?: boolean;
  checkerOptions?: Record<string, string>;
}

/** Run all selected checkers and return rollup totals + skipped checker details. */
export function runAllCheckers(
  input: CheckerInput,
  projectDir: string,
  options: RunAllOptions = {},
): CheckerRunSummary {
  // Belt-and-suspenders: clear module-level caches so stale data from a
  // previous request in this long-running MCP server process is discarded.
  clearImportCaches();
  clearApiCaches();

  // Create a request-scoped cache for checkers that opt into it.
  const scopedInput: CheckerInput = { ...input, cache: input.cache ?? new Map() };

  const checkerResults: CheckerRun[] = [];
  const skippedCheckers: SkippedChecker[] = [];
  let totalChecked = 0;
  let totalFindings = 0;

  for (const checker of getCheckers({
    includeExperimental: options.includeExperimental,
  })) {
    const result = checker.run(scopedInput, projectDir, options.checkerOptions);
    checkerResults.push({ checker, result });

    if (result.applicable) {
      totalChecked += result.checked;
      totalFindings += result.hallucinated;
    } else {
      skippedCheckers.push({
        checker,
        result,
        reason: result.notApplicableReason ?? "Not applicable",
      });
    }
  }

  return {
    checkerResults,
    skippedCheckers,
    totalChecked,
    totalFindings,
  };
}

/** Evaluate low-coverage gate status from total checked refs and configured minimum. */
export function evaluateCoverageGate(
  totalChecked: number,
  minCheckedRefs: number,
  mode: CoverageMode,
): CoverageGateResult {
  const min = Number.isFinite(minCheckedRefs)
    ? Math.max(0, Math.floor(minCheckedRefs))
    : 0;

  if (mode === "off" || min === 0) {
    return { mode, minCheckedRefs: min, triggered: false };
  }

  const triggered = totalChecked < min;
  if (!triggered) {
    return { mode, minCheckedRefs: min, triggered: false };
  }

  return {
    mode,
    minCheckedRefs: min,
    triggered: true,
    message: `Low coverage: ${totalChecked} ref(s) checked, minimum is ${min}.`,
  };
}
