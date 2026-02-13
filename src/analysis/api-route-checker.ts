import fs from "node:fs";
import path from "node:path";
import { getAllFiles } from "../context/tree.js";

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
  // Find the app/ prefix
  const appIndex = filePath.indexOf("app/");
  if (appIndex === -1) return null;

  // Strip everything before and including app/, and the route.{ext} suffix
  let urlPath = filePath.slice(appIndex + 4); // after 'app/'
  urlPath = urlPath.replace(/\/route\.(ts|js|tsx|jsx)$/, "");

  // Remove route group segments: (auth), (marketing), etc.
  urlPath = urlPath.replace(/\([^)]+\)\/?/g, "");

  // Remove trailing slash
  urlPath = urlPath.replace(/\/$/, "");

  // Prepend /
  return "/" + urlPath;
}

/** Parse exported HTTP method handlers from a route file's content. */
export function parseRouteMethods(content: string): Set<string> {
  const methods = new Set<string>();

  // Match: export async function GET / export function POST / etc.
  const exportRegex = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
  for (const match of content.matchAll(exportRegex)) {
    methods.add(match[1]);
  }

  // Match: export const GET = ... / export const POST = ...
  const constRegex = /export\s+const\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*=/g;
  for (const match of content.matchAll(constRegex)) {
    methods.add(match[1]);
  }

  return methods;
}

/** Scan project for Next.js App Router route files and build a URL → route index. */
export function buildRouteIndex(projectDir: string): Map<string, ApiRoute> {
  const allFiles = getAllFiles(projectDir);
  const index = new Map<string, ApiRoute>();

  for (const filePath of allFiles) {
    // Only match route.{ts,js,tsx,jsx} files inside an app/ directory
    if (!/app\/.*\/route\.(ts|js|tsx|jsx)$/.test(filePath)) continue;

    const urlPath = filePathToUrlPath(filePath);
    if (!urlPath) continue;

    // Parse methods from file content
    const fullPath = path.join(projectDir, filePath);
    let methods = new Set<string>();
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      methods = parseRouteMethods(content);
    } catch {
      // Can't read file — index with empty methods
    }

    index.set(urlPath, { urlPath, filePath, methods });
  }

  return index;
}

// --- Extraction ---

interface RawApiRef {
  raw: string;
  urlPath: string;
  method?: string;
}

/** Extract API route references from plan text. */
export function extractApiRouteRefs(planText: string): RawApiRef[] {
  const refs: RawApiRef[] = [];
  const seen = new Set<string>();

  const add = (raw: string, urlPath: string, method?: string) => {
    // Normalize: strip query string, trailing slash
    urlPath = urlPath.split("?")[0].replace(/\/$/, "");
    if (!urlPath.startsWith("/api/")) return;

    const key = `${method ?? ""}|${urlPath}`;
    if (seen.has(key)) return;
    seen.add(key);

    refs.push({ raw, urlPath, method });
  };

  // fetch('/api/...') or fetch("/api/...")
  const fetchRegex = /fetch\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]/g;
  for (const match of planText.matchAll(fetchRegex)) {
    add(match[0], match[1]);
  }

  // fetch('/api/...', { method: 'POST' }) — extract method from nearby options
  const fetchWithMethodRegex = /fetch\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]\s*,\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)['"`]/gi;
  for (const match of planText.matchAll(fetchWithMethodRegex)) {
    add(match[0], match[1], match[2].toUpperCase());
  }

  // axios.get('/api/...'), axios.post('/api/...'), etc.
  const axiosRegex = /axios\.(get|post|put|delete|patch)\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]/gi;
  for (const match of planText.matchAll(axiosRegex)) {
    add(match[0], match[2], match[1].toUpperCase());
  }

  // GET /api/..., POST /api/..., etc. (REST notation in prose)
  const restRegex = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/api\/\S+)/g;
  for (const match of planText.matchAll(restRegex)) {
    const urlPath = match[2].replace(/[`'")\],;.]+$/, ""); // strip trailing punctuation
    add(match[0], urlPath, match[1]);
  }

  // Bare `/api/...` in backticks
  const backtickRegex = /`(\/api\/[^`\s]+)`/g;
  for (const match of planText.matchAll(backtickRegex)) {
    add(match[0], match[1]);
  }

  // new URL('/api/...')
  const urlRegex = /new\s+URL\s*\(\s*['"`](\/api\/[^'"`\s)]+)['"`]/g;
  for (const match of planText.matchAll(urlRegex)) {
    add(match[0], match[1]);
  }

  return refs;
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
      if (/^\[\.\.\./.test(lastSeg) || /^\[\[\.\.\./.test(lastSeg)) {
        // Catch-all: match if URL starts with the same prefix
        const prefixSegments = routeSegments.slice(0, -1);
        if (segments.length >= prefixSegments.length) {
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

/** Analyze API route references in plan text against a project's Next.js App Router routes. */
export function analyzeApiRoutes(planText: string, projectDir: string): ApiRouteAnalysis {
  const index = buildRouteIndex(projectDir);

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

  const checkedRefs = rawRefs.length;
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
