import path from "node:path";
import type { PathDetection } from "./types.js";

/** Negative sentiment phrases that indicate a path was flagged as problematic. */
const NEGATIVE_SENTIMENT = [
  "does not exist",
  "doesn't exist",
  "not found",
  "no such file",
  "missing",
  "nonexistent",
  "non-existent",
  "couldn't find",
  "could not find",
  "doesn't appear to exist",
  "does not appear to exist",
  "not present",
  "isn't present",
  "is not present",
  "no file",
  "not in the project",
  "not in the tree",
  "not visible in",
  "don't see",
  "do not see",
  "cannot locate",
  "can't locate",
  // Corrective/contrast phrases the verifier uses
  "doesn't match",
  "does not match",
  "incorrect path",
  "wrong path",
  "wrong location",
  "doesn't align",
  "does not align",
  "the names don't match",
  "naming convention",
  "not the actual",
  "actual path is",
  "should be",
  "instead of",
  "rather than",
  "but the project",
  "but the existing",
  "however, the",
];

/** Section headings that indicate corrective or warning content. */
const WARNING_SECTIONS = [
  /#{1,4}\s*(?:concerns?|issues?|problems?|warnings?|errors?|incorrect|wrong|inaccurate)/i,
  /#{1,4}\s*(?:file path|path).*(?:issues?|concerns?|problems?|errors?)/i,
  /#{1,4}\s*(?:non-?existent|missing|hallucinated|incorrect).*(?:files?|paths?|references?)/i,
  /\*\*(?:concerns?|issues?|problems?|warnings?|incorrect|wrong)\*\*/i,
  /#{1,4}\s*(?:correctness|accuracy|verification)/i,
  /#{1,4}\s*(?:risk|critical)/i,
  /#{1,4}\s*(?:alignment|convention|project structure)/i,
  /#{1,4}\s*(?:security|missing|gaps?)/i,
];

/**
 * Tier 1: Direct path string match.
 * Check if the exact path appears in the verifier output.
 */
function checkDirectMatch(
  hallucinatedPath: string,
  verifierOutput: string,
): boolean {
  return verifierOutput.includes(hallucinatedPath);
}

/**
 * Tier 2: Filename + negative sentiment.
 * Check if the filename appears near negative sentiment phrases.
 */
function checkSentimentMatch(
  hallucinatedPath: string,
  verifierOutput: string,
): boolean {
  const filename = path.basename(hallucinatedPath);
  const lines = verifierOutput.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(filename)) continue;

    // Check this line and adjacent lines (wider window: ±2 lines)
    const window = lines
      .slice(Math.max(0, i - 2), Math.min(lines.length, i + 3))
      .join(" ")
      .toLowerCase();

    for (const phrase of NEGATIVE_SENTIMENT) {
      if (window.includes(phrase)) return true;
    }
  }

  return false;
}

/**
 * Tier 3: Section-based detection.
 * Check if the path or filename appears under a warning/corrective section.
 */
function checkSectionMatch(
  hallucinatedPath: string,
  verifierOutput: string,
): boolean {
  const filename = path.basename(hallucinatedPath);

  for (const sectionPattern of WARNING_SECTIONS) {
    // Use matchAll to find ALL matching sections, not just the first
    for (const match of verifierOutput.matchAll(new RegExp(sectionPattern, "gi"))) {
      const afterSection = verifierOutput.slice(match.index);
      const nextHeading = afterSection.slice(1).search(/^#{1,4}\s/m);
      const sectionText =
        nextHeading === -1
          ? afterSection
          : afterSection.slice(0, nextHeading + 1);

      if (
        sectionText.includes(hallucinatedPath) ||
        sectionText.includes(filename)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Tier 4: Directory mismatch detection.
 * Check if the verifier mentions the correct directory when the hallucinated
 * path uses a wrong directory prefix. E.g., hallucinated "deploy/base/" but
 * verifier mentions "deployments/k8s/base/" with the same filename.
 */
function checkDirectoryCorrection(
  hallucinatedPath: string,
  verifierOutput: string,
  actualFiles: Set<string>,
): boolean {
  const filename = path.basename(hallucinatedPath);

  // Find actual files with the same filename
  for (const actual of actualFiles) {
    if (path.basename(actual) !== filename) continue;
    if (actual === hallucinatedPath) continue; // Not a mismatch

    // The verifier mentions the correct path — implies it knows the hallucinated one is wrong
    if (verifierOutput.includes(actual)) {
      return true;
    }
  }

  return false;
}

/** Parse verifier output to determine which hallucinated paths were detected. */
export function parseDetections(
  hallucinatedPaths: string[],
  verifierOutput: string,
  actualFiles?: Set<string>,
): PathDetection[] {
  return hallucinatedPaths.map((p) => {
    // Try tiers in order of confidence
    if (checkDirectMatch(p, verifierOutput)) {
      return { path: p, detected: true, method: "direct" as const };
    }
    if (checkSentimentMatch(p, verifierOutput)) {
      return { path: p, detected: true, method: "sentiment" as const };
    }
    if (checkSectionMatch(p, verifierOutput)) {
      return { path: p, detected: true, method: "section" as const };
    }
    if (actualFiles && checkDirectoryCorrection(p, verifierOutput, actualFiles)) {
      return { path: p, detected: true, method: "section" as const };
    }
    return { path: p, detected: false, method: null };
  });
}
