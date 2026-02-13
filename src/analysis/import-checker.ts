import fs from "node:fs";
import path from "node:path";

// --- Types ---

export interface ImportRef {
  raw: string;           // Full source string: 'zod/mini'
  packageName: string;   // 'zod', '@anthropic-ai/sdk'
  subpath?: string;      // 'mini', 'core/streaming'
  valid: boolean;
  reason?: string;       // 'package-not-found', 'subpath-not-exported'
  suggestion?: string;   // Fuzzy match
}

export interface ImportAnalysis {
  totalImports: number;   // All extracted (including skipped)
  checkedImports: number; // node_modules imports actually validated
  validImports: number;
  hallucinations: ImportRef[];
  hallucinationRate: number;
  skippedImports: number; // Relative/alias/builtin
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

/** Extract import/require source strings from plan text (code blocks + inline). */
export function extractImports(planText: string): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();

  const add = (src: string) => {
    const trimmed = src.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      sources.push(trimmed);
    }
  };

  // import ... from 'source' / "source"
  const importFromRegex = /(?:import|export)\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g;
  for (const match of planText.matchAll(importFromRegex)) {
    add(match[1]);
  }

  // require('source') / require("source")
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of planText.matchAll(requireRegex)) {
    add(match[1]);
  }

  // import('source') — dynamic imports
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of planText.matchAll(dynamicImportRegex)) {
    add(match[1]);
  }

  return sources;
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
      const regex = new RegExp(
        "^" + pattern.replace(/\*/g, "[^/]+") + "$",
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

// --- Main Analysis ---

/** Analyze imports in plan text against a project's node_modules. */
export function analyzeImports(planText: string, projectDir: string): ImportAnalysis {
  const allSources = extractImports(planText);
  const nodeModulesDir = path.join(projectDir, "node_modules");

  const hallucinations: ImportRef[] = [];
  let skippedImports = 0;
  let checkedImports = 0;
  let validImports = 0;

  for (const source of allSources) {
    if (shouldSkip(source)) {
      skippedImports++;
      continue;
    }

    checkedImports++;
    const { packageName, subpath } = parsePackageName(source);

    // Check if package exists
    const pkgJsonPath = path.join(nodeModulesDir, packageName, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      const suggestion = suggestPackage(packageName, nodeModulesDir);
      hallucinations.push({
        raw: source,
        packageName,
        subpath,
        valid: false,
        reason: "package-not-found",
        suggestion,
      });
      continue;
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

            hallucinations.push({
              raw: source,
              packageName,
              subpath,
              valid: false,
              reason: "subpath-not-exported",
              suggestion,
            });
            continue;
          }
        }
        // No exports field (legacy) — can't validate subpaths, assume valid
      } catch {
        // Parse error on package.json — skip subpath validation
      }
    }

    validImports++;
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
  };
}
