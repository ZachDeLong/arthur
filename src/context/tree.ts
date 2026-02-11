import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

type Ignore = ReturnType<typeof ignore>;

const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".codeverifier",
  "__pycache__",
  ".next",
  ".venv",
  "venv",
];

function loadGitignore(projectDir: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);

  const gitignorePath = path.join(projectDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(content);
  }
  return ig;
}

interface TreeEntry {
  name: string;
  isDir: boolean;
  children?: TreeEntry[];
}

function buildTree(
  dir: string,
  ig: Ignore,
  rootDir: string,
  currentDepth: number,
  maxDepth: number,
): TreeEntry[] {
  if (currentDepth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: TreeEntry[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.relative(rootDir, path.join(dir, entry.name));
    // Normalize to forward slashes for ignore matching
    const normalizedPath = relativePath.replace(/\\/g, "/");

    const testPath = entry.isDirectory()
      ? normalizedPath + "/"
      : normalizedPath;

    if (ig.ignores(testPath)) continue;

    const node: TreeEntry = {
      name: entry.name,
      isDir: entry.isDirectory(),
    };

    if (entry.isDirectory()) {
      node.children = buildTree(
        path.join(dir, entry.name),
        ig,
        rootDir,
        currentDepth + 1,
        maxDepth,
      );
    }

    result.push(node);
  }

  return result;
}

function renderTree(entries: TreeEntry[], prefix: string = ""): string {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const display = entry.isDir ? entry.name + "/" : entry.name;
    lines.push(prefix + connector + display);

    if (entry.children && entry.children.length > 0) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      lines.push(renderTree(entry.children, childPrefix));
    }
  }
  return lines.join("\n");
}

/** Generate a gitignore-aware directory tree string. */
export function generateTree(
  projectDir: string,
  maxDepth: number = 4,
): string {
  const ig = loadGitignore(projectDir);
  const entries = buildTree(projectDir, ig, projectDir, 0, maxDepth);
  const dirName = path.basename(projectDir);
  return dirName + "/\n" + renderTree(entries);
}

/** Get a set of all files in the project (for cross-referencing). */
export function getAllFiles(
  projectDir: string,
  maxDepth: number = 6,
): Set<string> {
  const ig = loadGitignore(projectDir);
  const files = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path
        .relative(projectDir, fullPath)
        .replace(/\\/g, "/");
      const testPath = entry.isDirectory()
        ? relativePath + "/"
        : relativePath;
      if (ig.ignores(testPath)) continue;

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else {
        files.add(relativePath);
      }
    }
  }

  walk(projectDir, 0);
  return files;
}
