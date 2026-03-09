import { describe, it, expect } from "vitest";
import path from "node:path";
import { getChecker } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js";

const FIXTURE_A = path.resolve(import.meta.dirname, "../bench/fixtures/fixture-a");
const FIXTURE_C = path.resolve(import.meta.dirname, "../bench/fixtures/fixture-c");
const FIXTURE_D = path.resolve(import.meta.dirname, "../bench/fixtures/fixture-d");
const FIXTURE_E = path.resolve(import.meta.dirname, "../bench/fixtures/fixture-e");

describe("False positive regression — valid refs must not be flagged", () => {
  it("paths: existing files produce zero hallucinations", () => {
    const checker = getChecker("paths")!;
    // These files actually exist in fixture-a
    const plan = `
## Plan
Modify \`src/plugins/base.ts\` to add logging.
Update \`src/types/events.ts\` with new event type.
Check \`src/utils/validator.ts\` for edge cases.
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_A);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.hallucinated).toBe(0);
  });

  it("schema: real Prisma models/fields produce zero hallucinations", () => {
    const checker = getChecker("schema")!;
    // fixture-c has models: Participant (displayIdentifier, contactEmail), ContentItem (headline, body)
    const plan = `
## Changes
Query the Participant model to get displayIdentifier.
Also update ContentItem records, checking the headline field.
Use prisma.participant.findMany() and prisma.contentItem.update().
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_C);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("sql_schema: real Drizzle tables/columns produce zero hallucinations", () => {
    const checker = getChecker("sqlSchema")!;
    // fixture-d has tables: participants (displayIdentifier, contactEmail), contentItems (headline, bodyText)
    const plan = `
\`\`\`typescript
SELECT * FROM participants WHERE display_identifier = 'foo';
SELECT headline, body_text FROM content_items;
\`\`\`
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_D);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("imports: installed packages produce zero hallucinations", () => {
    const checker = getChecker("imports")!;
    // fixture-e has express in dependencies
    const plan = `
\`\`\`typescript
import express from "express";
\`\`\`
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_E);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("env: existing env vars produce zero hallucinations", () => {
    const checker = getChecker("env")!;
    // fixture-b has DATABASE_URL, PORT, JWT_SECRET in .env.example
    const FIXTURE_B = path.resolve(import.meta.dirname, "../bench/fixtures/fixture-b");
    const plan = `Check that process.env.PORT is set and process.env.JWT_SECRET is configured.`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_B);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("routes: real Next.js routes produce zero hallucinations", () => {
    const checker = getChecker("routes")!;
    // fixture-c has /api/content and /api/participants routes
    const plan = `
Call \`/api/content\` to fetch content items.
Call \`/api/participants\` to list participants.
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_C);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("express_routes: real Express routes produce zero hallucinations", () => {
    const checker = getChecker("expressRoutes")!;
    // fixture-e has express routes defined in src/routes/
    const plan = `
Send a GET request to \`/health\` to check the server.
Send a POST to \`/api/auth/login\` with credentials.
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_E);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });
});
