import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { buildContext } from "../../../src/context/builder.js";
import { getSystemPrompt, buildUserMessage } from "../../../src/verifier/prompt.js";
import { streamVerification } from "../../../src/verifier/client.js";
import { createRenderer } from "../../../src/verifier/renderer.js";
import { analyzePaths } from "../../harness/path-checker.js";
import { loadConfig } from "../../../src/config/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIER3_ROOT = path.resolve(__dirname, "..");
const PROMPT_FILE = path.join(TIER3_ROOT, "prompt.md");

const MODEL = "claude-opus-4-6";
const TOKEN_BUDGET = 120_000;

function usage(): never {
  console.error("Usage: verify-plan <plan-file> <workspace-dir>");
  console.error("");
  console.error("  <plan-file>     Path to the saved plan markdown file");
  console.error("  <workspace-dir> Path to the workspace (e.g., bench/tier3/workspaces/arthur-assisted)");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  const planFile = path.resolve(args[0]);
  const workspaceDir = path.resolve(args[1]);

  // Validate inputs
  if (!fs.existsSync(planFile)) {
    console.error(chalk.red(`Plan file not found: ${planFile}`));
    process.exit(1);
  }
  const frontendDir = path.join(workspaceDir, "frontend");
  if (!fs.existsSync(frontendDir)) {
    console.error(chalk.red(`No frontend/ in workspace: ${workspaceDir}`));
    process.exit(1);
  }

  // Get API key (config file or env)
  const config = loadConfig(path.resolve("."));
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("No API key found. Set ANTHROPIC_API_KEY or run codeverifier init."));
    process.exit(1);
  }

  const planText = fs.readFileSync(planFile, "utf-8");
  const planDir = path.dirname(planFile);

  console.log(chalk.cyan("── Arthur Tier 3 Verification ──\n"));
  console.log(chalk.dim(`Plan:      ${planFile}`));
  console.log(chalk.dim(`Workspace: ${workspaceDir}`));
  console.log(chalk.dim(`Model:     ${MODEL}`));
  console.log(chalk.dim(`Budget:    ${TOKEN_BUDGET.toLocaleString()} tokens\n`));

  // Build context from the frontend directory (the target of the refactoring)
  const context = buildContext({
    projectDir: frontendDir,
    planText,
    prompt: fs.readFileSync(PROMPT_FILE, "utf-8"),
    tokenBudget: TOKEN_BUDGET,
  });

  console.log(chalk.dim("Token allocation:"));
  for (const [key, tokens] of context.tokenStats) {
    console.log(chalk.dim(`  ${key}: ${tokens.toLocaleString()}`));
  }
  console.log("");

  // Run verification
  const renderer = createRenderer();
  const result = await streamVerification({
    apiKey,
    model: MODEL,
    systemPrompt: getSystemPrompt(),
    userMessage: buildUserMessage(context),
    onText: renderer.onText,
  });

  const verificationText = renderer.getFullText();
  console.log("\n");

  // Save verification output
  const verificationFile = path.join(planDir, "verification.md");
  fs.writeFileSync(verificationFile, verificationText);
  console.log(chalk.green(`✓ Verification saved: ${verificationFile}`));

  // Run path analysis
  console.log(chalk.cyan("\n── Path Analysis ──\n"));
  const pathAnalysis = analyzePaths(planText, frontendDir, [
    "src/hooks/**/*.ts",
    "src/hooks/**/*.tsx",
    "src/components/**/*.ts",
    "src/components/**/*.tsx",
  ]);

  console.log(`  Extracted paths: ${pathAnalysis.extractedPaths.length}`);
  console.log(chalk.green(`  Valid:           ${pathAnalysis.validPaths.length}`));
  console.log(chalk.blue(`  Intentional new: ${pathAnalysis.intentionalNewPaths.length}`));
  if (pathAnalysis.hallucinatedPaths.length > 0) {
    console.log(chalk.red(`  Hallucinated:    ${pathAnalysis.hallucinatedPaths.length}`));
    for (const p of pathAnalysis.hallucinatedPaths) {
      console.log(chalk.red(`    - ${p}`));
    }
  } else {
    console.log(chalk.green(`  Hallucinated:    0`));
  }

  // Save path analysis
  const pathFile = path.join(planDir, "path-analysis.json");
  fs.writeFileSync(pathFile, JSON.stringify(pathAnalysis, null, 2));
  console.log(chalk.green(`\n✓ Path analysis saved: ${pathFile}`));

  // Print API usage
  console.log(chalk.dim(`\nAPI usage: ${result.inputTokens.toLocaleString()} in / ${result.outputTokens.toLocaleString()} out`));
}

main().catch((err) => {
  console.error(chalk.red("Verification failed:"), err);
  process.exit(1);
});
