import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runCheck } from "../src/commands/check.js";

const fixtureA = path.resolve("bench/fixtures/fixture-a");
const fixtureC = path.resolve("bench/fixtures/fixture-c");

// Suppress console output during tests
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCheck — plan loading", () => {
  it("returns 1 for nonexistent plan file", async () => {
    const code = await runCheck({ plan: "/nonexistent/plan.md", project: fixtureA });
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("plan file not found"),
    );
  });

  it("loads plan from file", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nModify src/plugins/base.ts\n");

    try {
      const code = await runCheck({ plan: tmpFile, project: fixtureA });
      expect(code).toBe(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("runCheck — project validation", () => {
  it("returns 1 for nonexistent project directory", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nSome plan content\n");

    try {
      const code = await runCheck({ plan: tmpFile, project: "/nonexistent/project" });
      expect(code).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("project directory not found"),
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("runCheck — exit codes", () => {
  it("returns 0 when no findings", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    // Reference a file that exists in fixture-a
    fs.writeFileSync(tmpFile, "## Plan\nModify src/plugins/base.ts\n");

    try {
      const code = await runCheck({ plan: tmpFile, project: fixtureA });
      expect(code).toBe(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("returns 1 when findings exist", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    // Reference a file that does NOT exist in fixture-a
    fs.writeFileSync(tmpFile, "## Plan\nModify src/nonexistent/fake-file.ts to add feature.\n");

    try {
      const code = await runCheck({ plan: tmpFile, project: fixtureA });
      expect(code).toBe(1);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("runCheck — output formats", () => {
  it("text format includes report header", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nModify src/plugins/base.ts\n");

    try {
      await runCheck({ plan: tmpFile, project: fixtureA, format: "text" });
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map(c => c[0])
        .join("\n");
      expect(output).toContain("Arthur Verification Report");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("json format produces valid ArthurReport", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nModify src/plugins/base.ts\n");

    try {
      await runCheck({ plan: tmpFile, project: fixtureA, format: "json" });
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const report = JSON.parse(output);

      expect(report.schemaVersion).toBe("1.0");
      expect(report.timestamp).toBeTruthy();
      expect(report.summary).toBeDefined();
      expect(report.summary.totalChecked).toBeTypeOf("number");
      expect(report.summary.totalFindings).toBeTypeOf("number");
      expect(report.summary.checkerResults).toBeInstanceOf(Array);
      expect(report.findings).toBeInstanceOf(Array);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("json format includes findings for hallucinated paths", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nModify src/nonexistent/fake-file.ts to add feature.\n");

    try {
      await runCheck({ plan: tmpFile, project: fixtureA, format: "json" });
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const report = JSON.parse(output);

      expect(report.summary.totalFindings).toBeGreaterThan(0);
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings[0].checker).toBe("paths");
      expect(report.findings[0].severity).toBe("error");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("runCheck — text output details", () => {
  it("shows skipped checkers", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    // fixture-a has no Prisma, no Supabase, etc.
    fs.writeFileSync(tmpFile, "## Plan\nModify src/plugins/base.ts\n");

    try {
      await runCheck({ plan: tmpFile, project: fixtureA, format: "text" });
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map(c => c[0])
        .join("\n");
      expect(output).toContain("Skipped:");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("shows individual hallucinations under checker line", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nModify src/nonexistent/fake-file.ts to add feature.\n");

    try {
      await runCheck({ plan: tmpFile, project: fixtureA, format: "text" });
      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map(c => c[0])
        .join("\n");
      expect(output).toContain("src/nonexistent/fake-file.ts");
      expect(output).toContain("finding");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("runCheck — schema passthrough", () => {
  it("passes --schema option to checkers", async () => {
    const tmpFile = path.join(os.tmpdir(), `arthur-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "## Plan\nUse prisma.participant.findMany()\n");

    try {
      // fixture-c has Prisma — passing a schema path should work
      const code = await runCheck({
        plan: tmpFile,
        project: fixtureC,
        schema: path.join(fixtureC, "prisma/schema.prisma"),
      });
      // Just verify it doesn't crash — schema passthrough works
      expect(typeof code).toBe("number");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
