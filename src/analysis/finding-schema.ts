/**
 * Versioned JSON output schema for Arthur reports.
 *
 * Provides a machine-readable format for CI consumers, trend tracking,
 * and future GitHub Action integration. The markdown output path is unchanged.
 */

import path from "node:path";
import type {
  CheckerResult,
  CheckerDefinition,
  FindingSeverity,
  SourceLocation,
} from "./registry.js";

// --- Schema Types ---

export interface ArthurReport {
  schemaVersion: "1.1";
  timestamp: string;
  projectDir: string;
  summary: {
    totalChecked: number;
    totalFindings: number;
    totalErrors: number;
    totalWarnings: number;
    checkerResults: CheckerSummary[];
  };
  findings: Finding[];
}

export interface CheckerSummary {
  checker: string;
  displayName: string;
  checked: number;
  findings: number;
  applicable: boolean;
}

export interface Finding {
  findingId: string;
  checker: string;
  severity: FindingSeverity;
  category: string;
  target: string;
  message: string;
  suggestion?: string;
  evidence?: string[];
  location?: SourceLocation;
}

// --- Hash Utility ---

/** Simple deterministic string hash (djb2). No crypto dependency needed. */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Generate a deterministic finding ID from checker + category + target. */
function makeFindingId(
  checker: string,
  category: string,
  target: string,
  location?: SourceLocation,
): string {
  const position = location ? `${location.path}:${location.line}:${location.column}` : "";
  return hashString(`${checker}:${category}:${target}:${position}`);
}

// --- Category → Message Mapping ---

const categoryMessages: Record<string, (target: string) => string> = {
  "hallucinated-path": (t) => `Path does not exist: ${t}`,
  "hallucinated-model": (t) => `Prisma model not found: ${t}`,
  "hallucinated-field": (t) => `Prisma field not found: ${t}`,
  "hallucinated-method": (t) => `Invalid Prisma method: ${t}`,
  "wrong-relation": (t) => `Invalid relation: ${t}`,
  "hallucinated-type": (t) => `TypeScript type not found: ${t}`,
  "hallucinated-member": (t) => `TypeScript member not found: ${t}`,
  "hallucinated-table": (t) => `Table not found: ${t}`,
  "hallucinated-column": (t) => `Column not found: ${t}`,
  "hallucinated-function": (t) => `Function not found: ${t}`,
  "hallucinated-route": (t) => `Route not found: ${t}`,
  "wrong-method": (t) => `HTTP method not allowed: ${t}`,
  "package-not-found": (t) => `Package not installed: ${t}`,
  "subpath-not-found": (t) => `Subpath not exported: ${t}`,
  "subpath-not-exported": (t) => `Subpath not exported: ${t}`,
  "hallucinated-env": (t) => `Env variable not defined: ${t}`,
  "not-in-env-files": (t) => `Env variable not defined: ${t}`,
  "declared-not-installed": (t) => `Package is declared but not installed: ${t}`,
};

function messageForCategory(category: string, target: string): string {
  const fn = categoryMessages[category];
  return fn ? fn(target) : `Hallucinated reference: ${target}`;
}

// --- Report Builder ---

export function buildJsonReport(
  checkerResults: { checker: CheckerDefinition; result: CheckerResult }[],
  projectDir: string,
): ArthurReport {
  const findings: Finding[] = [];
  const checkerSummaries: CheckerSummary[] = [];
  let totalChecked = 0;
  let totalFindings = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const { checker, result } of checkerResults) {
    checkerSummaries.push({
      checker: checker.id,
      displayName: checker.displayName,
      checked: result.checked,
      findings: result.hallucinated,
      applicable: result.applicable,
    });

    totalChecked += result.checked;
    totalFindings += result.hallucinated;

    for (const h of result.hallucinations) {
      const severity = h.severity ?? "error";
      if (severity === "warning") totalWarnings++;
      else totalErrors++;
      findings.push({
        findingId: makeFindingId(checker.id, h.category, h.raw, h.location),
        checker: checker.id,
        severity,
        category: h.category,
        target: h.raw,
        message: messageForCategory(h.category, h.raw),
        suggestion: h.suggestion,
        evidence: h.evidence,
        location: h.location,
      });
    }
  }

  return {
    schemaVersion: "1.1",
    timestamp: new Date().toISOString(),
    projectDir: path.basename(projectDir),
    summary: {
      totalChecked,
      totalFindings,
      totalErrors,
      totalWarnings,
      checkerResults: checkerSummaries,
    },
    findings,
  };
}
