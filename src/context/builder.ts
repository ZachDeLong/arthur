import fs from "node:fs";
import path from "node:path";
import { generateTree } from "./tree.js";
import { readReferencedFiles } from "./file-reader.js";
import { allocateTokenBudget, PRIORITIES, type BudgetItem } from "./token-budget.js";
import { estimateTokens } from "../utils/tokens.js";
import * as log from "../utils/logger.js";

export interface ProjectContext {
  prompt?: string;
  planText: string;
  readme?: string;
  claudeMd?: string;
  sessionFeedback?: string;
  referencedFiles: Map<string, string>;
  tree: string;
  tokenStats: Map<string, number>;
}

export interface BuildContextOptions {
  projectDir: string;
  planText: string;
  prompt?: string;
  sessionFeedback?: string;
  tokenBudget: number;
}

/** Read a file if it exists, return undefined otherwise. */
function readOptionalFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/** Assemble all project context within the token budget. */
export function buildContext(options: BuildContextOptions): ProjectContext {
  const { projectDir, planText, prompt, sessionFeedback, tokenBudget } = options;

  // Read project docs
  const readme = readOptionalFile(path.join(projectDir, "README.md"));
  const claudeMd = readOptionalFile(path.join(projectDir, "CLAUDE.md"));

  if (!readme) {
    log.warn("No README.md found — verification quality may be limited");
  }

  // Generate tree
  const tree = generateTree(projectDir);

  // Read referenced files
  const referencedFiles = readReferencedFiles(planText, projectDir);

  // Build budget items
  const items: BudgetItem[] = [];

  if (prompt) {
    items.push({ key: "prompt", content: prompt, priority: PRIORITIES.PROMPT });
  }
  items.push({ key: "plan", content: planText, priority: PRIORITIES.PLAN });
  if (readme) {
    items.push({ key: "readme", content: readme, priority: PRIORITIES.README });
  }
  if (claudeMd) {
    items.push({ key: "claudeMd", content: claudeMd, priority: PRIORITIES.CLAUDE_MD });
  }
  if (sessionFeedback) {
    items.push({
      key: "sessionFeedback",
      content: sessionFeedback,
      priority: PRIORITIES.SESSION_FEEDBACK,
    });
  }
  for (const [filePath, content] of referencedFiles) {
    items.push({
      key: `file:${filePath}`,
      content,
      priority: PRIORITIES.REFERENCED_FILES,
    });
  }
  items.push({ key: "tree", content: tree, priority: PRIORITIES.TREE });

  // Allocate within budget
  const allocated = allocateTokenBudget(items, tokenBudget);

  // Build token stats
  const tokenStats = new Map<string, number>();
  for (const [key, content] of allocated) {
    tokenStats.set(key, estimateTokens(content));
  }

  // Build final context, only including what fit in budget
  const finalReferencedFiles = new Map<string, string>();
  for (const [key, content] of allocated) {
    if (key.startsWith("file:")) {
      finalReferencedFiles.set(key.slice(5), content);
    }
  }

  return {
    prompt: allocated.get("prompt"),
    planText: allocated.get("plan") ?? planText,
    readme: allocated.get("readme"),
    claudeMd: allocated.get("claudeMd"),
    sessionFeedback: allocated.get("sessionFeedback"),
    referencedFiles: finalReferencedFiles,
    tree: allocated.get("tree") ?? tree,
    tokenStats,
  };
}
