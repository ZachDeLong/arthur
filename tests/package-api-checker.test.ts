import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  extractImportBindings,
  resolveTypesEntrypoint,
  parseExportedApi,
  extractApiRefs,
  analyzePackageApi,
} from "../src/analysis/package-api-checker.js";
import fs from "node:fs";

const FIXTURE_F = path.resolve(__dirname, "../bench/fixtures/fixture-f");

// --- extractImportBindings ---

describe("extractImportBindings", () => {
  it("extracts default import", () => {
    const plan = "```ts\nimport z from 'zod';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      localName: "z",
      packageName: "zod",
      importKind: "default",
    });
  });

  it("extracts namespace import", () => {
    const plan = "```ts\nimport * as z from 'zod';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      localName: "z",
      packageName: "zod",
      importKind: "namespace",
    });
  });

  it("extracts named imports", () => {
    const plan = "```ts\nimport { string, number, object } from 'zod';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(3);
    expect(bindings.map(b => b.localName)).toEqual(["string", "number", "object"]);
    expect(bindings.every(b => b.importKind === "named")).toBe(true);
  });

  it("extracts aliased named imports", () => {
    const plan = "```ts\nimport { string as ZodString } from 'zod';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      localName: "ZodString",
      packageName: "zod",
      importKind: "named",
      originalName: "string",
    });
  });

  it("extracts mixed default + named imports", () => {
    const plan = "```ts\nimport z, { string, object } from 'zod';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toMatchObject({ localName: "z", importKind: "default" });
    expect(bindings[1]).toMatchObject({ localName: "string", importKind: "named" });
    expect(bindings[2]).toMatchObject({ localName: "object", importKind: "named" });
  });

  it("extracts CJS require", () => {
    const plan = "```js\nconst z = require('zod');\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      localName: "z",
      packageName: "zod",
      importKind: "default",
    });
  });

  it("extracts destructured require", () => {
    const plan = "```js\nconst { string, object } = require('zod');\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(2);
    expect(bindings.every(b => b.importKind === "named")).toBe(true);
    expect(bindings.map(b => b.localName)).toEqual(["string", "object"]);
  });

  it("skips relative imports", () => {
    const plan = "```ts\nimport { foo } from './utils';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(0);
  });

  it("skips builtins", () => {
    const plan = "```ts\nimport fs from 'node:fs';\nimport path from 'path';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(0);
  });

  it("ignores prose outside code blocks", () => {
    const plan = "We'll use `import z from 'zod'` to validate data.\n\nBut this import is just mentioned in prose, not in a code block.";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(0);
  });

  it("skips type-only imports", () => {
    const plan = "```ts\nimport type { ZodType } from 'zod';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(0);
  });

  it("handles scoped packages", () => {
    const plan = "```ts\nimport Anthropic from '@anthropic-ai/sdk';\n```";
    const bindings = extractImportBindings(plan);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].packageName).toBe("@anthropic-ai/sdk");
  });
});

// --- resolveTypesEntrypoint ---

describe("resolveTypesEntrypoint", () => {
  it("resolves zod types entrypoint", () => {
    const zodDir = path.join(FIXTURE_F, "node_modules/zod");
    const result = resolveTypesEntrypoint(zodDir);
    expect(result).not.toBeNull();
    expect(result!).toMatch(/\.d\.(c?ts|mts)$/);
    expect(fs.existsSync(result!)).toBe(true);
  });

  it("returns null for non-existent package", () => {
    const result = resolveTypesEntrypoint(path.join(FIXTURE_F, "node_modules/nonexistent-pkg-xyz"));
    expect(result).toBeNull();
  });
});

// --- parseExportedApi ---

describe("parseExportedApi", () => {
  it("parses export declare function", () => {
    const content = `export declare function string(): ZodString;\nexport declare function number(): ZodNumber;\n`;
    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("string")).toBe(true);
    expect(api.exports.has("number")).toBe(true);
  });

  it("parses export list", () => {
    const content = `export { foo, bar as baz };\n`;
    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("foo")).toBe(true);
    expect(api.exports.has("baz")).toBe(true);
    expect(api.exports.has("bar")).toBe(false);
  });

  it("skips type-only re-exports", () => {
    const content = `export { type Foo, bar };\n`;
    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Foo")).toBe(false);
    expect(api.exports.has("bar")).toBe(true);
  });

  it("parses interface members", () => {
    const content = [
      "export declare interface MyClass {",
      "  name: string;",
      "  getValue(): number;",
      "}",
    ].join("\n");
    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("MyClass")).toBe(true);
    const members = api.membersByExport.get("MyClass");
    expect(members).toBeDefined();
    expect(members!.has("name")).toBe(true);
    expect(members!.has("getValue")).toBe(true);
  });

  it("parses real zod types and finds expected exports", () => {
    const zodDir = path.join(FIXTURE_F, "node_modules/zod");
    const entrypoint = resolveTypesEntrypoint(zodDir);
    expect(entrypoint).not.toBeNull();

    const content = fs.readFileSync(entrypoint!, "utf-8");
    const api = parseExportedApi(content, entrypoint!, zodDir);

    // Zod v4 should have these as top-level exports (via re-exports)
    expect(api.exports.has("string")).toBe(true);
    expect(api.exports.has("number")).toBe(true);
    expect(api.exports.has("object")).toBe(true);
    expect(api.exports.has("array")).toBe(true);

    // isEmail does NOT exist as a top-level export in zod
    expect(api.exports.has("isEmail")).toBe(false);
  });
});

// --- extractApiRefs ---

describe("extractApiRefs", () => {
  it("extracts method calls on bound names", () => {
    const bindings = [
      { localName: "z", packageName: "zod", importKind: "namespace" as const },
    ];
    const plan = "```ts\nconst schema = z.string();\nconst result = z.object({ name: z.string() });\n```";
    const refs = extractApiRefs(plan, bindings);
    expect(refs.some(r => r.memberName === "string")).toBe(true);
    expect(refs.some(r => r.memberName === "object")).toBe(true);
  });

  it("ignores unbound names", () => {
    const bindings = [
      { localName: "z", packageName: "zod", importKind: "namespace" as const },
    ];
    const plan = "```ts\nconst x = foo.bar();\n```";
    const refs = extractApiRefs(plan, bindings);
    expect(refs).toHaveLength(0);
  });

  it("skips universal members", () => {
    const bindings = [
      { localName: "z", packageName: "zod", importKind: "namespace" as const },
    ];
    const plan = "```ts\nz.toString();\nz.valueOf();\nz.constructor;\n```";
    const refs = extractApiRefs(plan, bindings);
    expect(refs).toHaveLength(0);
  });

  it("deduplicates refs", () => {
    const bindings = [
      { localName: "z", packageName: "zod", importKind: "namespace" as const },
    ];
    const plan = "```ts\nz.string();\nz.string();\nz.string();\n```";
    const refs = extractApiRefs(plan, bindings);
    expect(refs).toHaveLength(1);
  });
});

// --- analyzePackageApi (integration) ---

describe("analyzePackageApi", () => {
  it("detects hallucinated z.isEmail()", () => {
    const plan = [
      "```ts",
      "import * as z from 'zod';",
      "",
      "const schema = z.object({",
      "  email: z.isEmail(),",
      "  name: z.string(),",
      "});",
      "```",
    ].join("\n");

    const analysis = analyzePackageApi(plan, FIXTURE_F);
    expect(analysis.applicable).toBe(true);
    expect(analysis.hallucinations.length).toBeGreaterThan(0);
    const isEmailHallucination = analysis.hallucinations.find(
      h => h.raw.includes("isEmail"),
    );
    expect(isEmailHallucination).toBeDefined();
    expect(isEmailHallucination!.category).toBe("hallucinated-member");
  });

  it("validates real z.object() and z.string()", () => {
    const plan = [
      "```ts",
      "import * as z from 'zod';",
      "",
      "const schema = z.object({",
      "  name: z.string(),",
      "  age: z.number(),",
      "});",
      "```",
    ].join("\n");

    const analysis = analyzePackageApi(plan, FIXTURE_F);
    expect(analysis.applicable).toBe(true);
    // object, string, number are all real zod exports
    const memberHallucinations = analysis.hallucinations.filter(
      h => h.category === "hallucinated-member",
    );
    expect(memberHallucinations).toHaveLength(0);
  });

  it("detects hallucinated named imports", () => {
    const plan = [
      "```ts",
      "import { parseEmail, validateUrl } from 'zod';",
      "```",
    ].join("\n");

    const analysis = analyzePackageApi(plan, FIXTURE_F);
    expect(analysis.applicable).toBe(true);
    const namedHallucinations = analysis.hallucinations.filter(
      h => h.category === "hallucinated-named-import",
    );
    expect(namedHallucinations.length).toBe(2);
  });

  it("returns inapplicable when no node_modules", () => {
    const analysis = analyzePackageApi(
      "```ts\nimport z from 'zod';\n```",
      "/tmp/nonexistent-project-xyz",
    );
    expect(analysis.applicable).toBe(false);
  });
});

// --- Registry integration ---

describe("Package API checker in registry", () => {
  it("is registered as experimental", async () => {
    // Import registry after checkers register
    const { getCheckers, getChecker } = await import("../src/analysis/registry.js");
    await import("../src/analysis/checkers/index.js");

    const checker = getChecker("packageApi");
    expect(checker).toBeDefined();
    expect(checker!.displayName).toBe("Package API");
    expect(checker!.experimental).toBe(true);

    // Should NOT be in default getCheckers()
    const defaultCheckers = getCheckers();
    const ids = defaultCheckers.map(c => c.id);
    expect(ids).not.toContain("packageApi");

    // Should be in includeExperimental
    const allCheckers = getCheckers({ includeExperimental: true });
    const allIds = allCheckers.map(c => c.id);
    expect(allIds).toContain("packageApi");
  });
});
