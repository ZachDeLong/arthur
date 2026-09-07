import { describe, expect, it } from "vitest";
import path from "node:path";
import { analyzeEnvSourceFiles } from "../src/analysis/env-checker.js";
import type { DiffFile } from "../src/diff/resolver.js";

const fixtureC = path.resolve("bench/fixtures/fixture-c");
const fixtureG = path.resolve("bench/fixtures/fixture-g");

describe("analyzeEnvSourceFiles", () => {
  it("checks only env references that touch changed lines and returns locations", () => {
    const files: DiffFile[] = [{
      path: "src/config.ts",
      content: [
        "const oldValue = process.env.OLD_UNCHANGED_SECRET;",
        "const database = process.env.DATABASE_URL;",
        "const payment = process.env.PAYMENT_TOKEN;",
      ].join("\n"),
      changedLines: [2, 3],
      status: "modified",
    }];

    const result = analyzeEnvSourceFiles(files, fixtureC);

    expect(result.checkedRefs).toBe(2);
    expect(result.validRefs).toBe(1);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.hallucinations[0].varName).toBe("PAYMENT_TOKEN");
    expect(result.hallucinations[0].location).toMatchObject({
      path: "src/config.ts",
      line: 3,
    });
  });

  it("uses changed env contract files as ground truth", () => {
    const files: DiffFile[] = [
      {
        path: ".env.example",
        content: "DATABASE_URL=postgres://example\nNEW_SERVICE_TOKEN=example\n",
        changedLines: [2],
        status: "modified",
      },
      {
        path: "src/config.ts",
        content: "export const token = process.env.NEW_SERVICE_TOKEN;\n",
        changedLines: [1],
        status: "added",
      },
    ];

    const result = analyzeEnvSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(1);
    expect(result.hallucinations).toEqual([]);
  });

  it("skips runtime-provided variables", () => {
    const files: DiffFile[] = [{
      path: "src/config.ts",
      content: "export const environment = process.env.NODE_ENV;\n",
      changedLines: [1],
    }];

    const result = analyzeEnvSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(0);
    expect(result.skippedRefs).toBe(1);
  });

  it("ignores env-shaped text in comments and strings", () => {
    const files: DiffFile[] = [{
      path: "src/config.ts",
      content: [
        "// process.env.COMMENT_ONLY_SECRET",
        "const docs = 'process.env.STRING_ONLY_SECRET';",
      ].join("\n"),
      changedLines: [1, 2],
    }];

    const result = analyzeEnvSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(0);
    expect(result.hallucinations).toEqual([]);
  });

  it("supports destructuring, Bun access, and custom .env variants", () => {
    const files: DiffFile[] = [
      {
        path: ".env.preview.local",
        content: "export PREVIEW_TOKEN=example\nBUN_TOKEN=example\n",
        changedLines: [1, 2],
        status: "added",
      },
      {
        path: "src/config.ts",
        content: [
          "const { PREVIEW_TOKEN: token } = process.env;",
          "const bunToken = Bun.env.BUN_TOKEN;",
        ].join("\n"),
        changedLines: [1, 2],
        status: "added",
      },
    ];

    const result = analyzeEnvSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(2);
    expect(result.validRefs).toBe(2);
    expect(result.hallucinations).toEqual([]);
    expect(result.envFilesFound).toContain(".env.preview.local");
  });

  it("reports each changed invalid occurrence with its own location", () => {
    const files: DiffFile[] = [{
      path: "src/config.ts",
      content: [
        "const first = process.env.MISSING_TOKEN;",
        "const second = process.env.MISSING_TOKEN;",
      ].join("\n"),
      changedLines: [1, 2],
    }];

    const result = analyzeEnvSourceFiles(files, fixtureC);
    expect(result.hallucinations.map((finding) => finding.location?.line)).toEqual([1, 2]);
  });

  it("combines root and owning-workspace env contracts", () => {
    const files: DiffFile[] = [{
      path: "apps/web/src/config.ts",
      content: [
        "export const local = process.env.WEB_TOKEN;",
        "export const shared = process.env.ROOT_SHARED_TOKEN;",
      ].join("\n"),
      changedLines: [1, 2],
      status: "added",
    }];

    const result = analyzeEnvSourceFiles(files, fixtureG);

    expect(result.checkedRefs).toBe(2);
    expect(result.validRefs).toBe(2);
    expect(result.hallucinations).toEqual([]);
    expect(result.envFilesFound).toEqual([
      ".env.example",
      "apps/web/.env.example",
    ]);
  });

  it("does not leak env declarations across sibling workspaces", () => {
    const files: DiffFile[] = [{
      path: "apps/admin/src/config.ts",
      content: "export const token = process.env.WEB_TOKEN;\n",
      changedLines: [1],
      status: "added",
    }];

    const result = analyzeEnvSourceFiles(files, fixtureG);

    expect(result.checkedRefs).toBe(1);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.envFilesFound).not.toContain("apps/web/.env.example");
  });

  it("uses a changed nested env contract in the staged snapshot", () => {
    const files: DiffFile[] = [
      {
        path: "apps/admin/.env.preview.local",
        content: "PREVIEW_TOKEN=example\n",
        changedLines: [1],
        status: "added",
      },
      {
        path: "apps/admin/src/config.ts",
        content: "export const token = process.env.PREVIEW_TOKEN;\n",
        changedLines: [1],
        status: "added",
      },
    ];

    const result = analyzeEnvSourceFiles(files, fixtureG);

    expect(result.checkedRefs).toBe(1);
    expect(result.hallucinations).toEqual([]);
    expect(result.envFilesFound).toContain("apps/admin/.env.preview.local");
  });
});
