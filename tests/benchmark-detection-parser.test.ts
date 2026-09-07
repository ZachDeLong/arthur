import { describe, expect, it } from "vitest";
import { extractGroundTruth } from "../bench/harness/ground-truth.js";
import { parseErrorDetections } from "../bench/harness/unified-detection-parser.js";
import type { SqlSchemaAnalysis } from "../src/analysis/sql-schema-checker.js";

describe("benchmark SQL detection scoring", () => {
  it("scores the semantic table name instead of a parser snippet", () => {
    const sqlSchema = {
      hallucinations: [
        {
          raw: "db.insert(interactions",
          category: "table",
          tableName: "interactions",
          valid: false,
          hallucinationCategory: "hallucinated-table",
        },
      ],
    } as SqlSchemaAnalysis;
    const errors = extractGroundTruth({ sqlSchema });

    expect(errors[0].raw).toBe("interactions");
    expect(
      parseErrorDetections(
        errors,
        "The plan uses interactions, but that table does not exist; use engagements instead.",
      )[0],
    ).toMatchObject({ detected: true });
  });

  it("recognizes an explicit assumed-versus-actual schema table", () => {
    const errors = [
      {
        category: "sql_schema" as const,
        raw: "users",
        description: "hallucinated-table: users",
      },
    ];
    const review = [
      "| Plan assumes | Actual schema |",
      "|---|---|",
      "| `users` table | `participants` table |",
    ].join("\n");

    expect(parseErrorDetections(errors, review)[0]).toMatchObject({
      detected: true,
    });
  });
});

describe("benchmark review normalization", () => {
  it("recognizes negative sentiment split by Markdown formatting", () => {
    const errors = [
      {
        category: "import" as const,
        raw: "@playwright/test",
        description: "package-not-found: @playwright/test",
      },
    ];
    const review = "`@playwright/test` is not in `package.json` and must be installed.";

    expect(parseErrorDetections(errors, review)[0]).toMatchObject({
      detected: true,
    });
  });

  it("treats mock-client and real-client accessors as the same schema reference", () => {
    const errors = [
      {
        category: "schema" as const,
        raw: "mockedPrisma.engagement",
        description: "hallucinated-model: mockedPrisma.engagement",
      },
    ];
    const review = "The engagement accessor does not exist; use participantEngagement.";

    expect(parseErrorDetections(errors, review)[0]).toMatchObject({
      detected: true,
    });
  });
});
