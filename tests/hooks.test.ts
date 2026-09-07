import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installPreCommitHook,
  uninstallPreCommitHook,
} from "../src/commands/hooks.js";

describe("Arthur pre-commit hook", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-hooks-"));
    execFileSync("git", ["init"], { cwd: projectDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("installs an idempotent, quiet staged-check hook", () => {
    const first = installPreCommitHook({ project: projectDir });
    const second = installPreCommitHook({ project: projectDir });

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const content = fs.readFileSync(first.hookPath!, "utf-8");
    expect(content).toContain("Managed by Arthur");
    expect(content).toContain("--diff HEAD --staged");
    expect(content).toContain("--coverage-mode off --quiet");
  });

  it("does not overwrite an existing user hook", () => {
    const hooksDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    const hookPath = path.resolve(projectDir, hooksDir, "pre-commit");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, "#!/bin/sh\necho user-hook\n");

    const result = installPreCommitHook({ project: projectDir });
    expect(result.code).toBe(1);
    expect(fs.readFileSync(hookPath, "utf-8")).toContain("user-hook");
  });

  it("only uninstalls hooks managed by Arthur", () => {
    const installed = installPreCommitHook({ project: projectDir });
    const removed = uninstallPreCommitHook({ project: projectDir });

    expect(removed.code).toBe(0);
    expect(fs.existsSync(installed.hookPath!)).toBe(false);
  });
});
