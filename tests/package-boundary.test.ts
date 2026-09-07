import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPackageRootResolver } from "../src/analysis/package-boundary.js";

describe("createPackageRootResolver", () => {
  it("uses the nearest on-disk package boundary", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-package-boundary-"));
    fs.mkdirSync(path.join(projectDir, "apps", "web", "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "package.json"), "{}");
    fs.writeFileSync(path.join(projectDir, "apps", "web", "package.json"), "{}");

    try {
      const resolvePackageRoot = createPackageRootResolver(projectDir);
      expect(resolvePackageRoot("apps/web/src/client.ts")).toBe("apps/web");
      expect(resolvePackageRoot("src/root.ts")).toBe("");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("applies added and deleted package manifests from the diff snapshot", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-package-overlay-"));
    fs.mkdirSync(path.join(projectDir, "apps", "old", "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "package.json"), "{}");
    fs.writeFileSync(path.join(projectDir, "apps", "old", "package.json"), "{}");

    try {
      const resolvePackageRoot = createPackageRootResolver(projectDir, [
        {
          path: "apps/new/package.json",
          content: "{}",
          status: "added",
        },
        {
          path: "apps/old/package.json",
          content: "",
          status: "deleted",
        },
      ]);

      expect(resolvePackageRoot("apps/new/src/client.ts")).toBe("apps/new");
      expect(resolvePackageRoot("apps/old/src/client.ts")).toBe("");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
