import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ARTHUR_VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8"));
    expect(ARTHUR_VERSION).toBe(packageJson.version);
  });
});
