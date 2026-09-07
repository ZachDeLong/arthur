import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DiffStatus = "added" | "modified" | "renamed" | "copied" | "deleted" | "untracked";

export interface DiffFile {
  path: string;
  content: string;
  /** One-based line numbers added or changed relative to the requested ref. */
  changedLines?: number[];
  status?: DiffStatus;
  previousPath?: string;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const CONTRACT_FILE_NAMES = new Set([
  "package.json",
]);

export interface ResolveDiffOptions {
  staged?: boolean;
  /** Include untracked source files in working-tree mode. Defaults to true. */
  includeUntracked?: boolean;
}

interface ChangedPath {
  path: string;
  status: DiffStatus;
  previousPath?: string;
}

function validateDiffRef(diffRef: string): void {
  // `execFileSync` avoids a shell, but refs beginning with a dash can still be
  // interpreted as git options. Keep a conservative allow-list as a second
  // boundary before the explicit `--` separator used below.
  if (/^-/.test(diffRef) || /[;&|`$(){}\[\]!<>\\]/.test(diffRef) || diffRef.length > 256) {
    throw new Error(`Invalid git ref: "${diffRef}"`);
  }
}

function runGit(projectDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * `git diff --cached` compares against the empty tree when no commit exists.
 * Preserve normal ref validation everywhere else, but omit HEAD for the first
 * staged check in a newly initialized repository.
 */
function resolveBaseRef(
  projectDir: string,
  diffRef: string,
  staged: boolean,
): string | undefined {
  if (!staged || diffRef !== "HEAD") return diffRef;

  try {
    runGit(projectDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return diffRef;
  } catch {
    // Distinguish an unborn branch from a non-Git directory before falling
    // back to Git's built-in empty-tree behavior.
    runGit(projectDir, ["rev-parse", "--git-dir"]);
    return undefined;
  }
}

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isRelevantDiffFile(filePath: string): boolean {
  const normalized = normalizeGitPath(filePath);
  const base = path.posix.basename(normalized);
  if (SOURCE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) return true;
  if (CONTRACT_FILE_NAMES.has(base)) return true;
  return /^\.env(?:\.|$)/.test(base);
}

export function isJavaScriptSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(normalizeGitPath(filePath)).toLowerCase());
}

function parseNameStatus(output: string): ChangedPath[] {
  const tokens = output.split("\0");
  const changes: ChangedPath[] = [];
  let index = 0;

  while (index < tokens.length) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;

    const code = statusToken[0];
    if (code === "R" || code === "C") {
      const previousPath = tokens[index++];
      const filePath = tokens[index++];
      if (!previousPath || !filePath) continue;
      changes.push({
        path: normalizeGitPath(filePath),
        previousPath: normalizeGitPath(previousPath),
        status: code === "R" ? "renamed" : "copied",
      });
      continue;
    }

    const filePath = tokens[index++];
    if (!filePath) continue;
    const status: DiffStatus | undefined = code === "A"
      ? "added"
      : code === "M"
        ? "modified"
        : code === "D"
          ? "deleted"
          : undefined;
    if (status) changes.push({ path: normalizeGitPath(filePath), status });
  }

  return changes;
}

function listChangedPaths(
  projectDir: string,
  diffRef: string | undefined,
  options: ResolveDiffOptions,
): ChangedPath[] {
  const args = ["diff", "--name-status", "-z", "--diff-filter=ACMRD"];
  if (options.staged) args.push("--cached");
  if (diffRef) args.push(diffRef);
  args.push("--");

  const changes = parseNameStatus(runGit(projectDir, args));

  if (!options.staged && options.includeUntracked !== false) {
    const untracked = runGit(projectDir, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
      .split("\0")
      .filter(Boolean)
      .map((filePath) => ({
        path: normalizeGitPath(filePath),
        status: "untracked" as const,
      }));
    changes.push(...untracked);
  }

  const byPath = new Map<string, ChangedPath>();
  for (const change of changes) byPath.set(change.path, change);
  return [...byPath.values()];
}

function readWorkingTreeFile(projectDir: string, filePath: string): string | null {
  const root = path.resolve(projectDir);
  const fullPath = path.resolve(root, filePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (fullPath !== root && !fullPath.startsWith(rootPrefix)) return null;
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
  return fs.readFileSync(fullPath, "utf-8");
}

function readIndexFile(projectDir: string, filePath: string): string | null {
  try {
    return runGit(projectDir, ["show", `:${filePath}`]);
  } catch {
    return null;
  }
}

function allLineNumbers(content: string): number[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const count = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
  return Array.from({ length: count }, (_, index) => index + 1);
}

function singleFileChangedLineNumbers(
  projectDir: string,
  diffRef: string | undefined,
  filePath: string,
  staged: boolean,
): number[] {
  const args = ["diff", "--unified=0", "--no-color"];
  if (staged) args.push("--cached");
  if (diffRef) args.push(diffRef);
  args.push("--", filePath);

  const patch = runGit(projectDir, args);
  const lines = new Set<number>();
  const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

  for (const match of patch.matchAll(hunkPattern)) {
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    for (let offset = 0; offset < count; offset++) lines.add(start + offset);
  }

  return [...lines].sort((a, b) => a - b);
}

function decodePatchPath(rawPath: string): string | null {
  if (rawPath === "/dev/null") return null;
  let decoded = rawPath;
  if (decoded.startsWith('"') && decoded.endsWith('"')) {
    try {
      decoded = JSON.parse(decoded) as string;
    } catch {
      return null;
    }
  }
  if (decoded.startsWith("b/")) decoded = decoded.slice(2);
  return normalizeGitPath(decoded);
}

/** Parse all hunk locations from one git process instead of one process per file. */
function changedLineMap(
  projectDir: string,
  diffRef: string | undefined,
  staged: boolean,
): Map<string, number[]> {
  const args = ["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color"];
  if (staged) args.push("--cached");
  if (diffRef) args.push(diffRef);
  args.push("--");

  const patch = runGit(projectDir, args);
  const linesByPath = new Map<string, Set<number>>();
  let currentPath: string | null = null;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentPath = decodePatchPath(line.slice(4).replace(/\r$/, ""));
      if (currentPath && !linesByPath.has(currentPath)) {
        linesByPath.set(currentPath, new Set());
      }
      continue;
    }
    if (!currentPath || !line.startsWith("@@ ")) continue;

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    const changed = linesByPath.get(currentPath)!;
    for (let offset = 0; offset < count; offset++) changed.add(start + offset);
  }

  return new Map(
    [...linesByPath].map(([filePath, lines]) => [
      filePath,
      [...lines].sort((a, b) => a - b),
    ]),
  );
}

export function resolveDiffFiles(
  projectDir: string,
  diffRef: string,
  options: ResolveDiffOptions = {},
): DiffFile[] {
  validateDiffRef(diffRef);

  let baseRef: string | undefined;
  try {
    baseRef = resolveBaseRef(projectDir, diffRef, options.staged ?? false);
  } catch {
    throw new Error(`git diff failed for ref "${diffRef}"`);
  }

  let changedPaths: ChangedPath[];
  try {
    changedPaths = listChangedPaths(projectDir, baseRef, options);
  } catch {
    throw new Error(`git diff failed for ref "${diffRef}"`);
  }

  const results: DiffFile[] = [];
  let lineMap = new Map<string, number[]>();
  try {
    lineMap = changedLineMap(projectDir, baseRef, options.staged ?? false);
  } catch {
    // The name/status result is still usable; individual files fall back below.
  }

  for (const change of changedPaths) {
    if (!isRelevantDiffFile(change.path)) continue;

    if (change.status === "deleted") {
      results.push({ ...change, content: "", changedLines: [] });
      continue;
    }

    const content = options.staged && change.status !== "untracked"
      ? readIndexFile(projectDir, change.path)
      : readWorkingTreeFile(projectDir, change.path);
    if (content === null) continue;

    let changedLines: number[];
    try {
      changedLines = change.status === "untracked"
        ? allLineNumbers(content)
        : lineMap.has(change.path)
          ? lineMap.get(change.path)!
          : singleFileChangedLineNumbers(projectDir, baseRef, change.path, options.staged ?? false);
    } catch {
      changedLines = allLineNumbers(content);
    }

    results.push({
      ...change,
      content,
      changedLines,
    });
  }

  return results;
}
