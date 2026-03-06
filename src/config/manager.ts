import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  type CodeVerifierConfig,
  DEFAULT_CONFIG,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_FILE,
  LEGACY_GLOBAL_CONFIG_DIR,
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILE,
} from "./schema.js";

function getGlobalConfigPath(): string {
  return path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE);
}

function getLegacyGlobalConfigPath(): string {
  return path.join(
    os.homedir(),
    LEGACY_GLOBAL_CONFIG_DIR,
    GLOBAL_CONFIG_FILE,
  );
}

function getProjectConfigPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
}

function readJsonSafe(filePath: string): Partial<CodeVerifierConfig> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Partial<CodeVerifierConfig>;
  } catch {
    return {};
  }
}

/**
 * If ~/.arthur/config.json doesn't exist but ~/.codeverifier/config.json does,
 * read from the legacy location and print a deprecation warning to stderr.
 * Returns the global config (from new location if it exists, legacy otherwise).
 */
function loadGlobalConfig(): Partial<CodeVerifierConfig> {
  const newPath = getGlobalConfigPath();
  if (fs.existsSync(newPath)) {
    return readJsonSafe(newPath);
  }

  const legacyPath = getLegacyGlobalConfigPath();
  if (fs.existsSync(legacyPath)) {
    console.error(
      `[arthur] Deprecation warning: ~/.codeverifier/config.json is deprecated. ` +
        `Please move your config to ~/.arthur/config.json`,
    );
    return readJsonSafe(legacyPath);
  }

  return {};
}

/** Load merged config: defaults < global < project < env vars. */
export function loadConfig(projectDir: string): CodeVerifierConfig {
  const globalCfg = loadGlobalConfig();
  const projectCfg = readJsonSafe(getProjectConfigPath(projectDir));

  const merged: CodeVerifierConfig = {
    ...DEFAULT_CONFIG,
    ...globalCfg,
    ...projectCfg,
  };

  // Env var takes priority
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    merged.apiKey = envKey;
  }

  return merged;
}

/** Write config to the global config file. */
export function saveGlobalConfig(
  config: Partial<CodeVerifierConfig>,
): void {
  const dir = path.join(os.homedir(), GLOBAL_CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getGlobalConfigPath();

  // Merge with existing
  const existing = readJsonSafe(filePath);
  const merged = { ...existing, ...config };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/** Ensure .arthur/ is in the project's .gitignore. */
export function ensureGitignore(projectDir: string): void {
  const gitignorePath = path.join(projectDir, ".gitignore");
  const entry = ".arthur/";

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.split("\n").some((line) => line.trim() === entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`, "utf-8");
    }
  }
  // If no .gitignore exists, don't create one — just skip
}

/** Get the project-level .arthur directory, creating it if needed. */
export function getProjectConfigDir(projectDir: string): string {
  const dir = path.join(projectDir, PROJECT_CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
