import { describe, it, expect, beforeAll } from "vitest";
import { initTsParser, parseDtsExports } from "../src/analysis/dts-parser.js";

beforeAll(async () => {
  const ok = await initTsParser();
  expect(ok).toBe(true);
});

// ---------------------------------------------------------------
// Regex-breaking patterns (the old regex parser fails on these)
// ---------------------------------------------------------------

describe("regex-breaking patterns", () => {
  it("interface with nested generic constraint containing braces", () => {
    const content = `
export interface Foo<T extends { id: number }> {
  items: T[];
  count: number;
}`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Foo")).toBe(true);
    const members = result.membersByExport.get("Foo")!;
    expect(members.has("items")).toBe(true);
    expect(members.has("count")).toBe(true);
    expect(members.get("items")!.kind).toBe("property");
  });

  it("class with complex generic extends", () => {
    const content = `
export declare class Builder<T extends Record<string, { value: unknown }>> {
  set(key: string, val: T[keyof T]): this;
  build(): T;
}`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Builder")).toBe(true);
    const members = result.membersByExport.get("Builder")!;
    expect(members.has("set")).toBe(true);
    expect(members.has("build")).toBe(true);
    expect(members.get("set")!.kind).toBe("method");
    expect(members.get("build")!.kind).toBe("method");
  });

  it("string literal property containing braces", () => {
    const content = `
export interface Config {
  template: "Hello { name }";
  greeting: string;
}`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Config")).toBe(true);
    const members = result.membersByExport.get("Config")!;
    expect(members.has("template")).toBe(true);
    expect(members.has("greeting")).toBe(true);
  });

  it("comments with braces inside declarations", () => {
    const content = `
export interface Widget {
  /** Example: { x: 1 } */
  position: { x: number; y: number };
  /** Returns { ok: boolean } */
  validate(): boolean;
}`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Widget")).toBe(true);
    const members = result.membersByExport.get("Widget")!;
    expect(members.has("position")).toBe(true);
    expect(members.has("validate")).toBe(true);
    expect(members.get("validate")!.kind).toBe("method");
  });

  it("generic defaults with object types", () => {
    const content = `
export interface Store<T = { count: number }> {
  state: T;
  dispatch(action: string): void;
}`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Store")).toBe(true);
    const members = result.membersByExport.get("Store")!;
    expect(members.has("state")).toBe(true);
    expect(members.has("dispatch")).toBe(true);
    expect(members.get("dispatch")!.kind).toBe("method");
  });

  it("union types with object literals in generics", () => {
    const content = `
export declare function handle<T extends { ok: true } | { ok: false }>(input: T): T;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("handle")).toBe(true);
  });
});

// ---------------------------------------------------------------
// Standard export extraction
// ---------------------------------------------------------------

describe("export extraction", () => {
  it("export declare function", () => {
    const content = `export declare function parseEmail(input: string): boolean;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("parseEmail")).toBe(true);
  });

  it("export declare const", () => {
    const content = `export declare const VERSION: string;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("VERSION")).toBe(true);
  });

  it("export declare let", () => {
    const content = `export declare let counter: number;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("counter")).toBe(true);
  });

  it("export declare var", () => {
    const content = `export declare var legacy: string;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("legacy")).toBe(true);
  });

  it("export function (without declare)", () => {
    const content = `export function helper(): void;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("helper")).toBe(true);
  });

  it("export const (without declare)", () => {
    const content = `export const MAX = 100;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("MAX")).toBe(true);
  });

  it("export class", () => {
    const content = `export class MyClass { foo(): void; }`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("MyClass")).toBe(true);
  });

  it("export interface", () => {
    const content = `export interface MyInterface { bar: string; }`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("MyInterface")).toBe(true);
  });

  it("export type", () => {
    const content = `export type MyType = string | number;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("MyType")).toBe(true);
  });

  it("export enum", () => {
    const content = `export enum Direction { Up, Down, Left, Right }`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Direction")).toBe(true);
  });

  it("export namespace", () => {
    const content = `export declare namespace Utils { function helper(): void; }`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Utils")).toBe(true);
  });

  it("export list with aliases", () => {
    const content = `
declare function _parse(s: string): void;
declare function _format(s: string): string;
export { _parse as parse, _format as format };`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("parse")).toBe(true);
    expect(result.exports.has("format")).toBe(true);
    // Original internal names should NOT be in exports
    expect(result.exports.has("_parse")).toBe(false);
    expect(result.exports.has("_format")).toBe(false);
  });

  it("skips type-only exports in export list", () => {
    const content = `
declare function real(): void;
declare interface OnlyType { x: number; }
export { real, type OnlyType };`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("real")).toBe(true);
    expect(result.exports.has("OnlyType")).toBe(false);
  });

  it("export { X } from '...' (re-export list)", () => {
    const content = `export { alpha, beta as gamma } from './submodule';`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("alpha")).toBe(true);
    expect(result.exports.has("gamma")).toBe(true);
    expect(result.exports.has("beta")).toBe(false);
  });

  it("skips export * from '...'", () => {
    const content = `export * from './other';`;
    const result = parseDtsExports(content)!;
    // No names extracted — caller handles file resolution
    expect(result.exports.size).toBe(0);
  });

  it("skips export * as ns from '...'", () => {
    const content = `export * as helpers from './helpers';`;
    const result = parseDtsExports(content)!;
    // No names extracted — caller handles file resolution
    expect(result.exports.size).toBe(0);
  });

  it("multiple exports in one file", () => {
    const content = `
export declare function createApp(): void;
export declare const version: string;
export declare class Router {}
export interface Route { path: string; }
export type Handler = () => void;
export enum Method { GET, POST, PUT, DELETE }
`;
    const result = parseDtsExports(content)!;
    expect(result.exports).toEqual(
      new Set(["createApp", "version", "Router", "Route", "Handler", "Method"]),
    );
  });
});

// ---------------------------------------------------------------
// Member extraction
// ---------------------------------------------------------------

describe("member extraction", () => {
  it("interface members: properties and methods", () => {
    const content = `
export interface User {
  id: number;
  name: string;
  readonly email: string;
  greet(msg: string): void;
  optionalField?: boolean;
}`;
    const result = parseDtsExports(content)!;
    const members = result.membersByExport.get("User")!;
    expect(members.has("id")).toBe(true);
    expect(members.get("id")!.kind).toBe("property");
    expect(members.has("name")).toBe(true);
    expect(members.has("email")).toBe(true);
    expect(members.has("greet")).toBe(true);
    expect(members.get("greet")!.kind).toBe("method");
    expect(members.has("optionalField")).toBe(true);
    expect(members.get("optionalField")!.kind).toBe("property");
  });

  it("class members with modifiers, skips constructor", () => {
    const content = `
export declare class Service {
  constructor(config: object);
  readonly name: string;
  private _internal: number;
  static instance: Service;
  start(): void;
  protected stop(): Promise<void>;
  get status(): string;
  set timeout(ms: number);
}`;
    const result = parseDtsExports(content)!;
    const members = result.membersByExport.get("Service")!;
    // Properties
    expect(members.has("name")).toBe(true);
    expect(members.get("name")!.kind).toBe("property");
    expect(members.has("_internal")).toBe(true);
    expect(members.has("instance")).toBe(true);
    // Methods
    expect(members.has("start")).toBe(true);
    expect(members.get("start")!.kind).toBe("method");
    expect(members.has("stop")).toBe(true);
    expect(members.get("stop")!.kind).toBe("method");
    // Getter/setter → property
    expect(members.has("status")).toBe(true);
    expect(members.get("status")!.kind).toBe("property");
    expect(members.has("timeout")).toBe(true);
    expect(members.get("timeout")!.kind).toBe("property");
    // Constructor should be skipped
    expect(members.has("constructor")).toBe(false);
  });

  it("enum members", () => {
    const content = `
export enum Color {
  Red = "red",
  Green = "green",
  Blue = "blue",
}`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Color")).toBe(true);
    const members = result.membersByExport.get("Color")!;
    expect(members.has("Red")).toBe(true);
    expect(members.get("Red")!.kind).toBe("enum-member");
    expect(members.has("Green")).toBe(true);
    expect(members.has("Blue")).toBe(true);
  });

  it("type alias with object literal members", () => {
    const content = `
export type Options = {
  verbose: boolean;
  timeout: number;
  run(): void;
};`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("Options")).toBe(true);
    const members = result.membersByExport.get("Options")!;
    expect(members.has("verbose")).toBe(true);
    expect(members.get("verbose")!.kind).toBe("property");
    expect(members.has("timeout")).toBe(true);
    expect(members.has("run")).toBe(true);
    expect(members.get("run")!.kind).toBe("method");
  });

  it("type alias with non-object type has no members", () => {
    const content = `export type ID = string | number;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("ID")).toBe(true);
    expect(result.membersByExport.has("ID")).toBe(false);
  });

  it("no members extracted for non-exported declarations", () => {
    const content = `
interface Internal {
  secret: string;
}
export declare function getInternal(): Internal;`;
    const result = parseDtsExports(content)!;
    expect(result.exports.has("getInternal")).toBe(true);
    // Internal is not exported, so no members tracked
    expect(result.membersByExport.has("Internal")).toBe(false);
  });
});

// ---------------------------------------------------------------
// initTsParser / null behavior
// ---------------------------------------------------------------

describe("initTsParser", () => {
  it("returns true when TypeScript is available", async () => {
    const ok = await initTsParser();
    expect(ok).toBe(true);
  });

  it("parseDtsExports returns a valid result after init", () => {
    const result = parseDtsExports("export declare const x: number;");
    expect(result).not.toBeNull();
    expect(result!.exports.has("x")).toBe(true);
  });
});
