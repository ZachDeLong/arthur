import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { buildJsonReport } from "../analysis/finding-schema.js";
import { buildSarifReport } from "../analysis/sarif.js";
import type { CheckerInput } from "../analysis/registry.js";
import {
  evaluateCoverageGate,
  runAllCheckers,
  type CheckerRun,
  type CheckerCoverageSummary,
  type CoverageGateResult,
  type SkippedChecker,
} from "../analysis/run-all.js";
import {
  resolveArthurCheckPolicy,
  type CoverageMode,
} from "../config/arthur-check.js";
import { resolveDiffFiles } from "../diff/resolver.js";
import "../analysis/checkers/index.js";

export interface CheckOptions {
  plan?: string;
  stdin?: boolean;
  diff?: string;
  staged?: boolean;
  untracked?: boolean;
  project?: string;
  format?: "text" | "json" | "sarif";
  schema?: string;
  includeExperimental?: boolean;
  strict?: boolean;
  minCheckedRefs?: number;
  coverageMode?: CoverageMode;
  quiet?: boolean;
}

interface CheckScope {
  mode: "plan" | "diff";
  input?: "file" | "stdin";
  planFile?: string;
  diffRef?: string;
  staged?: boolean;
  includeUntracked?: boolean;
  files?: Array<{
    path: string;
    status?: string;
    changedLines: number;
  }>;
}

/** Load plan text from file or stdin (never interactive). */
async function loadPlanText(opts: CheckOptions): Promise<string | null> {
  // Explicit file
  if (opts.plan) {
    const resolved = path.resolve(opts.plan);
    if (!fs.existsSync(resolved)) {
      console.error(chalk.red(`Error: plan file not found: ${resolved}`));
      return null;
    }
    return fs.readFileSync(resolved, "utf-8");
  }

  // Explicit --stdin or piped stdin
  if (opts.stdin || !process.stdin.isTTY) {
    const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10MB
    return new Promise((resolve) => {
      let data = "";
      let bytes = 0;
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk, "utf-8");
        if (bytes > MAX_STDIN_BYTES) {
          process.stdin.destroy();
          console.error(chalk.red(`Error: stdin input exceeds ${MAX_STDIN_BYTES / 1024 / 1024}MB limit`));
          resolve(null);
          return;
        }
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
    });
  }

  return null;
}

/** Format checker results as a compact CI-friendly table. */
function formatTextOutput(
  checkerResults: CheckerRun[],
  skippedCheckers: SkippedChecker[],
  coverageGate: CoverageGateResult,
  includeExperimental: boolean,
  coverage: CheckerCoverageSummary,
  scope: CheckScope,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Arthur Verification Report"));
  lines.push("");
  lines.push(chalk.dim(`  Experimental checkers: ${includeExperimental ? "enabled" : "disabled"}`));
  if (scope.mode === "diff") {
    const diffMode = scope.staged ? "staged index" : `working tree vs ${scope.diffRef}`;
    lines.push(chalk.dim(`  Scope: ${diffMode}, ${scope.files?.length ?? 0} relevant file(s)`));
  } else {
    lines.push(chalk.dim(`  Scope: plan from ${scope.input}${scope.planFile ? ` (${scope.planFile})` : ""}`));
  }

  for (const { checker, result } of checkerResults) {
    if (!result.applicable) {
      continue;
    }

    const errors = result.hallucinations.filter((finding) => finding.severity !== "warning").length;
    const warnings = result.hallucinations.length - errors;
    const status = errors > 0 ? chalk.red("✗") : warnings > 0 ? chalk.yellow("!") : chalk.green("✓");
    const count = `${result.checked} checked`;
    const outcome = errors === 0 && warnings === 0
      ? chalk.green("pass")
      : errors > 0
        ? chalk.red(`${errors} error${errors === 1 ? "" : "s"}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`)
        : chalk.yellow(`${warnings} warning${warnings === 1 ? "" : "s"}`);

    lines.push(`  ${status} ${checker.displayName.padEnd(26)} ${count.padEnd(14)} ${outcome}`);

    // Show individual findings indented
    for (const h of result.hallucinations) {
      const location = h.location
        ? `${h.location.path}:${h.location.line}:${h.location.column} `
        : "";
      const detail = h.suggestion
        ? `${location}${h.raw} ${chalk.dim(`(${h.suggestion})`)}`
        : `${location}${h.raw}`;
      lines.push(`      ${h.severity === "warning" ? chalk.yellow("warning:") : ""} ${detail}`.trimEnd());
    }
  }

  if (skippedCheckers.length > 0) {
    lines.push("");
    lines.push(chalk.dim("  Skipped / not applicable:"));
    for (const skipped of skippedCheckers) {
      lines.push(chalk.dim(`    - ${skipped.checker.displayName}: ${skipped.reason}`));
    }
  }

  if (coverage.mode === "source") {
    lines.push("");
    lines.push(chalk.dim(
      `  Diff checker support: ${coverage.sourceModeSupported.length}/${coverage.selectedCheckers.length} selected checker(s)`,
    ));
  }

  if (coverageGate.mode === "off") {
    lines.push("");
    lines.push(chalk.dim("  Coverage gate: off"));
  } else if (coverageGate.triggered) {
    lines.push("");
    const message = `  Coverage gate ${coverageGate.mode.toUpperCase()} (min ${coverageGate.minCheckedRefs}) — ${coverageGate.message}`;
    if (coverageGate.mode === "fail") {
      lines.push(chalk.red(message));
    } else {
      lines.push(chalk.yellow(message));
    }
  } else {
    lines.push("");
    lines.push(chalk.green(`  Coverage gate ${coverageGate.mode} (min ${coverageGate.minCheckedRefs}) — pass`));
  }

  const findings = checkerResults.flatMap(({ result }) => result.hallucinations);
  const totalErrors = findings.filter((finding) => finding.severity !== "warning").length;
  const totalWarnings = findings.length - totalErrors;

  lines.push("");
  if (totalErrors === 0 && totalWarnings === 0 && coverageGate.mode === "fail" && coverageGate.triggered) {
    lines.push(chalk.red("  0 finding(s), but coverage gate failed."));
  } else if (totalErrors === 0 && totalWarnings === 0 && coverageGate.triggered) {
    lines.push(chalk.yellow("  0 finding(s), but coverage is low."));
  } else if (totalErrors === 0 && totalWarnings === 0) {
    lines.push(chalk.green("  0 finding(s) in the references Arthur checked."));
  } else if (totalErrors === 0) {
    lines.push(chalk.yellow(`  0 errors, ${totalWarnings} warning(s).`));
  } else {
    lines.push(chalk.red(`  ${totalErrors} error(s), ${totalWarnings} warning(s). Fix the invalid references above.`));
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Run arthur check — standalone CLI entry point.
 * Returns 0 (clean) or 1 (findings or error).
 */
export async function runCheck(opts: CheckOptions): Promise<number> {
  // 1. Mutual exclusion
  if (opts.diff && opts.plan) {
    console.error(chalk.red("Error: Cannot use --diff and --plan together."));
    return 1;
  }

  if (opts.format && !["text", "json", "sarif"].includes(opts.format)) {
    console.error(chalk.red(`Error: unsupported output format: ${opts.format}`));
    return 1;
  }

  // 2. Validate project dir
  const projectDir = path.resolve(opts.project ?? ".");
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    console.error(chalk.red(`Error: project directory not found: ${projectDir}`));
    return 1;
  }

  // 3. Build CheckerInput
  let input: CheckerInput;
  let scope: CheckScope;
  let emptyDiff = false;

  if (opts.diff) {
    // Diff mode — resolve changed files from git
    try {
      const files = resolveDiffFiles(projectDir, opts.diff, {
        staged: opts.staged,
        includeUntracked: opts.untracked,
      });
      scope = {
        mode: "diff",
        diffRef: opts.diff,
        staged: opts.staged ?? false,
        includeUntracked: opts.untracked !== false,
        files: files.map((file) => ({
          path: file.path,
          status: file.status,
          changedLines: file.changedLines?.length ?? 0,
        })),
      };
      if (files.length === 0) {
        emptyDiff = true;
        if (opts.format !== "json" && opts.format !== "sarif") {
          if (!opts.quiet) console.log(chalk.green("No changed source files found in diff."));
          return 0;
        }
      }
      input = { mode: "source", text: files.map(f => f.content).join("\n"), files };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error resolving diff: ${msg}`));
      return 1;
    }
  } else {
    // Plan mode — load plan text
    const planText = await loadPlanText(opts);
    if (!planText) {
      if (!opts.plan && !opts.stdin && process.stdin.isTTY) {
        console.error(chalk.red("Error: no plan provided."));
        console.error("");
        console.error("Usage:");
        console.error("  arthur check --plan <file> [--project <dir>]");
        console.error("  arthur check --diff <ref> [--staged] [--project <dir>]");
        console.error("  cat plan.md | arthur check [--project <dir>]");
        console.error("");
        console.error("Options:");
        console.error("  --plan <file>      Path to plan file");
        console.error("  --stdin            Read plan from stdin");
        console.error("  --project <dir>    Project directory (default: cwd)");
        console.error("  --format <format>  Output format: text|json|sarif (default: text)");
        console.error("  --schema <file>    Path to Prisma schema file");
        console.error("  --include-experimental  Include experimental checkers");
        console.error("  --strict           Fail when coverage is below the configured threshold");
        console.error("  --min-checked-refs <n> Minimum refs that must be checked");
        console.error("  --coverage-mode <mode> Coverage gate: off|warn|fail");
      }
      return 1;
    }
    input = { mode: "plan", text: planText };
    scope = {
      mode: "plan",
      input: opts.plan ? "file" : "stdin",
      planFile: opts.plan ? path.basename(opts.plan) : undefined,
    };
  }

  // 4. Run checkers
  const options: Record<string, string> = {};
  if (opts.schema) options.schemaPath = opts.schema;
  const policy = resolveArthurCheckPolicy(projectDir, {
    includeExperimental: opts.includeExperimental,
    strict: opts.strict,
    minCheckedRefs: opts.minCheckedRefs,
    coverageMode: opts.coverageMode,
  });
  const summary = runAllCheckers(input, projectDir, {
    includeExperimental: policy.includeExperimental,
    checkerOptions: options,
  });
  const coverageGate: CoverageGateResult = emptyDiff
    ? {
        mode: policy.coverageMode,
        minCheckedRefs: policy.minCheckedRefs,
        triggered: false,
        message: "No changed source files; coverage gate is not applicable.",
      }
    : evaluateCoverageGate(
        summary.totalChecked,
        policy.minCheckedRefs,
        policy.coverageMode,
      );
  const coverageFailed = coverageGate.mode === "fail" && coverageGate.triggered;

  // 5. Output
  if (opts.format === "json" || opts.format === "sarif") {
    const report = buildJsonReport(summary.checkerResults, projectDir);
    if (opts.format === "sarif") {
      console.log(JSON.stringify(buildSarifReport(report), null, 2));
      return summary.totalErrors > 0 || coverageFailed ? 1 : 0;
    }
    const payload = {
      ...report,
      meta: {
        scope,
        includeExperimental: policy.includeExperimental,
        checkerCoverage: summary.coverage,
        coverageGate,
        skippedCheckers: summary.skippedCheckers.map((s) => ({
          checker: s.checker.id,
          displayName: s.checker.displayName,
          reason: s.reason,
        })),
      },
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (!(opts.quiet && summary.totalErrors === 0 && summary.totalWarnings === 0 && !coverageFailed)) {
    console.log(formatTextOutput(
      summary.checkerResults,
      summary.skippedCheckers,
      coverageGate,
      policy.includeExperimental,
      summary.coverage,
      scope,
    ));
  }

  // 6. Exit code
  return summary.totalErrors > 0 || coverageFailed ? 1 : 0;
}
