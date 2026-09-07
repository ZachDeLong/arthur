import fs from "node:fs";
import path from "node:path";
import type { DiffFile } from "../diff/resolver.js";

/** Normalize project-relative paths to the representation used by DiffFile. */
export function normalizeProjectPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function comparisonKey(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideProject(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(projectRoot, candidate);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
  );
}

/**
 * Resolve the nearest package.json boundary for a project-relative file.
 * Added/deleted manifests in the diff override the working tree so staged
 * checks use the same workspace layout as the source snapshot being checked.
 */
export function createPackageRootResolver(
  projectDir: string,
  diffFiles: DiffFile[] = [],
): (filePath: string) => string {
  const projectRoot = path.resolve(projectDir);
  const manifestOverlays = new Map<string, boolean>();

  for (const file of diffFiles) {
    const normalized = normalizeProjectPath(file.path);
    if (path.posix.basename(normalized) === "package.json") {
      manifestOverlays.set(comparisonKey(normalized), file.status !== "deleted");
    }
    if (file.status === "renamed" && file.previousPath) {
      const previousPath = normalizeProjectPath(file.previousPath);
      if (path.posix.basename(previousPath) === "package.json") {
        manifestOverlays.set(comparisonKey(previousPath), false);
      }
    }
  }

  const manifestExists = (manifestPath: string): boolean => {
    const overlay = manifestOverlays.get(comparisonKey(manifestPath));
    if (overlay !== undefined) return overlay;
    return fs.existsSync(path.join(projectRoot, manifestPath));
  };

  return (filePath: string): string => {
    const absoluteFile = path.resolve(projectRoot, normalizeProjectPath(filePath));
    if (!isInsideProject(projectRoot, absoluteFile)) return "";

    let current = path.dirname(absoluteFile);
    while (isInsideProject(projectRoot, current)) {
      const relativeDir = normalizeProjectPath(path.relative(projectRoot, current));
      const manifestPath = relativeDir ? `${relativeDir}/package.json` : "package.json";
      if (manifestExists(manifestPath)) return relativeDir;
      if (current === projectRoot) break;
      current = path.dirname(current);
    }

    return "";
  };
}
