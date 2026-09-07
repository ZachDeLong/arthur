import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { runCheck } from "../src/commands/check.js";

// Suppress console output during tests
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-e2e-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });

  // Write package.json with chalk as a dependency
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "test-project",
    version: "1.0.0",
    dependencies: { "chalk": "^5.0.0" },
  }));

  fs.writeFileSync(path.join(dir, "index.ts"), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, ".env.example"), "SERVICE_URL=https://example.test\n");
  fs.mkdirSync(path.join(dir, "src/app/api/health"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src/app/api/health/route.ts"),
    "export async function GET() { return new Response('ok'); }\n",
  );
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });

  return dir;
}

describe("check --diff end-to-end", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTestRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("passes when new file imports a listed dependency", async () => {
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import chalk from "chalk";\nconsole.log(chalk.green("ok"));\n',
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });

    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(0);
  });

  it("fails when new file imports a nonexistent package", async () => {
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import nonexistent from "totally-fake-package-xyz";\n',
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });

    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(1);
  });

  it("text output shows Arthur Verification Report header", async () => {
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import chalk from "chalk";\n',
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });

    await runCheck({ diff: "HEAD", project: repoDir, format: "text" });
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .join("\n");
    expect(output).toContain("Arthur Verification Report");
  });

  it("json output produces valid ArthurReport in diff mode", async () => {
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import fake from "not-a-real-package";\n',
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });

    await runCheck({ diff: "HEAD", project: repoDir, format: "json" });
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const report = JSON.parse(output);
    expect(report.schemaVersion).toBe("1.1");
    expect(report.summary.totalFindings).toBeGreaterThan(0);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings[0].location).toMatchObject({
      path: "src/app.ts",
      line: 1,
    });
    expect(report.meta.checkerCoverage.sourceModeSupported).toEqual(
      expect.arrayContaining(["imports", "env", "routes"]),
    );
    expect(report.meta.scope.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/app.ts" })]),
    );
  });

  it("checks changed env and route references end to end", async () => {
    fs.writeFileSync(
      path.join(repoDir, "src/client.ts"),
      [
        "export const url = process.env.MISSING_SERVICE_URL;",
        "export const response = fetch('/api/missing-health');",
      ].join("\n"),
    );

    const code = await runCheck({ diff: "HEAD", project: repoDir, format: "json" });
    expect(code).toBe(1);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const report = JSON.parse(output);

    expect(report.summary.totalErrors).toBe(2);
    expect(report.findings.map((finding: { checker: string }) => finding.checker)).toEqual(
      expect.arrayContaining(["env", "routes"]),
    );
    expect(report.findings.every((finding: { location?: unknown }) => finding.location)).toBe(true);
  });

  it("returns 0 for empty diff", async () => {
    // No changes since last commit
    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(0);
  });

  it("only checks changed files, not the entire project", async () => {
    // First commit has index.ts with no imports — that should NOT be checked
    // New file has a hallucinated import — only this should be flagged
    fs.writeFileSync(
      path.join(repoDir, "new.ts"),
      'import fake from "hallucinated-pkg";\n',
    );
    execSync("git add new.ts", { cwd: repoDir, stdio: "pipe" });

    const code = await runCheck({ diff: "HEAD", project: repoDir, format: "json" });
    expect(code).toBe(1);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const report = JSON.parse(output);
    // Should have exactly 1 finding from the new file
    expect(report.summary.totalFindings).toBe(1);
  });
});
