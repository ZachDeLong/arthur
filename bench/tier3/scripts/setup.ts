import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIER3_ROOT = path.resolve(__dirname, "..");
// Workspaces live outside ~/arthur/ so Claude Code doesn't pick up Arthur's CLAUDE.md
const WORKSPACES_DIR = path.join(process.env.HOME ?? "~", ".arthur-tier3-workspaces");
const SOURCE_DIR = path.resolve(process.env.HOME ?? "~", "Desktop/ai-reasoning-hub");

const ARMS = ["vanilla", "arthur-assisted"] as const;

const RSYNC_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "__pycache__",
  "data/",
];

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function runVerbose(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, stdio: "inherit" });
}

function main(): void {
  // Validate source exists
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(chalk.red(`Source not found: ${SOURCE_DIR}`));
    console.error("Expected ai-reasoning-hub at ~/Desktop/ai-reasoning-hub/");
    process.exit(1);
  }

  // Validate source has frontend/
  const frontendDir = path.join(SOURCE_DIR, "frontend");
  if (!fs.existsSync(frontendDir)) {
    console.error(chalk.red(`No frontend/ directory in ${SOURCE_DIR}`));
    process.exit(1);
  }

  // Clean and create workspaces
  if (fs.existsSync(WORKSPACES_DIR)) {
    console.log(chalk.dim("Cleaning existing workspaces..."));
    fs.rmSync(WORKSPACES_DIR, { recursive: true });
  }
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  for (const arm of ARMS) {
    const armDir = path.join(WORKSPACES_DIR, arm);
    console.log(chalk.cyan(`\n── Setting up ${arm} ──`));

    // rsync the project
    const excludeFlags = RSYNC_EXCLUDES.map((e) => `--exclude='${e}'`).join(" ");
    console.log(chalk.dim("  Copying source..."));
    run(`rsync -a ${excludeFlags} '${SOURCE_DIR}/' '${armDir}/'`);

    // Init git for diffing later
    console.log(chalk.dim("  Initializing git baseline..."));
    run("git init", armDir);
    run("git add -A", armDir);
    run('git commit -m "baseline" --allow-empty', armDir);

    // Install frontend dependencies
    const armFrontend = path.join(armDir, "frontend");
    console.log(chalk.dim("  Installing frontend dependencies..."));
    runVerbose("npm install", armFrontend);

    // Validate baseline build
    console.log(chalk.dim("  Validating baseline build..."));
    try {
      run("npm run build", armFrontend);
      console.log(chalk.green(`  ✓ Build passes for ${arm}`));
    } catch (e) {
      console.error(chalk.red(`  ✗ Baseline build FAILED for ${arm}`));
      console.error("Fix the source repo before benchmarking.");
      process.exit(1);
    }
  }

  console.log(chalk.bold.green("\n── Setup complete ──\n"));
  console.log("Workspace paths:");
  for (const arm of ARMS) {
    console.log(`  ${arm}: ${path.join(WORKSPACES_DIR, arm)}`);
  }
  console.log(
    chalk.dim("\nOpen Claude Code in each workspace and paste the prompt from:"),
  );
  console.log(chalk.dim(`  ${path.join(TIER3_ROOT, "prompt.md")}`));
}

main();
