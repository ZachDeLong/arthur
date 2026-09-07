import fs from "node:fs";
import path from "node:path";
import { normalizeText, sha256, stableJson } from "./storage.js";

export const CHECKER_BUILD_INPUTS = [
  "src/analysis",
  "src/diff",
  "src/config/arthur-check.ts",
  "src/config/manager.ts",
  "src/config/schema.ts",
  "package-lock.json",
] as const;

function collectFiles(root: string, relativePath: string): string[] {
  const absolute = path.join(root, relativePath);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relativePath.replace(/\\/g, "/")];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => collectFiles(root, path.join(relativePath, entry.name)))
    .sort();
}

/** Fingerprint exactly the code and dependency lock used by source-mode checks. */
export function fingerprintArthurBuild(repoRoot: string): string {
  const entries = CHECKER_BUILD_INPUTS
    .flatMap((entry) => collectFiles(repoRoot, entry))
    .sort()
    .map((relativePath) => {
      const content = fs.readFileSync(path.join(repoRoot, relativePath));
      const normalized = /\.(?:ts|js|json)$/i.test(relativePath)
        ? Buffer.from(normalizeText(content.toString("utf-8")), "utf-8")
        : content;
      return { path: relativePath, sha256: sha256(normalized) };
    });
  return sha256(stableJson(entries));
}
