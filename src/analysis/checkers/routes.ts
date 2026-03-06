import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeApiRoutes, buildRouteIndex, type ApiRouteAnalysis } from "../api-route-checker.js";
import { printApiRouteAnalysis } from "../formatter.js";

registerChecker({
  id: "routes",
  displayName: "API Routes",
  catchKey: "routes",

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "routes",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzeApiRoutes(input.text, projectDir);
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
      notApplicableReason: analysis.routesIndexed > 0 ? undefined : "No Next.js App Router route files found",
      rawAnalysis: analysis,
    };
  },

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as ApiRouteAnalysis;
    const lines: string[] = [];

    const { checkedRefs, validRefs, hallucinations, routesIndexed } = analysis;

    lines.push(`## API Route Analysis`);
    lines.push(``);

    if (routesIndexed === 0) {
      lines.push(`No Next.js App Router route files found in project.`);
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

    // Always include all available routes as ground truth
    const routeIndex = buildRouteIndex(projectDir);
    if (routeIndex.size > 0) {
      lines.push(``);
      lines.push(`### Available Routes`);
      for (const [urlPath, route] of routeIndex) {
        const methods = route.methods.size > 0 ? [...route.methods].join(", ") : "no exports";
        lines.push(`- \`${urlPath}\` [${methods}] → \`${route.filePath}\``);
      }
    }

    return lines.join("\n");
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

  formatForCli(result) {
    printApiRouteAnalysis(result.rawAnalysis as ApiRouteAnalysis);
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
