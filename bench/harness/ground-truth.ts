/**
 * Ground truth extraction from static checker results.
 *
 * Converts the output of all 7 static checkers into a flat
 * list of GroundTruthError objects for unified scoring.
 */

import type { CheckerCategory, GroundTruthError } from "./types.js";
import type { PathAnalysis } from "../../src/analysis/path-checker.js";
import type { SchemaAnalysis } from "../../src/analysis/schema-checker.js";
import type { SqlSchemaAnalysis } from "../../src/analysis/sql-schema-checker.js";
import type { ImportAnalysis } from "../../src/analysis/import-checker.js";
import type { EnvAnalysis } from "../../src/analysis/env-checker.js";
import type { TypeAnalysis } from "../../src/analysis/type-checker.js";
import type { ApiRouteAnalysis } from "../../src/analysis/api-route-checker.js";
import type { ExpressRouteAnalysis } from "../../src/analysis/express-route-checker.js";

export interface AllCheckerResults {
  paths?: PathAnalysis;
  schema?: SchemaAnalysis;
  sqlSchema?: SqlSchemaAnalysis;
  imports?: ImportAnalysis;
  env?: EnvAnalysis;
  types?: TypeAnalysis;
  routes?: ApiRouteAnalysis;
  expressRoutes?: ExpressRouteAnalysis;
}

/** Convert all checker outputs into a flat GroundTruthError array. */
export function extractGroundTruth(results: AllCheckerResults): GroundTruthError[] {
  const errors: GroundTruthError[] = [];

  // Path hallucinations
  if (results.paths) {
    for (const p of results.paths.hallucinatedPaths) {
      errors.push({
        category: "path",
        raw: p,
        description: `Hallucinated file path: ${p}`,
      });
    }
  }

  // Prisma schema hallucinations
  if (results.schema) {
    for (const h of results.schema.hallucinations) {
      errors.push({
        category: "schema",
        raw: h.raw,
        description: `${h.hallucinationCategory}: ${h.raw}`,
        suggestion: h.suggestion,
      });
    }
  }

  // SQL/Drizzle schema hallucinations
  if (results.sqlSchema) {
    for (const h of results.sqlSchema.hallucinations) {
      errors.push({
        category: "sql_schema",
        raw: h.raw,
        description: `${h.hallucinationCategory}: ${h.raw}`,
        suggestion: h.suggestion,
      });
    }
  }

  // Import hallucinations
  if (results.imports) {
    for (const h of results.imports.hallucinations) {
      errors.push({
        category: "import",
        raw: h.raw,
        description: `${h.reason}: ${h.raw}`,
        suggestion: h.suggestion,
      });
    }
  }

  // Env variable hallucinations
  if (results.env) {
    for (const h of results.env.hallucinations) {
      errors.push({
        category: "env",
        raw: h.raw,
        description: `${h.reason}: ${h.varName}`,
        suggestion: h.suggestion,
      });
    }
  }

  // Type hallucinations
  if (results.types) {
    for (const h of results.types.hallucinations) {
      errors.push({
        category: "type",
        raw: h.raw,
        description: `${h.hallucinationCategory}: ${h.raw}`,
        suggestion: h.suggestion,
      });
    }
  }

  // API route hallucinations
  if (results.routes) {
    for (const h of results.routes.hallucinations) {
      errors.push({
        category: "route",
        raw: h.raw,
        description: `${h.hallucinationCategory}: ${h.urlPath}${h.method ? ` (${h.method})` : ""}`,
        suggestion: h.suggestion,
      });
    }
  }

  // Express/Fastify route hallucinations
  if (results.expressRoutes) {
    for (const h of results.expressRoutes.hallucinations) {
      errors.push({
        category: "express_route",
        raw: h.raw,
        description: `${h.hallucinationCategory}: ${h.urlPath}${h.method ? ` (${h.method})` : ""}`,
        suggestion: h.suggestion,
      });
    }
  }

  return errors;
}
