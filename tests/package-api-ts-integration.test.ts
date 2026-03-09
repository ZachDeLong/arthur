import { describe, it, expect, beforeAll } from "vitest";
import { parseExportedApi } from "../src/analysis/package-api-checker.js";
import { initTsParser } from "../src/analysis/dts-parser.js";

/**
 * End-to-end integration test: calls parseExportedApi() (the real production
 * function) with a single .d.ts content string containing EVERY regex-breaking
 * pattern. Proves the full TS Compiler API pipeline handles them correctly.
 */

beforeAll(async () => {
  const ok = await initTsParser();
  expect(ok).toBe(true);
});

// A single large .d.ts file containing every regex-breaking pattern plus
// standard export forms (function, const, enum).
const DTS_CONTENT = `
// --- Regex-breaking pattern 1: nested generic constraint with braces ---
export interface Repository<T extends { id: number }> {
  findById(id: number): T | undefined;
  findAll(): T[];
  count: number;
}

// --- Regex-breaking pattern 2: complex generic extends with nested objects ---
export declare class Builder<T extends Record<string, { value: unknown }>> {
  set(key: string, val: T[keyof T]): this;
  build(): T;
  readonly entries: number;
}

// --- Regex-breaking pattern 3: string literal property containing braces ---
export interface TemplateConfig {
  pattern: "Hello { name }";
  fallback: "Error: { code }";
  label: string;
}

// --- Regex-breaking pattern 4: comments with braces inside declarations ---
export interface Widget {
  /** Example usage: { x: 1, y: 2 } */
  position: { x: number; y: number };
  /** Returns an object like { ok: boolean } */
  validate(): boolean;
  enabled: boolean;
}

// --- Regex-breaking pattern 5: generic default with object type ---
export interface Store<T = { count: number }> {
  state: T;
  dispatch(action: string): void;
  subscribe(listener: () => void): () => void;
}

// --- Regex-breaking pattern 6: union types with object literals in generics ---
export declare function handleResult<T extends { ok: true; data: string } | { ok: false; error: string }>(input: T): T;

// --- Standard exports: function ---
export declare function parseEmail(input: string): boolean;

// --- Standard exports: const ---
export declare const VERSION: string;

// --- Standard exports: enum ---
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}
`;

describe("parseExportedApi integration — regex-breaking .d.ts patterns", () => {
  let result: ReturnType<typeof parseExportedApi>;

  beforeAll(() => {
    result = parseExportedApi(DTS_CONTENT, "/fake/index.d.ts", "/fake");
  });

  // --- All top-level exports found ---

  it("finds all exported declarations", () => {
    const expected = [
      "Repository",
      "Builder",
      "TemplateConfig",
      "Widget",
      "Store",
      "handleResult",
      "parseEmail",
      "VERSION",
      "LogLevel",
    ];
    for (const name of expected) {
      expect(result.exports.has(name), `missing export: ${name}`).toBe(true);
    }
  });

  // --- Interface with nested generic constraint ---

  it("extracts members from Repository<T extends { id: number }>", () => {
    const members = result.membersByExport.get("Repository");
    expect(members, "Repository members missing").toBeDefined();
    expect(members!.has("findById")).toBe(true);
    expect(members!.get("findById")!.kind).toBe("method");
    expect(members!.has("findAll")).toBe(true);
    expect(members!.get("findAll")!.kind).toBe("method");
    expect(members!.has("count")).toBe(true);
    expect(members!.get("count")!.kind).toBe("property");
  });

  // --- Class with complex generic extends ---

  it("extracts members from Builder<T extends Record<string, { value: unknown }>>", () => {
    const members = result.membersByExport.get("Builder");
    expect(members, "Builder members missing").toBeDefined();
    expect(members!.has("set")).toBe(true);
    expect(members!.get("set")!.kind).toBe("method");
    expect(members!.has("build")).toBe(true);
    expect(members!.get("build")!.kind).toBe("method");
    expect(members!.has("entries")).toBe(true);
    expect(members!.get("entries")!.kind).toBe("property");
  });

  // --- String literal property containing braces ---

  it("extracts members from TemplateConfig with brace-containing string literals", () => {
    const members = result.membersByExport.get("TemplateConfig");
    expect(members, "TemplateConfig members missing").toBeDefined();
    expect(members!.has("pattern")).toBe(true);
    expect(members!.has("fallback")).toBe(true);
    expect(members!.has("label")).toBe(true);
  });

  // --- Comments with braces inside declarations ---

  it("extracts members from Widget with brace-containing JSDoc comments", () => {
    const members = result.membersByExport.get("Widget");
    expect(members, "Widget members missing").toBeDefined();
    expect(members!.has("position")).toBe(true);
    expect(members!.get("position")!.kind).toBe("property");
    expect(members!.has("validate")).toBe(true);
    expect(members!.get("validate")!.kind).toBe("method");
    expect(members!.has("enabled")).toBe(true);
    expect(members!.get("enabled")!.kind).toBe("property");
  });

  // --- Generic default with object type ---

  it("extracts members from Store<T = { count: number }>", () => {
    const members = result.membersByExport.get("Store");
    expect(members, "Store members missing").toBeDefined();
    expect(members!.has("state")).toBe(true);
    expect(members!.get("state")!.kind).toBe("property");
    expect(members!.has("dispatch")).toBe(true);
    expect(members!.get("dispatch")!.kind).toBe("method");
    expect(members!.has("subscribe")).toBe(true);
    expect(members!.get("subscribe")!.kind).toBe("method");
  });

  // --- Union types with object literals in generics ---

  it("finds handleResult with union-of-objects generic constraint", () => {
    expect(result.exports.has("handleResult")).toBe(true);
    // Functions don't have member maps — just verify it's exported
  });

  // --- Standard exports: function + const ---

  it("finds standard function and const exports", () => {
    expect(result.exports.has("parseEmail")).toBe(true);
    expect(result.exports.has("VERSION")).toBe(true);
  });

  // --- Enum with members ---

  it("finds LogLevel enum and its members", () => {
    expect(result.exports.has("LogLevel")).toBe(true);
    const members = result.membersByExport.get("LogLevel");
    expect(members, "LogLevel members missing").toBeDefined();
    expect(members!.has("Debug")).toBe(true);
    expect(members!.get("Debug")!.kind).toBe("enum-member");
    expect(members!.has("Info")).toBe(true);
    expect(members!.get("Info")!.kind).toBe("enum-member");
    expect(members!.has("Warn")).toBe(true);
    expect(members!.get("Warn")!.kind).toBe("enum-member");
    expect(members!.has("Error")).toBe(true);
    expect(members!.get("Error")!.kind).toBe("enum-member");
  });
});
