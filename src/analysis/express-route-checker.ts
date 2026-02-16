import fs from "node:fs";
import path from "node:path";
import { getAllFiles } from "../context/tree.js";

// --- Types ---

export interface ExpressRoute {
  method: string;           // 'GET', 'POST', etc. or 'ALL'
  urlPath: string;          // '/api/users/:id'
  filePath: string;         // 'src/routes/users.ts'
  mountPrefix?: string;     // '/api/users' if mounted via app.use()
}

export interface ExpressRouteRef {
  raw: string;
  urlPath: string;
  method?: string;
  valid: boolean;
  hallucinationCategory?: "hallucinated-route" | "hallucinated-method";
  suggestion?: string;
}

export interface ExpressRouteAnalysis {
  totalRefs: number;
  checkedRefs: number;
  validRefs: number;
  hallucinations: ExpressRouteRef[];
  hallucinationRate: number;
  skippedRefs: number;
  routesIndexed: number;
  framework: "express" | "fastify" | "both" | "none";
}

// --- Valid HTTP Methods ---

const HTTP_METHODS = new Set([
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "ALL",
]);

// --- Framework Detection ---

/** Check if the project uses Express or Fastify. */
export function detectFramework(projectDir: string): "express" | "fastify" | "both" | "none" {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) return "none";

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const hasExpress = "express" in allDeps;
    const hasFastify = "fastify" in allDeps;

    if (hasExpress && hasFastify) return "both";
    if (hasExpress) return "express";
    if (hasFastify) return "fastify";
    return "none";
  } catch {
    return "none";
  }
}

// --- Route Indexing ---

interface RawRouteDecl {
  method: string;
  path: string;
  filePath: string;
}

interface MountDecl {
  prefix: string;
  routerVar: string;
  filePath: string;
}

/** Extract Express/Fastify route declarations from a source file. */
function extractRouteDecls(content: string, filePath: string): { routes: RawRouteDecl[]; mounts: MountDecl[] } {
  const routes: RawRouteDecl[] = [];
  const mounts: MountDecl[] = [];

  // Match: app.get('/path', ...) / router.get('/path', ...) / app.post('/path', ...) etc.
  // Also handles: fastify.get('/path', ...) / server.get('/path', ...)
  const routeRegex = /\b(\w+)\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi;
  for (const match of content.matchAll(routeRegex)) {
    const method = match[2].toUpperCase();
    if (!HTTP_METHODS.has(method)) continue;
    routes.push({ method, path: match[3], filePath });
  }

  // Match Fastify route() method: fastify.route({ method: 'GET', url: '/path' })
  const fastifyRouteRegex = /\b\w+\.route\s*\(\s*\{[^}]*method\s*:\s*['"`](\w+)['"`][^}]*url\s*:\s*['"`](\/[^'"`]*)['"`]/gi;
  for (const match of content.matchAll(fastifyRouteRegex)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2], filePath });
  }
  // Also handle the reversed order: url first, then method
  const fastifyRouteRegex2 = /\b\w+\.route\s*\(\s*\{[^}]*url\s*:\s*['"`](\/[^'"`]*)['"`][^}]*method\s*:\s*['"`](\w+)['"`]/gi;
  for (const match of content.matchAll(fastifyRouteRegex2)) {
    routes.push({ method: match[2].toUpperCase(), path: match[1], filePath });
  }

  // Match app.use('/prefix', routerVar) — mount prefixes
  const mountRegex = /\b\w+\.use\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*(\w+)\s*\)/g;
  for (const match of content.matchAll(mountRegex)) {
    mounts.push({ prefix: match[1], routerVar: match[2], filePath });
  }

  return { routes, mounts };
}

/** Resolve which file a router variable was imported from. */
function resolveRouterImport(content: string, routerVar: string, filePath: string, projectDir: string): string | undefined {
  // Match: import routerVar from './routes/users'
  const importRegex = new RegExp(`import\\s+(?:\\{[^}]*\\}|${routerVar})\\s+from\\s+['"\`]([^'"\`]+)['"\`]`);
  const match = content.match(importRegex);
  if (match) {
    return resolveRelativePath(match[1], filePath, projectDir);
  }

  // Match: const routerVar = require('./routes/users')
  const requireRegex = new RegExp(`(?:const|let|var)\\s+${routerVar}\\s*=\\s*require\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`);
  const reqMatch = content.match(requireRegex);
  if (reqMatch) {
    return resolveRelativePath(reqMatch[1], filePath, projectDir);
  }

  return undefined;
}

function resolveRelativePath(importPath: string, fromFile: string, projectDir: string): string | undefined {
  if (!importPath.startsWith(".")) return undefined;
  const fromDir = path.dirname(path.join(projectDir, fromFile));
  const resolved = path.resolve(fromDir, importPath);
  const relative = path.relative(projectDir, resolved).replace(/\\/g, "/");

  const allFiles = getAllFiles(projectDir);

  // Direct match first
  if (allFiles.has(relative)) return relative;

  // Strip .js extension and try .ts (common in TS projects with .js imports)
  const base = relative.replace(/\.js$/, "");

  // Try common extensions
  const extensions = [".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"];
  for (const ext of extensions) {
    if (allFiles.has(base + ext)) return base + ext;
  }

  // Try without any extension additions
  for (const ext of extensions) {
    if (allFiles.has(relative + ext)) return relative + ext;
  }

  return undefined;
}

/** Build a complete route index with mount prefix resolution. */
export function buildExpressRouteIndex(projectDir: string): Map<string, ExpressRoute[]> {
  const allFiles = getAllFiles(projectDir);
  const index = new Map<string, ExpressRoute[]>(); // urlPath → routes

  const allRouteDecls: RawRouteDecl[] = [];
  const allMounts: MountDecl[] = [];
  const fileContents = new Map<string, string>();

  // Phase 1: Scan all .ts/.js files for route declarations and mounts
  for (const filePath of allFiles) {
    if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) continue;
    if (filePath.includes("node_modules/")) continue;
    if (filePath.includes(".d.ts")) continue;

    const fullPath = path.join(projectDir, filePath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      fileContents.set(filePath, content);
      const { routes, mounts } = extractRouteDecls(content, filePath);
      allRouteDecls.push(...routes);
      allMounts.push(...mounts);
    } catch {
      // Can't read file — skip
    }
  }

  // Phase 2: Resolve mount prefixes
  // Build a map of file → mount prefix
  const filePrefixes = new Map<string, string>();
  for (const mount of allMounts) {
    const mountContent = fileContents.get(mount.filePath);
    if (!mountContent) continue;

    const resolvedFile = resolveRouterImport(mountContent, mount.routerVar, mount.filePath, projectDir);
    if (resolvedFile) {
      filePrefixes.set(resolvedFile, mount.prefix);
    }
  }

  // Phase 3: Build final index with resolved paths
  for (const decl of allRouteDecls) {
    const prefix = filePrefixes.get(decl.filePath) ?? "";
    const fullPath = normalizePath(prefix + decl.path);

    const route: ExpressRoute = {
      method: decl.method,
      urlPath: fullPath,
      filePath: decl.filePath,
      mountPrefix: prefix || undefined,
    };

    const existing = index.get(fullPath) ?? [];
    existing.push(route);
    index.set(fullPath, existing);
  }

  return index;
}

function normalizePath(urlPath: string): string {
  // Remove double slashes
  return urlPath.replace(/\/\//g, "/").replace(/\/$/, "") || "/";
}

// --- Extraction ---

interface RawExpressRef {
  raw: string;
  urlPath: string;
  method?: string;
}

/** Extract route references from plan text (reuses patterns from api-route-checker). */
export function extractExpressRouteRefs(planText: string): RawExpressRef[] {
  const refs: RawExpressRef[] = [];
  const seen = new Set<string>();

  const add = (raw: string, urlPath: string, method?: string) => {
    urlPath = urlPath.split("?")[0].replace(/\/$/, "") || "/";

    // Skip Next.js-only /api/ routes — the api-route-checker handles those
    // Accept everything else (Express/Fastify routes can start with anything)
    if (!urlPath.startsWith("/")) return;

    const key = `${method ?? ""}|${urlPath}`;
    if (seen.has(key)) return;
    seen.add(key);

    refs.push({ raw, urlPath, method });
  };

  // fetch('/path') or fetch("/path")
  const fetchRegex = /fetch\s*\(\s*['"`](\/[^'"`\s)]+)['"`]/g;
  for (const match of planText.matchAll(fetchRegex)) {
    add(match[0], match[1]);
  }

  // fetch('/path', { method: 'POST' })
  const fetchMethodRegex = /fetch\s*\(\s*['"`](\/[^'"`\s)]+)['"`]\s*,\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)['"`]/gi;
  for (const match of planText.matchAll(fetchMethodRegex)) {
    add(match[0], match[1], match[2].toUpperCase());
  }

  // axios.get('/path'), axios.post('/path'), etc.
  const axiosRegex = /axios\.(get|post|put|delete|patch)\s*\(\s*['"`](\/[^'"`\s)]+)['"`]/gi;
  for (const match of planText.matchAll(axiosRegex)) {
    add(match[0], match[2], match[1].toUpperCase());
  }

  // GET /path, POST /path, etc. (REST notation in prose)
  const restRegex = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S+)/g;
  for (const match of planText.matchAll(restRegex)) {
    const urlPath = match[2].replace(/[`'")\],;.]+$/, "");
    add(match[0], urlPath, match[1]);
  }

  // Bare `/path` in backticks (only if looks like a route)
  const backtickRegex = /`(\/[a-z][^`\s]*)`/gi;
  for (const match of planText.matchAll(backtickRegex)) {
    const urlPath = match[1];
    // Skip file paths (contain dots for extensions)
    if (/\.\w{1,5}$/.test(urlPath)) continue;
    add(match[0], urlPath);
  }

  return refs;
}

// --- Route Matching ---

/** Normalize Express :param segments to match concrete values. */
function matchExpressRoute(
  urlPath: string,
  index: Map<string, ExpressRoute[]>,
): ExpressRoute[] | undefined {
  // 1. Exact match
  if (index.has(urlPath)) return index.get(urlPath);

  // 2. Dynamic segment match (:param)
  const segments = urlPath.split("/").filter(Boolean);
  for (const [routePath, routes] of index) {
    const routeSegments = routePath.split("/").filter(Boolean);
    if (routeSegments.length !== segments.length) continue;

    const matches = routeSegments.every((seg, i) => {
      if (seg.startsWith(":")) return true; // Express dynamic param
      return seg === segments[i];
    });

    if (matches) return routes;
  }

  // 3. Also try matching plan's :param against concrete routes
  for (const [routePath, routes] of index) {
    const routeSegments = routePath.split("/").filter(Boolean);
    if (routeSegments.length !== segments.length) continue;

    const matches = segments.every((seg, i) => {
      if (seg.startsWith(":")) return true; // Plan uses :param notation
      return seg === routeSegments[i];
    });

    if (matches) return routes;
  }

  return undefined;
}

/** Find a fuzzy suggestion for a missing route. */
function suggestExpressRoute(urlPath: string, index: Map<string, ExpressRoute[]>): string | undefined {
  const segments = urlPath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1]?.toLowerCase();
  if (!lastSegment) return undefined;

  for (const routePath of index.keys()) {
    const routeSegments = routePath.split("/").filter(Boolean);
    const routeLastSegment = routeSegments[routeSegments.length - 1]?.toLowerCase();
    if (!routeLastSegment) continue;

    // Skip dynamic segments
    if (routeLastSegment.startsWith(":")) continue;
    if (lastSegment.startsWith(":")) continue;

    if (routeLastSegment.includes(lastSegment) || lastSegment.includes(routeLastSegment)) {
      return routePath;
    }
  }

  return undefined;
}

// --- Main Analysis ---

/** Analyze Express/Fastify route references in plan text against the project. */
export function analyzeExpressRoutes(planText: string, projectDir: string): ExpressRouteAnalysis {
  const framework = detectFramework(projectDir);

  if (framework === "none") {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      skippedRefs: 0,
      routesIndexed: 0,
      framework: "none",
    };
  }

  const index = buildExpressRouteIndex(projectDir);

  if (index.size === 0) {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      skippedRefs: 0,
      routesIndexed: 0,
      framework,
    };
  }

  const rawRefs = extractExpressRouteRefs(planText);

  const hallucinations: ExpressRouteRef[] = [];
  let validRefs = 0;

  for (const ref of rawRefs) {
    const routes = matchExpressRoute(ref.urlPath, index);

    if (!routes) {
      const suggestion = suggestExpressRoute(ref.urlPath, index);
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
    if (ref.method) {
      const methods = new Set(routes.map(r => r.method));
      if (!methods.has(ref.method) && !methods.has("ALL")) {
        const validMethods = [...methods].join(", ");
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
    skippedRefs: 0,
    routesIndexed: index.size,
    framework,
  };
}
