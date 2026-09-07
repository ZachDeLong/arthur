import type { ArthurReport, Finding } from "./finding-schema.js";

export interface SarifLog {
  version: "2.1.0";
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      level: "error" | "warning";
      message: { text: string };
      locations?: Array<{
        physicalLocation: {
          artifactLocation: { uri: string; uriBaseId: "%SRCROOT%" };
          region: {
            startLine: number;
            startColumn: number;
            endLine?: number;
            endColumn?: number;
          };
        };
      }>;
      partialFingerprints: { "arthurFindingId/v1": string };
    }>;
  }>;
}

function ruleId(finding: Finding): string {
  return `${finding.checker}/${finding.category}`;
}

/** Convert Arthur's stable JSON report into SARIF 2.1.0 for code scanning. */
export function buildSarifReport(report: ArthurReport): SarifLog {
  const rulesById = new Map<string, Finding>();
  for (const finding of report.findings) {
    rulesById.set(ruleId(finding), finding);
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: {
        driver: {
          name: "Arthur",
          informationUri: "https://github.com/ZachDeLong/arthur",
          rules: [...rulesById.entries()].map(([id, finding]) => ({
            id,
            name: finding.category,
            shortDescription: { text: finding.message },
          })),
        },
      },
      results: report.findings.map((finding) => ({
        ruleId: ruleId(finding),
        level: finding.severity,
        message: {
          text: finding.suggestion
            ? `${finding.message} (${finding.suggestion})`
            : finding.message,
        },
        ...(finding.location
          ? {
              locations: [{
                physicalLocation: {
                  artifactLocation: {
                    uri: finding.location.path.replace(/\\/g, "/"),
                    uriBaseId: "%SRCROOT%" as const,
                  },
                  region: {
                    startLine: finding.location.line,
                    startColumn: finding.location.column,
                    endLine: finding.location.endLine,
                    endColumn: finding.location.endColumn,
                  },
                },
              }],
            }
          : {}),
        partialFingerprints: {
          "arthurFindingId/v1": finding.findingId,
        },
      })),
    }],
  };
}
