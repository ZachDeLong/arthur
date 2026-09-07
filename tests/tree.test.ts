import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllFiles } from "../src/context/tree.js";

describe("getAllFiles", () => {
  it("indexes files deeper than the former six-directory limit", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-tree-"));
    const relative = "a/b/c/d/e/f/g/h/deep.ts";
    const fullPath = path.join(projectDir, relative);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "export const deep = true;\n");

    try {
      expect(getAllFiles(projectDir)).toContain(relative);
      expect(getAllFiles(projectDir, 2)).not.toContain(relative);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
