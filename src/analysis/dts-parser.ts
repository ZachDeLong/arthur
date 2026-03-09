/**
 * TypeScript Compiler API parser for .d.ts files.
 *
 * Uses ts.createSourceFile() (parser only, no type checker) to extract exported
 * names and members from declaration files. This replaces fragile regex-based
 * parsing that breaks on nested generics, string literals with braces, and
 * comments containing braces.
 *
 * TypeScript is loaded dynamically — returns null if unavailable at runtime
 * (no production dependency).
 */

import type { TypeMember } from "./member-parser.js";

// Module-level reference to dynamically loaded TypeScript module
let tsModule: typeof import("typescript") | null = null;

/**
 * Pre-load the TypeScript module once. Must be called before parseDtsExports().
 * Returns true if TypeScript is available, false otherwise.
 */
export async function initTsParser(): Promise<boolean> {
  if (tsModule) return true;
  try {
    tsModule = await import("typescript");
    return true;
  } catch {
    return false;
  }
}

/** Result of parsing a .d.ts file. */
export interface DtsParseResult {
  exports: Set<string>;
  membersByExport: Map<string, Map<string, TypeMember>>;
}

/**
 * Parse .d.ts file content using TypeScript's Compiler API and extract:
 * - All exported names (functions, constants, classes, interfaces, types, enums, namespaces, export lists)
 * - Members of exported classes/interfaces/enums (for member-access validation)
 *
 * Returns null if TypeScript is not available (initTsParser() not called or failed).
 */
export function parseDtsExports(content: string): DtsParseResult | null {
  if (!tsModule) return null;
  const ts = tsModule;

  const sourceFile = ts.createSourceFile(
    "module.d.ts",
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const exports = new Set<string>();
  const membersByExport = new Map<string, Map<string, TypeMember>>();

  for (const stmt of sourceFile.statements) {
    // Handle export declarations: export { X, Y }, export { X } from '...',
    // export * from '...', export * as ns from '...'
    if (ts.isExportDeclaration(stmt)) {
      handleExportDeclaration(ts, stmt, exports);
      continue;
    }

    // Only process statements with export modifier
    if (!hasExportModifier(ts, stmt)) continue;

    // Extract the exported name
    const name = getDeclarationName(ts, stmt);
    if (name) {
      exports.add(name);
    }

    // Extract members for classes, interfaces, enums, and type aliases
    if (name) {
      const members = extractMembers(ts, stmt);
      if (members && members.size > 0) {
        membersByExport.set(name, members);
      }
    }
  }

  return { exports, membersByExport };
}

// --- Internal helpers ---

function hasExportModifier(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function handleExportDeclaration(
  ts: typeof import("typescript"),
  decl: import("typescript").ExportDeclaration,
  exports: Set<string>,
): void {
  // export * from '...' — skip (caller does file resolution)
  // export * as ns from '...' — skip (caller does file resolution)
  if (!decl.exportClause) return;

  // export { X, Y } or export { X, Y } from '...'
  if (ts.isNamedExports(decl.exportClause)) {
    for (const element of decl.exportClause.elements) {
      // Skip type-only: export { type Foo }
      if (element.isTypeOnly) continue;
      // Use the exported name (propertyName is the original, name is the alias)
      exports.add(element.name.text);
    }
  }

  // export * as ns from '...' comes as NamespaceExport — skip (caller does file resolution)
}

function getDeclarationName(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isClassDeclaration(node) && node.name) return node.name.text;
  if (ts.isInterfaceDeclaration(node) && node.name) return node.name.text;
  if (ts.isTypeAliasDeclaration(node) && node.name) return node.name.text;
  if (ts.isEnumDeclaration(node) && node.name) return node.name.text;
  if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;

  // Variable statements: export declare const/let/var X
  if (ts.isVariableStatement(node)) {
    const decls = node.declarationList.declarations;
    if (decls.length > 0 && ts.isIdentifier(decls[0].name)) {
      return decls[0].name.text;
    }
  }

  return null;
}

function extractMembers(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): Map<string, TypeMember> | null {
  if (ts.isInterfaceDeclaration(node)) {
    return extractInterfaceMembers(ts, node);
  }
  if (ts.isClassDeclaration(node)) {
    return extractClassMembers(ts, node);
  }
  if (ts.isEnumDeclaration(node)) {
    return extractEnumMembers(ts, node);
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return extractTypeAliasMembers(ts, node);
  }
  return null;
}

function extractInterfaceMembers(
  ts: typeof import("typescript"),
  decl: import("typescript").InterfaceDeclaration,
): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "property" });
    } else if (ts.isMethodSignature(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "method" });
    }
  }
  return members;
}

function extractClassMembers(
  ts: typeof import("typescript"),
  decl: import("typescript").ClassDeclaration,
): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const member of decl.members) {
    // Skip constructors
    if (ts.isConstructorDeclaration(member)) continue;

    if (ts.isPropertyDeclaration(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "property" });
    } else if (ts.isMethodDeclaration(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "method" });
    } else if (ts.isGetAccessorDeclaration(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "property" });
    } else if (ts.isSetAccessorDeclaration(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "property" });
    }
  }
  return members;
}

function extractEnumMembers(
  ts: typeof import("typescript"),
  decl: import("typescript").EnumDeclaration,
): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const member of decl.members) {
    if (member.name && ts.isIdentifier(member.name)) {
      const name = member.name.text;
      members.set(name, { name, kind: "enum-member" });
    }
  }
  return members;
}

function extractTypeAliasMembers(
  ts: typeof import("typescript"),
  decl: import("typescript").TypeAliasDeclaration,
): Map<string, TypeMember> | null {
  // Only extract members if the type is an object literal type: type Foo = { bar: string }
  if (!ts.isTypeLiteralNode(decl.type)) return null;

  const members = new Map<string, TypeMember>();
  for (const member of decl.type.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "property" });
    } else if (ts.isMethodSignature(member) && member.name) {
      const name = getMemberName(ts, member.name);
      if (name) members.set(name, { name, kind: "method" });
    }
  }
  return members.size > 0 ? members : null;
}

function getMemberName(
  ts: typeof import("typescript"),
  name: import("typescript").PropertyName,
): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}
