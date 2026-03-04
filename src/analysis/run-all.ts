import type { CoverageMode } from "../config/arthur-check.js";
import { getCheckers, type CheckerDefinition, type CheckerInput, type CheckerResult } from "./registry.js";

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

function inferSkipReason(
  checker: CheckerDefinition,
  result: CheckerResult,
): string {
  if (result.notApplicableReason) return result.notApplicableReason;

  const analysis = result.rawAnalysis as Record<string, unknown> | undefined;

  switch (checker.id) {
    case "schema":
      return "No readable prisma/schema.prisma found";
    case "sqlSchema":
      return "No Drizzle or SQL schema files found";
    case "supabaseSchema":
      return "No Supabase generated types file found";
    case "imports":
      return "No package import refs found in plan";
    case "env":
      if (Array.isArray(analysis?.envFilesFound) && analysis.envFilesFound.length === 0) {
        return "No .env* files found in project";
      }
      return "No env var refs found in plan";
    case "types":
      return "No TypeScript type/member refs found in plan";
    case "routes":
      return "No Next.js App Router route files found";
    case "expressRoutes":
      if (analysis?.framework === "none") {
        return "Express/Fastify not detected in package.json";
      }
      return "No Express/Fastify routes indexed";
    case "packageApi":
      return "No package API refs could be validated";
    default:
      return "Not applicable";
  }
}

/** Run all selected checkers and return rollup totals + skipped checker details. */
export function runAllCheckers(
  input: CheckerInput,
  projectDir: string,
  options: RunAllOptions = {},
): CheckerRunSummary {
  const checkerResults: CheckerRun[] = [];
  const skippedCheckers: SkippedChecker[] = [];
  let totalChecked = 0;
  let totalFindings = 0;

  for (const checker of getCheckers({
    includeExperimental: options.includeExperimental,
  })) {
    const result = checker.run(input, projectDir, options.checkerOptions);
    checkerResults.push({ checker, result });

    if (result.applicable) {
      totalChecked += result.checked;
      totalFindings += result.hallucinated;
    } else {
      skippedCheckers.push({
        checker,
        result,
        reason: inferSkipReason(checker, result),
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
