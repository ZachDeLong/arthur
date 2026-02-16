import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  detectFramework,
  buildExpressRouteIndex,
  extractExpressRouteRefs,
  analyzeExpressRoutes,
} from "../src/analysis/express-route-checker.js";

const FIXTURE_E = path.resolve(__dirname, "../bench/fixtures/fixture-e");

describe("detectFramework", () => {
  it("detects Express in fixture-e", () => {
    expect(detectFramework(FIXTURE_E)).toBe("express");
  });

  it("returns none for non-existent dir", () => {
    expect(detectFramework("/tmp/nonexistent-project-xyz")).toBe("none");
  });
});

describe("buildExpressRouteIndex", () => {
  it("indexes routes with mount prefix resolution", () => {
    const index = buildExpressRouteIndex(FIXTURE_E);

    // Should find routes from users.ts mounted at /api/users
    expect(index.has("/api/users")).toBe(true);
    expect(index.has("/api/users/:id")).toBe(true);

    // Should find routes from auth.ts mounted at /api/auth
    expect(index.has("/api/auth/login")).toBe(true);
    expect(index.has("/api/auth/register")).toBe(true);
    expect(index.has("/api/auth/refresh")).toBe(true);

    // Should find routes from health.ts mounted at /health
    expect(index.has("/health")).toBe(true);

    // Should find direct route on app
    expect(index.has("/api/status")).toBe(true);
  });

  it("indexes correct methods for each route", () => {
    const index = buildExpressRouteIndex(FIXTURE_E);

    const userRoutes = index.get("/api/users");
    expect(userRoutes).toBeDefined();
    const userMethods = new Set(userRoutes!.map(r => r.method));
    expect(userMethods.has("GET")).toBe(true);
    expect(userMethods.has("POST")).toBe(true);

    const userIdRoutes = index.get("/api/users/:id");
    expect(userIdRoutes).toBeDefined();
    const userIdMethods = new Set(userIdRoutes!.map(r => r.method));
    expect(userIdMethods.has("GET")).toBe(true);
    expect(userIdMethods.has("PUT")).toBe(true);
    expect(userIdMethods.has("DELETE")).toBe(true);
  });
});

describe("extractExpressRouteRefs", () => {
  it("extracts fetch references", () => {
    const refs = extractExpressRouteRefs(`fetch('/api/users')`);
    expect(refs.length).toBe(1);
    expect(refs[0].urlPath).toBe("/api/users");
  });

  it("extracts fetch with method", () => {
    const refs = extractExpressRouteRefs(`fetch('/api/users', { method: 'POST' })`);
    expect(refs.some(r => r.urlPath === "/api/users" && r.method === "POST")).toBe(true);
  });

  it("extracts axios references", () => {
    const refs = extractExpressRouteRefs(`axios.get('/api/users')`);
    expect(refs.some(r => r.urlPath === "/api/users" && r.method === "GET")).toBe(true);
  });

  it("extracts REST notation", () => {
    const refs = extractExpressRouteRefs("POST /api/auth/login");
    expect(refs.some(r => r.urlPath === "/api/auth/login" && r.method === "POST")).toBe(true);
  });

  it("extracts backtick references", () => {
    const refs = extractExpressRouteRefs("Call the `/api/users/:id` endpoint");
    expect(refs.some(r => r.urlPath === "/api/users/:id")).toBe(true);
  });

  it("skips file paths in backticks", () => {
    const refs = extractExpressRouteRefs("`/src/routes/users.ts`");
    expect(refs.length).toBe(0);
  });

  it("deduplicates references", () => {
    const refs = extractExpressRouteRefs(`
      fetch('/api/users')
      fetch('/api/users')
    `);
    expect(refs.length).toBe(1);
  });
});

describe("analyzeExpressRoutes", () => {
  it("detects hallucinated routes", () => {
    const plan = `
      We'll call fetch('/api/users') to list users.
      Then POST /api/auth/login to authenticate.
      Also need to GET /api/products which doesn't exist.
    `;
    const analysis = analyzeExpressRoutes(plan, FIXTURE_E);

    expect(analysis.framework).toBe("express");
    expect(analysis.routesIndexed).toBeGreaterThan(0);

    // /api/products should be hallucinated
    const hallucinated = analysis.hallucinations.find(h => h.urlPath === "/api/products");
    expect(hallucinated).toBeDefined();
    expect(hallucinated!.hallucinationCategory).toBe("hallucinated-route");

    // /api/users and /api/auth/login should be valid
    expect(analysis.hallucinations.find(h => h.urlPath === "/api/users")).toBeUndefined();
    expect(analysis.hallucinations.find(h => h.urlPath === "/api/auth/login")).toBeUndefined();
  });

  it("detects hallucinated methods", () => {
    const plan = `DELETE /api/auth/login`;
    const analysis = analyzeExpressRoutes(plan, FIXTURE_E);

    // auth/login only has POST, not DELETE
    const hallucinated = analysis.hallucinations.find(h => h.urlPath === "/api/auth/login");
    expect(hallucinated).toBeDefined();
    expect(hallucinated!.hallucinationCategory).toBe("hallucinated-method");
  });

  it("matches dynamic segments", () => {
    const plan = `fetch('/api/users/123')`;
    const analysis = analyzeExpressRoutes(plan, FIXTURE_E);

    // /api/users/123 should match /api/users/:id
    expect(analysis.hallucinations.find(h => h.urlPath === "/api/users/123")).toBeUndefined();
    expect(analysis.validRefs).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for non-express project", () => {
    const analysis = analyzeExpressRoutes("GET /api/users", "/tmp/nonexistent-project-xyz");
    expect(analysis.framework).toBe("none");
    expect(analysis.routesIndexed).toBe(0);
  });
});
