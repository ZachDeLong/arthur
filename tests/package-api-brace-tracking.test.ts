import { describe, it, expect } from "vitest";
import { parseExportedApi } from "../src/analysis/package-api-checker.js";

describe("brace-tracking for nested generics", () => {
  it("parses interface with nested generic constraint", () => {
    const content = [
      "export declare interface Container<T extends { id: number }> {",
      "  items: T[];",
      "  getItem(id: number): T;",
      "}",
      "",
      "export declare function create(): Container<any>;",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Container")).toBe(true);
    expect(api.exports.has("create")).toBe(true);
    const members = api.membersByExport.get("Container");
    expect(members).toBeDefined();
    expect(members!.has("items")).toBe(true);
    expect(members!.has("getItem")).toBe(true);
  });

  it("parses class with extends clause containing nested braces", () => {
    const content = [
      "export declare class Builder<T extends Record<string, { value: unknown }>> {",
      "  build(): T;",
      "  reset(): void;",
      "}",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Builder")).toBe(true);
    const members = api.membersByExport.get("Builder");
    expect(members).toBeDefined();
    expect(members!.has("build")).toBe(true);
    expect(members!.has("reset")).toBe(true);
  });

  it("parses multiple declarations after a nested-brace declaration", () => {
    const content = [
      "export declare interface First<T extends { x: number }> {",
      "  foo: string;",
      "}",
      "",
      "export declare interface Second {",
      "  bar: number;",
      "}",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("First")).toBe(true);
    expect(api.exports.has("Second")).toBe(true);
    expect(api.membersByExport.get("First")!.has("foo")).toBe(true);
    expect(api.membersByExport.get("Second")!.has("bar")).toBe(true);
  });

  it("still handles simple interfaces without generics", () => {
    const content = [
      "export declare interface Simple {",
      "  name: string;",
      "  getValue(): number;",
      "}",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Simple")).toBe(true);
    const members = api.membersByExport.get("Simple");
    expect(members).toBeDefined();
    expect(members!.has("name")).toBe(true);
    expect(members!.has("getValue")).toBe(true);
  });
});
