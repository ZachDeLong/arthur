import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Tier3EvaluationResult } from "../../harness/types.js";

const ORIGINAL_APP_TSX_LINES = 899;

function usage(): never {
  console.error("Usage: evaluate <arm-name> <workspace-dir> <output-dir>");
  console.error("");
  console.error("  <arm-name>      'vanilla' or 'arthur-assisted'");
  console.error("  <workspace-dir> Path to the workspace");
  console.error("  <output-dir>    Path to save results (e.g., bench/tier3/results/<ts>/vanilla)");
  process.exit(1);
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function tryRun(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Count lines in a file. */
function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf-8").split("\n").length;
}

/** Scan changed .ts/.tsx files for imports that don't resolve. */
function findHallucinatedImports(workspaceDir: string): string[] {
  const frontendDir = path.join(workspaceDir, "frontend");
  const srcDir = path.join(frontendDir, "src");
  const hallucinated: string[] = [];

  // Get all changed/added ts/tsx files
  let changedFiles: string[];
  try {
    const diff = run("git diff --name-only HEAD~1", workspaceDir);
    changedFiles = diff
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => f.startsWith("frontend/src/"));
  } catch {
    // If no commits to diff, scan all ts/tsx in frontend/src
    changedFiles = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules") {
          walk(path.join(dir, entry.name), rel);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          changedFiles.push(rel);
        }
      }
    };
    walk(srcDir, "frontend/src");
  }

  for (const file of changedFiles) {
    const absFile = path.join(workspaceDir, file);
    if (!fs.existsSync(absFile)) continue;

    const content = fs.readFileSync(absFile, "utf-8");
    const fileDir = path.dirname(absFile);

    // Match local imports (relative or @/ alias)
    const importRegex = /(?:import|from)\s+['"]([.@][^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      let resolved: string;

      if (importPath.startsWith("@/")) {
        // @/ alias resolves to src/
        resolved = path.join(srcDir, importPath.slice(2));
      } else {
        resolved = path.resolve(fileDir, importPath);
      }

      // Try resolving with extensions
      const extensions = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
      const found = extensions.some((ext) => fs.existsSync(resolved + ext));

      if (!found) {
        hallucinated.push(`${file}: ${importPath}`);
      }
    }
  }

  return hallucinated;
}

/** Compute composite score (0-100). */
function computeScore(result: Omit<Tier3EvaluationResult, "compositeScore">): number {
  // Build: 35 points (boolean)
  const buildScore = result.build.pass ? 35 : 0;

  // Hallucinated imports: 25 points (0 = full, 1-2 = half, 3+ = zero)
  const hCount = result.hallucinatedImports.count;
  const importScore = hCount === 0 ? 25 : hCount <= 2 ? 12.5 : 0;

  // Files extracted: 20 points (min(count/5, 1) * 20)
  const fileScore = Math.min(result.extractedFiles.total / 5, 1) * 20;

  // App.tsx reduction: 20 points (min(reduction%/50%, 1) * 20)
  const reductionScore = Math.min(result.appTsx.reductionPct / 50, 1) * 20;

  return Math.round((buildScore + importScore + fileScore + reductionScore) * 10) / 10;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) usage();

  const armName = args[0];
  const workspaceDir = path.resolve(args[1]);
  const outputDir = path.resolve(args[2]);

  const frontendDir = path.join(workspaceDir, "frontend");
  if (!fs.existsSync(frontendDir)) {
    console.error(chalk.red(`No frontend/ in workspace: ${workspaceDir}`));
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(chalk.cyan(`── Evaluating: ${armName} ──\n`));

  // 1. Build check
  console.log(chalk.dim("  Checking build..."));
  const buildResult = tryRun("npm run build", frontendDir);
  const buildErrors = buildResult.ok ? [] : buildResult.stderr.split("\n").filter(Boolean);
  console.log(
    buildResult.ok
      ? chalk.green("  ✓ Build passes")
      : chalk.red(`  ✗ Build failed (${buildErrors.length} error lines)`),
  );

  // 2. App.tsx line count
  const appTsxPath = path.join(frontendDir, "src", "App.tsx");
  const currentLines = countLines(appTsxPath);
  const reductionPct =
    ORIGINAL_APP_TSX_LINES > 0
      ? Math.round(((ORIGINAL_APP_TSX_LINES - currentLines) / ORIGINAL_APP_TSX_LINES) * 100 * 10) / 10
      : 0;
  console.log(chalk.dim(`  App.tsx: ${ORIGINAL_APP_TSX_LINES} → ${currentLines} lines (${reductionPct}% reduction)`));

  // 3. New files (hooks and components)
  let newFiles: string[] = [];
  try {
    const diffOutput = run("git diff --name-only --diff-filter=A HEAD~1", workspaceDir);
    newFiles = diffOutput.split("\n").filter(Boolean);
  } catch {
    // No baseline commit — compare against empty
  }
  const hooks = newFiles.filter((f) => f.includes("hooks/") && /\.(ts|tsx)$/.test(f));
  const components = newFiles.filter((f) => f.includes("components/") && /\.(ts|tsx)$/.test(f));
  console.log(chalk.dim(`  New files: ${newFiles.length} total (${hooks.length} hooks, ${components.length} components)`));

  // 4. Hallucinated imports
  console.log(chalk.dim("  Scanning imports..."));
  const hallucinatedImports = findHallucinatedImports(workspaceDir);
  if (hallucinatedImports.length > 0) {
    console.log(chalk.red(`  ✗ ${hallucinatedImports.length} hallucinated imports:`));
    for (const imp of hallucinatedImports) {
      console.log(chalk.red(`    - ${imp}`));
    }
  } else {
    console.log(chalk.green("  ✓ No hallucinated imports"));
  }

  // 5. Diff stats
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  try {
    const statOutput = run("git diff --stat HEAD~1", workspaceDir);
    const summaryLine = statOutput.split("\n").pop() ?? "";
    const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
    const insertMatch = summaryLine.match(/(\d+)\s+insertions?/);
    const deleteMatch = summaryLine.match(/(\d+)\s+deletions?/);
    filesChanged = filesMatch ? parseInt(filesMatch[1]) : 0;
    insertions = insertMatch ? parseInt(insertMatch[1]) : 0;
    deletions = deleteMatch ? parseInt(deleteMatch[1]) : 0;
  } catch {
    // No diff available
  }
  console.log(chalk.dim(`  Diff: ${filesChanged} files, +${insertions} -${deletions}`));

  // Build result object
  const partial = {
    arm: armName,
    build: { pass: buildResult.ok, errors: buildErrors },
    appTsx: {
      originalLines: ORIGINAL_APP_TSX_LINES,
      currentLines,
      reductionPct,
    },
    extractedFiles: {
      hooks,
      components,
      total: hooks.length + components.length,
    },
    hallucinatedImports: {
      count: hallucinatedImports.length,
      paths: hallucinatedImports,
    },
    diffStats: { filesChanged, insertions, deletions },
  };

  const result: Tier3EvaluationResult = {
    ...partial,
    compositeScore: computeScore(partial),
  };

  // Save evaluation
  const evalFile = path.join(outputDir, "evaluation.json");
  fs.writeFileSync(evalFile, JSON.stringify(result, null, 2));
  console.log(chalk.green(`\n✓ Evaluation saved: ${evalFile}`));

  // Save diff patch
  try {
    const patch = run("git diff HEAD~1", workspaceDir);
    const patchFile = path.join(outputDir, "diff.patch");
    fs.writeFileSync(patchFile, patch);
    console.log(chalk.green(`✓ Diff saved: ${patchFile}`));
  } catch {
    console.log(chalk.dim("  (no diff available)"));
  }

  // Print composite score
  console.log(chalk.bold(`\n  Composite score: ${result.compositeScore}/100\n`));
  console.log(chalk.dim("  Breakdown:"));
  console.log(chalk.dim(`    Build (35):          ${result.build.pass ? 35 : 0}`));
  const hCount = result.hallucinatedImports.count;
  const importScore = hCount === 0 ? 25 : hCount <= 2 ? 12.5 : 0;
  console.log(chalk.dim(`    Imports (25):        ${importScore}`));
  const fileScore = Math.round(Math.min(result.extractedFiles.total / 5, 1) * 20 * 10) / 10;
  console.log(chalk.dim(`    Files extracted (20): ${fileScore}`));
  const reductionScore = Math.round(Math.min(result.appTsx.reductionPct / 50, 1) * 20 * 10) / 10;
  console.log(chalk.dim(`    Reduction (20):      ${reductionScore}`));
}

main().catch((err) => {
  console.error(chalk.red("Evaluation failed:"), err);
  process.exit(1);
});
