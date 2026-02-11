/** Estimate token count using chars/4 heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
