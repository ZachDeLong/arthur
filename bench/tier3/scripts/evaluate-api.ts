import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ApiUnificationEvaluationResult } from "../../harness/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type GroundTruth = Record<string, Record<string, string>>;

function usage(): never {
  console.error("Usage: evaluate-api <arm-name> <workspace-dir> <output-dir>");
  console.error("");
  console.error("  <arm-name>      'vanilla' or 'arthur-assisted'");
  console.error("  <workspace-dir> Path to the workspace");
  console.error("  <output-dir>    Path to save results");
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

// ── Hallucinated Imports ──

function findHallucinatedImports(workspaceDir: string): string[] {
  const frontendDir = path.join(workspaceDir, "frontend");
  const srcDir = path.join(frontendDir, "src");
  const hallucinated: string[] = [];

  let changedFiles: string[];
  try {
    const diff = run("git diff --name-only HEAD~1", workspaceDir);
    changedFiles = diff
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => f.startsWith("frontend/src/"));
  } catch {
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
    const importRegex = /(?:import|from)\s+['"]([.@][^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      let resolved: string;
      if (importPath.startsWith("@/")) {
        resolved = path.join(srcDir, importPath.slice(2));
      } else {
        resolved = path.resolve(fileDir, importPath);
      }
      const extensions = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
      const found = extensions.some((ext) => fs.existsSync(resolved + ext));
      if (!found) {
        hallucinated.push(`${file}: ${importPath}`);
      }
    }
  }

  return hallucinated;
}

// ── Type Accuracy ──

/** Normalize a field name for comparison: lowercase, strip underscores. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

/** Extract interface/type field names from TypeScript source. */
function extractInterfaceFields(content: string): Map<string, string[]> {
  const interfaces = new Map<string, string[]>();

  // Match `interface Foo {` or `type Foo = {` blocks
  const blockRegex = /(?:interface|type)\s+(\w+)\s*(?:=\s*)?\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(content)) !== null) {
    const name = blockMatch[1];
    const body = blockMatch[2];
    const fields: string[] = [];

    // Match field declarations: `fieldName:` or `fieldName?:`
    const fieldRegex = /^\s*(\w+)\s*\??:/gm;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      fields.push(fieldMatch[1]);
    }

    if (fields.length > 0) {
      interfaces.set(name, fields);
    }
  }

  return interfaces;
}

/** Scan all .ts/.tsx files in frontend/src for interface declarations. */
function scanInterfaces(srcDir: string): Map<string, string[]> {
  const allInterfaces = new Map<string, string[]>();

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(path.join(dir, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
        const interfaces = extractInterfaceFields(content);
        for (const [name, fields] of interfaces) {
          allInterfaces.set(name, fields);
        }
      }
    }
  };

  walk(srcDir);
  return allInterfaces;
}

/** Match ground truth entries to found interfaces using field overlap. */
function matchInterfaces(
  groundTruth: GroundTruth,
  foundInterfaces: Map<string, string[]>,
): Record<string, { expected: string[]; found: string[]; missing: string[]; extra: string[] }> {
  const result: Record<string, { expected: string[]; found: string[]; missing: string[]; extra: string[] }> = {};

  for (const [gtName, gtFields] of Object.entries(groundTruth)) {
    const expectedFields = Object.keys(gtFields);
    const normalizedExpected = expectedFields.map(normalizeFieldName);

    // Find best matching interface by field overlap
    let bestMatch: { name: string; fields: string[]; score: number } | null = null;

    for (const [ifaceName, ifaceFields] of foundInterfaces) {
      const normalizedFound = ifaceFields.map(normalizeFieldName);
      const overlap = normalizedExpected.filter((f) => normalizedFound.includes(f)).length;
      const score = overlap / Math.max(normalizedExpected.length, 1);

      if (score > (bestMatch?.score ?? 0)) {
        bestMatch = { name: ifaceName, fields: ifaceFields, score };
      }
    }

    // Require at least 30% overlap to count as a match
    if (bestMatch && bestMatch.score >= 0.3) {
      const normalizedFound = bestMatch.fields.map(normalizeFieldName);
      const missing = expectedFields.filter(
        (f) => !normalizedFound.includes(normalizeFieldName(f)),
      );
      const extra = bestMatch.fields.filter(
        (f) => !normalizedExpected.includes(normalizeFieldName(f)),
      );

      result[gtName] = {
        expected: expectedFields,
        found: bestMatch.fields,
        missing,
        extra,
      };
    } else {
      // No match found — all fields missing
      result[gtName] = {
        expected: expectedFields,
        found: [],
        missing: expectedFields,
        extra: [],
      };
    }
  }

  return result;
}

// ── API Coverage ──

/** Find raw fetch() calls outside the API client file. */
function findRawFetchCalls(
  srcDir: string,
): { file: string; line: number }[] {
  const results: { file: string; line: number }[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(path.join(dir, entry.name), path.join(prefix, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const relPath = path.join(prefix, entry.name);
        // Skip the API client itself — it's supposed to use fetch
        if (relPath.includes("api.ts") || relPath.includes("api/")) continue;

        const absPath = path.join(dir, entry.name);
        const content = fs.readFileSync(absPath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          // Match fetch( but not type references or comments
          if (/\bfetch\s*\(/.test(lines[i]) && !lines[i].trim().startsWith("//") && !lines[i].trim().startsWith("*")) {
            results.push({ file: relPath, line: i + 1 });
          }
        }
      }
    }
  };

  walk(srcDir, "");
  return results;
}

// ── Error Handling ──

/** Check API client functions for error handling patterns. */
function checkErrorHandling(srcDir: string): {
  functionsWithHandling: string[];
  functionsWithoutHandling: string[];
} {
  const withHandling: string[] = [];
  const withoutHandling: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(path.join(dir, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        // Only check files that look like API modules
        const name = entry.name.toLowerCase();
        if (!name.includes("api") && !name.includes("client")) continue;

        const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");

        // Find exported async functions or arrow functions
        const fnRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
        let fnMatch;
        while ((fnMatch = fnRegex.exec(content)) !== null) {
          const fnName = fnMatch[1] || fnMatch[2];
          // Look ahead for try/catch or .catch in the function body
          const afterFn = content.slice(fnMatch.index, fnMatch.index + 1000);
          if (/try\s*\{/.test(afterFn) || /\.catch\s*\(/.test(afterFn)) {
            withHandling.push(fnName);
          } else {
            withoutHandling.push(fnName);
          }
        }
      }
    }
  };

  walk(srcDir);
  return { functionsWithHandling: withHandling, functionsWithoutHandling: withoutHandling };
}

// ── Scoring ──

function computeScore(result: Omit<ApiUnificationEvaluationResult, "compositeScore">): number {
  // Build: 25 points (binary)
  const buildScore = result.build.pass ? 25 : 0;

  // Hallucinated imports: 15 points
  const hCount = result.hallucinatedImports.count;
  const importScore = hCount === 0 ? 15 : hCount <= 2 ? 7.5 : 0;

  // Type accuracy: 30 points
  const typeScore = (result.typeAccuracy.overallScore / 100) * 30;

  // API coverage: 20 points
  const rawCount = result.apiCoverage.totalRawFetches;
  const coverageScore = rawCount === 0 ? 20 : rawCount <= 2 ? 10 : 0;

  // Error handling: 10 points
  const ehPct = result.errorHandling.coveragePct;
  const ehScore = ehPct >= 90 ? 10 : ehPct >= 50 ? 5 : 0;

  return Math.round((buildScore + importScore + typeScore + coverageScore + ehScore) * 10) / 10;
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) usage();

  const armName = args[0];
  const workspaceDir = path.resolve(args[1]);
  const outputDir = path.resolve(args[2]);

  const frontendDir = path.join(workspaceDir, "frontend");
  const srcDir = path.join(frontendDir, "src");
  if (!fs.existsSync(frontendDir)) {
    console.error(chalk.red(`No frontend/ in workspace: ${workspaceDir}`));
    process.exit(1);
  }

  // Load ground truth
  const gtPath = path.join(__dirname, "..", "ground-truth-api.json");
  if (!fs.existsSync(gtPath)) {
    console.error(chalk.red(`Missing ground truth: ${gtPath}`));
    process.exit(1);
  }
  const groundTruth: GroundTruth = JSON.parse(fs.readFileSync(gtPath, "utf-8"));

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(chalk.cyan(`── API Unification Evaluation: ${armName} ──\n`));

  // 1. Build check
  console.log(chalk.dim("  Checking build..."));
  const buildResult = tryRun("npm run build", frontendDir);
  const buildErrors = buildResult.ok ? [] : buildResult.stderr.split("\n").filter(Boolean);
  console.log(
    buildResult.ok
      ? chalk.green("  ✓ Build passes")
      : chalk.red(`  ✗ Build failed (${buildErrors.length} error lines)`),
  );

  // 2. Hallucinated imports
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

  // 3. Type accuracy
  console.log(chalk.dim("  Analyzing type accuracy..."));
  const foundInterfaces = scanInterfaces(srcDir);
  const fieldAccuracy = matchInterfaces(groundTruth, foundInterfaces);

  let totalExpected = 0;
  let totalCorrect = 0;
  for (const entry of Object.values(fieldAccuracy)) {
    totalExpected += entry.expected.length;
    totalCorrect += entry.expected.length - entry.missing.length;
  }
  const overallTypeScore = totalExpected > 0 ? Math.round((totalCorrect / totalExpected) * 100 * 10) / 10 : 0;

  console.log(chalk.dim(`  Found ${foundInterfaces.size} interfaces`));
  for (const [gtName, accuracy] of Object.entries(fieldAccuracy)) {
    const pct = accuracy.expected.length > 0
      ? Math.round(((accuracy.expected.length - accuracy.missing.length) / accuracy.expected.length) * 100)
      : 0;
    const status = accuracy.missing.length === 0 ? chalk.green("✓") : chalk.yellow("~");
    console.log(chalk.dim(`    ${status} ${gtName}: ${pct}% (${accuracy.missing.length} missing, ${accuracy.extra.length} extra)`));
    if (accuracy.missing.length > 0) {
      console.log(chalk.dim(`      missing: ${accuracy.missing.join(", ")}`));
    }
  }
  console.log(chalk.dim(`  Overall type accuracy: ${overallTypeScore}%`));

  // 4. API coverage — raw fetch calls outside api client
  console.log(chalk.dim("  Checking API coverage..."));
  const rawFetchCalls = findRawFetchCalls(srcDir);
  if (rawFetchCalls.length > 0) {
    console.log(chalk.yellow(`  ~ ${rawFetchCalls.length} raw fetch calls found:`));
    for (const call of rawFetchCalls) {
      console.log(chalk.yellow(`    - ${call.file}:${call.line}`));
    }
  } else {
    console.log(chalk.green("  ✓ All API calls routed through client"));
  }

  // 5. Error handling
  console.log(chalk.dim("  Checking error handling..."));
  const errorHandling = checkErrorHandling(srcDir);
  const totalFns = errorHandling.functionsWithHandling.length + errorHandling.functionsWithoutHandling.length;
  const coveragePct = totalFns > 0
    ? Math.round((errorHandling.functionsWithHandling.length / totalFns) * 100)
    : 100; // no functions found = vacuously true
  console.log(chalk.dim(`  ${errorHandling.functionsWithHandling.length}/${totalFns} API functions have error handling (${coveragePct}%)`));

  // 6. Diff stats
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

  // Build result
  const partial: Omit<ApiUnificationEvaluationResult, "compositeScore"> = {
    arm: armName,
    build: { pass: buildResult.ok, errors: buildErrors },
    hallucinatedImports: {
      count: hallucinatedImports.length,
      paths: hallucinatedImports,
    },
    typeAccuracy: {
      interfacesFound: [...foundInterfaces.keys()],
      fieldAccuracy,
      overallScore: overallTypeScore,
    },
    apiCoverage: {
      rawFetchCalls,
      totalRawFetches: rawFetchCalls.length,
    },
    errorHandling: {
      functionsWithHandling: errorHandling.functionsWithHandling,
      functionsWithoutHandling: errorHandling.functionsWithoutHandling,
      coveragePct,
    },
    diffStats: { filesChanged, insertions, deletions },
  };

  const result: ApiUnificationEvaluationResult = {
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

  const buildScore = result.build.pass ? 25 : 0;
  console.log(chalk.dim(`    Build (25):            ${buildScore}`));

  const hCount = result.hallucinatedImports.count;
  const importScore = hCount === 0 ? 15 : hCount <= 2 ? 7.5 : 0;
  console.log(chalk.dim(`    Imports (15):          ${importScore}`));

  const typeScore = Math.round((overallTypeScore / 100) * 30 * 10) / 10;
  console.log(chalk.dim(`    Type accuracy (30):    ${typeScore}`));

  const rawCount = result.apiCoverage.totalRawFetches;
  const coverageScore = rawCount === 0 ? 20 : rawCount <= 2 ? 10 : 0;
  console.log(chalk.dim(`    API coverage (20):     ${coverageScore}`));

  const ehScore = coveragePct >= 90 ? 10 : coveragePct >= 50 ? 5 : 0;
  console.log(chalk.dim(`    Error handling (10):   ${ehScore}`));
}

main().catch((err) => {
  console.error(chalk.red("Evaluation failed:"), err);
  process.exit(1);
});
