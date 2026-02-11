import fs from "node:fs";
import path from "node:path";
import { getAllFiles } from "./tree.js";

const MAX_LINES_PER_FILE = 500;

/** Extract file-path-like strings from plan text. */
export function extractFilePaths(planText: string): string[] {
  // Match patterns like: src/foo/bar.ts, ./config/schema.ts, etc.
  // Require at least one slash and a file extension
  const regex = /(?:^|[\s`"'(,])([.\w/-]+\.\w{1,10})(?=[\s`"'),;:\]|]|$)/gm;
  const matches = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = regex.exec(planText)) !== null) {
    let p = match[1].replace(/^\.\//, "");
    // Normalize path separators
    p = p.replace(/\\/g, "/");
    // Skip things that look like URLs, version strings, or common false positives
    if (p.includes("://")) continue;
    if (/^\d+\.\d+/.test(p)) continue;
    if (p.startsWith("node_modules/")) continue;
    matches.add(p);
  }

  return [...matches];
}

/** Read files referenced in the plan, cross-referencing against the actual project tree. */
export function readReferencedFiles(
  planText: string,
  projectDir: string,
): Map<string, string> {
  const extracted = extractFilePaths(planText);
  const projectFiles = getAllFiles(projectDir);
  const result = new Map<string, string>();

  for (const filePath of extracted) {
    // Normalize for comparison
    const normalized = filePath.replace(/\\/g, "/");

    // Check if this path (or a suffix of it) exists in the project
    let resolvedPath: string | null = null;

    if (projectFiles.has(normalized)) {
      resolvedPath = normalized;
    } else {
      // Try matching as a suffix (e.g., "schema.ts" → "src/config/schema.ts")
      for (const pf of projectFiles) {
        if (pf.endsWith("/" + normalized) || pf === normalized) {
          resolvedPath = pf;
          break;
        }
      }
    }

    if (!resolvedPath) continue;

    const fullPath = path.join(projectDir, resolvedPath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      if (lines.length > MAX_LINES_PER_FILE) {
        result.set(
          resolvedPath,
          lines.slice(0, MAX_LINES_PER_FILE).join("\n") +
            "\n[...truncated at " +
            MAX_LINES_PER_FILE +
            " lines]",
        );
      } else {
        result.set(resolvedPath, content);
      }
    } catch {
      // File couldn't be read — skip
    }
  }

  return result;
}
