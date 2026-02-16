import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzeApiRoutes, buildRouteIndex, type ApiRouteAnalysis } from "../api-route-checker.js";

registerChecker({
  id: "routes",
  displayName: "API Routes",
  catchKey: "routes",

  run(planText, projectDir): CheckerResult {
    const analysis = analyzeApiRoutes(planText, projectDir);
    return {
      checkerId: "routes",
      checked: analysis.checkedRefs,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: `${h.method ?? ""} ${h.urlPath}`.trim(),
        category: h.hallucinationCategory ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => `${h.method ?? ""} ${h.urlPath}`.trim()),
      applicable: analysis.routesIndexed > 0,
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result, projectDir): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as ApiRouteAnalysis;
    const routeIssues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## API Routes`);
    lines.push(`**${analysis.routesIndexed}** routes indexed, **${analysis.checkedRefs}** refs — **${routeIssues}** hallucinated`);
    if (routeIssues > 0) {
      for (const h of analysis.hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-route" ? "not found" : "method not allowed";
        const method = h.method ? `${h.method} ` : "";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${method}${h.urlPath}\` — ${category}${suggestion}`);
      }
    } else {
      lines.push(`All route refs valid.`);
    }

    const routeIndex = buildRouteIndex(projectDir);
    lines.push(`**Routes:** ${[...routeIndex.entries()].map(([url, r]) => `\`${url}\` [${[...r.methods].join(",")}]`).join(", ")}`);
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as ApiRouteAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### API Route Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} API route hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const category = h.hallucinationCategory === "hallucinated-route" ? "route not found" : "method not allowed";
      const method = h.method ? `${h.method} ` : "";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      lines.push(`- \`${method}${h.urlPath}\` — ${category}${suggestion}`);
    }
    return lines.join("\n");
  },
});
