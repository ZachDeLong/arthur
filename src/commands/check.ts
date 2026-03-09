import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { buildJsonReport } from "../analysis/finding-schema.js";
import type { CheckerInput } from "../analysis/registry.js";
import {
  evaluateCoverageGate,
  runAllCheckers,
  type CheckerRun,
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
  project?: string;
  format?: "text" | "json";
  schema?: string;
  includeExperimental?: boolean;
  strict?: boolean;
  minCheckedRefs?: number;
  coverageMode?: CoverageMode;
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
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Arthur Verification Report"));
  lines.push("");
  lines.push(chalk.dim(`  Experimental checkers: ${includeExperimental ? "enabled" : "disabled"}`));

  for (const { checker, result } of checkerResults) {
    if (!result.applicable) {
      continue;
    }

    const status = result.hallucinated === 0 ? chalk.green("✓") : chalk.red("✗");
    const count = `${result.checked} checked`;
    const outcome = result.hallucinated === 0
      ? chalk.green("pass")
      : chalk.red(`${result.hallucinated} finding${result.hallucinated === 1 ? "" : "s"}`);

    lines.push(`  ${status} ${checker.displayName.padEnd(26)} ${count.padEnd(14)} ${outcome}`);

    // Show individual findings indented
    for (const h of result.hallucinations) {
      const detail = h.suggestion
        ? `${h.raw} ${chalk.dim(`(did you mean ${h.suggestion}?)`)}`
        : h.raw;
      lines.push(`      ${detail}`);
    }
  }

  if (skippedCheckers.length > 0) {
    lines.push("");
    lines.push(chalk.dim("  Skipped / not applicable:"));
    for (const skipped of skippedCheckers) {
      lines.push(chalk.dim(`    - ${skipped.checker.displayName}: ${skipped.reason}`));
    }
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

  const totalFindings = checkerResults
    .filter(({ result }) => result.applicable)
    .reduce((sum, { result }) => sum + result.hallucinated, 0);

  lines.push("");
  if (totalFindings === 0 && coverageGate.mode === "fail" && coverageGate.triggered) {
    lines.push(chalk.red("  0 finding(s), but coverage gate failed."));
  } else if (totalFindings === 0 && coverageGate.triggered) {
    lines.push(chalk.yellow("  0 finding(s), but coverage is low."));
  } else if (totalFindings === 0) {
    lines.push(chalk.green("  0 finding(s). All references verified."));
  } else {
    lines.push(chalk.red(`  ${totalFindings} finding(s). Fix the hallucinated references above.`));
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

  // 2. Validate project dir
  const projectDir = path.resolve(opts.project ?? ".");
  if (!fs.existsSync(projectDir)) {
    console.error(chalk.red(`Error: project directory not found: ${projectDir}`));
    return 1;
  }

  // 3. Build CheckerInput
  let input: CheckerInput;

  if (opts.diff) {
    // Diff mode — resolve changed files from git
    try {
      const files = resolveDiffFiles(projectDir, opts.diff, { staged: opts.staged });
      if (files.length === 0) {
        console.log(chalk.green("No changed source files found in diff."));
        return 0;
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
        console.error("  cat plan.md | arthur check [--project <dir>]");
        console.error("");
        console.error("Options:");
        console.error("  --plan <file>      Path to plan file");
        console.error("  --stdin            Read plan from stdin");
        console.error("  --project <dir>    Project directory (default: cwd)");
        console.error("  --format text|json Output format (default: text)");
        console.error("  --schema <file>    Path to Prisma schema file");
        console.error("  --include-experimental  Include experimental checkers");
        console.error("  --strict           Enable strict mode (includes experimental + coverage fail)");
        console.error("  --min-checked-refs <n> Minimum refs that must be checked");
        console.error("  --coverage-mode <mode> Coverage gate: off|warn|fail");
      }
      return 1;
    }
    input = { mode: "plan", text: planText };
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
  const coverageGate = evaluateCoverageGate(
    summary.totalChecked,
    policy.minCheckedRefs,
    policy.coverageMode,
  );

  // 5. Output
  if (opts.format === "json") {
    const report = buildJsonReport(summary.checkerResults, projectDir);
    const payload = {
      ...report,
      meta: {
        includeExperimental: policy.includeExperimental,
        coverageGate,
        skippedCheckers: summary.skippedCheckers.map((s) => ({
          checker: s.checker.id,
          displayName: s.checker.displayName,
          reason: s.reason,
        })),
      },
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatTextOutput(
      summary.checkerResults,
      summary.skippedCheckers,
      coverageGate,
      policy.includeExperimental,
    ));
  }

  // 6. Exit code
  const coverageFailed = coverageGate.mode === "fail" && coverageGate.triggered;
  return summary.totalFindings > 0 || coverageFailed ? 1 : 0;
}
