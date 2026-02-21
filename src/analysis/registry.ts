/**
 * Checker Registry — unified interface for all static analysis checkers.
 *
 * Each checker registers itself via `registerChecker()`. The MCP server
 * loops over `getCheckers()` instead of calling each checker individually.
 */

// --- Core Types ---

/** Unified result returned by every checker's `run()` method. */
export interface CheckerResult {
  checkerId: string;
  checked: number;
  hallucinated: number;
  hallucinations: { raw: string; category: string; suggestion?: string }[];
  catchItems: string[];
  applicable: boolean;
  rawAnalysis: unknown;
}

/** Definition that each checker must implement to register. */
export interface CheckerDefinition {
  /** Unique identifier: "paths", "schema", "expressRoutes", etc. */
  id: string;
  /** Human-readable name: "File Paths", "Express/Fastify Routes" */
  displayName: string;
  /** Key used in the catches.jsonl findings record */
  catchKey: string;
  /** Experimental checkers are excluded from check_all by default. */
  experimental?: boolean;

  /** Run the checker and return a unified result. */
  run(planText: string, projectDir: string, options?: Record<string, string>): CheckerResult;
  /** Format result for the `check_all` combined report. */
  formatForCheckAll(result: CheckerResult, projectDir: string): string[];
  /** Format result for the `verify_plan` static findings section (LLM context). */
  formatForFindings(result: CheckerResult): string | undefined;
}

// --- Registry Runtime ---

const checkers: CheckerDefinition[] = [];
const checkerMap = new Map<string, CheckerDefinition>();

/** Register a checker definition. Called at import time by each checker module. */
export function registerChecker(def: CheckerDefinition): void {
  if (checkerMap.has(def.id)) {
    throw new Error(`Checker "${def.id}" already registered`);
  }
  checkers.push(def);
  checkerMap.set(def.id, def);
}

/** Get registered checkers in registration order. Excludes experimental by default. */
export function getCheckers(opts?: { includeExperimental?: boolean }): readonly CheckerDefinition[] {
  if (opts?.includeExperimental) return checkers;
  return checkers.filter(c => !c.experimental);
}

/** Get a specific checker by ID. */
export function getChecker(id: string): CheckerDefinition | undefined {
  return checkerMap.get(id);
}
