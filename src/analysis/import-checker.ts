import fs from "node:fs";
import path from "node:path";
import { isJavaScriptSourceFile, type DiffFile } from "../diff/resolver.js";
import type { SourceLocation } from "./registry.js";
import {
  occurrenceLocation,
  occurrenceTouchesChangedLines,
} from "./source-locations.js";
import { extractTypeScriptImports } from "./typescript-source.js";

// --- Types ---

export interface ImportRef {
  raw: string;           // Full source string: 'zod/mini'
  packageName: string;   // 'zod', '@anthropic-ai/sdk'
  subpath?: string;      // 'mini', 'core/streaming'
  valid: boolean;
  reason?: string;       // 'package-not-found', 'subpath-not-exported'
  suggestion?: string;   // Fuzzy match
  file?: string;         // Source file path (source mode only)
  location?: SourceLocation;
}

export interface ImportAnalysis {
  totalImports: number;   // All extracted (including skipped)
  checkedImports: number; // node_modules imports actually validated
  validImports: number;
  hallucinations: ImportRef[];
  hallucinationRate: number;
  skippedImports: number; // Relative/alias/builtin
  unverifiedImports: ImportRef[]; // Declared but unavailable in installed ground truth
}

// --- Node Builtins ---

const NODE_BUILTINS = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process",
  "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http",
  "http2", "https", "inspector", "inspector/promises", "module", "net",
  "os", "path", "path/posix", "path/win32", "perf_hooks", "process",
  "punycode", "querystring", "readline", "readline/promises", "repl",
  "stream", "stream/consumers", "stream/promises", "stream/web",
  "string_decoder", "sys", "test", "timers", "timers/promises", "tls",
  "trace_events", "tty", "url", "util", "util/types", "v8", "vm",
  "wasi", "worker_threads", "zlib",
]);

// --- Extraction ---

interface ImportOccurrence {
  source: string;
  index: number;
  length: number;
}

/** Extract import/require occurrences while retaining their source positions. */
function extractImportOccurrences(sourceText: string): ImportOccurrence[] {
  const occurrences: ImportOccurrence[] = [];
  const seen = new Set<string>();

  const addMatches = (regex: RegExp) => {
    for (const match of sourceText.matchAll(regex)) {
      if (match.index === undefined || !match[1]) continue;
      const source = match[1].trim();
      const relativeIndex = match[0].lastIndexOf(match[1]);
      const index = match.index + Math.max(0, relativeIndex);
      const key = `${index}:${source}`;
      if (!source || seen.has(key)) continue;
      seen.add(key);
      occurrences.push({ source, index, length: source.length });
    }
  };

  // Static imports/exports, including side-effect imports.
  addMatches(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";\n]+?\s+from\s+)?['"]([^'"]+)['"]/g);
  addMatches(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  addMatches(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);

  return occurrences.sort((a, b) => a.index - b.index);
}

/** Extract unique import/require source strings from plan text. */
export function extractImports(planText: string): string[] {
  return [...new Set(extractImportOccurrences(planText).map((occurrence) => occurrence.source))];
}

// --- Classification ---

/** Check if an import source is relative, a local alias, or a Node builtin. */
function shouldSkip(source: string): boolean {
  // Relative imports
  if (source.startsWith("./") || source.startsWith("../")) return true;

  // Local aliases
  if (source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#")) return true;

  // Node builtins
  if (source.startsWith("node:")) return true;
  const base = source.split("/")[0];
  if (NODE_BUILTINS.has(base)) return true;
  // Handle builtins with subpaths like "fs/promises"
  if (NODE_BUILTINS.has(source)) return true;

  return false;
}

/** Parse a package source into package name and optional subpath. */
export function parsePackageName(source: string): { packageName: string; subpath?: string } {
  if (source.startsWith("@")) {
    // Scoped package: @scope/name or @scope/name/subpath
    const parts = source.split("/");
    if (parts.length < 2) {
      return { packageName: source };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
    return { packageName, subpath };
  }

  // Regular package: name or name/subpath
  const slashIndex = source.indexOf("/");
  if (slashIndex === -1) {
    return { packageName: source };
  }
  return {
    packageName: source.substring(0, slashIndex),
    subpath: source.substring(slashIndex + 1),
  };
}

// --- Exports Resolution ---

/**
 * Flatten the `exports` field of a package.json into a set of valid subpath patterns.
 * Handles nested conditional exports ({ import: ..., require: ... }).
 */
function flattenExports(exports: unknown): Set<string> {
  const subpaths = new Set<string>();

  if (typeof exports === "string") {
    // exports: "./index.js" — only root import
    subpaths.add(".");
    return subpaths;
  }

  if (typeof exports !== "object" || exports === null) {
    return subpaths;
  }

  const walk = (obj: Record<string, unknown>) => {
    for (const key of Object.keys(obj)) {
      if (key.startsWith(".")) {
        // This is a subpath pattern like ".", "./foo", "./foo/*"
        subpaths.add(key);
      } else {
        // Conditional key (import, require, default, node, etc.) — recurse
        const val = obj[key];
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          walk(val as Record<string, unknown>);
        }
        // If it's a string, it's a resolved path — the parent key was the subpath
      }
    }
  };

  walk(exports as Record<string, unknown>);
  return subpaths;
}

/**
 * Parse a package.json's exports field into valid subpath patterns.
 * Returns null if the package has no exports field (legacy — skip subpath validation).
 */
export function resolvePackageExports(packageJsonPath: string): Set<string> | null {
  const content = fs.readFileSync(packageJsonPath, "utf-8");
  const pkg = JSON.parse(content);

  if (pkg.exports !== undefined) {
    const subpaths = flattenExports(pkg.exports);
    return subpaths;
  }

  // No exports field — legacy package, only root import is reliable
  if (pkg.main || pkg.module || pkg.types) {
    return null; // Can't validate subpaths, skip
  }

  return null;
}

/** Check if a requested subpath matches the package's valid subpaths. */
function matchSubpath(subpath: string, validSubpaths: Set<string>): boolean {
  const requested = `./${subpath}`;

  // Exact match
  if (validSubpaths.has(requested)) return true;

  // Glob match: "./prefix/*" matches "./prefix/anything"
  for (const pattern of validSubpaths) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2); // "./prefix"
      if (requested.startsWith(prefix + "/")) return true;
    }
    // Wildcard in the middle: "./prefix/*/suffix"
    if (pattern.includes("*")) {
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
      const regex = new RegExp(
        `^${escaped}$`,
      );
      if (regex.test(requested)) return true;
    }
  }

  return false;
}

// --- Fuzzy Suggestions ---

/** Find packages in node_modules that are similar to the requested name. */
function suggestPackage(packageName: string, nodeModulesDir: string): string | undefined {
  if (!fs.existsSync(nodeModulesDir)) return undefined;

  const lower = packageName.toLowerCase();

  try {
    // For scoped packages, check the scope dir
    if (packageName.startsWith("@")) {
      const [scope, name] = packageName.split("/");
      const scopeDir = path.join(nodeModulesDir, scope);
      if (!fs.existsSync(scopeDir)) return undefined;
      const entries = fs.readdirSync(scopeDir);
      for (const entry of entries) {
        if (entry.toLowerCase().includes(name?.toLowerCase() ?? "") ||
            name?.toLowerCase().includes(entry.toLowerCase())) {
          return `${scope}/${entry}`;
        }
      }
      return undefined;
    }

    const entries = fs.readdirSync(nodeModulesDir).filter(e => !e.startsWith("."));
    for (const entry of entries) {
      if (entry === packageName) continue; // Would have been found already
      const entryLower = entry.toLowerCase();
      if (entryLower.includes(lower) || lower.includes(entryLower)) {
        return entry;
      }
    }
  } catch {
    // Permission errors etc.
  }

  return undefined;
}

// --- Package.json Dependency Check ---

/** Cache for parsed package.json deps (per projectDir). Cleared per run via clearImportCaches(). */
const depsCache = new Map<string, Set<string>>();

/** Clear module-level caches. Call before each MCP tool invocation to avoid stale results. */
export function clearImportCaches(): void {
  depsCache.clear();
}

/** Check if a package is listed in the project's package.json dependencies or devDependencies. */
function parseDeclaredDependencies(content: string): Set<string> {
  const allDeps = new Set<string>();
  try {
    const pkg = JSON.parse(content);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkg[field] && typeof pkg[field] === "object") {
        for (const dep of Object.keys(pkg[field])) allDeps.add(dep);
      }
    }
  } catch {
    // Invalid package metadata provides no dependency ground truth.
  }
  return allDeps;
}

/** Check whether a plan explicitly adds a package before importing it. */
function isPlannedDependency(packageName: string, planText: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // A package entry inside an explicit dependency object is an unambiguous
  // declaration of intent. Do not accept arbitrary JSON keys with this name.
  const dependencyObject =
    /["'](?:dependencies|devDependencies|peerDependencies|optionalDependencies)["']\s*:\s*\{([\s\S]*?)\}/gi;
  const packageJsonEntry = new RegExp(
    `["']${escaped}["']\\s*:\\s*["'][^"'\\n]+["']`,
    "i",
  );
  for (const match of planText.matchAll(dependencyObject)) {
    if (packageJsonEntry.test(match[1])) return true;
  }

  // Also accept explicit package-manager installation commands on one line.
  const installCommand = /\b(?:npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+add|bun\s+add)\b/i;
  return planText
    .split("\n")
    .some((line) => installCommand.test(line) && new RegExp(`(?:^|[\\s'"\`])${escaped}(?:$|[\\s'"\`])`, "i").test(line));
}

function isListedDependency(
  packageName: string,
  projectDir: string,
  cache?: Map<string, unknown>,
  override?: Set<string>,
): boolean {
  if (override) return override.has(packageName);
  const cacheKey = `deps:${projectDir}`;
  let allDeps = (cache?.get(cacheKey) as Set<string> | undefined) ?? depsCache.get(projectDir);
  if (!allDeps) {
    allDeps = new Set<string>();
    const pkgPath = path.join(projectDir, "package.json");
    try {
      const content = fs.readFileSync(pkgPath, "utf-8");
      allDeps = parseDeclaredDependencies(content);
    } catch {
      // No package.json or parse error — can't validate
    }
    depsCache.set(projectDir, allDeps);
    if (cache) cache.set(cacheKey, allDeps);
  }
  return allDeps.has(packageName);
}

/** Locate an installed package in the project or a hoisted workspace ancestor. */
function findInstalledPackageJson(packageName: string, projectDir: string): string | null {
  let current = path.resolve(projectDir);
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, "node_modules", packageName, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    if (current === root) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// --- Main Analysis ---

/**
 * Validate a single import source against a project's node_modules / package.json.
 * Returns { ref, skipped } — ref is an ImportRef if hallucinated, null if valid.
 */
function validateImportSource(
  source: string,
  projectDir: string,
  nodeModulesDir: string,
  filePath?: string,
  cache?: Map<string, unknown>,
  declaredDependencies?: Set<string>,
): { ref: ImportRef | null; skipped: boolean; unverified?: ImportRef } {
  if (shouldSkip(source)) {
    return { ref: null, skipped: true };
  }

  const { packageName, subpath } = parsePackageName(source);

  // Check if package exists in node_modules
  const pkgJsonPath = findInstalledPackageJson(packageName, projectDir);
  if (!pkgJsonPath) {
    // A declaration is intent, not installed ground truth. Surface it as an
    // unverified warning instead of silently calling it valid.
    if (isListedDependency(packageName, projectDir, cache, declaredDependencies)) {
      return {
        ref: null,
        skipped: false,
        unverified: {
          raw: source,
          packageName,
          subpath,
          valid: false,
          reason: "declared-not-installed",
          file: filePath,
        },
      };
    }
    const suggestion = suggestPackage(packageName, nodeModulesDir);
    return {
      ref: {
        raw: source,
        packageName,
        subpath,
        valid: false,
        reason: "package-not-found",
        suggestion,
        file: filePath,
      },
      skipped: false,
    };
  }

  // Package exists — check subpath if present
  if (subpath) {
    try {
      const validSubpaths = resolvePackageExports(pkgJsonPath);

      if (validSubpaths !== null) {
        // Package has exports field — validate subpath
        if (!matchSubpath(subpath, validSubpaths)) {
          // List available exports as suggestion
          const available = [...validSubpaths]
            .filter(s => s !== ".")
            .map(s => s.replace(/^\.\//, ""))
            .slice(0, 5);
          const suggestion = available.length > 0
            ? `available: ${available.join(", ")}`
            : undefined;

          return {
            ref: {
              raw: source,
              packageName,
              subpath,
              valid: false,
              reason: "subpath-not-exported",
              suggestion,
              file: filePath,
            },
            skipped: false,
          };
        }
      }
      // No exports field (legacy) — can't validate subpaths, assume valid
    } catch {
      // Parse error on package.json — skip subpath validation
    }
  }

  return { ref: null, skipped: false };
}

/** Analyze imports from DiffFile[] (source mode) — per-file attribution. */
function analyzeImportsFromFiles(files: DiffFile[], projectDir: string, cache?: Map<string, unknown>): ImportAnalysis {
  const nodeModulesDir = path.join(projectDir, "node_modules");
  const hallucinations: ImportRef[] = [];
  const unverifiedImports: ImportRef[] = [];
  let totalImports = 0;
  let skippedImports = 0;
  let checkedImports = 0;
  let validImports = 0;
  const packageJsonOverlay = files.find((file) => file.path === "package.json");
  const declaredDependencies = packageJsonOverlay
    ? packageJsonOverlay.status === "deleted"
      ? new Set<string>()
      : parseDeclaredDependencies(packageJsonOverlay.content)
    : undefined;

  // Cache validation results by package source to avoid redundant fs lookups
  const validatedPackages = new Map<string, ReturnType<typeof validateImportSource>>();

  for (const diffFile of files) {
    if (diffFile.status === "deleted" || !isJavaScriptSourceFile(diffFile.path)) continue;
    const occurrences = extractTypeScriptImports(diffFile.path, diffFile.content)
      .filter((occurrence) => occurrenceTouchesChangedLines(diffFile, occurrence));
    totalImports += occurrences.length;

    for (const occurrence of occurrences) {
      const source = occurrence.source;
      // Check cache first
      let result = validatedPackages.get(source);
      if (!result) {
        result = validateImportSource(
          source,
          projectDir,
          nodeModulesDir,
          undefined,
          cache,
          declaredDependencies,
        );
        validatedPackages.set(source, result);
      }

      if (result.skipped) {
        skippedImports++;
        continue;
      }

      if (result.unverified) {
        unverifiedImports.push({
          ...result.unverified,
          file: diffFile.path,
          location: occurrenceLocation(diffFile, occurrence),
        });
        continue;
      }

      checkedImports++;

      if (result.ref) {
        // Hallucinated — create per-file entry with file attribution
        hallucinations.push({
          ...result.ref,
          file: diffFile.path,
          location: occurrenceLocation(diffFile, occurrence),
        });
      } else {
        validImports++;
      }
    }
  }

  const denominator = checkedImports;
  const hallucinationRate = denominator > 0 ? hallucinations.length / denominator : 0;

  return {
    totalImports,
    checkedImports,
    validImports,
    hallucinations,
    hallucinationRate,
    skippedImports,
    unverifiedImports,
  };
}

/** Analyze imports in plan text or source files against a project's node_modules. */
export function analyzeImports(
  input: string | DiffFile[],
  projectDir: string,
  options?: { mode?: "plan" | "source"; cache?: Map<string, unknown> },
): ImportAnalysis {
  // Source mode: iterate DiffFile[] with per-file attribution
  if (options?.mode === "source" && Array.isArray(input)) {
    return analyzeImportsFromFiles(input as DiffFile[], projectDir, options?.cache);
  }

  // Plan mode (default): extract from plan text string
  const planText = input as string;
  const allSources = extractImports(planText);
  const nodeModulesDir = path.join(projectDir, "node_modules");

  const hallucinations: ImportRef[] = [];
  const unverifiedImports: ImportRef[] = [];
  let skippedImports = 0;
  let checkedImports = 0;
  let validImports = 0;

  for (const source of allSources) {
    const result = validateImportSource(source, projectDir, nodeModulesDir, undefined, options?.cache);

    if (result.skipped) {
      skippedImports++;
      continue;
    }

    if (result.unverified) {
      // In plan mode, package.json is the intended future dependency graph.
      // Source mode is stricter because changed code is expected to run now.
      checkedImports++;
      validImports++;
      continue;
    }

    checkedImports++;

    if (result.ref) {
      if (
        result.ref.reason === "package-not-found" &&
        isPlannedDependency(result.ref.packageName, planText)
      ) {
        // The package is not present in current ground truth, but the plan
        // explicitly adds it before use. Keep that uncertainty visible without
        // mislabeling the intended future dependency as a hallucination.
        unverifiedImports.push({
          ...result.ref,
          reason: "planned-dependency",
        });
        validImports++;
      } else {
        hallucinations.push(result.ref);
      }
    } else {
      validImports++;
    }
  }

  const denominator = checkedImports;
  const hallucinationRate = denominator > 0 ? hallucinations.length / denominator : 0;

  return {
    totalImports: allSources.length,
    checkedImports,
    validImports,
    hallucinations,
    hallucinationRate,
    skippedImports,
    unverifiedImports,
  };
}
