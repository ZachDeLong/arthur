import fs from "node:fs";
import path from "node:path";
import { parsePackageName } from "./import-checker.js";
import { parseObjectMembers, parseClassMembers, type TypeMember } from "./type-checker.js";

// --- Types ---

export interface ImportBinding {
  localName: string;       // Local binding name: z, parseEmail, React
  packageName: string;     // Package: 'zod', 'react'
  importKind: "default" | "namespace" | "named";
  originalName?: string;   // For aliased: { parseEmail as validate } → originalName = "parseEmail"
}

export interface PackageApi {
  exports: Set<string>;                          // Top-level export names
  membersByExport: Map<string, Map<string, TypeMember>>;  // class/interface members
}

export interface ApiRef {
  bindingName: string;     // z
  memberName: string;      // isEmail
  raw: string;             // z.isEmail
}

export interface PackageApiHallucination {
  raw: string;
  category: "hallucinated-named-import" | "hallucinated-member";
  packageName: string;
  suggestion?: string;
  availableExports?: string;
}

export interface PackageApiAnalysis {
  totalBindings: number;
  checkedBindings: number;
  checkedMembers: number;
  hallucinations: PackageApiHallucination[];
  applicable: boolean;
}

// --- Node Builtins (duplicated from import-checker — shouldSkip is unexported) ---

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

function shouldSkip(source: string): boolean {
  if (source.startsWith("./") || source.startsWith("../")) return true;
  if (source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#")) return true;
  if (source.startsWith("node:")) return true;
  const base = source.split("/")[0];
  if (NODE_BUILTINS.has(base)) return true;
  if (NODE_BUILTINS.has(source)) return true;
  return false;
}

// --- Universal members to skip ---

const UNIVERSAL_MEMBERS = new Set([
  "toString", "valueOf", "constructor", "then", "catch", "finally",
  "message", "data", "name", "length", "prototype", "apply", "call", "bind",
  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
]);

// --- Code block extraction ---

function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:\w*\n)?([\s\S]*?)```/g;
  for (const match of text.matchAll(regex)) {
    blocks.push(match[1]);
  }
  return blocks;
}

// --- Import Binding Extraction ---

export function extractImportBindings(planText: string): ImportBinding[] {
  const codeBlocks = extractCodeBlocks(planText);
  const codeText = codeBlocks.join("\n");
  const bindings: ImportBinding[] = [];
  const seen = new Set<string>();

  const add = (b: ImportBinding) => {
    const key = `${b.localName}:${b.packageName}:${b.importKind}`;
    if (seen.has(key)) return;
    seen.add(key);
    bindings.push(b);
  };

  // ESM: import ... from 'source'
  // Patterns:
  //   import defaultName from 'pkg'
  //   import * as ns from 'pkg'
  //   import { a, b as c } from 'pkg'
  //   import defaultName, { a } from 'pkg'
  //   import defaultName, * as ns from 'pkg'
  const esmRegex = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of codeText.matchAll(esmRegex)) {
    const specifiers = match[1].trim();
    const source = match[2];
    if (shouldSkip(source)) continue;
    const { packageName } = parsePackageName(source);

    parseEsmSpecifiers(specifiers, packageName, add);
  }

  // CJS: const/let/var name = require('pkg')
  // Patterns:
  //   const z = require('zod')
  //   const { string, number } = require('zod')
  const cjsRegex = /(?:const|let|var)\s+([\w{}\s,:*]+?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of codeText.matchAll(cjsRegex)) {
    const binding = match[1].trim();
    const source = match[2];
    if (shouldSkip(source)) continue;
    const { packageName } = parsePackageName(source);

    if (binding.startsWith("{")) {
      // Destructured require: const { a, b: c } = require('pkg')
      const inner = binding.slice(1, binding.lastIndexOf("}")).trim();
      for (const part of inner.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx !== -1) {
          const originalName = trimmed.slice(0, colonIdx).trim();
          const localName = trimmed.slice(colonIdx + 1).trim();
          add({ localName, packageName, importKind: "named", originalName });
        } else {
          add({ localName: trimmed, packageName, importKind: "named" });
        }
      }
    } else {
      // Default-style require: const z = require('zod')
      add({ localName: binding, packageName, importKind: "default" });
    }
  }

  return bindings;
}

function parseEsmSpecifiers(
  specifiers: string,
  packageName: string,
  add: (b: ImportBinding) => void,
): void {
  // Namespace: * as ns
  const nsMatch = specifiers.match(/^\*\s+as\s+(\w+)$/);
  if (nsMatch) {
    add({ localName: nsMatch[1], packageName, importKind: "namespace" });
    return;
  }

  // Mixed: default, { ... } or default, * as ns
  const mixedBracketMatch = specifiers.match(/^(\w+)\s*,\s*\{([\s\S]*)\}$/);
  if (mixedBracketMatch) {
    add({ localName: mixedBracketMatch[1], packageName, importKind: "default" });
    parseNamedSpecifiers(mixedBracketMatch[2], packageName, add);
    return;
  }

  const mixedNsMatch = specifiers.match(/^(\w+)\s*,\s*\*\s+as\s+(\w+)$/);
  if (mixedNsMatch) {
    add({ localName: mixedNsMatch[1], packageName, importKind: "default" });
    add({ localName: mixedNsMatch[2], packageName, importKind: "namespace" });
    return;
  }

  // Named only: { ... }
  const namedMatch = specifiers.match(/^\{([\s\S]*)\}$/);
  if (namedMatch) {
    parseNamedSpecifiers(namedMatch[1], packageName, add);
    return;
  }

  // Type-only import: import type X from 'pkg' — skip
  if (specifiers.startsWith("type ")) return;

  // Default only: identifier
  if (/^\w+$/.test(specifiers)) {
    add({ localName: specifiers, packageName, importKind: "default" });
  }
}

function parseNamedSpecifiers(
  inner: string,
  packageName: string,
  add: (b: ImportBinding) => void,
): void {
  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Skip type-only imports: type X or type X as Y
    if (trimmed.startsWith("type ")) continue;

    const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (asMatch) {
      add({ localName: asMatch[2], packageName, importKind: "named", originalName: asMatch[1] });
    } else if (/^\w+$/.test(trimmed)) {
      add({ localName: trimmed, packageName, importKind: "named" });
    }
  }
}

// --- Types Entrypoint Resolution ---

export function resolveTypesEntrypoint(packageDir: string): string | null {
  const pkgJsonPath = path.join(packageDir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return null;
  }

  // 1. exports["."].types (recursive descent into conditional exports)
  if (pkg.exports) {
    const typesPath = resolveConditionalTypes(pkg.exports as ExportsField, packageDir);
    if (typesPath) return typesPath;
  }

  // 2. "types" field
  if (typeof pkg.types === "string") {
    const resolved = path.join(packageDir, pkg.types);
    if (fs.existsSync(resolved)) return resolved;
  }

  // 3. "typings" field
  if (typeof pkg.typings === "string") {
    const resolved = path.join(packageDir, pkg.typings);
    if (fs.existsSync(resolved)) return resolved;
  }

  // 4. main with .d.ts substitution
  if (typeof pkg.main === "string") {
    const dtsPath = substituteForDts(path.join(packageDir, pkg.main));
    if (dtsPath) return dtsPath;
  }

  // 5. index.d.ts fallback
  for (const candidate of ["index.d.ts", "index.d.cts", "index.d.mts"]) {
    const resolved = path.join(packageDir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  // 6. Check @types/<package>
  const pkgName = path.basename(packageDir);
  const scope = path.basename(path.dirname(packageDir));
  const atTypesName = scope.startsWith("@") ? `${scope}__${pkgName}` : pkgName;
  const nodeModulesDir = scope.startsWith("@")
    ? path.dirname(path.dirname(packageDir))
    : path.dirname(packageDir);
  const atTypesDir = path.join(nodeModulesDir, "@types", atTypesName);
  if (fs.existsSync(atTypesDir)) {
    return resolveTypesEntrypoint(atTypesDir);
  }

  return null;
}

type ExportsField = string | Record<string, unknown>;

function resolveConditionalTypes(exports: ExportsField, packageDir: string): string | null {
  if (typeof exports === "string") return null;

  // Check for "." entry first (root export)
  const dotEntry = exports["."];
  if (dotEntry !== undefined) {
    return extractTypesFromCondition(dotEntry, packageDir);
  }

  // Maybe it IS the condition map directly (no "." key, has "types"/"import"/etc.)
  return extractTypesFromCondition(exports, packageDir);
}

function extractTypesFromCondition(entry: unknown, packageDir: string): string | null {
  if (typeof entry === "string") {
    // Could be a .d.ts directly
    if (entry.endsWith(".d.ts") || entry.endsWith(".d.cts") || entry.endsWith(".d.mts")) {
      const resolved = path.join(packageDir, entry);
      if (fs.existsSync(resolved)) return resolved;
    }
    return null;
  }
  if (typeof entry !== "object" || entry === null) return null;

  const obj = entry as Record<string, unknown>;

  // Direct "types" key
  if (typeof obj.types === "string") {
    const resolved = path.join(packageDir, obj.types);
    if (fs.existsSync(resolved)) return resolved;
  }

  // Recurse into conditional keys (import, require, default, node, etc.)
  for (const key of Object.keys(obj)) {
    if (key === "types") continue; // Already checked
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const result = extractTypesFromCondition(val, packageDir);
      if (result) return result;
    }
  }

  return null;
}

function substituteForDts(filePath: string): string | null {
  // Try replacing extension with .d.ts, .d.cts, .d.mts
  const base = filePath.replace(/\.(js|cjs|mjs|ts|cts|mts)$/, "");
  for (const ext of [".d.ts", ".d.cts", ".d.mts"]) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// --- .d.ts Export Parsing ---

/** Module-level cache for parsed APIs. Keyed by resolved entrypoint path. */
const apiCache = new Map<string, PackageApi>();

export function parseExportedApi(
  dtsContent: string,
  dtsFilePath: string,
  packageDir: string,
  depth: number = 0,
): PackageApi {
  const MAX_DEPTH = 3;
  const exports = new Set<string>();
  const membersByExport = new Map<string, Map<string, TypeMember>>();

  // 1. export declare function/const/class/interface/type/enum/namespace X
  const declareRegex = /^export\s+declare\s+(?:function|const|let|var|class|abstract\s+class|interface|type|enum|namespace)\s+(\w+)/gm;
  for (const match of dtsContent.matchAll(declareRegex)) {
    exports.add(match[1]);
  }

  // 2. export function/const/class/interface/type/enum X (without declare)
  const exportRegex = /^export\s+(?:function|const|let|var|class|abstract\s+class|interface|type|enum|namespace)\s+(\w+)/gm;
  for (const match of dtsContent.matchAll(exportRegex)) {
    exports.add(match[1]);
  }

  // 3. export { X, Y as Z } — skip type-only
  const exportListRegex = /^export\s*\{([^}]+)\}/gm;
  for (const match of dtsContent.matchAll(exportListRegex)) {
    const inner = match[1];
    for (const part of inner.split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;

      // Check for "from" in the line — that's a re-export with source, handled separately
      // But if we get here, it's a local re-export: export { X }
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        exports.add(asMatch[2]);
      } else if (/^\w+$/.test(trimmed)) {
        exports.add(trimmed);
      }
    }
  }

  // 4. export { X, Y } from './submodule' — add names directly
  const reExportNamedRegex = /^export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm;
  for (const match of dtsContent.matchAll(reExportNamedRegex)) {
    const inner = match[1];
    for (const part of inner.split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        exports.add(asMatch[2]);
      } else if (/^\w+$/.test(trimmed)) {
        exports.add(trimmed);
      }
    }
  }

  // 5. export * from './submodule' — recurse
  if (depth < MAX_DEPTH) {
    const starReExportRegex = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm;
    for (const match of dtsContent.matchAll(starReExportRegex)) {
      const specifier = match[1];
      const resolvedPath = resolveReExportPath(specifier, dtsFilePath, packageDir);
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        try {
          const subContent = fs.readFileSync(resolvedPath, "utf-8");
          const subApi = parseExportedApi(subContent, resolvedPath, packageDir, depth + 1);
          for (const name of subApi.exports) {
            exports.add(name);
          }
          for (const [name, members] of subApi.membersByExport) {
            membersByExport.set(name, members);
          }
        } catch {
          // Can't read sub-module — skip silently
        }
      }
    }

    // export * as ns from './submodule' — add the namespace name
    const starAsRegex = /^export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm;
    for (const match of dtsContent.matchAll(starAsRegex)) {
      exports.add(match[1]);
    }
  }

  // 6. Extract class/interface members for member access validation
  // Interfaces
  const interfaceRegex = /^(?:export\s+(?:declare\s+)?)?interface\s+(\w+)(?:\s+extends\s+[\w\s,<>]+)?\s*\{([\s\S]*?)^\}/gm;
  for (const match of dtsContent.matchAll(interfaceRegex)) {
    const name = match[1];
    if (exports.has(name)) {
      membersByExport.set(name, parseObjectMembers(match[2]));
    }
  }

  // Classes
  const classRegex = /^(?:export\s+(?:declare\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)[\s\S]*?)?\s*\{([\s\S]*?)^\}/gm;
  for (const match of dtsContent.matchAll(classRegex)) {
    const name = match[1];
    if (exports.has(name)) {
      membersByExport.set(name, parseClassMembers(match[2]));
    }
  }

  return { exports, membersByExport };
}

function resolveReExportPath(
  specifier: string,
  currentFile: string,
  packageDir: string,
): string | null {
  // Relative specifier: ./foo or ../foo
  if (specifier.startsWith(".")) {
    const dir = path.dirname(currentFile);
    const base = path.join(dir, specifier);

    // Try direct .d.ts/.d.cts/.d.mts
    for (const ext of [".d.ts", ".d.cts", ".d.mts"]) {
      // Specifier might end in .js/.cjs/.mjs — normalize
      const normalized = base.replace(/\.(js|cjs|mjs)$/, "");
      const candidate = normalized + ext;
      if (fs.existsSync(candidate)) return candidate;
    }

    // Try as directory with index.d.ts
    for (const ext of [".d.ts", ".d.cts", ".d.mts"]) {
      const normalized = base.replace(/\.(js|cjs|mjs)$/, "");
      const candidate = path.join(normalized, "index" + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Bare specifier (cross-package re-export) — look up in node_modules
  // Only do 1 level of cross-package resolution
  const nodeModulesDir = findNodeModulesDir(packageDir);
  if (nodeModulesDir) {
    const { packageName } = parsePackageName(specifier);
    const depDir = path.join(nodeModulesDir, packageName);
    if (fs.existsSync(depDir)) {
      return resolveTypesEntrypoint(depDir);
    }
  }

  return null;
}

function findNodeModulesDir(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "node_modules");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// --- API Ref Extraction ---

export function extractApiRefs(planText: string, bindings: ImportBinding[]): ApiRef[] {
  const codeBlocks = extractCodeBlocks(planText);
  const codeText = codeBlocks.join("\n");
  const refs: ApiRef[] = [];
  const seen = new Set<string>();

  // Build a set of binding names for fast lookup
  const bindingNames = new Set(bindings.map(b => b.localName));

  // Match binding.member or binding.member( patterns
  const memberRegex = /\b(\w+)\.(\w+)\b/g;
  for (const match of codeText.matchAll(memberRegex)) {
    const objName = match[1];
    const memberName = match[2];
    if (!bindingNames.has(objName)) continue;
    if (UNIVERSAL_MEMBERS.has(memberName)) continue;

    const key = `${objName}.${memberName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    refs.push({ bindingName: objName, memberName, raw: key });
  }

  return refs;
}

// --- Fuzzy Suggestions ---

function suggestExportName(hallucinated: string, available: Set<string>): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const name of available) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return name;
    }
  }
  return undefined;
}

// --- Main Analysis ---

export function analyzePackageApi(planText: string, projectDir: string): PackageApiAnalysis {
  const nodeModulesDir = path.join(projectDir, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    return {
      totalBindings: 0,
      checkedBindings: 0,
      checkedMembers: 0,
      hallucinations: [],
      applicable: false,
    };
  }

  const bindings = extractImportBindings(planText);
  if (bindings.length === 0) {
    return {
      totalBindings: 0,
      checkedBindings: 0,
      checkedMembers: 0,
      hallucinations: [],
      applicable: false,
    };
  }

  const hallucinations: PackageApiHallucination[] = [];
  let checkedBindings = 0;
  let checkedMembers = 0;

  // Group bindings by package for efficiency
  const byPackage = new Map<string, ImportBinding[]>();
  for (const b of bindings) {
    const existing = byPackage.get(b.packageName) ?? [];
    existing.push(b);
    byPackage.set(b.packageName, existing);
  }

  // Resolve and parse API per package
  const packageApis = new Map<string, PackageApi>();
  for (const [pkgName] of byPackage) {
    const pkgDir = path.join(nodeModulesDir, pkgName);
    if (!fs.existsSync(pkgDir)) continue;

    const entrypoint = resolveTypesEntrypoint(pkgDir);
    if (!entrypoint) continue;

    // Check cache
    let api = apiCache.get(entrypoint);
    if (!api) {
      try {
        const content = fs.readFileSync(entrypoint, "utf-8");
        api = parseExportedApi(content, entrypoint, pkgDir);
        apiCache.set(entrypoint, api);
      } catch {
        continue;
      }
    }
    packageApis.set(pkgName, api);
  }

  // Validate named imports
  for (const [pkgName, pkgBindings] of byPackage) {
    const api = packageApis.get(pkgName);
    if (!api) continue;

    for (const b of pkgBindings) {
      if (b.importKind !== "named") continue;
      checkedBindings++;

      const exportName = b.originalName ?? b.localName;
      if (!api.exports.has(exportName)) {
        const suggestion = suggestExportName(exportName, api.exports);
        const available = [...api.exports].slice(0, 20).join(", ");
        hallucinations.push({
          raw: `import { ${exportName} } from '${pkgName}'`,
          category: "hallucinated-named-import",
          packageName: pkgName,
          suggestion,
          availableExports: available,
        });
      }
    }
  }

  // Validate member access
  const apiRefs = extractApiRefs(planText, bindings);
  for (const ref of apiRefs) {
    // Find which package this binding belongs to
    const binding = bindings.find(b => b.localName === ref.bindingName);
    if (!binding) continue;

    const api = packageApis.get(binding.packageName);
    if (!api) continue;

    checkedMembers++;

    // For namespace/default imports, check against the flat export set
    if (binding.importKind === "namespace" || binding.importKind === "default") {
      if (!api.exports.has(ref.memberName)) {
        // Also check membersByExport for class/interface members on all exported types
        let foundInMembers = false;
        for (const [, members] of api.membersByExport) {
          if (members.has(ref.memberName)) {
            foundInMembers = true;
            break;
          }
        }
        if (!foundInMembers) {
          const suggestion = suggestExportName(ref.memberName, api.exports);
          const available = [...api.exports].slice(0, 20).join(", ");
          hallucinations.push({
            raw: `${ref.bindingName}.${ref.memberName}`,
            category: "hallucinated-member",
            packageName: binding.packageName,
            suggestion,
            availableExports: available,
          });
        }
      }
    }

    // For named imports, check if the member is on the imported type's members
    if (binding.importKind === "named") {
      const exportName = binding.originalName ?? binding.localName;
      const members = api.membersByExport.get(exportName);
      if (members && !members.has(ref.memberName)) {
        const suggestion = suggestExportName(ref.memberName, new Set(members.keys()));
        hallucinations.push({
          raw: `${ref.bindingName}.${ref.memberName}`,
          category: "hallucinated-member",
          packageName: binding.packageName,
          suggestion,
        });
      }
      // If no members tracked for this export (e.g., it's a function), skip —
      // we can't validate member access on functions without full type resolution.
    }
  }

  return {
    totalBindings: bindings.length,
    checkedBindings,
    checkedMembers,
    hallucinations,
    applicable: packageApis.size > 0,
  };
}
