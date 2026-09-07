import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { isJavaScriptSourceFile, type DiffFile } from "../../src/diff/resolver.js";
import { blindId, sha256 } from "./storage.js";
import type {
  CodeContextLine,
  GroundTruthContracts,
  PackageContract,
  ReferenceCase,
  ReferenceDomain,
} from "./types.js";

const BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

interface InventoryOccurrence {
  domain: ReferenceDomain;
  target: string;
  raw: string;
  index: number;
  length: number;
  changeIndex: number;
  changeLength: number;
  methods: string[];
}

function positionAt(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, Math.max(0, Math.min(offset, content.length)));
  const newline = prefix.lastIndexOf("\n");
  return { line: prefix.split("\n").length, column: prefix.length - newline };
}

function touchesChangedLines(file: DiffFile, occurrence: InventoryOccurrence): boolean {
  if (file.changedLines === undefined) return true;
  if (file.changedLines.length === 0) return false;
  const start = positionAt(file.content, occurrence.changeIndex).line;
  const end = positionAt(file.content, occurrence.changeIndex + occurrence.changeLength).line;
  return file.changedLines.some((line) => line >= start && line <= end);
}

function scriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function literalValue(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
}

function methodFromOptions(node: ts.Expression | undefined): string | undefined {
  if (!node) return "GET";
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  for (const item of node.properties) {
    if (!ts.isPropertyAssignment(item) || propertyName(item.name)?.toLowerCase() !== "method") continue;
    return literalValue(item.initializer)?.toUpperCase();
  }
  return "GET";
}

function normalizeRoute(value: string): string | undefined {
  const normalized = value.split("?")[0].replace(/\/$/, "");
  return normalized.startsWith("/api/") && !normalized.includes("${") ? normalized : undefined;
}

function occurrenceKey(item: InventoryOccurrence): string {
  return `${item.domain}\0${item.index}\0${item.target}`;
}

function addOccurrence(
  occurrences: Map<string, InventoryOccurrence>,
  item: Omit<InventoryOccurrence, "methods">,
  method: string,
): void {
  const key = occurrenceKey({ ...item, methods: [] });
  const existing = occurrences.get(key);
  if (existing) {
    if (!existing.methods.includes(method)) existing.methods.push(method);
    existing.methods.sort();
    return;
  }
  occurrences.set(key, { ...item, methods: [method] });
}

function astInventory(filePath: string, content: string): InventoryOccurrence[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const occurrences = new Map<string, InventoryOccurrence>();
  const textOf = (node: ts.Node) => node.getText(sourceFile).replace(/\s+/g, "");
  const addImport = (literal: ts.StringLiteralLike) => addOccurrence(occurrences, {
    domain: "imports",
    target: literal.text,
    raw: literal.text,
    index: literal.getStart(sourceFile) + 1,
    length: literal.text.length,
    changeIndex: literal.getStart(sourceFile),
    changeLength: literal.getWidth(sourceFile),
  }, "independent-ast");
  const addEnv = (node: ts.Node, name: string) => addOccurrence(occurrences, {
    domain: "env",
    target: name,
    raw: node.getText(sourceFile),
    index: node.getStart(sourceFile),
    length: node.getWidth(sourceFile),
    changeIndex: node.getStart(sourceFile),
    changeLength: node.getWidth(sourceFile),
  }, "independent-ast");
  const addRoute = (
    literal: ts.StringLiteralLike,
    owner: ts.Node,
    method?: string,
  ) => {
    const route = normalizeRoute(literal.text);
    if (!route) return;
    addOccurrence(occurrences, {
      domain: "routes",
      target: `${method ?? "ANY"} ${route}`,
      raw: `${method ? `${method} ` : ""}${route}`,
      index: literal.getStart(sourceFile) + 1,
      length: literal.text.length,
      changeIndex: owner.getStart(sourceFile),
      changeLength: owner.getWidth(sourceFile),
    }, "independent-ast");
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addImport(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addImport(node.moduleReference.expression);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const owner = textOf(node.expression);
      const isGetCall = node.name.text === "get" && ts.isCallExpression(node.parent);
      if (!isGetCall && ["process.env", "import.meta.env", "Bun.env"].includes(owner)) {
        addEnv(node, node.name.text);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const owner = textOf(node.expression);
      const name = literalValue(node.argumentExpression);
      if (name && ["process.env", "import.meta.env", "Bun.env"].includes(owner)) addEnv(node, name);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ["process.env", "import.meta.env", "Bun.env"].includes(textOf(node.initializer))
    ) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) continue;
        const name = element.propertyName
          ? propertyName(element.propertyName)
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (name) addEnv(element, name);
      }
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0];
      const value = literalValue(first);
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (value && (isRequire || isDynamicImport) && ts.isStringLiteralLike(first)) addImport(first);

      const callName = textOf(node.expression);
      if (value && ["Deno.env.get", "Bun.env.get"].includes(callName)) addEnv(node, value);
      if (value && ts.isStringLiteralLike(first)) {
        const isFetch = callName === "fetch" || callName === "globalThis.fetch" || callName === "window.fetch";
        if (isFetch) addRoute(first, node, methodFromOptions(node.arguments[1]));
        if (ts.isPropertyAccessExpression(node.expression) && textOf(node.expression.expression) === "axios") {
          const method = node.expression.name.text.toUpperCase();
          if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
            addRoute(first, node, method);
          }
        }
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addRoute(node.arguments[0], node);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return [...occurrences.values()];
}

function lexicalInventory(content: string): InventoryOccurrence[] {
  const occurrences = new Map<string, InventoryOccurrence>();
  const addMatch = (
    domain: ReferenceDomain,
    target: string,
    raw: string,
    index: number,
    length: number,
    matchIndex: number,
    matchLength: number,
  ) => addOccurrence(occurrences, {
    domain,
    target,
    raw,
    index,
    length,
    changeIndex: matchIndex,
    changeLength: matchLength,
  }, "independent-lexical");

  const importPatterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/g,
    /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
  ];
  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      if (match.index === undefined || !match[2]) continue;
      const index = match.index + match[0].lastIndexOf(match[2]);
      addMatch("imports", match[2], match[2], index, match[2].length, match.index, match[0].length);
    }
  }

  const envPatterns = [
    /(?:process|import\.meta|Bun)\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /(?:process|import\.meta|Bun)\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /(?:Deno|Bun)\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  ];
  for (const pattern of envPatterns) {
    for (const match of content.matchAll(pattern)) {
      if (match.index === undefined || !match[1]) continue;
      const after = content.slice(match.index + match[0].length);
      if (match[1] === "get" && /^\s*\(/.test(after)) continue;
      addMatch("env", match[1], match[0], match.index, match[0].length, match.index, match[0].length);
    }
  }

  const fetchPattern = /\b(?:globalThis\.|window\.)?fetch\s*\(\s*(['"])(\/api\/[^'"\r\n]*)\1([\s\S]{0,400}?)(?:\)|;)/g;
  for (const match of content.matchAll(fetchPattern)) {
    if (match.index === undefined || !match[2]) continue;
    const route = normalizeRoute(match[2]);
    if (!route) continue;
    const method = match[3]?.match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/)?.[1]?.toUpperCase() ?? "GET";
    const index = match.index + match[0].indexOf(match[2]);
    addMatch("routes", `${method} ${route}`, `${method} ${route}`, index, match[2].length, match.index, match[0].length);
  }
  const axiosPattern = /\baxios\.(get|post|put|delete|patch|head|options)\s*\(\s*(['"])(\/api\/[^'"\r\n]*)\2/g;
  for (const match of content.matchAll(axiosPattern)) {
    if (match.index === undefined || !match[1] || !match[3]) continue;
    const route = normalizeRoute(match[3]);
    if (!route) continue;
    const method = match[1].toUpperCase();
    const index = match.index + match[0].indexOf(match[3]);
    addMatch("routes", `${method} ${route}`, `${method} ${route}`, index, match[3].length, match.index, match[0].length);
  }
  return [...occurrences.values()];
}

function independentInventory(filePath: string, content: string): InventoryOccurrence[] {
  const combined = new Map<string, InventoryOccurrence>();
  for (const occurrence of [...astInventory(filePath, content), ...lexicalInventory(content)]) {
    const routeIdentity = occurrence.domain === "routes"
      ? occurrence.target.replace(/^[A-Z]+\s+/, "")
      : occurrence.target;
    const key = `${occurrence.domain}\0${occurrence.index}\0${routeIdentity}`;
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, { ...occurrence, methods: [...occurrence.methods] });
      continue;
    }
    existing.methods = [...new Set([...existing.methods, ...occurrence.methods])].sort();
    if (occurrence.domain === "routes" && existing.target !== occurrence.target) {
      const preferOccurrence = occurrence.target.startsWith("ANY ") ||
        (!existing.target.startsWith("ANY ") && occurrence.methods.includes("independent-ast"));
      if (preferOccurrence) {
        existing.target = occurrence.target;
        existing.raw = occurrence.raw;
      }
    }
    existing.changeIndex = Math.min(existing.changeIndex, occurrence.changeIndex);
    const end = Math.max(
      existing.changeIndex + existing.changeLength,
      occurrence.changeIndex + occurrence.changeLength,
    );
    existing.changeLength = end - existing.changeIndex;
  }
  return [...combined.values()].sort((left, right) => left.index - right.index);
}

function isPackageImport(source: string): boolean {
  if (source.startsWith("./") || source.startsWith("../")) return false;
  if (source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#")) return false;
  const withoutPrefix = source.replace(/^node:/, "");
  if (source.startsWith("node:") || BUILTINS.has(withoutPrefix)) return false;
  const base = withoutPrefix.startsWith("@")
    ? withoutPrefix.split("/").slice(0, 2).join("/")
    : withoutPrefix.split("/")[0];
  return !BUILTINS.has(base);
}

function codeContext(file: DiffFile, line: number, radius = 2): CodeContextLine[] {
  const lines = file.content.replace(/\r\n/g, "\n").split("\n");
  const changed = new Set(file.changedLines ?? lines.map((_, index) => index + 1));
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const result: CodeContextLine[] = [];
  for (let current = start; current <= end; current++) {
    result.push({
      line: current,
      text: lines[current - 1] ?? "",
      changed: changed.has(current),
    });
  }
  return result;
}

function addCase(
  cases: ReferenceCase[],
  file: DiffFile,
  changeId: string,
  repositoryId: string,
  domain: ReferenceDomain,
  target: string,
  raw: string,
  occurrence: InventoryOccurrence,
): void {
  const start = positionAt(file.content, occurrence.index);
  const end = positionAt(file.content, occurrence.index + occurrence.length);
  const location = {
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
  const caseId = blindId(
    "c",
    changeId,
    domain,
    file.path,
    String(location.line),
    String(location.column),
    target,
  );
  cases.push({
    caseId,
    changeId,
    repositoryId,
    domain,
    target,
    raw,
    location,
    context: codeContext(file, location.line),
    sourceSha256: sha256(file.content.replace(/\r\n/g, "\n")),
    inventoryMethods: [...occurrence.methods].sort(),
  });
}

export function buildReferenceInventory(
  files: DiffFile[],
  changeId: string,
  repositoryId: string,
): ReferenceCase[] {
  const cases: ReferenceCase[] = [];

  for (const file of files) {
    if (file.status === "deleted" || !isJavaScriptSourceFile(file.path)) continue;

    for (const occurrence of independentInventory(file.path, file.content)) {
      if (occurrence.domain === "imports" && !isPackageImport(occurrence.target)) continue;
      if (!touchesChangedLines(file, occurrence)) continue;
      addCase(
        cases,
        file,
        changeId,
        repositoryId,
        occurrence.domain,
        occurrence.target,
        occurrence.raw,
        occurrence,
      );
    }
  }

  const byId = new Map(cases.map((item) => [item.caseId, item]));
  if (byId.size !== cases.length) throw new Error("Reference inventory produced duplicate case IDs.");
  return [...byId.values()].sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function packageNameForSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function independentEnvContract(projectDir: string): GroundTruthContracts["env"] {
  const filesFound = fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\.env(?:\.|$)/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const definedNames = new Set<string>();
  for (const fileName of filesFound) {
    const content = fs.readFileSync(path.join(projectDir, fileName), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) definedNames.add(match[1]);
    }
  }
  return { filesFound, definedNames: [...definedNames].sort() };
}

function routePathForFile(filePath: string): string | undefined {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";
  if (!/^route\.(?:ts|tsx|js|jsx)$/.test(fileName)) return undefined;
  const appIndex = segments.findIndex((segment, index) => {
    if (segment !== "app") return false;
    const firstRouteSegment = segments
      .slice(index + 1, -1)
      .find((candidate) => !/^\([^)]+\)$/.test(candidate) && !candidate.startsWith("@"));
    return firstRouteSegment === "api";
  });
  if (appIndex < 0) return undefined;
  const routeSegments = segments
    .slice(appIndex + 1, -1)
    .filter((segment) => !/^\([^)]+\)$/.test(segment) && !segment.startsWith("@"));
  return `/${routeSegments.join("/")}`;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

function independentRouteMethods(filePath: string, content: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const methods = new Set<string>();
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      exported(statement) &&
      statement.name &&
      HTTP_METHODS.has(statement.name.text)
    ) {
      methods.add(statement.name.text);
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_METHODS.has(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (HTTP_METHODS.has(element.name.text)) methods.add(element.name.text);
      }
    }
  }
  return [...methods].sort();
}

function independentRoutes(projectDir: string): GroundTruthContracts["routes"] {
  const tracked = execFileSync("git", ["ls-files", "-z", "--"], {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  return tracked.flatMap((filePath) => {
    const urlPath = routePathForFile(filePath);
    if (!urlPath?.startsWith("/api/")) return [];
    const content = fs.readFileSync(path.join(projectDir, filePath), "utf-8");
    return [{
      urlPath,
      filePath: filePath.replace(/\\/g, "/"),
      methods: independentRouteMethods(filePath, content),
    }];
  }).sort((left, right) => left.urlPath.localeCompare(right.urlPath));
}

function projectAncestors(sourcePath: string, projectDir: string): string[] {
  const projectRoot = path.resolve(projectDir);
  const sourceAbsolute = path.resolve(projectRoot, sourcePath);
  const relative = path.relative(projectRoot, sourceAbsolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [projectRoot];

  const result: string[] = [];
  let current = path.dirname(sourceAbsolute);
  while (true) {
    result.push(current);
    if (current === projectRoot) return result;
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

function relativeProjectPath(projectDir: string, filePath: string): string | undefined {
  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.replace(/\\/g, "/");
}

function declaredPackage(
  projectDir: string,
  sourcePath: string,
  packageName: string,
): { version?: string; manifestPath?: string } {
  for (const directory of projectAncestors(sourcePath, projectDir)) {
    const manifestPath = path.join(directory, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      const declared = {
        ...stringMap(manifest.dependencies),
        ...stringMap(manifest.devDependencies),
        ...stringMap(manifest.optionalDependencies),
        ...stringMap(manifest.peerDependencies),
      };
      if (declared[packageName] !== undefined) {
        return {
          version: declared[packageName],
          manifestPath: relativeProjectPath(projectDir, manifestPath),
        };
      }
    } catch {
      // Invalid package metadata provides no frozen dependency fact.
    }
  }
  return {};
}

function installedPackagePath(projectDir: string, sourcePath: string, packageName: string): string | undefined {
  for (const directory of projectAncestors(sourcePath, projectDir)) {
    const candidate = path.join(directory, "node_modules", ...packageName.split("/"), "package.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function packageContract(
  projectDir: string,
  item: ReferenceCase,
): PackageContract {
  const packageName = packageNameForSpecifier(item.target);
  const declared = declaredPackage(projectDir, item.location.path, packageName);
  const packagePath = installedPackagePath(projectDir, item.location.path, packageName);
  if (!packagePath) {
    return {
      caseId: item.caseId,
      packageName,
      sourcePath: item.location.path,
      declaredVersion: declared.version,
      declarationManifestPath: declared.manifestPath,
      installed: false,
    };
  }

  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as Record<string, unknown>;
  const text = (key: string) => typeof manifest[key] === "string" ? manifest[key] as string : undefined;
  return {
    caseId: item.caseId,
    packageName,
    sourcePath: item.location.path,
    declaredVersion: declared.version,
    declarationManifestPath: declared.manifestPath,
    installed: true,
    installedManifest: {
      name: text("name"),
      version: text("version"),
      exports: manifest.exports,
      main: text("main"),
      module: text("module"),
      types: text("types"),
      typings: text("typings"),
    },
  };
}

export function buildGroundTruthContracts(
  projectDir: string,
  files: DiffFile[],
  cases: ReferenceCase[],
): GroundTruthContracts {
  const env = independentEnvContract(projectDir);
  const routes = independentRoutes(projectDir);

  return {
    packages: cases
      .filter((item) => item.domain === "imports")
      .sort((left, right) => left.caseId.localeCompare(right.caseId))
      .map((item) => packageContract(projectDir, item)),
    env: {
      filesFound: [...env.filesFound].sort(),
      definedNames: [...env.definedNames].sort(),
    },
    routes,
  };
}
