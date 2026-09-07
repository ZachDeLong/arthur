import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveArthurCheckPolicy } from "../src/config/arthur-check.js";

describe("resolveArthurCheckPolicy", () => {
  it("makes strict mode fail closed on coverage without enabling experimental rules", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-policy-"));
    try {
      const policy = resolveArthurCheckPolicy(projectDir, { strict: true });
      expect(policy.includeExperimental).toBe(false);
      expect(policy.coverageMode).toBe("fail");
      expect(policy.minCheckedRefs).toBe(5);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("allows experimental rules only through an explicit opt-in", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-policy-"));
    try {
      const policy = resolveArthurCheckPolicy(projectDir, {
        strict: true,
        includeExperimental: true,
      });
      expect(policy.includeExperimental).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
