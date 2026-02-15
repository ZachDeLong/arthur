/**
 * Catch logging — records every hallucination Arthur catches to ~/.arthur/catches.jsonl.
 * Builds organic evidence of value over time.
 *
 * CRITICAL: Logging must never break the MCP server. All errors are silently swallowed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface FindingEntry {
  checked: number;
  hallucinated: number;
  items: string[];
}

export interface CatchEntry {
  timestamp: string;
  tool: string;
  projectDir: string; // basename only — no full paths for privacy
  findings: {
    paths: FindingEntry | null;
    schema: FindingEntry | null;
    sqlSchema: FindingEntry | null;
    imports: FindingEntry | null;
    env: FindingEntry | null;
    types: FindingEntry | null;
    routes: FindingEntry | null;
    supabaseSchema: FindingEntry | null;
  };
  totalChecked: number;
  totalHallucinated: number;
}

const CATCHES_DIR = path.join(os.homedir(), ".arthur");
const CATCHES_FILE = path.join(CATCHES_DIR, "catches.jsonl");

/**
 * Append a catch entry to ~/.arthur/catches.jsonl.
 * No-op if totalHallucinated === 0. Silently swallows all errors.
 */
export function logCatch(entry: CatchEntry): void {
  try {
    if (entry.totalHallucinated === 0) return;
    fs.mkdirSync(CATCHES_DIR, { recursive: true });
    fs.appendFileSync(CATCHES_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Never break the MCP server
  }
}

/**
 * Read all catch entries from ~/.arthur/catches.jsonl.
 * Returns empty array if file doesn't exist or on any error.
 */
export function readCatches(): CatchEntry[] {
  try {
    if (!fs.existsSync(CATCHES_FILE)) return [];
    const content = fs.readFileSync(CATCHES_FILE, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CatchEntry);
  } catch {
    return [];
  }
}
