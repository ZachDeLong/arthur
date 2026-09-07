import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  analyzeApiRouteSourceFiles,
  filePathToUrlPath,
  matchRoute,
  parseRouteMethods,
  type ApiRoute,
} from "../src/analysis/api-route-checker.js";
import type { DiffFile } from "../src/diff/resolver.js";

const fixtureC = path.resolve("bench/fixtures/fixture-c");
const fixtureG = path.resolve("bench/fixtures/fixture-g");

describe("analyzeApiRouteSourceFiles", () => {
  it("validates changed static route calls and reports source locations", () => {
    const files: DiffFile[] = [{
      path: "src/client.ts",
      content: [
        "fetch('/api/unchanged-missing');",
        "fetch('/api/participants');",
        "fetch('/api/users');",
        "fetch('/api/participants', { method: 'DELETE' });",
      ].join("\n"),
      changedLines: [2, 3, 4],
      status: "modified",
    }];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);

    expect(result.checkedRefs).toBe(3);
    expect(result.validRefs).toBe(1);
    expect(result.hallucinations).toHaveLength(2);
    expect(result.hallucinations.map((finding) => finding.urlPath)).toEqual([
      "/api/users",
      "/api/participants",
    ]);
    expect(result.hallucinations[0].location).toMatchObject({
      path: "src/client.ts",
      line: 3,
    });
    expect(result.hallucinations[1].hallucinationCategory).toBe("hallucinated-method");
  });

  it("indexes a route added in the same staged view", () => {
    const files: DiffFile[] = [
      {
        path: "src/app/api/health/route.ts",
        content: "export async function GET() { return new Response('ok'); }\n",
        changedLines: [1],
        status: "added",
      },
      {
        path: "src/client.ts",
        content: "export const response = fetch('/api/health');\n",
        changedLines: [1],
        status: "added",
      },
    ];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(1);
    expect(result.hallucinations).toEqual([]);
  });

  it("removes a deleted route from the staged route index", () => {
    const files: DiffFile[] = [
      {
        path: "src/app/api/participants/route.ts",
        content: "",
        changedLines: [],
        status: "deleted",
      },
      {
        path: "src/client.ts",
        content: "export const response = fetch('/api/participants');\n",
        changedLines: [1],
        status: "added",
      },
    ];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.hallucinations[0].urlPath).toBe("/api/participants");
  });

  it("does not claim dynamic template URLs are deterministic references", () => {
    const files: DiffFile[] = [{
      path: "src/client.ts",
      content: "export const response = fetch(`/api/users/${userId}`);\n",
      changedLines: [1],
    }];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(0);
  });

  it("ignores route-shaped text in comments and strings", () => {
    const files: DiffFile[] = [{
      path: "src/client.ts",
      content: [
        "// fetch('/api/comment-only')",
        "const docs = `axios.get('/api/string-only')`;",
      ].join("\n"),
      changedLines: [1, 2],
    }];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(0);
    expect(result.hallucinations).toEqual([]);
  });

  it("checks a multiline call when only its method line changed", () => {
    const files: DiffFile[] = [{
      path: "src/client.ts",
      content: [
        "export const response = fetch(",
        "  '/api/participants',",
        "  { method: 'DELETE' },",
        ");",
      ].join("\n"),
      changedLines: [3],
    }];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);
    expect(result.checkedRefs).toBe(1);
    expect(result.hallucinations[0].hallucinationCategory).toBe("hallucinated-method");
    expect(result.hallucinations[0].location?.line).toBe(2);
  });

  it("treats fetch without an explicit method as GET", () => {
    const files: DiffFile[] = [
      {
        path: "src/app/api/write-only/route.ts",
        content: "export async function POST() { return new Response('ok'); }\n",
        changedLines: [1],
        status: "added",
      },
      {
        path: "src/client.ts",
        content: "export const response = fetch('/api/write-only');\n",
        changedLines: [1],
        status: "added",
      },
    ];

    const result = analyzeApiRouteSourceFiles(files, fixtureC);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.hallucinations[0]).toMatchObject({
      method: "GET",
      hallucinationCategory: "hallucinated-method",
    });
  });

  it("parses actual exported handlers without trusting comments", () => {
    const methods = parseRouteMethods([
      "// export async function DELETE() {}",
      "const handler = () => new Response('ok');",
      "export { handler as POST };",
      "export const GET = handler;",
    ].join("\n"));

    expect([...methods].sort()).toEqual(["GET", "POST"]);
  });

  it("matches app as a path segment and removes route groups", () => {
    expect(filePathToUrlPath("src/myapp/api/users/route.ts")).toBeNull();
    expect(filePathToUrlPath("src/app/(internal)/api/users/route.ts")).toBe("/api/users");
    expect(filePathToUrlPath("packages/app/src/app/api/users/route.ts")).toBe("/api/users");
  });

  it("distinguishes required and optional catch-all roots", () => {
    const required: ApiRoute = {
      urlPath: "/api/files/[...slug]",
      filePath: "src/app/api/files/[...slug]/route.ts",
      methods: new Set(["GET"]),
    };
    const optional: ApiRoute = {
      urlPath: "/api/search/[[...query]]",
      filePath: "src/app/api/search/[[...query]]/route.ts",
      methods: new Set(["GET"]),
    };

    expect(matchRoute("/api/files", new Map([[required.urlPath, required]]))).toBeUndefined();
    expect(matchRoute("/api/files/a", new Map([[required.urlPath, required]]))).toBe(required);
    expect(matchRoute("/api/search", new Map([[optional.urlPath, optional]]))).toBe(optional);
  });

  it("uses routes from the source file's workspace", () => {
    const files: DiffFile[] = [{
      path: "apps/web/src/client.ts",
      content: "export const response = fetch('/api/health');\n",
      changedLines: [1],
      status: "added",
    }];

    const result = analyzeApiRouteSourceFiles(files, fixtureG);

    expect(result.checkedRefs).toBe(1);
    expect(result.validRefs).toBe(1);
    expect(result.hallucinations).toEqual([]);
  });

  it("does not use a route from a sibling workspace", () => {
    const files: DiffFile[] = [{
      path: "apps/admin/src/client.ts",
      content: "export const response = fetch('/api/health');\n",
      changedLines: [1],
      status: "added",
    }];

    const result = analyzeApiRouteSourceFiles(files, fixtureG);

    expect(result.checkedRefs).toBe(1);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.hallucinations[0].urlPath).toBe("/api/health");
  });

  it("keeps duplicate route paths and methods isolated by workspace", () => {
    const files: DiffFile[] = [
      {
        path: "apps/web/src/client.ts",
        content: "export const response = fetch('/api/shared', { method: 'POST' });\n",
        changedLines: [1],
        status: "added",
      },
      {
        path: "apps/admin/src/client.ts",
        content: "export const response = fetch('/api/shared', { method: 'POST' });\n",
        changedLines: [1],
        status: "added",
      },
    ];

    const result = analyzeApiRouteSourceFiles(files, fixtureG);

    expect(result.checkedRefs).toBe(2);
    expect(result.validRefs).toBe(1);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.hallucinations[0]).toMatchObject({
      file: "apps/web/src/client.ts",
      method: "POST",
      hallucinationCategory: "hallucinated-method",
    });
  });
});
