/**
 * Unified detection parser for all 7 checker categories.
 *
 * Determines whether a self-review LLM output detected each
 * ground-truth error. Uses the proven 3-tier detection structure:
 * direct match → sentiment → section.
 */

import path from "node:path";
import type { GroundTruthError, ErrorDetection, CheckerCategory } from "./types.js";

// --- Negative Sentiment Phrases ---

const BASE_NEGATIVE_SENTIMENT = [
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
  "not in the project",
  "not in the tree",
  "don't see",
  "do not see",
  "cannot locate",
  "can't locate",
  "doesn't match",
  "does not match",
  "incorrect",
  "wrong",
  "doesn't align",
  "does not align",
  "not the actual",
  "actual path is",
  "should be",
  "instead of",
  "rather than",
  "but the project",
  "but the existing",
  "however, the",
  "hallucinated",
  "fabricated",
  "invented",
  "made up",
  "assumed",
];

const SCHEMA_SENTIMENT = [
  ...BASE_NEGATIVE_SENTIMENT,
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
  "the schema has",
  "in the schema",
  "not a relation",
  "no such table",
  "no such column",
  "table does not",
  "column does not",
  "not a valid column",
  "not a valid table",
];

const IMPORT_SENTIMENT = [
  ...BASE_NEGATIVE_SENTIMENT,
  "not installed",
  "not a dependency",
  "not in package.json",
  "not in node_modules",
  "no such package",
  "package not found",
  "module not found",
  "cannot find module",
  "not available",
  "not exported",
  "subpath not",
];

const ENV_SENTIMENT = [
  ...BASE_NEGATIVE_SENTIMENT,
  "not defined",
  "not set",
  "not in .env",
  "not in the env",
  "no such variable",
  "environment variable",
  "env var",
  "not configured",
  "variable name",
];

const TYPE_SENTIMENT = [
  ...BASE_NEGATIVE_SENTIMENT,
  "not a type",
  "no such type",
  "type does not",
  "type doesn't",
  "not an interface",
  "not defined in",
  "no member",
  "not a member",
  "not a property",
  "no property",
  "not a method",
];

const ROUTE_SENTIMENT = [
  ...BASE_NEGATIVE_SENTIMENT,
  "no such route",
  "route does not",
  "route doesn't",
  "endpoint does not",
  "endpoint doesn't",
  "not a valid route",
  "not a valid endpoint",
  "api route",
  "no handler",
  "method not",
];

/** Get the sentiment phrases for a given category. */
function getSentimentPhrases(category: CheckerCategory): string[] {
  switch (category) {
    case "path":
      return BASE_NEGATIVE_SENTIMENT;
    case "schema":
    case "sql_schema":
      return SCHEMA_SENTIMENT;
    case "import":
      return IMPORT_SENTIMENT;
    case "env":
      return ENV_SENTIMENT;
    case "type":
      return TYPE_SENTIMENT;
    case "route":
    case "express_route":
      return ROUTE_SENTIMENT;
  }
}

// --- Warning Section Headings ---

const WARNING_SECTIONS = [
  /#{1,4}\s*(?:concerns?|issues?|problems?|warnings?|errors?|incorrect|wrong|inaccurate)/i,
  /#{1,4}\s*(?:file path|path).*(?:issues?|concerns?|problems?|errors?)/i,
  /#{1,4}\s*(?:non-?existent|missing|hallucinated|incorrect).*(?:files?|paths?|references?)/i,
  /\*\*(?:concerns?|issues?|problems?|warnings?|incorrect|wrong)\*\*/i,
  /#{1,4}\s*(?:correctness|accuracy|verification)/i,
  /#{1,4}\s*(?:risk|critical)/i,
  /#{1,4}\s*(?:alignment|convention|project structure)/i,
  /#{1,4}\s*(?:security|missing|gaps?)/i,
  /#{1,4}\s*(?:schema|database|model|table|column).*(?:issues?|concerns?|problems?|errors?)/i,
  /#{1,4}\s*(?:import|dependency|package).*(?:issues?|concerns?|problems?|errors?)/i,
  /#{1,4}\s*(?:environment|env|config).*(?:issues?|concerns?|problems?|errors?)/i,
  /#{1,4}\s*(?:type|interface|enum).*(?:issues?|concerns?|problems?|errors?)/i,
  /#{1,4}\s*(?:route|endpoint|api).*(?:issues?|concerns?|problems?|errors?)/i,
];

// --- Search Term Builders ---

/** Build search terms for finding a ground-truth error in review output. */
function buildSearchTerms(error: GroundTruthError): string[] {
  const terms: string[] = [];

  switch (error.category) {
    case "path": {
      terms.push(error.raw);
      terms.push(path.basename(error.raw));
      break;
    }
    case "schema": {
      // error.raw is like "prisma.engagement" or "fieldName" or ".methodName"
      terms.push(error.raw);
      // Also try without prefix
      if (error.raw.startsWith("prisma.")) {
        const accessor = error.raw.slice(7);
        terms.push(accessor);
        terms.push(accessor[0].toUpperCase() + accessor.slice(1));
      }
      if (error.raw.startsWith("include: { ")) {
        const relation = error.raw.slice(11, -2);
        terms.push(relation);
      }
      break;
    }
    case "sql_schema": {
      terms.push(error.raw);
      // For "tableName.columnName" refs, also search individual parts
      if (error.raw.includes(".")) {
        const parts = error.raw.split(".");
        terms.push(parts[parts.length - 1]);
      }
      break;
    }
    case "import": {
      terms.push(error.raw);
      // Also search for the package name part
      const slashIdx = error.raw.indexOf("/");
      if (slashIdx > 0 && !error.raw.startsWith("@")) {
        terms.push(error.raw.substring(0, slashIdx));
      }
      break;
    }
    case "env": {
      terms.push(error.raw);
      // For env vars, also try process.env.X pattern
      terms.push(`process.env.${error.raw}`);
      break;
    }
    case "type": {
      terms.push(error.raw);
      // For member refs like "TypeName.member", also search just the member
      if (error.raw.includes(".")) {
        const parts = error.raw.split(".");
        terms.push(parts[0]); // type name alone
      }
      break;
    }
    case "route": {
      terms.push(error.raw);
      // Extract just the URL path
      const urlMatch = error.raw.match(/(\/api\/\S+)/);
      if (urlMatch) {
        terms.push(urlMatch[1]);
      }
      break;
    }
  }

  // Add suggestion as a detection term — if reviewer mentions the correct name,
  // they likely identified the error
  if (error.suggestion) {
    terms.push(error.suggestion);
  }

  return terms.filter(Boolean);
}

// --- Detection Tiers ---

/** Tier 1: Direct match — the search term appears in the output. */
function checkDirectMatch(term: string, output: string): boolean {
  return output.includes(term);
}

/** Tier 2: Term appears near negative sentiment within ±3 lines. */
function checkSentimentMatch(
  term: string,
  output: string,
  sentimentPhrases: string[],
): boolean {
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(term)) continue;

    const window = lines
      .slice(Math.max(0, i - 3), Math.min(lines.length, i + 4))
      .join(" ")
      .toLowerCase();

    for (const phrase of sentimentPhrases) {
      if (window.includes(phrase)) return true;
    }
  }

  return false;
}

/** Tier 3: Term appears under a warning/error section heading. */
function checkSectionMatch(term: string, output: string): boolean {
  for (const sectionPattern of WARNING_SECTIONS) {
    for (const match of output.matchAll(new RegExp(sectionPattern, "gi"))) {
      const afterSection = output.slice(match.index);
      const nextHeading = afterSection.slice(1).search(/^#{1,4}\s/m);
      const sectionText =
        nextHeading === -1
          ? afterSection
          : afterSection.slice(0, nextHeading + 1);

      if (sectionText.includes(term)) {
        return true;
      }
    }
  }

  return false;
}

// --- Main Entry Point ---

/** Parse a review output for detection of each ground-truth error. */
export function parseErrorDetections(
  errors: GroundTruthError[],
  reviewOutput: string,
  actualFiles?: Set<string>,
): ErrorDetection[] {
  return errors.map((error) => {
    const searchTerms = buildSearchTerms(error);
    const sentimentPhrases = getSentimentPhrases(error.category);

    // Tier 1: Direct match + sentiment
    for (const term of searchTerms) {
      if (checkDirectMatch(term, reviewOutput)) {
        if (checkSentimentMatch(term, reviewOutput, sentimentPhrases)) {
          return { error, detected: true, method: "direct" as const };
        }
      }
    }

    // Tier 2: Sentiment-only (term near negative language)
    for (const term of searchTerms) {
      if (checkSentimentMatch(term, reviewOutput, sentimentPhrases)) {
        return { error, detected: true, method: "sentiment" as const };
      }
    }

    // Tier 3: Section-based
    for (const term of searchTerms) {
      if (checkSectionMatch(term, reviewOutput)) {
        return { error, detected: true, method: "section" as const };
      }
    }

    // Tier 4 (paths only): Directory correction
    if (error.category === "path" && actualFiles) {
      const filename = path.basename(error.raw);
      for (const actual of actualFiles) {
        if (path.basename(actual) !== filename) continue;
        if (actual === error.raw) continue;
        if (reviewOutput.includes(actual)) {
          return { error, detected: true, method: "section" as const };
        }
      }
    }

    return { error, detected: false, method: null };
  });
}
