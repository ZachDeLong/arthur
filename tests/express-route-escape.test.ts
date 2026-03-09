import { describe, it, expect } from "vitest";

describe("express-route-checker regex safety", () => {
  it("escapeRegExp escapes all special characters", async () => {
    const { escapeRegExp } = await import("../src/analysis/express-route-checker.js");
    const input = "foo.bar+baz(qux)";
    const escaped = escapeRegExp(input);
    // Should not throw when used in RegExp
    expect(() => new RegExp(escaped)).not.toThrow();
    // Should match the literal string
    expect(new RegExp(escaped).test(input)).toBe(true);
  });
});
