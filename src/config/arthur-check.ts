import fs from "node:fs";
import path from "node:path";

export type CoverageMode = "off" | "warn" | "fail";

export interface ArthurCheckConfig {
  includeExperimental?: boolean;
  minCheckedRefs?: number;
  coverageMode?: CoverageMode;
}

export interface ArthurCheckPolicy {
  includeExperimental: boolean;
  minCheckedRefs: number;
  coverageMode: CoverageMode;
}

const CONFIG_FILE_PATH = ".arthur/config.json";
const DEFAULT_MIN_CHECKED_REFS = 1;
const STRICT_DEFAULT_MIN_CHECKED_REFS = 5;
const DEFAULT_COVERAGE_MODE: CoverageMode = "warn";

interface ResolveOverrides {
  includeExperimental?: boolean;
  strict?: boolean;
  minCheckedRefs?: number;
  coverageMode?: CoverageMode;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeCoverageMode(value: unknown): CoverageMode | undefined {
  if (value === "off" || value === "warn" || value === "fail") {
    return value;
  }
  return undefined;
}

/** Read optional project-level Arthur config from .arthur/config.json. */
export function loadArthurCheckConfig(projectDir: string): ArthurCheckConfig {
  const configPath = path.join(projectDir, CONFIG_FILE_PATH);
  if (!fs.existsSync(configPath)) return {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ArthurCheckConfig;

    const config: ArthurCheckConfig = {};
    if (typeof parsed.includeExperimental === "boolean") {
      config.includeExperimental = parsed.includeExperimental;
    }

    const minCheckedRefs = parsePositiveInt(parsed.minCheckedRefs);
    if (minCheckedRefs !== undefined) {
      config.minCheckedRefs = minCheckedRefs;
    }

    const coverageMode = normalizeCoverageMode(parsed.coverageMode);
    if (coverageMode) {
      config.coverageMode = coverageMode;
    }

    return config;
  } catch {
    return {};
  }
}

/** Resolve effective checker policy from defaults < project config < call-site overrides. */
export function resolveArthurCheckPolicy(
  projectDir: string,
  overrides: ResolveOverrides = {},
): ArthurCheckPolicy {
  const fromFile = loadArthurCheckConfig(projectDir);

  const fileMin = parsePositiveInt(fromFile.minCheckedRefs);
  const overrideMin = parsePositiveInt(overrides.minCheckedRefs);

  let includeExperimental = overrides.includeExperimental
    ?? fromFile.includeExperimental
    ?? false;
  let minCheckedRefs = overrideMin ?? fileMin ?? DEFAULT_MIN_CHECKED_REFS;
  let coverageMode = normalizeCoverageMode(overrides.coverageMode)
    ?? fromFile.coverageMode
    ?? DEFAULT_COVERAGE_MODE;

  if (overrides.strict) {
    includeExperimental = true;
    if (overrideMin === undefined && fileMin === undefined) {
      minCheckedRefs = STRICT_DEFAULT_MIN_CHECKED_REFS;
    }
    if (overrides.coverageMode === undefined && fromFile.coverageMode === undefined) {
      coverageMode = "fail";
    }
  }

  return { includeExperimental, minCheckedRefs, coverageMode };
}
