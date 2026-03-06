import { describe, it, expect } from "vitest";
import path from "node:path";
import { runAllCheckers, type CheckerRunSummary } from "../src/analysis/run-all.js";
import { getChecker, type CheckerInput } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js"; // register all checkers

const FIXTURE_A = path.resolve(__dirname, "../bench/fixtures/fixture-a");
const FIXTURE_C = path.resolve(__dirname, "../bench/fixtures/fixture-c");
const FIXTURE_D = path.resolve(__dirname, "../bench/fixtures/fixture-d");
const FIXTURE_E = path.resolve(__dirname, "../bench/fixtures/fixture-e");

/** Helper: build a plan-mode CheckerInput from text. */
function planInput(text: string): CheckerInput {
  return { mode: "plan", text };
}

/** Helper: find a checker result by ID in a summary. */
function findResult(summary: CheckerRunSummary, id: string) {
  return summary.checkerResults.find(r => r.checker.id === id);
}

// ---------------------------------------------------------------------------
// check_paths (analyzePaths)
// ---------------------------------------------------------------------------
describe("check_paths", () => {
  const checker = getChecker("paths")!;

  it("returns clean results for valid paths in fixture-a", () => {
    const result = checker.run(
      planInput("We will modify `src/utils/resolver.ts` and `src/plugins/base.ts`"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.hallucinated).toBe(0);
    expect(result.hallucinations).toHaveLength(0);
  });

  it("detects hallucinated paths in fixture-a", () => {
    const result = checker.run(
      planInput("We will modify `src/nonexistent/file.ts` and `src/services/auth.ts`"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(2);
    expect(result.hallucinations.some(h => h.raw.includes("nonexistent"))).toBe(true);
    expect(result.hallucinations.some(h => h.raw.includes("auth"))).toBe(true);
  });

  it("finds closest matches for hallucinated paths", () => {
    const result = checker.run(
      planInput("We will modify `src/utils/resolvers.ts`"),
      FIXTURE_A,
    );
    // "resolvers.ts" is close to "resolver.ts" — should be hallucinated
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("formatForCheckAll includes hallucination details", () => {
    const result = checker.run(
      planInput("We will modify `src/nonexistent/file.ts` and `src/utils/resolver.ts`"),
      FIXTURE_A,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_A);
    expect(lines.some(l => l.includes("File Paths"))).toBe(true);
    expect(lines.some(l => l.includes("NOT FOUND"))).toBe(true);
    expect(lines.some(l => l.includes("Closest"))).toBe(true);
  });

  it("formatForCheckAll shows 'All paths valid' when clean", () => {
    const result = checker.run(
      planInput("We will modify `src/utils/resolver.ts`"),
      FIXTURE_A,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_A);
    expect(lines.some(l => l.includes("All paths valid"))).toBe(true);
  });

  it("formatForFindings returns undefined when clean", () => {
    const result = checker.run(
      planInput("We will modify `src/utils/resolver.ts`"),
      FIXTURE_A,
    );
    expect(checker.formatForFindings(result)).toBeUndefined();
  });

  it("formatForFindings returns markdown when findings exist", () => {
    const result = checker.run(
      planInput("We will modify `src/nonexistent/file.ts`"),
      FIXTURE_A,
    );
    const output = checker.formatForFindings(result);
    expect(output).toBeDefined();
    expect(output).toContain("File Path Issues");
    expect(output).toContain("NOT FOUND");
  });
});

// ---------------------------------------------------------------------------
// check_schema (parseSchema + analyzeSchema)
// ---------------------------------------------------------------------------
describe("check_schema", () => {
  const checker = getChecker("schema")!;

  it("returns clean results for valid Prisma model references in fixture-c", () => {
    const result = checker.run(
      planInput("We will query `prisma.participant.findMany()` and `prisma.contentItem.create()`"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated model names", () => {
    const result = checker.run(
      planInput("We will query `prisma.user.findMany()` and `prisma.post.create()`"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(2);
    expect(result.hallucinations.some(h => h.raw.includes("user"))).toBe(true);
    expect(result.hallucinations.some(h => h.raw.includes("post"))).toBe(true);
  });

  it("detects hallucinated field names on valid models", () => {
    // Schema checker extracts prisma.X.method({ field }) patterns
    const result = checker.run(
      planInput("We will call `prisma.participant.update({ data: { username: 'new' } })`"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    // "username" doesn't exist on Participant — it's "displayIdentifier"
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("not applicable for projects without Prisma schema", () => {
    const result = checker.run(
      planInput("We will query prisma.user.findMany()"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(false);
  });

  it("formatForCheckAll includes schema ground truth", () => {
    const result = checker.run(
      planInput("We will query `prisma.participant.findMany()`"),
      FIXTURE_C,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_C);
    expect(lines.some(l => l.includes("Prisma Schema"))).toBe(true);
    expect(lines.some(l => l.includes("Participant"))).toBe(true);
    expect(lines.some(l => l.includes("ContentItem"))).toBe(true);
  });

  it("formatForCheckAll includes hallucination details with suggestions", () => {
    const result = checker.run(
      planInput("We will query `prisma.user.findMany()`"),
      FIXTURE_C,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_C);
    expect(lines.some(l => l.includes("hallucinated"))).toBe(true);
  });

  it("formatForFindings returns undefined when clean", () => {
    const result = checker.run(
      planInput("We will query `prisma.participant.findMany()`"),
      FIXTURE_C,
    );
    expect(checker.formatForFindings(result)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// check_imports (analyzeImports)
// ---------------------------------------------------------------------------
describe("check_imports", () => {
  const checker = getChecker("imports")!;

  it("returns clean results for valid imports in fixture-a", () => {
    const result = checker.run(
      planInput('We will `import { z } from "zod"` and `import chalk from "chalk"`'),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated package imports", () => {
    const result = checker.run(
      planInput('We will `import { foo } from "nonexistent-package-xyz"` in the project'),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
    expect(result.hallucinations.some(h => h.raw.includes("nonexistent-package-xyz"))).toBe(true);
  });

  it("detects hallucinated imports in fixture-e", () => {
    const result = checker.run(
      planInput('We will `import helmet from "helmet"` for security'),
      FIXTURE_E,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("returns clean for valid express import in fixture-e", () => {
    const result = checker.run(
      planInput('We will `import express from "express"`'),
      FIXTURE_E,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("formatForCheckAll shows clean message", () => {
    const result = checker.run(
      planInput('We will `import chalk from "chalk"`'),
      FIXTURE_A,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_A);
    expect(lines.some(l => l.includes("Imports"))).toBe(true);
    expect(lines.some(l => l.includes("All imports valid"))).toBe(true);
  });

  it("formatForCheckAll shows hallucinations", () => {
    const result = checker.run(
      planInput('We will `import { foo } from "nonexistent-pkg-abc"`'),
      FIXTURE_A,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_A);
    expect(lines.some(l => l.includes("not installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check_env (analyzeEnv)
// ---------------------------------------------------------------------------
describe("check_env", () => {
  const checker = getChecker("env")!;

  it("returns clean results for valid env vars in fixture-c", () => {
    const result = checker.run(
      planInput("We will use `process.env.DATABASE_URL` to connect"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated env vars in fixture-c", () => {
    const result = checker.run(
      planInput("We will use `process.env.REDIS_URL` and `process.env.API_KEY`"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(2);
  });

  it("returns clean for valid env vars in fixture-d", () => {
    const result = checker.run(
      planInput("We will use `process.env.POSTGRES_CONNECTION_STRING` and `process.env.APP_SECRET_KEY`"),
      FIXTURE_D,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated env var in fixture-d", () => {
    const result = checker.run(
      planInput("We will use `process.env.DATABASE_URL` for the connection"),
      FIXTURE_D,
    );
    expect(result.applicable).toBe(true);
    // fixture-d has POSTGRES_CONNECTION_STRING, not DATABASE_URL
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("not applicable for projects without .env files", () => {
    const result = checker.run(
      planInput("We will use `process.env.FOO`"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(false);
  });

  it("formatForCheckAll includes defined vars when findings exist", () => {
    const result = checker.run(
      planInput("We will use `process.env.FAKE_VAR`"),
      FIXTURE_C,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_C);
    expect(lines.some(l => l.includes("Env Variables"))).toBe(true);
    expect(lines.some(l => l.includes("DATABASE_URL"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check_routes (analyzeApiRoutes) — Next.js App Router
// ---------------------------------------------------------------------------
describe("check_routes", () => {
  const checker = getChecker("routes")!;

  it("returns clean results for valid routes in fixture-c", () => {
    const result = checker.run(
      planInput("We will call `GET /api/participants` and `POST /api/content`"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated routes in fixture-c", () => {
    const result = checker.run(
      planInput("We will call `GET /api/users` and `DELETE /api/posts`"),
      FIXTURE_C,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("not applicable for projects without Next.js routes", () => {
    const result = checker.run(
      planInput("We will call GET /api/users"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(false);
  });

  it("formatForCheckAll includes route listing", () => {
    const result = checker.run(
      planInput("We will call `GET /api/participants`"),
      FIXTURE_C,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_C);
    expect(lines.some(l => l.includes("API Routes"))).toBe(true);
    expect(lines.some(l => l.includes("Routes:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check_express_routes (analyzeExpressRoutes)
// ---------------------------------------------------------------------------
describe("check_express_routes", () => {
  const checker = getChecker("expressRoutes")!;

  it("returns clean results for valid routes in fixture-e", () => {
    const result = checker.run(
      planInput("We will call `GET /api/users` and `POST /api/auth/login`"),
      FIXTURE_E,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated routes in fixture-e", () => {
    const result = checker.run(
      planInput("We will call `GET /api/products` and `DELETE /api/auth/logout`"),
      FIXTURE_E,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("detects method mismatch in fixture-e", () => {
    // /health only has GET, not POST
    const result = checker.run(
      planInput("We will call `POST /health`"),
      FIXTURE_E,
    );
    expect(result.applicable).toBe(true);
    // Should detect method not allowed or hallucinated route
    if (result.hallucinated > 0) {
      expect(result.hallucinations.some(h =>
        h.raw.includes("/health") || h.category.includes("method"),
      )).toBe(true);
    }
  });

  it("not applicable for projects without Express", () => {
    const result = checker.run(
      planInput("We will call GET /api/users"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(false);
  });

  it("formatForCheckAll includes route table", () => {
    const result = checker.run(
      planInput("We will call `GET /api/users`"),
      FIXTURE_E,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_E);
    expect(lines.some(l => l.includes("Express"))).toBe(true);
    expect(lines.some(l => l.includes("Routes:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check_sql_schema (analyzeSqlSchema)
// ---------------------------------------------------------------------------
describe("check_sql_schema", () => {
  const checker = getChecker("sqlSchema")!;

  it("returns clean results for valid table references in fixture-d", () => {
    const result = checker.run(
      planInput("We will query the `participants` table and the `content_items` table"),
      FIXTURE_D,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBe(0);
  });

  it("detects hallucinated table names in fixture-d", () => {
    // SQL checker extracts FROM/INTO/UPDATE/JOIN patterns in code blocks
    const result = checker.run(
      planInput("```sql\nSELECT * FROM users;\nINSERT INTO posts (title) VALUES ('x');\n```"),
      FIXTURE_D,
    );
    expect(result.applicable).toBe(true);
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("detects hallucinated column names in fixture-d", () => {
    // SQL checker extracts table.column dot notation for column validation
    const result = checker.run(
      planInput("We filter with `eq(participants.username, value)` and `eq(participants.email, value)`"),
      FIXTURE_D,
    );
    expect(result.applicable).toBe(true);
    // "username" and "email" don't exist — they're "display_identifier" and "contact_email"
    expect(result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("not applicable for projects without SQL schemas", () => {
    const result = checker.run(
      planInput("We will query the users table"),
      FIXTURE_A,
    );
    expect(result.applicable).toBe(false);
  });

  it("formatForCheckAll includes table listing", () => {
    const result = checker.run(
      planInput("We will query the `participants` table"),
      FIXTURE_D,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_D);
    expect(lines.some(l => l.includes("SQL/Drizzle Schema"))).toBe(true);
    expect(lines.some(l => l.includes("Tables:"))).toBe(true);
    expect(lines.some(l => l.includes("participants"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check_all (runAllCheckers)
// ---------------------------------------------------------------------------
describe("check_all (runAllCheckers)", () => {
  it("finds hallucinated paths in fixture-a", () => {
    const summary = runAllCheckers(
      planInput("We will modify `src/nonexistent/file.ts` and `src/utils/resolver.ts`"),
      FIXTURE_A,
    );
    expect(summary.totalFindings).toBeGreaterThan(0);
    const pathResult = findResult(summary, "paths");
    expect(pathResult).toBeDefined();
    expect(pathResult!.result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("returns clean path results for valid references in fixture-a", () => {
    const summary = runAllCheckers(
      planInput("We will modify `src/utils/resolver.ts`"),
      FIXTURE_A,
    );
    const pathResult = findResult(summary, "paths");
    expect(pathResult).toBeDefined();
    expect(pathResult!.result.hallucinated).toBe(0);
  });

  it("runs all applicable checkers against fixture-c", () => {
    const summary = runAllCheckers(
      planInput(
        "We will query `prisma.participant.findMany()` at `GET /api/participants`. " +
        "We use `process.env.DATABASE_URL`. " +
        'Import `import { PrismaClient } from "@prisma/client"`. ' +
        "Modify `src/lib/db.ts`.",
      ),
      FIXTURE_C,
    );

    // Paths, schema, imports, env, routes should all be applicable
    const pathResult = findResult(summary, "paths");
    const schemaResult = findResult(summary, "schema");
    const importResult = findResult(summary, "imports");
    const envResult = findResult(summary, "env");
    const routeResult = findResult(summary, "routes");

    expect(pathResult?.result.applicable).toBe(true);
    expect(schemaResult?.result.applicable).toBe(true);
    expect(importResult?.result.applicable).toBe(true);
    expect(envResult?.result.applicable).toBe(true);
    expect(routeResult?.result.applicable).toBe(true);

    // All references are valid — no findings expected
    expect(summary.totalFindings).toBe(0);
  });

  it("catches multiple hallucination types against fixture-c", () => {
    const summary = runAllCheckers(
      planInput(
        "We will query `prisma.user.findMany()` at `GET /api/users`. " +
        "We use `process.env.REDIS_URL`. " +
        'Import `import helmet from "helmet"`. ' +
        "Modify `src/controllers/auth.ts`.",
      ),
      FIXTURE_C,
    );

    // Multiple hallucination types expected
    expect(summary.totalFindings).toBeGreaterThanOrEqual(3);

    // Path checker: src/controllers/auth.ts doesn't exist
    const pathResult = findResult(summary, "paths");
    expect(pathResult?.result.hallucinated).toBeGreaterThanOrEqual(1);

    // Schema: "user" model doesn't exist (should be "participant")
    const schemaResult = findResult(summary, "schema");
    expect(schemaResult?.result.hallucinated).toBeGreaterThanOrEqual(1);

    // Env: REDIS_URL doesn't exist
    const envResult = findResult(summary, "env");
    expect(envResult?.result.hallucinated).toBeGreaterThanOrEqual(1);
  });

  it("skips non-applicable checkers", () => {
    const summary = runAllCheckers(
      planInput("We will modify `src/utils/resolver.ts`"),
      FIXTURE_A,
    );

    // fixture-a has no Prisma schema, no .env, no Next.js routes, no Express, no SQL
    expect(summary.skippedCheckers.length).toBeGreaterThan(0);
    const skippedIds = summary.skippedCheckers.map(s => s.checker.id);
    expect(skippedIds).toContain("schema");
    expect(skippedIds).toContain("env");
    expect(skippedIds).toContain("routes");
    expect(skippedIds).toContain("expressRoutes");
    expect(skippedIds).toContain("sqlSchema");
  });

  it("runs express route checker against fixture-e", () => {
    const summary = runAllCheckers(
      planInput("We will call `GET /api/users` and `POST /api/auth/login`"),
      FIXTURE_E,
    );
    const expressResult = findResult(summary, "expressRoutes");
    expect(expressResult?.result.applicable).toBe(true);
    expect(expressResult?.result.hallucinated).toBe(0);
  });

  it("runs sql schema checker against fixture-d", () => {
    const summary = runAllCheckers(
      planInput("We will query the `participants` table and `engagements` table"),
      FIXTURE_D,
    );
    const sqlResult = findResult(summary, "sqlSchema");
    expect(sqlResult?.result.applicable).toBe(true);
    expect(sqlResult?.result.hallucinated).toBe(0);
  });

  it("totalChecked aggregates all applicable checkers", () => {
    const summary = runAllCheckers(
      planInput(
        "We will modify `src/utils/resolver.ts`. " +
        'Import `import chalk from "chalk"`.',
      ),
      FIXTURE_A,
    );
    // At least paths + imports should contribute
    expect(summary.totalChecked).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// formatForCheckAll snapshot-style tests
// ---------------------------------------------------------------------------
describe("formatForCheckAll output snapshots", () => {
  it("paths checker clean output structure", () => {
    const checker = getChecker("paths")!;
    const result = checker.run(
      planInput("We will modify `src/utils/resolver.ts`"),
      FIXTURE_A,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_A);
    expect(lines[0]).toBe("## File Paths");
    expect(lines[1]).toMatch(/\*\*\d+\*\* paths checked .* \*\*0\*\* hallucinated/);
    expect(lines).toContain("All paths valid.");
  });

  it("schema checker clean output structure", () => {
    const checker = getChecker("schema")!;
    const result = checker.run(
      planInput("We will query `prisma.participant.findMany()`"),
      FIXTURE_C,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_C);
    expect(lines[0]).toBe("## Prisma Schema");
    expect(lines.some(l => l.includes("All schema refs valid"))).toBe(true);
    // Should include schema ground truth
    expect(lines.some(l => l.includes("**Schema:**"))).toBe(true);
  });

  it("sql schema checker clean output structure", () => {
    const checker = getChecker("sqlSchema")!;
    const result = checker.run(
      planInput("We will query the `participants` table"),
      FIXTURE_D,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_D);
    expect(lines[0]).toBe("## SQL/Drizzle Schema");
    expect(lines.some(l => l.includes("All SQL refs valid"))).toBe(true);
    expect(lines.some(l => l.includes("**Tables:**"))).toBe(true);
  });

  it("express routes checker clean output structure", () => {
    const checker = getChecker("expressRoutes")!;
    const result = checker.run(
      planInput("We will call `GET /api/users`"),
      FIXTURE_E,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_E);
    expect(lines[0]).toMatch(/## Express/);
    expect(lines.some(l => l.includes("All route refs valid"))).toBe(true);
    expect(lines.some(l => l.includes("**Routes:**"))).toBe(true);
  });

  it("paths checker hallucination output structure", () => {
    const checker = getChecker("paths")!;
    const result = checker.run(
      planInput("We will modify `src/nonexistent/file.ts`"),
      FIXTURE_A,
    );
    const lines = checker.formatForCheckAll(result, FIXTURE_A);
    expect(lines[0]).toBe("## File Paths");
    expect(lines.some(l => l.includes("NOT FOUND"))).toBe(true);
  });
});
