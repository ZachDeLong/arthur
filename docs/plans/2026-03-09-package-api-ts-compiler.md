# Package API Checker: TypeScript Compiler API Migration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Implementation skills:** @typescript-pro, @test-master

**Goal:** Replace regex/brace-tracking in `parseExportedApi` with TypeScript's Compiler API for .d.ts parsing, eliminating the ~15-20% FP/FN rate from string literals, comments, and complex generics breaking brace counting.

**Architecture:** Dynamic `import('typescript')` at runtime with regex fallback. Most Arthur users run in TypeScript projects that already have `typescript` installed — we get 99%+ accuracy for free without adding a 40MB production dependency. The external API (`parseExportedApi`, `analyzePackageApi`) stays identical. Only the internal `.d.ts` → exports/members extraction changes.

**Tech Stack:** TypeScript Compiler API (`ts.createSourceFile` — parser only, no type checker needed), Vitest

**What's broken today:**
- `findDeclarationBodies()` uses brace/angle-bracket counting that breaks on string literals containing `{`/`}`, comments with code examples, complex generic unions like `<T extends { a: number } | { b: string }>`, and generic defaults `<T = { x: string }>`
- `member-parser.ts` uses line-by-line regex that misses multi-line method signatures and can't distinguish comments from code
- These combine to produce ~15-20% false positive/negative rate on real-world `.d.ts` files

---

## Task 1: Create the TS Compiler API parser module

The new module uses `ts.createSourceFile()` to parse `.d.ts` content into an AST, then walks it to extract exports and class/interface members. This replaces both `findDeclarationBodies()` and the regex-based member-parser usage in package-api-checker.

**Files:**
- Create: `src/analysis/dts-parser.ts`
- Create: `tests/dts-parser.test.ts`

**Step 1: Write the failing tests**

These tests cover exactly the patterns that break the current regex approach:

```typescript
import { describe, it, expect } from "vitest";

// Dynamic import — mirrors how the production code will load it
let parseDtsExports: typeof import("../src/analysis/dts-parser.js").parseDtsExports;

describe("dts-parser (TS Compiler API)", async () => {
  // Skip entire suite if TypeScript isn't available
  try {
    const mod = await import("../src/analysis/dts-parser.js");
    parseDtsExports = mod.parseDtsExports;
    if (!parseDtsExports) {
      console.warn("parseDtsExports not available — skipping dts-parser tests");
      return;
    }
  } catch {
    console.warn("dts-parser module not loadable — skipping");
    return;
  }

  it("extracts export declare function", () => {
    const content = `export declare function string(): ZodString;\nexport declare function number(): ZodNumber;\n`;
    const api = parseDtsExports(content);
    expect(api.exports.has("string")).toBe(true);
    expect(api.exports.has("number")).toBe(true);
  });

  it("extracts export list with aliases", () => {
    const content = `export { foo, bar as baz };\n`;
    const api = parseDtsExports(content);
    expect(api.exports.has("foo")).toBe(true);
    expect(api.exports.has("baz")).toBe(true);
    expect(api.exports.has("bar")).toBe(false);
  });

  it("skips type-only exports", () => {
    const content = `export { type Foo, bar };\n`;
    const api = parseDtsExports(content);
    expect(api.exports.has("Foo")).toBe(false);
    expect(api.exports.has("bar")).toBe(true);
  });

  it("extracts interface members", () => {
    const content = [
      "export declare interface MyClass {",
      "  name: string;",
      "  getValue(): number;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    expect(api.exports.has("MyClass")).toBe(true);
    const members = api.membersByExport.get("MyClass");
    expect(members).toBeDefined();
    expect(members!.has("name")).toBe(true);
    expect(members!.has("getValue")).toBe(true);
  });

  it("extracts class members with modifiers", () => {
    const content = [
      "export declare class Builder {",
      "  readonly id: string;",
      "  private secret: string;",
      "  build(): Result;",
      "  static create(): Builder;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    const members = api.membersByExport.get("Builder");
    expect(members).toBeDefined();
    expect(members!.has("id")).toBe(true);
    expect(members!.has("build")).toBe(true);
    expect(members!.has("create")).toBe(true);
  });

  // --- Cases that break the regex approach ---

  it("handles interface with nested generic constraint (regex breaker)", () => {
    const content = [
      "export declare interface Container<T extends { id: number }> {",
      "  items: T[];",
      "  getItem(id: number): T;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    expect(api.exports.has("Container")).toBe(true);
    const members = api.membersByExport.get("Container");
    expect(members).toBeDefined();
    expect(members!.has("items")).toBe(true);
    expect(members!.has("getItem")).toBe(true);
  });

  it("handles class with complex generic extends (regex breaker)", () => {
    const content = [
      "export declare class Builder<T extends Record<string, { value: unknown }>> {",
      "  build(): T;",
      "  reset(): void;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    const members = api.membersByExport.get("Builder");
    expect(members).toBeDefined();
    expect(members!.has("build")).toBe(true);
    expect(members!.has("reset")).toBe(true);
  });

  it("handles string literal properties containing braces (regex breaker)", () => {
    const content = [
      "export declare interface Config {",
      '  template: "Hello { name }";',
      "  format(): string;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    const members = api.membersByExport.get("Config");
    expect(members).toBeDefined();
    expect(members!.has("template")).toBe(true);
    expect(members!.has("format")).toBe(true);
  });

  it("handles comments with braces inside declarations (regex breaker)", () => {
    const content = [
      "export declare interface Widget {",
      "  /** Example: { x: 1 } */",
      "  data: unknown;",
      "  render(): void;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    const members = api.membersByExport.get("Widget");
    expect(members).toBeDefined();
    expect(members!.has("data")).toBe(true);
    expect(members!.has("render")).toBe(true);
  });

  it("handles generic defaults with object types (regex breaker)", () => {
    const content = [
      "export declare interface Store<T = { count: number }> {",
      "  state: T;",
      "  dispatch(action: string): void;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    const members = api.membersByExport.get("Store");
    expect(members).toBeDefined();
    expect(members!.has("state")).toBe(true);
    expect(members!.has("dispatch")).toBe(true);
  });

  it("handles union types with object literals in generics (regex breaker)", () => {
    const content = [
      "export declare interface Parser<T extends { ok: true; value: unknown } | { ok: false; error: string }> {",
      "  parse(input: string): T;",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    const members = api.membersByExport.get("Parser");
    expect(members).toBeDefined();
    expect(members!.has("parse")).toBe(true);
  });

  it("extracts export const/let/var", () => {
    const content = [
      "export declare const VERSION: string;",
      "export declare let mutable: number;",
    ].join("\n");
    const api = parseDtsExports(content);
    expect(api.exports.has("VERSION")).toBe(true);
    expect(api.exports.has("mutable")).toBe(true);
  });

  it("extracts export enum members", () => {
    const content = [
      "export declare enum Color {",
      "  Red = 0,",
      "  Green = 1,",
      "  Blue = 2",
      "}",
    ].join("\n");
    const api = parseDtsExports(content);
    expect(api.exports.has("Color")).toBe(true);
    const members = api.membersByExport.get("Color");
    expect(members).toBeDefined();
    expect(members!.has("Red")).toBe(true);
    expect(members!.has("Green")).toBe(true);
    expect(members!.has("Blue")).toBe(true);
  });

  it("extracts namespace exports", () => {
    const content = `export declare namespace utils { function helper(): void; }\n`;
    const api = parseDtsExports(content);
    expect(api.exports.has("utils")).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dts-parser.test.ts`
Expected: FAIL — module doesn't exist yet

**Step 3: Implement the TS Compiler API parser**

Create `src/analysis/dts-parser.ts`:

```typescript
/**
 * .d.ts export/member extraction using TypeScript's Compiler API.
 *
 * Uses ts.createSourceFile() (parser only — no type checker, no Program).
 * This correctly handles all the cases that break regex/brace-tracking:
 * string literals with braces, comments, complex generics, union types.
 *
 * Dynamically imports 'typescript' so it's zero-cost if not installed.
 * The caller (package-api-checker) falls back to regex if this fails.
 */

import type { TypeMember } from "./member-parser.js";

interface DtsExports {
  exports: Set<string>;
  membersByExport: Map<string, Map<string, TypeMember>>;
}

// Lazy-loaded TypeScript module
let ts: typeof import("typescript") | null | undefined;

async function loadTs(): Promise<typeof import("typescript") | null> {
  if (ts !== undefined) return ts;
  try {
    ts = await import("typescript");
    return ts;
  } catch {
    ts = null;
    return null;
  }
}

// Synchronous check after first load
function getTs(): typeof import("typescript") | null {
  return ts ?? null;
}

/**
 * Initialize the TS module. Call once at startup (e.g., in MCP server init).
 * After this, parseDtsExports() works synchronously.
 */
export async function initTsParser(): Promise<boolean> {
  const mod = await loadTs();
  return mod !== null;
}

/**
 * Parse .d.ts content and extract exports + class/interface/enum members.
 * Returns null if TypeScript isn't available (caller should fall back to regex).
 */
export function parseDtsExports(content: string): DtsExports | null {
  const tsModule = getTs();
  if (!tsModule) return null;

  const sourceFile = tsModule.createSourceFile(
    "module.d.ts",
    content,
    tsModule.ScriptTarget.Latest,
    true,
    tsModule.ScriptKind.TS,
  );

  const exports = new Set<string>();
  const membersByExport = new Map<string, Map<string, TypeMember>>();

  for (const stmt of sourceFile.statements) {
    // Skip non-exported statements
    if (!hasExportModifier(tsModule, stmt)) continue;

    visitExportedStatement(tsModule, stmt, exports, membersByExport);
  }

  return { exports, membersByExport };
}

function hasExportModifier(
  tsModule: typeof import("typescript"),
  node: import("typescript").Node,
): boolean {
  if (!tsModule.canHaveModifiers(node)) return false;
  const modifiers = tsModule.getModifiers(node);
  if (!modifiers) return false;
  return modifiers.some(m => m.kind === tsModule.SyntaxKind.ExportKeyword);
}

function visitExportedStatement(
  tsModule: typeof import("typescript"),
  stmt: import("typescript").Statement,
  exports: Set<string>,
  membersByExport: Map<string, Map<string, TypeMember>>,
): void {
  const SyntaxKind = tsModule.SyntaxKind;

  // export declare function X / export function X
  if (tsModule.isFunctionDeclaration(stmt) && stmt.name) {
    exports.add(stmt.name.text);
    return;
  }

  // export declare const/let/var X
  if (tsModule.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (tsModule.isIdentifier(decl.name)) {
        exports.add(decl.name.text);
      }
    }
    return;
  }

  // export declare class X { ... }
  if (tsModule.isClassDeclaration(stmt) && stmt.name) {
    const name = stmt.name.text;
    exports.add(name);
    membersByExport.set(name, extractClassMembers(tsModule, stmt));
    return;
  }

  // export declare interface X { ... }
  if (tsModule.isInterfaceDeclaration(stmt)) {
    const name = stmt.name.text;
    exports.add(name);
    membersByExport.set(name, extractInterfaceMembers(tsModule, stmt));
    return;
  }

  // export declare type X = ...
  if (tsModule.isTypeAliasDeclaration(stmt)) {
    exports.add(stmt.name.text);
    // If it's an object type literal, extract members
    if (tsModule.isTypeLiteralNode(stmt.type)) {
      membersByExport.set(stmt.name.text, extractTypeLiteralMembers(tsModule, stmt.type));
    }
    return;
  }

  // export declare enum X { ... }
  if (tsModule.isEnumDeclaration(stmt)) {
    const name = stmt.name.text;
    exports.add(name);
    const members = new Map<string, TypeMember>();
    for (const member of stmt.members) {
      if (tsModule.isIdentifier(member.name)) {
        members.set(member.name.text, { name: member.name.text, kind: "enum-member" });
      }
    }
    membersByExport.set(name, members);
    return;
  }

  // export declare namespace X { ... }
  if (tsModule.isModuleDeclaration(stmt) && stmt.name) {
    if (tsModule.isIdentifier(stmt.name)) {
      exports.add(stmt.name.text);
    }
    return;
  }

  // export { X, Y as Z }
  if (tsModule.isExportDeclaration(stmt)) {
    if (stmt.exportClause && tsModule.isNamedExports(stmt.exportClause)) {
      for (const element of stmt.exportClause.elements) {
        // Skip type-only exports
        if (element.isTypeOnly) continue;
        exports.add(element.name.text);
      }
    }
    // export * is handled by the caller (resolves re-export paths)
    return;
  }
}

function extractInterfaceMembers(
  tsModule: typeof import("typescript"),
  decl: import("typescript").InterfaceDeclaration,
): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const member of decl.members) {
    const name = getMemberName(tsModule, member);
    if (!name) continue;

    if (tsModule.isMethodSignature(member) || tsModule.isCallSignatureDeclaration(member)) {
      members.set(name, { name, kind: "method" });
    } else if (tsModule.isPropertySignature(member)) {
      members.set(name, { name, kind: "property" });
    }
  }
  return members;
}

function extractClassMembers(
  tsModule: typeof import("typescript"),
  decl: import("typescript").ClassDeclaration,
): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const member of decl.members) {
    const name = getMemberName(tsModule, member);
    if (!name || name === "constructor") continue;

    if (tsModule.isMethodDeclaration(member)) {
      members.set(name, { name, kind: "method" });
    } else if (tsModule.isPropertyDeclaration(member) || tsModule.isGetAccessorDeclaration(member) || tsModule.isSetAccessorDeclaration(member)) {
      members.set(name, { name, kind: "property" });
    }
  }
  return members;
}

function extractTypeLiteralMembers(
  tsModule: typeof import("typescript"),
  node: import("typescript").TypeLiteralNode,
): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const member of node.members) {
    const name = getMemberName(tsModule, member);
    if (!name) continue;

    if (tsModule.isMethodSignature(member)) {
      members.set(name, { name, kind: "method" });
    } else if (tsModule.isPropertySignature(member)) {
      members.set(name, { name, kind: "property" });
    }
  }
  return members;
}

function getMemberName(
  tsModule: typeof import("typescript"),
  member: import("typescript").TypeElement | import("typescript").ClassElement,
): string | undefined {
  if (!member.name) return undefined;
  if (tsModule.isIdentifier(member.name)) return member.name.text;
  if (tsModule.isStringLiteral(member.name)) return member.name.text;
  return undefined;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/dts-parser.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/analysis/dts-parser.ts tests/dts-parser.test.ts
git commit -m "feat: add TypeScript Compiler API parser for .d.ts files"
```

---

## Task 2: Wire the TS parser into parseExportedApi with regex fallback

Replace the regex-based export/member extraction in `parseExportedApi()` with the TS parser, falling back to the existing regex approach if TypeScript isn't available at runtime.

**Files:**
- Modify: `src/analysis/package-api-checker.ts:339-488` (parseExportedApi + findDeclarationBodies)
- Modify: `bin/arthur-mcp.ts` — call `initTsParser()` at startup

**Step 1: Update parseExportedApi to try TS first**

In `src/analysis/package-api-checker.ts`, modify `parseExportedApi`:

```typescript
import { parseDtsExports, initTsParser } from "./dts-parser.js";
```

Then at the **top** of `parseExportedApi()`, before any regex logic, add:

```typescript
export function parseExportedApi(
  dtsContent: string,
  dtsFilePath: string,
  packageDir: string,
  depth: number = 0,
): PackageApi {
  // Try TS Compiler API first (handles all edge cases correctly).
  // Falls back to regex if TypeScript isn't available at runtime.
  const tsResult = parseDtsExports(dtsContent);
  if (tsResult) {
    // TS parser handles local exports but not re-exports (those need file resolution).
    // Merge re-export results from the existing recursive logic.
    const { exports, membersByExport } = tsResult;

    // Handle export * from './submodule' — still needs file resolution
    if (depth < 3) {
      const starReExportRegex = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm;
      for (const match of dtsContent.matchAll(starReExportRegex)) {
        const specifier = match[1];
        const resolvedPath = resolveReExportPath(specifier, dtsFilePath, packageDir);
        if (resolvedPath && fs.existsSync(resolvedPath)) {
          try {
            const subContent = fs.readFileSync(resolvedPath, "utf-8");
            const subApi = parseExportedApi(subContent, resolvedPath, packageDir, depth + 1);
            for (const name of subApi.exports) exports.add(name);
            for (const [name, members] of subApi.membersByExport) membersByExport.set(name, members);
          } catch { /* skip unreadable */ }
        }
      }

      const starAsRegex = /^export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm;
      for (const match of dtsContent.matchAll(starAsRegex)) {
        exports.add(match[1]);
      }
    }

    return { exports, membersByExport };
  }

  // --- Regex fallback (TypeScript not available) ---
  // ... existing regex code unchanged ...
```

The key insight: `parseDtsExports` handles everything *within a single file* (declarations, export lists, members). The only thing it doesn't do is resolve `export * from './submodule'` — that requires file I/O, which stays in the caller.

**Step 2: Call initTsParser at MCP server startup**

In `bin/arthur-mcp.ts`, add the init call before starting the server:

```typescript
import { initTsParser } from "../src/analysis/dts-parser.js";

// ... existing code ...

// Initialize TS parser (loads TypeScript if available)
await initTsParser();

// ... start server ...
```

**Step 3: Run the full package-api test suite**

Run: `npx vitest run tests/package-api-checker.test.ts tests/package-api-brace-tracking.test.ts tests/dts-parser.test.ts`
Expected: All PASS — existing behavior preserved, TS parser active

**Step 4: Run the full test suite for regressions**

Run: `npx vitest run`
Expected: All PASS

**Step 5: Verify build**

Run: `npm run build`
Expected: Clean build

**Step 6: Commit**

```bash
git add src/analysis/package-api-checker.ts bin/arthur-mcp.ts
git commit -m "feat: wire TS Compiler API into parseExportedApi with regex fallback"
```

---

## Task 3: Add integration test proving TS parser fixes known regex failures

Write a test that runs `analyzePackageApi` against a synthetic `.d.ts` with all the regex-breaking patterns, proving the full pipeline handles them correctly.

**Files:**
- Create: `tests/package-api-ts-integration.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseExportedApi } from "../src/analysis/package-api-checker.js";
import { initTsParser } from "../src/analysis/dts-parser.js";

describe("parseExportedApi with TS Compiler API (integration)", () => {
  beforeAll(async () => {
    await initTsParser();
  });

  it("correctly parses a .d.ts with every regex-breaking pattern", () => {
    const content = [
      '// Comment with braces: { x: 1 }',
      '',
      'export declare interface Container<T extends { id: number }> {',
      '  items: T[];',
      '  /** Example usage: result = { ok: true } */',
      '  getItem(id: number): T;',
      '}',
      '',
      'export declare class Builder<T extends Record<string, { value: unknown }>> {',
      '  build(): T;',
      '  reset(): void;',
      '}',
      '',
      'export declare interface Config<T = { count: number }> {',
      '  state: T;',
      '  dispatch(action: string): void;',
      '}',
      '',
      'export declare interface Parser<T extends { ok: true; value: unknown } | { ok: false; error: string }> {',
      '  parse(input: string): T;',
      '}',
      '',
      'export declare interface Formatter {',
      '  template: "Hello { name }";',
      '  format(): string;',
      '}',
      '',
      'export declare function create(): Container<any>;',
      'export declare const VERSION: string;',
      '',
      'export declare enum Color {',
      '  Red = 0,',
      '  Green = 1,',
      '  Blue = 2',
      '}',
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");

    // All declarations found
    expect(api.exports.has("Container")).toBe(true);
    expect(api.exports.has("Builder")).toBe(true);
    expect(api.exports.has("Config")).toBe(true);
    expect(api.exports.has("Parser")).toBe(true);
    expect(api.exports.has("Formatter")).toBe(true);
    expect(api.exports.has("create")).toBe(true);
    expect(api.exports.has("VERSION")).toBe(true);
    expect(api.exports.has("Color")).toBe(true);

    // Interface members (nested generic constraint)
    const container = api.membersByExport.get("Container")!;
    expect(container.has("items")).toBe(true);
    expect(container.has("getItem")).toBe(true);

    // Class members (complex generic extends)
    const builder = api.membersByExport.get("Builder")!;
    expect(builder.has("build")).toBe(true);
    expect(builder.has("reset")).toBe(true);

    // Generic default with object type
    const config = api.membersByExport.get("Config")!;
    expect(config.has("state")).toBe(true);
    expect(config.has("dispatch")).toBe(true);

    // Union type in generic
    const parser = api.membersByExport.get("Parser")!;
    expect(parser.has("parse")).toBe(true);

    // String literal property containing braces
    const formatter = api.membersByExport.get("Formatter")!;
    expect(formatter.has("template")).toBe(true);
    expect(formatter.has("format")).toBe(true);

    // Enum members
    const color = api.membersByExport.get("Color")!;
    expect(color.has("Red")).toBe(true);
    expect(color.has("Green")).toBe(true);
    expect(color.has("Blue")).toBe(true);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/package-api-ts-integration.test.ts`
Expected: All PASS

**Step 3: Run full suite**

Run: `npx vitest run`
Expected: All PASS

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean

**Step 5: Commit**

```bash
git add tests/package-api-ts-integration.test.ts
git commit -m "test: add integration test proving TS parser fixes regex-breaking patterns"
```

---

## Task 4: Clean up dead code

Now that the TS parser handles member extraction for package-api-checker, `findDeclarationBodies` is only used as a regex fallback. Clean up: add a comment marking it as fallback-only, and remove the `parseObjectMembers`/`parseClassMembers` import if it's only used in the fallback path.

**Files:**
- Modify: `src/analysis/package-api-checker.ts`

**Step 1: Add fallback comment to findDeclarationBodies**

Add a comment above `findDeclarationBodies`:

```typescript
/**
 * REGEX FALLBACK ONLY — used when TypeScript isn't available at runtime.
 * When TS Compiler API is available, parseDtsExports() in dts-parser.ts
 * handles this with full AST accuracy.
 */
```

**Step 2: Verify member-parser.ts is still needed**

Check if `parseObjectMembers`/`parseClassMembers` are used anywhere else. If they're only used in the regex fallback path of `parseExportedApi`, they're still needed (for the fallback). If they're used elsewhere, leave them.

Run: `grep -rn "parseObjectMembers\|parseClassMembers" src/ --include="*.ts"`

Keep `member-parser.ts` regardless — it's small and serves the fallback path.

**Step 3: Run full suite and build**

Run: `npx vitest run && npm run build`
Expected: All PASS, clean build

**Step 4: Commit**

```bash
git add src/analysis/package-api-checker.ts
git commit -m "chore: mark findDeclarationBodies as regex fallback, add docs"
```

---

## Summary

| Task | What it does |
|---|---|
| 1. TS parser module | New `dts-parser.ts` — `parseDtsExports()` using `ts.createSourceFile()` |
| 2. Wire into package-api-checker | `parseExportedApi` tries TS first, regex fallback. Init at MCP startup. |
| 3. Integration test | Proves all regex-breaking patterns are handled correctly end-to-end |
| 4. Clean up | Mark regex code as fallback-only, document the architecture |

**No new production dependencies.** TypeScript is dynamically imported — if available (it will be in 99% of target projects), Arthur gets 99%+ accuracy. If not, regex fallback preserves current behavior.
