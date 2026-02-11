import readline from "node:readline";
import { saveGlobalConfig, ensureGitignore } from "../config/manager.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import * as log from "../utils/logger.js";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runInit(): Promise<void> {
  log.heading("CodeVerifier Setup");

  const apiKey = await prompt(
    "Anthropic API key (leave blank to use ANTHROPIC_API_KEY env var): ",
  );

  const modelInput = await prompt(
    `Default model [${DEFAULT_CONFIG.model}]: `,
  );

  const budgetInput = await prompt(
    `Token budget [${DEFAULT_CONFIG.tokenBudget}]: `,
  );

  const config: Record<string, unknown> = {};
  if (apiKey) config.apiKey = apiKey;
  if (modelInput) config.model = modelInput;
  if (budgetInput) {
    const parsed = parseInt(budgetInput, 10);
    if (!isNaN(parsed) && parsed > 0) config.tokenBudget = parsed;
  }

  saveGlobalConfig(config);
  log.success("Global config saved to ~/.codeverifier/config.json");

  // Try to update .gitignore in cwd
  ensureGitignore(process.cwd());
  log.info("Checked .gitignore for .codeverifier/ entry");
}
