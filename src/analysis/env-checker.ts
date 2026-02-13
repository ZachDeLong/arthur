import fs from "node:fs";
import path from "node:path";

// --- Types ---

export interface EnvRef {
  raw: string;           // 'process.env.DATABASE_URL'
  varName: string;       // 'DATABASE_URL'
  valid: boolean;
  reason?: string;       // 'not-in-env-files'
  suggestion?: string;   // Fuzzy match: 'DB_URL'
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

const KEY_REGEX = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Parse all .env* files in project root. Returns set of defined var names and list of files found. */
export function parseEnvFiles(projectDir: string): { vars: Set<string>; filesFound: string[] } {
  const vars = new Set<string>();
  const filesFound: string[] = [];

  for (const name of ENV_FILE_NAMES) {
    const filePath = path.join(projectDir, name);
    if (!fs.existsSync(filePath)) continue;

    filesFound.push(name);
    const content = fs.readFileSync(filePath, "utf-8");

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

// --- Extraction ---

/** Extract env variable names from plan text. */
export function extractEnvRefs(planText: string): string[] {
  const varNames: string[] = [];
  const seen = new Set<string>();

  const add = (name: string) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      varNames.push(name);
    }
  };

  // process.env.VAR_NAME
  for (const m of planText.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    add(m[1]);
  }

  // process.env['VAR_NAME'] / process.env["VAR_NAME"]
  for (const m of planText.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) {
    add(m[1]);
  }

  // import.meta.env.VAR_NAME
  for (const m of planText.matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    add(m[1]);
  }

  // os.environ["VAR_NAME"] / os.environ.get("VAR_NAME") / os.getenv("VAR_NAME")
  for (const m of planText.matchAll(/os\.environ\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) {
    add(m[1]);
  }
  for (const m of planText.matchAll(/os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
    add(m[1]);
  }
  for (const m of planText.matchAll(/os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
    add(m[1]);
  }

  // Deno.env.get("VAR_NAME")
  for (const m of planText.matchAll(/Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
    add(m[1]);
  }

  // ENV["VAR_NAME"] / ENV.fetch("VAR_NAME")
  for (const m of planText.matchAll(/ENV\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) {
    add(m[1]);
  }
  for (const m of planText.matchAll(/ENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
    add(m[1]);
  }

  return varNames;
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
