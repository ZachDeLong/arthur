import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { getCheckers } from "../analysis/registry.js";
import { buildJsonReport } from "../analysis/finding-schema.js";
import "../analysis/checkers/index.js";

export interface CheckOptions {
  plan?: string;
  stdin?: boolean;
  project?: string;
  format?: "text" | "json";
  schema?: string;
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
    return new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
    });
  }

  return null;
}

/** Format checker results as a compact CI-friendly table. */
function formatTextOutput(
  checkerResults: { checker: { displayName: string }; result: { applicable: boolean; checked: number; hallucinated: number; hallucinations: { raw: string; suggestion?: string }[] } }[],
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Arthur Verification Report"));
  lines.push("");

  const skipped: string[] = [];

  for (const { checker, result } of checkerResults) {
    if (!result.applicable) {
      skipped.push(checker.displayName);
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

  if (skipped.length > 0) {
    lines.push("");
    lines.push(chalk.dim(`  Skipped: ${skipped.join(", ")}`));
  }

  const totalFindings = checkerResults.reduce(
    (sum, { result }) => sum + (result.applicable ? result.hallucinated : 0),
    0,
  );

  lines.push("");
  if (totalFindings === 0) {
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
  // 1. Load plan
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
    }
    return 1;
  }

  // 2. Validate project dir
  const projectDir = path.resolve(opts.project ?? ".");
  if (!fs.existsSync(projectDir)) {
    console.error(chalk.red(`Error: project directory not found: ${projectDir}`));
    return 1;
  }

  // 3. Run checkers
  const options: Record<string, string> = {};
  if (opts.schema) options.schemaPath = opts.schema;

  const checkerResults: { checker: ReturnType<typeof getCheckers>[number]; result: ReturnType<ReturnType<typeof getCheckers>[number]["run"]> }[] = [];

  for (const checker of getCheckers()) {
    const result = checker.run(planText, projectDir, options);
    checkerResults.push({ checker, result });
  }

  // 4. Output
  if (opts.format === "json") {
    const report = buildJsonReport(checkerResults, projectDir);
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTextOutput(checkerResults));
  }

  // 5. Exit code
  const totalFindings = checkerResults.reduce(
    (sum, { result }) => sum + (result.applicable ? result.hallucinated : 0),
    0,
  );
  return totalFindings > 0 ? 1 : 0;
}
