import { extractFilePaths } from "../context/file-reader.js";
import { getAllFiles } from "../context/tree.js";

/** Classification of an extracted file path */
export type PathClassification = "valid" | "intentionalNew" | "hallucinated";

/** Result of path analysis for a single run */
export interface PathAnalysis {
  extractedPaths: string[];
  validPaths: string[];
  intentionalNewPaths: string[];
  hallucinatedPaths: string[];
  hallucinationRate: number;
}

/** Test whether a path matches a simple glob pattern (supports * and **). */
function matchesGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}

/** Check if a path matches any of the allowed new path patterns. */
function matchesAllowedNew(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}

/** Check if the plan text suggests this path is intentionally new. */
function hasCreateSignal(filePath: string, planText: string): boolean {
  const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const createPatterns = [
    // "Create src/foo/bar.ts" or "Add src/foo/bar.ts"
    new RegExp(`(?:create|add|new file|introduce)\\s+\`?${escapedPath}`, "i"),
    // Path on same line as (CREATE) — handles markdown: **File: `path`** (CREATE)
    new RegExp(`${escapedPath}[^\n]*\\(\\s*(?:CREATE|create|Create|new|NEW|Add|ADD)`, "i"),
    // (CREATE) before path on same line: (CREATE) `path`
    new RegExp(`\\(\\s*(?:CREATE|create|Create|new|NEW)[^\n]*${escapedPath}`, "i"),
    // "src/foo/bar.ts (new)" or "src/foo/bar.ts (create)"
    new RegExp(`${escapedPath}[^)\n]{0,20}\\((?:new|create)\\)`, "i"),
  ];

  for (const pattern of createPatterns) {
    if (pattern.test(planText)) return true;
  }

  // Check if path appears in a "new files" / "files to create" section
  const sectionPatterns = [
    /#{1,4}\s*(?:new|files to create|files to add|created files)/i,
    /\*\*(?:new|files to create|files to add|created files)\*\*/i,
  ];

  for (const sectionPattern of sectionPatterns) {
    const sectionMatch = sectionPattern.exec(planText);
    if (!sectionMatch) continue;

    const afterSection = planText.slice(sectionMatch.index);
    const nextHeading = afterSection.slice(1).search(/^#{1,4}\s/m);
    const sectionText =
      nextHeading === -1
        ? afterSection
        : afterSection.slice(0, nextHeading + 1);

    if (sectionText.includes(filePath)) return true;
  }

  return false;
}

/** Classify a non-existent path as intentionalNew or hallucinated. */
function classifyMissingPath(
  filePath: string,
  planText: string,
  allowedNewPaths: string[],
): PathClassification {
  // Check allowed new path patterns first
  if (matchesAllowedNew(filePath, allowedNewPaths)) {
    return "intentionalNew";
  }

  // Check for create/add language in the plan text
  if (hasCreateSignal(filePath, planText)) {
    return "intentionalNew";
  }

  return "hallucinated";
}

/**
 * Filter extracted paths to remove code expressions that aren't file paths.
 * The upstream extractFilePaths() is intentionally broad (it serves the verifier).
 * For benchmarking, we need precision — only real file path references.
 */
function filterCodeExpressions(paths: string[]): string[] {
  return paths.filter((p) => {
    // Must contain at least one "/" — real file references include directories
    if (!p.includes("/")) return false;

    // Skip property access chains (this.foo, error.bar, result.baz)
    if (/^(?:this|self|error|result|config|options|req|res|ctx)\./i.test(p)) return false;

    // Skip Go stdlib type refs (time.Duration, sync.RWMutex, http.Handler, etc.)
    if (/^[a-z]+\.[A-Z]\w*$/.test(p)) return false;

    // Skip spread/destructure artifacts
    if (p.startsWith("...")) return false;

    // Skip template placeholders (YYYY, XXXX patterns as leading component)
    if (/^[A-Z]{4,}/.test(p.split("/")[0])) return false;

    return true;
  });
}

/** Find the closest matching file paths for a hallucinated path. */
export function findClosestPaths(
  hallucinated: string,
  actualFiles: Set<string>,
  maxResults: number = 5,
): string[] {
  const halParts = hallucinated.split("/");
  const halFileName = halParts[halParts.length - 1]?.toLowerCase() ?? "";
  const halDirParts = halParts.slice(0, -1).map(p => p.toLowerCase());

  const scored: { path: string; score: number }[] = [];

  for (const filePath of actualFiles) {
    const parts = filePath.split("/");
    const fileName = parts[parts.length - 1]?.toLowerCase() ?? "";
    const dirParts = parts.slice(0, -1).map(p => p.toLowerCase());
    let score = 0;

    // Exact filename match is heavily weighted
    if (fileName === halFileName) {
      score += 10;
    } else if (fileName.includes(halFileName) || halFileName.includes(fileName)) {
      score += 5;
    }

    // Extension match
    const halExt = halFileName.split(".").pop() ?? "";
    const fileExt = fileName.split(".").pop() ?? "";
    if (halExt === fileExt) score += 2;

    // Directory overlap (how many dir segments match)
    for (const halDir of halDirParts) {
      if (dirParts.includes(halDir)) score += 3;
    }

    // Penalize large depth difference
    const depthDiff = Math.abs(parts.length - halParts.length);
    score -= depthDiff;

    if (score > 0) {
      scored.push({ path: filePath, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.path);
}

/** Get a listing of files in or near a directory path. */
export function getDirectoryContext(
  dirPath: string,
  actualFiles: Set<string>,
  maxFiles: number = 15,
): string[] {
  // Normalize: remove trailing filename to get directory
  const dir = dirPath.includes("/")
    ? dirPath.substring(0, dirPath.lastIndexOf("/"))
    : "";

  if (!dir) return [];

  const matches: string[] = [];
  for (const filePath of actualFiles) {
    if (filePath.startsWith(dir + "/")) {
      matches.push(filePath);
      if (matches.length >= maxFiles) break;
    }
  }
  return matches.sort();
}

/** Analyze paths extracted from a plan against a project's actual files. */
export function analyzePaths(
  planText: string,
  projectDir: string,
  allowedNewPaths: string[] = [],
): PathAnalysis {
  const rawPaths = extractFilePaths(planText);
  const extractedPaths = filterCodeExpressions(rawPaths);
  const actualFiles = getAllFiles(projectDir);

  const validPaths: string[] = [];
  const intentionalNewPaths: string[] = [];
  const hallucinatedPaths: string[] = [];

  for (const filePath of extractedPaths) {
    if (actualFiles.has(filePath)) {
      validPaths.push(filePath);
    } else {
      // Check if any actual file ends with this path (partial match)
      let found = false;
      for (const actual of actualFiles) {
        if (actual.endsWith("/" + filePath) || actual === filePath) {
          validPaths.push(filePath);
          found = true;
          break;
        }
      }

      if (!found) {
        const classification = classifyMissingPath(
          filePath,
          planText,
          allowedNewPaths,
        );
        if (classification === "intentionalNew") {
          intentionalNewPaths.push(filePath);
        } else {
          hallucinatedPaths.push(filePath);
        }
      }
    }
  }

  // Hallucination rate = hallucinated / (total - intentionalNew)
  const denominator = extractedPaths.length - intentionalNewPaths.length;
  const hallucinationRate =
    denominator > 0 ? hallucinatedPaths.length / denominator : 0;

  return {
    extractedPaths,
    validPaths,
    intentionalNewPaths,
    hallucinatedPaths,
    hallucinationRate,
  };
}
