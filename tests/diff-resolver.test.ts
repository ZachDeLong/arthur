import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveDiffFiles, type DiffFile } from "../src/diff/resolver.js";

let tmpDir: string;

function git(cmd: string, cwd?: string) {
  execSync(`git ${cmd}`, { cwd: cwd ?? tmpDir, stdio: "pipe" });
}

function writeFile(relPath: string, content: string) {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-diff-test-"));
  git("init");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  // Create initial commit so HEAD exists
  writeFile("README.md", "# test\n");
  git("add .");
  git('commit -m "initial"');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveDiffFiles", () => {
  it("detects new staged .ts files vs HEAD", () => {
    writeFile("src/foo.ts", 'export const foo = "bar";\n');
    git("add src/foo.ts");
    git('commit -m "add foo"');

    const files = resolveDiffFiles(tmpDir, "HEAD~1");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");
    expect(files[0].content).toBe('export const foo = "bar";\n');
  });

  it("detects staged files with --staged option", () => {
    writeFile("lib/utils.tsx", "export default function() { return <div/>; }\n");
    git("add lib/utils.tsx");

    const files = resolveDiffFiles(tmpDir, "HEAD", { staged: true });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("lib/utils.tsx");
    expect(files[0].content).toContain("export default function");
  });

  it("filters to supported extensions only (ignores .md, .json)", () => {
    writeFile("docs/notes.md", "# Notes\n");
    writeFile("config.json", '{"key": "value"}\n');
    writeFile("src/app.ts", "console.log('app');\n");
    writeFile("src/page.tsx", "export default () => <p/>;\n");
    writeFile("src/util.js", "module.exports = {};\n");
    writeFile("src/helper.jsx", "export const H = () => <span/>;\n");
    writeFile("src/esm.mjs", "export const x = 1;\n");
    writeFile("src/cjs.cjs", "module.exports = {};\n");
    git("add .");
    git('commit -m "add files"');

    const files = resolveDiffFiles(tmpDir, "HEAD~1");
    const paths = files.map(f => f.path).sort();

    expect(paths).toEqual([
      "src/app.ts",
      "src/cjs.cjs",
      "src/esm.mjs",
      "src/helper.jsx",
      "src/page.tsx",
      "src/util.js",
    ]);
    // .md and .json should not appear
    expect(paths).not.toContain("docs/notes.md");
    expect(paths).not.toContain("config.json");
  });

  it("handles modified files", () => {
    writeFile("src/mod.ts", "const x = 1;\n");
    git("add .");
    git('commit -m "add mod"');

    writeFile("src/mod.ts", "const x = 2;\n");
    git("add .");
    git('commit -m "modify mod"');

    const files = resolveDiffFiles(tmpDir, "HEAD~1");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/mod.ts");
    expect(files[0].content).toBe("const x = 2;\n");
  });

  it("returns empty array when no changes", () => {
    // No staged changes, so --staged against HEAD returns nothing
    const files = resolveDiffFiles(tmpDir, "HEAD", { staged: true });
    expect(files).toEqual([]);
  });

  it("throws on non-git directory", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-nongit-"));
    try {
      expect(() => resolveDiffFiles(nonGitDir, "HEAD")).toThrow();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("supports diff against a branch ref", () => {
    // Detect the default branch name (could be "main" or "master" depending on git config)
    const defaultBranch = execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
    // Create a branch, add a file, diff against the default branch
    git("checkout -b feature");
    writeFile("src/feature.ts", "export const feat = true;\n");
    git("add .");
    git('commit -m "feature commit"');

    const files = resolveDiffFiles(tmpDir, defaultBranch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/feature.ts");
  });

  it("skips deleted files (--diff-filter=ACMR excludes D)", () => {
    writeFile("src/keep.ts", "export const keep = 1;\n");
    writeFile("src/remove.ts", "export const remove = 1;\n");
    git("add .");
    git('commit -m "add two files"');

    // Delete one file and commit
    fs.unlinkSync(path.join(tmpDir, "src/remove.ts"));
    git("add .");
    git('commit -m "delete remove.ts"');

    const files = resolveDiffFiles(tmpDir, "HEAD~1");
    const paths = files.map(f => f.path);
    // remove.ts was Deleted — excluded by --diff-filter=ACMR
    expect(paths).not.toContain("src/remove.ts");
  });

  it("does not leak system paths in error messages", () => {
    expect(() => resolveDiffFiles("/some/private/path", "nonexistent-ref")).toThrow();
    try {
      resolveDiffFiles("/some/private/path", "nonexistent-ref");
    } catch (e: any) {
      expect(e.message).not.toContain("/some/private/path");
    }
  });

  it("skips files that no longer exist on disk", () => {
    // File appears in git diff but was deleted after the diff ref
    writeFile("src/ghost.ts", "export const ghost = 1;\n");
    writeFile("src/real.ts", "export const real = 1;\n");
    git("add .");
    git('commit -m "add ghost and real"');

    // Delete ghost.ts from disk but don't commit (simulates a file that git reports but doesn't exist)
    fs.unlinkSync(path.join(tmpDir, "src/ghost.ts"));

    const files = resolveDiffFiles(tmpDir, "HEAD~1");
    const paths = files.map(f => f.path);
    expect(paths).not.toContain("src/ghost.ts");
    expect(paths).toContain("src/real.ts");
  });
});
