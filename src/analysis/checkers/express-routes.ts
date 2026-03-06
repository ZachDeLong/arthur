import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeExpressRoutes, buildExpressRouteIndex, type ExpressRouteAnalysis } from "../express-route-checker.js";
import * as log from "../../utils/logger.js";

registerChecker({
  id: "expressRoutes",
  displayName: "Express/Fastify Routes",
  catchKey: "expressRoutes",

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "expressRoutes",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzeExpressRoutes(input.text, projectDir);
    const notApplicableReason = analysis.framework === "none"
      ? "Express/Fastify not detected in package.json"
      : "No Express/Fastify routes indexed";
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
      notApplicableReason: analysis.routesIndexed > 0 ? undefined : notApplicableReason,
      rawAnalysis: analysis,
    };
  },

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as ExpressRouteAnalysis;
    const lines: string[] = [];

    const { checkedRefs, validRefs, hallucinations, routesIndexed, framework } = analysis;

    const frameworkLabel = framework === "both" ? "Express + Fastify"
      : framework === "fastify" ? "Fastify"
      : "Express";

    lines.push(`## ${frameworkLabel} Route Analysis`);
    lines.push(``);

    if (framework === "none") {
      lines.push(`No Express or Fastify dependency found in package.json.`);
      return lines.join("\n");
    }

    if (routesIndexed === 0) {
      lines.push(`${frameworkLabel} detected but no route definitions found in source files.`);
      return lines.join("\n");
    }

    lines.push(`**${routesIndexed}** routes indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

    if (hallucinations.length > 0) {
      lines.push(``);
      lines.push(`### Hallucinated Routes`);
      for (const h of hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-route" ? "route not found" : "method not allowed";
        const method = h.method ? `${h.method} ` : "";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${method}${h.urlPath}\` — ${category}${suggestion}`);
      }
    }

    // Always include full route table as ground truth
    const index = buildExpressRouteIndex(projectDir);
    if (index.size > 0) {
      lines.push(``);
      lines.push(`### Available Routes`);
      for (const [urlPath, routes] of index) {
        const methods = [...new Set(routes.map(r => r.method))].join(", ");
        const file = routes[0].filePath;
        lines.push(`- \`${urlPath}\` [${methods}] → \`${file}\``);
      }
    }

    return lines.join("\n");
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

  formatForCli(result) {
    log.heading(`Static Analysis: ${this.displayName}`);
    log.dim(`  ${result.checked} checked, ${result.hallucinated} hallucinated`);
    for (const finding of result.hallucinations) {
      const label = finding.category === "hallucinated-route" ? "route not found"
        : finding.category === "wrong-method" ? "method not allowed"
        : finding.category;
      const suggestion = finding.suggestion ? ` (${finding.suggestion})` : "";
      log.dim(`  - ${finding.raw} [${label}]${suggestion}`);
    }
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
