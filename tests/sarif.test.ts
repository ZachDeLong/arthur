import { describe, expect, it } from "vitest";
import { buildSarifReport } from "../src/analysis/sarif.js";
import type { ArthurReport } from "../src/analysis/finding-schema.js";

describe("buildSarifReport", () => {
  it("emits SARIF 2.1.0 with relative source locations and stable fingerprints", () => {
    const report: ArthurReport = {
      schemaVersion: "1.1",
      timestamp: "2026-09-06T00:00:00.000Z",
      projectDir: "example",
      summary: {
        totalChecked: 1,
        totalFindings: 1,
        totalErrors: 1,
        totalWarnings: 0,
        checkerResults: [],
      },
      findings: [{
        findingId: "abc123",
        checker: "env",
        severity: "error",
        category: "not-in-env-files",
        target: "MISSING_TOKEN",
        message: "Env variable not defined: MISSING_TOKEN",
        location: {
          path: "src/config.ts",
          line: 4,
          column: 15,
          endLine: 4,
          endColumn: 40,
        },
      }],
    };

    const sarif = buildSarifReport(report);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "env/not-in-env-files",
      level: "error",
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: "src/config.ts", uriBaseId: "%SRCROOT%" },
          region: { startLine: 4, startColumn: 15 },
        },
      }],
      partialFingerprints: { "arthurFindingId/v1": "abc123" },
    });
  });
});
