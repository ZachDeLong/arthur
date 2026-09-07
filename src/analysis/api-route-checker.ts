import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { getAllFiles } from "../context/tree.js";
import { isJavaScriptSourceFile, type DiffFile } from "../diff/resolver.js";
import type { SourceLocation } from "./registry.js";
import {
  occurrenceLocation,
  occurrenceTouchesChangedLines,
} from "./source-locations.js";
import { extractTypeScriptRouteRefs } from "./typescript-source.js";
import { createPackageRootResolver, normalizeProjectPath } from "./package-boundary.js";

// --- Types ---

export interface ApiRoute {
  urlPath: string;           // '/api/participants'
  filePath: string;          // 'src/app/api/participants/route.ts'
  methods: Set<string>;      // {'GET', 'POST'}
}

export interface ApiRouteRef {
  raw: string;
  urlPath: string;
  method?: string;
  valid: boolean;
  hallucinationCategory?: "hallucinated-route" | "hallucinated-method";
  suggestion?: string;
  file?: string;
  location?: SourceLocation;
}

export interface ApiRouteAnalysis {
  totalRefs: number;
  checkedRefs: number;
  validRefs: number;
  hallucinations: ApiRouteRef[];
  hallucinationRate: number;
  skippedRefs: number;
  routesIndexed: number;
}

// --- Valid HTTP Methods ---

const VALID_HTTP_METHODS = new Set([
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
]);

// --- Route Indexing ---

/** Convert a filesystem path like 'src/app/api/participants/route.ts' to URL path '/api/participants'. */
export function filePathToUrlPath(filePath: string): string | null {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const appIndex = segments.findIndex((segment, index) => {
    if (segment !== "app") return false;
    const firstUrlSegment = segments
      .slice(index + 1, -1)
      .find((candidate) => !/^\([^)]+\)$/.test(candidate) && !candidate.startsWith("@"));
    return firstUrlSegment === "api";
  });
  if (appIndex === -1) return null;
  if (!/^route\.(?:ts|js|tsx|jsx)$/.test(segments.at(-1) ?? "")) return null;

  const routeSegments = segments
    .slice(appIndex + 1, -1)
    .filter((segment) => !/^\([^)]+\)$/.test(segment) && !segment.startsWith("@"));
  return `/${routeSegments.join("/")}`;
}

/** Parse exported HTTP method handlers from a route file's content. */
export function parseRouteMethods(content: string): Set<string> {
  const methods = new Set<string>();
  const sourceFile = ts.createSourceFile(
    "route.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const isExported = (node: ts.Node): boolean => (
    ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  );

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)
      && isExported(statement)
      && statement.name
      && VALID_HTTP_METHODS.has(statement.name.text)) {
      methods.add(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && VALID_HTTP_METHODS.has(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (VALID_HTTP_METHODS.has(element.name.text)) methods.add(element.name.text);
      }
    }
  }

  return methods;
}

/** Scan project for Next.js App Router route files. */
function collectRoutes(
  projectDir: string,
  diffFiles?: DiffFile[],
): ApiRoute[] {
  const allFiles = getAllFiles(projectDir);
  const routes: ApiRoute[] = [];
  const overlays = new Map(
    (diffFiles ?? []).map((file) => [normalizeProjectPath(file.path), file]),
  );

  for (const file of diffFiles ?? []) {
    if (file.previousPath) allFiles.delete(normalizeProjectPath(file.previousPath));
    const normalized = normalizeProjectPath(file.path);
    if (file.status === "deleted") allFiles.delete(normalized);
    else allFiles.add(normalized);
  }

  for (const filePath of allFiles) {
    // Only match route.{ts,js,tsx,jsx} files inside an app/ directory
    if (!/(?:^|\/)app\//.test(filePath) || !/\/route\.(ts|js|tsx|jsx)$/.test(filePath)) continue;

    const urlPath = filePathToUrlPath(filePath);
    if (!urlPath || !urlPath.startsWith("/api/")) continue;

    // Parse methods from file content
    const fullPath = path.join(projectDir, filePath);
    let methods = new Set<string>();
    try {
      const content = overlays.get(filePath)?.content ?? fs.readFileSync(fullPath, "utf-8");
      methods = parseRouteMethods(content);
    } catch {
      // Can't read file — index with empty methods
    }

    routes.push({ urlPath, filePath, methods });
  }

  return routes;
}

function indexRoutes(routes: ApiRoute[]): Map<string, ApiRoute> {
  const index = new Map<string, ApiRoute>();
  for (const route of routes) index.set(route.urlPath, route);
  return index;
}

/** Scan project for Next.js App Router route files and build a URL → route index. */
export function buildRouteIndex(
  projectDir: string,
  diffFiles?: DiffFile[],
): Map<string, ApiRoute> {
  return indexRoutes(collectRoutes(projectDir, diffFiles));
}

// --- Extraction ---

interface RawApiRef {
  raw: string;
  urlPath: string;
  method?: string;
  index: number;
  length: number;
}

function extractApiRouteOccurrences(
  sourceText: string,
  sourceMode: boolean,
): RawApiRef[] {
  const refs: RawApiRef[] = [];
  const seen = new Set<string>();
  const methodAwareFetches = new Set<number>();

  const add = (
    raw: string,
    urlPath: string,
    method: string | undefined,
    index: number,
  ) => {
    // Normalize: strip query string, trailing slash
    urlPath = urlPath.split("?")[0].replace(/\/$/, "");
    if (!urlPath.startsWith("/api/")) return;
    // Dynamic templates are not deterministic references. Concrete values
    // still match dynamic route segments through matchRoute().
    if (sourceMode && urlPath.includes("${")) return;

    const key = sourceMode
      ? `${index}|${method ?? ""}|${urlPath}`
      : `${method ?? ""}|${urlPath}`;
    if (seen.has(key)) return;
    seen.add(key);

    refs.push({ raw, urlPath, method, index, length: raw.length });
  };

  // fetch('/api/...', { method: 'POST' }) — extract method from nearby options
  const fetchWithMethodRegex = /fetch\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]\s*,\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)['"`]/gi;
  for (const match of sourceText.matchAll(fetchWithMethodRegex)) {
    if (match.index === undefined) continue;
    methodAwareFetches.add(match.index);
    add(match[0], match[1], match[2].toUpperCase(), match.index);
  }

  // fetch('/api/...') or fetch("/api/...")
  const fetchRegex = /fetch\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]/g;
  for (const match of sourceText.matchAll(fetchRegex)) {
    if (match.index === undefined || methodAwareFetches.has(match.index)) continue;
    add(match[0], match[1], "GET", match.index);
  }

  // axios.get('/api/...'), axios.post('/api/...'), etc.
  const axiosRegex = /axios\.(get|post|put|delete|patch)\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]/gi;
  for (const match of sourceText.matchAll(axiosRegex)) {
    if (match.index === undefined) continue;
    add(match[0], match[2], match[1].toUpperCase(), match.index);
  }

  if (!sourceMode) {
    // REST notation and bare backticks are useful in plans but too noisy in
    // source files, where they frequently occur in comments and examples.
    const restRegex = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/api\/\S+)/g;
    for (const match of sourceText.matchAll(restRegex)) {
      if (match.index === undefined) continue;
      const urlPath = match[2].replace(/[`'")\],;.]+$/, "");
      add(match[0], urlPath, match[1], match.index);
    }

    const backtickRegex = /`(\/api\/[^`\s]+)`/g;
    for (const match of sourceText.matchAll(backtickRegex)) {
      if (match.index === undefined) continue;
      add(match[0], match[1], undefined, match.index);
    }
  }

  // new URL('/api/...')
  const urlRegex = /new\s+URL\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]/g;
  for (const match of sourceText.matchAll(urlRegex)) {
    if (match.index === undefined) continue;
    add(match[0], match[1], undefined, match.index);
  }

  return refs.sort((a, b) => a.index - b.index);
}

/** Extract API route references from plan text. */
export function extractApiRouteRefs(planText: string): RawApiRef[] {
  return extractApiRouteOccurrences(planText, false);
}

/** Ignore illustrative routes that the plan explicitly defers to the future. */
function isDeferredPlanRoute(ref: RawApiRef, planText: string): boolean {
  const lineStart = planText.lastIndexOf("\n", ref.index) + 1;
  const nextLine = planText.indexOf("\n", ref.index + ref.length);
  const lineEnd = nextLine === -1 ? planText.length : nextLine;
  const line = planText.slice(lineStart, lineEnd).toLowerCase();

  return (
    /\bif\b[^\n]{0,120}\b(?:later|future)\b/.test(line) ||
    /\b(?:later|future)\b[^\n]{0,80}\b(?:needed|required|desired)\b/.test(line) ||
    /\b(?:hypothetical|future endpoint|deferred endpoint)\b/.test(line)
  );
}

// --- Route Matching ---

/** Try to match a URL path against the route index, including dynamic segments. */
export function matchRoute(urlPath: string, index: Map<string, ApiRoute>): ApiRoute | undefined {
  // 1. Exact match
  if (index.has(urlPath)) return index.get(urlPath);

  // 2. Dynamic segment match — try replacing concrete segments with [param] patterns
  const segments = urlPath.split("/").filter(Boolean);
  for (const [routePath, route] of index) {
    const routeSegments = routePath.split("/").filter(Boolean);

    // Check catch-all first: [...slug] or [[...slug]]
    if (routeSegments.length > 0) {
      const lastSeg = routeSegments[routeSegments.length - 1];
      const requiredCatchAll = /^\[\.\.\.[^\]]+\]$/.test(lastSeg);
      const optionalCatchAll = /^\[\[\.\.\.[^\]]+\]\]$/.test(lastSeg);
      if (requiredCatchAll || optionalCatchAll) {
        // Catch-all: match if URL starts with the same prefix
        const prefixSegments = routeSegments.slice(0, -1);
        const minimumLength = prefixSegments.length + (requiredCatchAll ? 1 : 0);
        if (segments.length >= minimumLength) {
          const prefixMatch = prefixSegments.every((seg, i) => {
            if (seg.startsWith("[") && seg.endsWith("]")) return true;
            return seg === segments[i];
          });
          if (prefixMatch) return route;
        }
      }
    }

    // Same-length match with dynamic segments
    if (routeSegments.length !== segments.length) continue;

    const matches = routeSegments.every((seg, i) => {
      if (seg.startsWith("[") && seg.endsWith("]")) return true; // dynamic segment
      return seg === segments[i];
    });

    if (matches) return route;
  }

  return undefined;
}

// --- Fuzzy Suggestions ---

/** Find the closest URL path in the index by bidirectional substring match on segments. */
function suggestRoute(urlPath: string, index: Map<string, ApiRoute>): string | undefined {
  const segments = urlPath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1]?.toLowerCase();
  if (!lastSegment) return undefined;

  for (const routePath of index.keys()) {
    const routeSegments = routePath.split("/").filter(Boolean);
    const routeLastSegment = routeSegments[routeSegments.length - 1]?.toLowerCase();
    if (!routeLastSegment) continue;

    if (routeLastSegment.includes(lastSegment) || lastSegment.includes(routeLastSegment)) {
      return routePath;
    }
  }

  return undefined;
}

// --- Main Analysis ---

/** Extract route files the plan intends to create and add them to the index. */
function addPlannedRoutes(planText: string, index: Map<string, ApiRoute>): void {
  // Match file paths that look like route files: app/api/.../route.ts
  // Common patterns: "Create: `src/app/api/.../route.ts`", "**Create** `src/app/...`"
  const routeFileRegex = /(?:src\/)?app\/[^\s`'"]+\/route\.(?:ts|js|tsx|jsx)/g;
  for (const match of planText.matchAll(routeFileRegex)) {
    const filePath = match[0];
    const urlPath = filePathToUrlPath(filePath);
    if (urlPath && !index.has(urlPath)) {
      // Add as planned route — assume all methods until file exists
      index.set(urlPath, { urlPath, filePath, methods: new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]) });
    }
  }
}

/** Analyze API route references in plan text against a project's Next.js App Router routes. */
export function analyzeApiRoutes(planText: string, projectDir: string): ApiRouteAnalysis {
  const index = buildRouteIndex(projectDir);

  // Add routes the plan intends to create (so they don't get flagged as hallucinated)
  addPlannedRoutes(planText, index);

  // No App Router routes found — nothing to check against
  if (index.size === 0) {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      skippedRefs: 0,
      routesIndexed: 0,
    };
  }

  const rawRefs = extractApiRouteRefs(planText);

  const hallucinations: ApiRouteRef[] = [];
  let validRefs = 0;
  let skippedRefs = 0;

  for (const ref of rawRefs) {
    if (isDeferredPlanRoute(ref, planText)) {
      skippedRefs++;
      continue;
    }

    const route = matchRoute(ref.urlPath, index);

    if (!route) {
      // Route doesn't exist
      const suggestion = suggestRoute(ref.urlPath, index);
      hallucinations.push({
        raw: ref.raw,
        urlPath: ref.urlPath,
        method: ref.method,
        valid: false,
        hallucinationCategory: "hallucinated-route",
        suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
      });
      continue;
    }

    // Route exists — check method if specified
    if (ref.method && route.methods.size > 0 && !route.methods.has(ref.method)) {
      const validMethods = [...route.methods].join(", ");
      hallucinations.push({
        raw: ref.raw,
        urlPath: ref.urlPath,
        method: ref.method,
        valid: false,
        hallucinationCategory: "hallucinated-method",
        suggestion: `valid methods: ${validMethods}`,
      });
      continue;
    }

    validRefs++;
  }

  const checkedRefs = rawRefs.length - skippedRefs;
  const hallucinationRate = checkedRefs > 0 ? hallucinations.length / checkedRefs : 0;

  return {
    totalRefs: rawRefs.length,
    checkedRefs,
    validRefs,
    hallucinations,
    hallucinationRate,
    skippedRefs,
    routesIndexed: index.size,
  };
}

/** Analyze only static route references that intersect changed source lines. */
export function analyzeApiRouteSourceFiles(
  files: DiffFile[],
  projectDir: string,
): ApiRouteAnalysis {
  const routes = collectRoutes(projectDir, files);
  if (routes.length === 0) {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      skippedRefs: 0,
      routesIndexed: 0,
    };
  }

  const resolvePackageRoot = createPackageRootResolver(projectDir, files);
  const routesByPackage = new Map<string, ApiRoute[]>();
  for (const route of routes) {
    const packageRoot = resolvePackageRoot(route.filePath);
    const packageRoutes = routesByPackage.get(packageRoot) ?? [];
    packageRoutes.push(route);
    routesByPackage.set(packageRoot, packageRoutes);
  }
  const indexes = new Map(
    [...routesByPackage].map(([packageRoot, packageRoutes]) => [packageRoot, indexRoutes(packageRoutes)]),
  );

  const hallucinations: ApiRouteRef[] = [];
  const indexedRouteFiles = new Set<string>();
  let totalRefs = 0;
  let checkedRefs = 0;
  let validRefs = 0;
  let skippedRefs = 0;

  for (const file of files) {
    if (file.status === "deleted" || !isJavaScriptSourceFile(file.path)) continue;
    const refs = extractTypeScriptRouteRefs(file.path, file.content)
      .filter((ref) => occurrenceTouchesChangedLines(file, {
        index: ref.changeIndex,
        length: ref.changeLength,
      }));
    if (refs.length === 0) continue;

    const packageRoot = resolvePackageRoot(file.path);
    const index = indexes.get(packageRoot);
    totalRefs += refs.length;
    if (!index || index.size === 0) {
      // Route files in another package cannot establish ground truth here.
      skippedRefs += refs.length;
      continue;
    }
    for (const route of index.values()) indexedRouteFiles.add(route.filePath);

    for (const ref of refs) {
      checkedRefs++;
      const route = matchRoute(ref.urlPath, index);
      const location = occurrenceLocation(file, ref);

      if (!route) {
        const suggestion = suggestRoute(ref.urlPath, index);
        hallucinations.push({
          raw: ref.raw,
          urlPath: ref.urlPath,
          method: ref.method,
          valid: false,
          hallucinationCategory: "hallucinated-route",
          suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
          file: file.path,
          location,
        });
        continue;
      }

      if (ref.method && route.methods.size > 0 && !route.methods.has(ref.method)) {
        hallucinations.push({
          raw: ref.raw,
          urlPath: ref.urlPath,
          method: ref.method,
          valid: false,
          hallucinationCategory: "hallucinated-method",
          suggestion: `valid methods: ${[...route.methods].join(", ")}`,
          file: file.path,
          location,
        });
        continue;
      }

      validRefs++;
    }
  }

  return {
    totalRefs,
    checkedRefs,
    validRefs,
    hallucinations,
    hallucinationRate: checkedRefs > 0 ? hallucinations.length / checkedRefs : 0,
    skippedRefs,
    routesIndexed: indexedRouteFiles.size,
  };
}
