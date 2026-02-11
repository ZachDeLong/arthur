import fs from "node:fs";
import readline from "node:readline";
import * as log from "../utils/logger.js";

export interface PlanInput {
  planText: string;
  source: "file" | "stdin" | "interactive";
}

/** Load plan from file path. */
function loadFromFile(filePath: string): PlanInput {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }
  return {
    planText: fs.readFileSync(filePath, "utf-8"),
    source: "file",
  };
}

/** Load plan from stdin. */
async function loadFromStdin(): Promise<PlanInput> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => chunks.push(chunk as string));
    process.stdin.on("end", () => {
      const text = chunks.join("");
      if (!text.trim()) {
        reject(new Error("No plan text received from stdin"));
        return;
      }
      resolve({ planText: text, source: "stdin" });
    });
    process.stdin.on("error", reject);
  });
}

/** Load plan interactively — user types/pastes, ends with Ctrl+D or empty line twice. */
async function loadInteractive(): Promise<PlanInput> {
  log.info("Paste your plan below. Press Enter twice on an empty line to finish.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const lines: string[] = [];
    let emptyCount = 0;

    rl.on("line", (line) => {
      if (line.trim() === "") {
        emptyCount++;
        if (emptyCount >= 2) {
          rl.close();
          return;
        }
      } else {
        // Reset empty counter and add any pending blank lines
        for (let i = 0; i < emptyCount; i++) lines.push("");
        emptyCount = 0;
        lines.push(line);
      }
    });

    rl.on("close", () => {
      resolve({ planText: lines.join("\n"), source: "interactive" });
    });
  });
}

/** Load plan based on CLI options. */
export async function loadPlan(options: {
  plan?: string;
  stdin?: boolean;
}): Promise<PlanInput> {
  if (options.plan) {
    return loadFromFile(options.plan);
  }
  if (options.stdin) {
    return loadFromStdin();
  }
  return loadInteractive();
}
