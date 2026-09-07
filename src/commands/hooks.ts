import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MANAGED_MARKER = "# Managed by Arthur reference-integrity gate";

export interface HookCommandOptions {
  project?: string;
}

export interface HookCommandResult {
  code: number;
  message: string;
  hookPath?: string;
}

function resolveHooksDir(projectDir: string): string {
  let gitPath: string;
  try {
    gitPath = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("project is not a Git repository");
  }
  return path.resolve(projectDir, gitPath);
}

function managedHookContent(): string {
  return [
    "#!/bin/sh",
    MANAGED_MARKER,
    "",
    "if [ -x ./node_modules/.bin/arthur ]; then",
    "  ARTHUR_BIN=./node_modules/.bin/arthur",
    "elif command -v arthur >/dev/null 2>&1; then",
    "  ARTHUR_BIN=arthur",
    "else",
    '  echo "Arthur pre-commit hook: install arthur-mcp locally or globally." >&2',
    "  exit 1",
    "fi",
    "",
    '"$ARTHUR_BIN" check --diff HEAD --staged --project . --coverage-mode off --quiet',
    "",
  ].join("\n");
}

export function installPreCommitHook(options: HookCommandOptions = {}): HookCommandResult {
  const projectDir = path.resolve(options.project ?? ".");
  const hooksDir = resolveHooksDir(projectDir);
  const hookPath = path.join(hooksDir, "pre-commit");

  fs.mkdirSync(hooksDir, { recursive: true });
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf-8");
    if (!existing.includes(MANAGED_MARKER)) {
      return {
        code: 1,
        hookPath,
        message: "Existing pre-commit hook was left untouched. Add `arthur check --diff HEAD --staged --coverage-mode off --quiet` to it manually.",
      };
    }
  }

  fs.writeFileSync(hookPath, managedHookContent(), { encoding: "utf-8", mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // Windows filesystems may not expose POSIX mode bits; Git still invokes it.
  }

  return {
    code: 0,
    hookPath,
    message: "Arthur pre-commit hook installed. It checks staged references and stays quiet on success.",
  };
}

export function uninstallPreCommitHook(options: HookCommandOptions = {}): HookCommandResult {
  const projectDir = path.resolve(options.project ?? ".");
  const hookPath = path.join(resolveHooksDir(projectDir), "pre-commit");

  if (!fs.existsSync(hookPath)) {
    return { code: 0, hookPath, message: "No pre-commit hook is installed." };
  }

  const existing = fs.readFileSync(hookPath, "utf-8");
  if (!existing.includes(MANAGED_MARKER)) {
    return {
      code: 1,
      hookPath,
      message: "Existing pre-commit hook is not managed by Arthur and was left untouched.",
    };
  }

  fs.unlinkSync(hookPath);
  return { code: 0, hookPath, message: "Arthur pre-commit hook removed." };
}
