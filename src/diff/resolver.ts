import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface DiffFile {
  path: string;
  content: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export interface ResolveDiffOptions {
  staged?: boolean;
}

export async function resolveDiffFiles(
  projectDir: string,
  diffRef: string,
  options?: ResolveDiffOptions,
): Promise<DiffFile[]> {
  const args = ["diff", "--name-only", "--diff-filter=ACMR"];

  if (options?.staged) {
    args.push("--cached");
  }

  args.push(diffRef);

  let stdout: string;
  try {
    stdout = execSync(`git ${args.join(" ")}`, {
      cwd: projectDir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new Error(`git diff failed: ${message}`);
  }

  const filePaths = stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const results: DiffFile[] = [];

  for (const filePath of filePaths) {
    const ext = path.extname(filePath);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      continue;
    }

    const fullPath = path.join(projectDir, filePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    results.push({ path: filePath, content });
  }

  return results;
}
