import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzeExpressRoutes, buildExpressRouteIndex, type ExpressRouteAnalysis } from "../express-route-checker.js";

registerChecker({
  id: "expressRoutes",
  displayName: "Express/Fastify Routes",
  catchKey: "expressRoutes",

  run(planText, projectDir): CheckerResult {
    const analysis = analyzeExpressRoutes(planText, projectDir);
    return {
      checkerId: "expressRoutes",
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
    const analysis = result.rawAnalysis as ExpressRouteAnalysis;
    const routeIssues = analysis.hallucinations.length;
    const lines: string[] = [];
    const frameworkLabel = analysis.framework === "both" ? "Express + Fastify"
      : analysis.framework === "fastify" ? "Fastify"
      : "Express";

    lines.push(`## ${frameworkLabel} Routes`);
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

    // Show full route table as ground truth
    const index = buildExpressRouteIndex(projectDir);
    const routeEntries: string[] = [];
    for (const [urlPath, routes] of index) {
      const methods = [...new Set(routes.map(r => r.method))].join(",");
      const file = routes[0].filePath;
      routeEntries.push(`\`${urlPath}\` [${methods}] → \`${file}\``);
    }
    if (routeEntries.length > 0) {
      lines.push(`**Routes:** ${routeEntries.join(", ")}`);
    }
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as ExpressRouteAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const frameworkLabel = analysis.framework === "both" ? "Express/Fastify"
      : analysis.framework === "fastify" ? "Fastify"
      : "Express";

    const lines = [
      `### ${frameworkLabel} Route Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} ${frameworkLabel} route hallucination(s):`,
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
