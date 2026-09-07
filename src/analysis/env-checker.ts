import fs from "node:fs";
import path from "node:path";
import { isJavaScriptSourceFile, type DiffFile } from "../diff/resolver.js";
import type { SourceLocation } from "./registry.js";
import {
  occurrenceLocation,
  occurrenceTouchesChangedLines,
} from "./source-locations.js";
import { extractTypeScriptEnvRefs } from "./typescript-source.js";
import {
  createPackageRootResolver,
  normalizeProjectPath,
} from "./package-boundary.js";

// --- Types ---

export interface EnvRef {
  raw: string;           // 'process.env.DATABASE_URL'
  varName: string;       // 'DATABASE_URL'
  valid: boolean;
  reason?: string;       // 'not-in-env-files'
  suggestion?: string;   // Fuzzy match: 'DB_URL'
  file?: string;
  location?: SourceLocation;
}

export interface EnvAnalysis {
  totalRefs: number;
  checkedRefs: number;   // After skipping runtime vars
  validRefs: number;
  hallucinations: EnvRef[];
  hallucinationRate: number;
  skippedRefs: number;   // Runtime/OS vars
  envFilesFound: string[]; // Which .env* files existed
}

// --- Runtime Variables (Skip Set) ---

const RUNTIME_VARS = new Set([
  "NODE_ENV", "HOME", "PATH", "PWD", "USER", "SHELL", "LANG", "TERM",
  "CI", "PORT", "HOST", "HOSTNAME", "TZ", "EDITOR", "TMPDIR", "TEMP",
  "TMP", "npm_package_name", "npm_package_version", "npm_lifecycle_event",
]);

function isRuntimeVar(varName: string): boolean {
  if (RUNTIME_VARS.has(varName)) return true;
  if (varName.startsWith("npm_")) return true;
  return false;
}

// --- Env File Parsing ---

const ENV_FILE_NAMES = [
  ".env", ".env.example", ".env.local", ".env.development",
  ".env.production", ".env.test", ".env.staging",
];

const KEY_REGEX = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

interface EnvContract {
  vars: Set<string>;
  filesFound: string[];
}

interface EnvOverlay {
  content: string;
  deleted: boolean;
}

function envOverlayMap(diffFiles: DiffFile[]): Map<string, EnvOverlay> {
  const overlays = new Map<string, EnvOverlay>();
  for (const file of diffFiles) {
    const normalized = normalizeProjectPath(file.path);
    if (/^\.env(?:\.|$)/.test(path.posix.basename(normalized))) {
      overlays.set(normalized, {
        content: file.content,
        deleted: file.status === "deleted",
      });
    }
    if (file.status === "renamed" && file.previousPath) {
      const previousPath = normalizeProjectPath(file.previousPath);
      if (/^\.env(?:\.|$)/.test(path.posix.basename(previousPath))) {
        overlays.set(previousPath, { content: "", deleted: true });
      }
    }
  }
  return overlays;
}

function parseEnvDirectory(
  projectDir: string,
  directory: string,
  overlays: Map<string, EnvOverlay>,
): EnvContract {
  const vars = new Set<string>();
  const filesFound: string[] = [];
  const normalizedDirectory = normalizeProjectPath(directory).replace(/\/$/, "");
  const absoluteDirectory = path.join(projectDir, normalizedDirectory);

  const discoveredNames = new Set(ENV_FILE_NAMES);
  try {
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.env(?:\.|$)/.test(entry.name)) discoveredNames.add(entry.name);
    }
  } catch {
    // Missing or unreadable package roots are handled as no env ground truth.
  }
  for (const overlayPath of overlays.keys()) {
    const overlayDirectory = path.posix.dirname(overlayPath);
    const normalizedOverlayDirectory = overlayDirectory === "." ? "" : overlayDirectory;
    if (normalizedOverlayDirectory === normalizedDirectory) {
      discoveredNames.add(path.posix.basename(overlayPath));
    }
  }

  for (const name of [...discoveredNames].sort()) {
    const relativePath = normalizedDirectory ? `${normalizedDirectory}/${name}` : name;
    const filePath = path.join(projectDir, relativePath);
    const overlay = overlays.get(relativePath);
    if (overlay?.deleted) continue;
    if (!overlay && !fs.existsSync(filePath)) continue;

    filesFound.push(relativePath);
    const content = overlay?.content ?? fs.readFileSync(filePath, "utf-8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(KEY_REGEX);
      if (match) {
        vars.add(match[1]);
      }
    }
  }

  return { vars, filesFound };
}

/** Parse all .env* files in project root. Returns set of defined var names and list of files found. */
export function parseEnvFiles(
  projectDir: string,
  diffFiles?: DiffFile[],
): EnvContract {
  return parseEnvDirectory(projectDir, "", envOverlayMap(diffFiles ?? []));
}

function mergeEnvContracts(contracts: EnvContract[]): EnvContract {
  return {
    vars: new Set(contracts.flatMap((contract) => [...contract.vars])),
    filesFound: [...new Set(contracts.flatMap((contract) => contract.filesFound))],
  };
}

// --- Extraction ---

interface EnvOccurrence {
  varName: string;
  raw: string;
  index: number;
  length: number;
}

function extractEnvOccurrences(sourceText: string): EnvOccurrence[] {
  const occurrences: EnvOccurrence[] = [];
  const seen = new Set<string>();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /os\.environ\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /ENV\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /ENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      if (match.index === undefined || !match[1]) continue;
      const key = `${match.index}:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      occurrences.push({
        varName: match[1],
        raw: match[0],
        index: match.index,
        length: match[0].length,
      });
    }
  }

  return occurrences.sort((a, b) => a.index - b.index);
}

/** Extract unique env variable names from plan text. */
export function extractEnvRefs(planText: string): string[] {
  return [...new Set(extractEnvOccurrences(planText).map((occurrence) => occurrence.varName))];
}

// --- Fuzzy Suggestions ---

/** Find closest matching env var for a hallucinated one. */
function suggestEnvVar(hallucinated: string, knownVars: Set<string>): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const v of knownVars) {
    if (v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase())) {
      return v;
    }
  }
  return undefined;
}

// --- Main Analysis ---

/** Analyze env variable references in plan text against a project's .env* files. */
export function analyzeEnv(planText: string, projectDir: string): EnvAnalysis {
  const { vars, filesFound } = parseEnvFiles(projectDir);

  // No env files found — nothing to check against
  if (filesFound.length === 0) {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      skippedRefs: 0,
      envFilesFound: [],
    };
  }

  const allVarNames = extractEnvRefs(planText);
  const hallucinations: EnvRef[] = [];
  let skippedRefs = 0;
  let checkedRefs = 0;
  let validRefs = 0;

  for (const varName of allVarNames) {
    if (isRuntimeVar(varName)) {
      skippedRefs++;
      continue;
    }

    checkedRefs++;

    if (vars.has(varName)) {
      validRefs++;
    } else {
      const suggestion = suggestEnvVar(varName, vars);
      hallucinations.push({
        raw: varName,
        varName,
        valid: false,
        reason: "not-in-env-files",
        suggestion,
      });
    }
  }

  const hallucinationRate = checkedRefs > 0 ? hallucinations.length / checkedRefs : 0;

  return {
    totalRefs: allVarNames.length,
    checkedRefs,
    validRefs,
    hallucinations,
    hallucinationRate,
    skippedRefs,
    envFilesFound: filesFound,
  };
}

/** Analyze only env references that intersect changed lines in source files. */
export function analyzeEnvSourceFiles(files: DiffFile[], projectDir: string): EnvAnalysis {
  const overlays = envOverlayMap(files);
  const resolvePackageRoot = createPackageRootResolver(projectDir, files);
  const contracts = new Map<string, EnvContract>();
  const allFilesFound = new Set<string>();
  const hallucinations: EnvRef[] = [];
  let totalRefs = 0;
  let checkedRefs = 0;
  let validRefs = 0;
  let skippedRefs = 0;

  for (const file of files) {
    if (file.status === "deleted" || !isJavaScriptSourceFile(file.path)) continue;
    const occurrences = extractTypeScriptEnvRefs(file.path, file.content)
      .filter((occurrence) => occurrenceTouchesChangedLines(file, occurrence));
    if (occurrences.length === 0) continue;

    const packageRoot = resolvePackageRoot(file.path);
    let contract = contracts.get(packageRoot);
    if (!contract) {
      const directories = packageRoot ? ["", packageRoot] : [""];
      contract = mergeEnvContracts(
        directories.map((directory) => parseEnvDirectory(projectDir, directory, overlays)),
      );
      contracts.set(packageRoot, contract);
    }

    // Without a contract in this source file's package, there is no local
    // ground truth and therefore nothing deterministic to assert.
    if (contract.filesFound.length === 0) continue;
    for (const envFile of contract.filesFound) allFilesFound.add(envFile);

    for (const occurrence of occurrences) {
      totalRefs++;

      if (isRuntimeVar(occurrence.varName)) {
        skippedRefs++;
        continue;
      }

      checkedRefs++;
      if (contract.vars.has(occurrence.varName)) {
        validRefs++;
        continue;
      }

      hallucinations.push({
        raw: occurrence.raw,
        varName: occurrence.varName,
        valid: false,
        reason: "not-in-env-files",
        suggestion: suggestEnvVar(occurrence.varName, contract.vars),
        file: file.path,
        location: occurrenceLocation(file, occurrence),
      });
    }
  }

  return {
    totalRefs,
    checkedRefs,
    validRefs,
    hallucinations,
    hallucinationRate: checkedRefs > 0 ? hallucinations.length / checkedRefs : 0,
    skippedRefs,
    envFilesFound: [...allFilesFound].sort(),
  };
}
