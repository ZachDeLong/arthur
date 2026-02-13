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

// --- Schema Detection ---

import type { SchemaDetection } from "./types.js";
import type { SchemaRef } from "./schema-checker.js";

/** Schema-specific negative sentiment phrases. */
const SCHEMA_NEGATIVE_SENTIMENT = [
  ...NEGATIVE_SENTIMENT,
  "not a valid",
  "no such model",
  "no such field",
  "not in the schema",
  "doesn't have",
  "does not have",
  "no field named",
  "no model named",
  "schema does not",
  "schema doesn't",
  "the model is",
  "the field is",
  "the actual",
  "the correct",
  "should use",
  "should be",
  "the schema has",
  "in the schema",
  "not a relation",
  "not a valid method",
  "method does not exist",
  "no such method",
];

/** Parse verifier output to determine which schema hallucinations were detected. */
export function parseSchemaDetections(
  hallucinations: SchemaRef[],
  verifierOutput: string,
): SchemaDetection[] {
  return hallucinations.map((h) => {
    // Build search terms based on the hallucination
    const searchTerms = buildSearchTerms(h);

    // Tier 1: Direct match — the exact hallucinated reference appears in verifier output
    for (const term of searchTerms) {
      if (verifierOutput.includes(term)) {
        // Check if there's negative sentiment nearby
        if (checkSchemaSentiment(term, verifierOutput)) {
          return {
            raw: h.raw,
            category: h.hallucinationCategory!,
            suggestion: h.suggestion,
            detected: true,
            method: "direct" as const,
          };
        }
      }
    }

    // Tier 2: Sentiment match — search term near negative phrases
    for (const term of searchTerms) {
      if (checkSchemaSentiment(term, verifierOutput)) {
        return {
          raw: h.raw,
          category: h.hallucinationCategory!,
          suggestion: h.suggestion,
          detected: true,
          method: "sentiment" as const,
        };
      }
    }

    // Tier 3: Section-based detection — term appears under warning sections
    for (const term of searchTerms) {
      if (checkSectionMatch(term, verifierOutput)) {
        return {
          raw: h.raw,
          category: h.hallucinationCategory!,
          suggestion: h.suggestion,
          detected: true,
          method: "section" as const,
        };
      }
    }

    // Also check if the suggestion (correct name) is mentioned as a correction
    if (h.suggestion) {
      const correctionTerms = [h.suggestion];
      for (const term of correctionTerms) {
        if (verifierOutput.includes(term)) {
          // The verifier mentions the correct name — likely flagging the hallucination
          const nearHallucination = searchTerms.some((st) => {
            const stIdx = verifierOutput.indexOf(st);
            const sugIdx = verifierOutput.indexOf(term);
            if (stIdx === -1 || sugIdx === -1) return false;
            return Math.abs(stIdx - sugIdx) < 500;
          });
          if (nearHallucination) {
            return {
              raw: h.raw,
              category: h.hallucinationCategory!,
              suggestion: h.suggestion,
              detected: true,
              method: "sentiment" as const,
            };
          }
        }
      }
    }

    return {
      raw: h.raw,
      category: h.hallucinationCategory!,
      suggestion: h.suggestion,
      detected: false,
      method: null,
    };
  });
}

/** Build search terms for finding a hallucination reference in verifier output. */
function buildSearchTerms(h: SchemaRef): string[] {
  const terms: string[] = [];

  switch (h.hallucinationCategory) {
    case "hallucinated-model":
      if (h.modelAccessor) {
        terms.push(`prisma.${h.modelAccessor}`);
        terms.push(h.modelAccessor);
        // Also check for PascalCase version
        terms.push(h.modelAccessor[0].toUpperCase() + h.modelAccessor.slice(1));
      }
      break;
    case "hallucinated-field":
      if (h.fieldName) {
        terms.push(h.fieldName);
      }
      break;
    case "invalid-method":
      if (h.methodName) {
        terms.push(h.methodName);
        terms.push(`.${h.methodName}`);
      }
      break;
    case "wrong-relation":
      if (h.fieldName) {
        terms.push(h.fieldName);
        terms.push(`include: { ${h.fieldName}`);
        terms.push(`include: {${h.fieldName}`);
      }
      break;
  }

  return terms;
}

/** Check if a term appears near negative sentiment in the verifier output. */
function checkSchemaSentiment(
  term: string,
  verifierOutput: string,
): boolean {
  const lines = verifierOutput.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(term)) continue;

    // Check wider window (±3 lines for schema context)
    const window = lines
      .slice(Math.max(0, i - 3), Math.min(lines.length, i + 4))
      .join(" ")
      .toLowerCase();

    for (const phrase of SCHEMA_NEGATIVE_SENTIMENT) {
      if (window.includes(phrase)) return true;
    }
  }

  return false;
}
