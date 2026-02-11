import { estimateTokens } from "../utils/tokens.js";

export interface BudgetItem {
  key: string;
  content: string;
  priority: number; // lower = higher priority
}

/**
 * Allocate items within a token budget by priority.
 * Returns items that fit, in priority order.
 * Lower priority number = included first.
 */
export function allocateTokenBudget(
  items: BudgetItem[],
  budget: number,
): Map<string, string> {
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  const result = new Map<string, string>();
  let remaining = budget;

  for (const item of sorted) {
    const tokens = estimateTokens(item.content);
    if (tokens <= remaining) {
      result.set(item.key, item.content);
      remaining -= tokens;
    }
    // If it doesn't fit, skip it (could add truncation later)
  }

  return result;
}

/** Priority levels for context items. */
export const PRIORITIES = {
  PROMPT: 0,
  PLAN: 1,
  README: 2,
  CLAUDE_MD: 3,
  SESSION_FEEDBACK: 4,
  REFERENCED_FILES: 5,
  TREE: 6,
} as const;
