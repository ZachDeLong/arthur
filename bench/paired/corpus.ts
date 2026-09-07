import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PairedCase,
  PairedCategory,
  PairedLabel,
  PairedManifest,
  PairedOutcome,
} from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
export const casesPath = path.join(here, "cases.json");
export const labelsPath = path.join(here, "labels.json");
export const manifestPath = path.join(here, "manifest.json");
const seed = "arthur-paired-v1-2026-09-07";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function blindId(category: PairedCategory, projectDir: string, base: string, variant: string): string {
  return `case-${sha256(`${seed}|${category}|${projectDir}|${base}|${variant}`).slice(0, 12)}`;
}

function mutateText(value: string, occupied: Set<string>): string {
  const offset = Number.parseInt(sha256(`${seed}|${value}`).slice(0, 8), 16);
  for (let step = 0; step < value.length; step++) {
    const index = (offset + step) % value.length;
    const char = value[index];
    if (!/[A-Za-z0-9]/.test(char)) continue;

    const replacement = /[A-Z]/.test(char)
      ? String.fromCharCode(((char.charCodeAt(0) - 65 + 1) % 26) + 65)
      : /[a-z]/.test(char)
        ? String.fromCharCode(((char.charCodeAt(0) - 97 + 1) % 26) + 97)
        : String((Number(char) + 1) % 10);
    const candidate = `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
    if (!occupied.has(candidate)) return candidate;
  }

  let suffix = 1;
  while (occupied.has(`${value}-${suffix}`)) suffix++;
  return `${value}-${suffix}`;
}

function addVariants(
  cases: PairedCase[],
  labels: PairedLabel[],
  input: {
    category: PairedCategory;
    projectDir: string;
    base: string;
    validSource: string;
    invalidSource: string;
    ignoredCommentSource: string;
    ignoredStringSource: string;
    validOracle: string;
    invalidOracle: string;
  },
): void {
  const variants: Array<{
    name: string;
    source: string;
    expected: PairedOutcome;
    basis: PairedLabel["basis"];
    oracle: string;
  }> = [
    {
      name: "valid",
      source: input.validSource,
      expected: "clean",
      basis: "artifact-valid",
      oracle: input.validOracle,
    },
    {
      name: "invalid",
      source: input.invalidSource,
      expected: "error",
      basis: "artifact-invalid",
      oracle: input.invalidOracle,
    },
    {
      name: "comment",
      source: input.ignoredCommentSource,
      expected: "ignored",
      basis: "language-ignored",
      oracle: "The apparent reference occurs only inside a JavaScript comment.",
    },
    {
      name: "string",
      source: input.ignoredStringSource,
      expected: "ignored",
      basis: "language-ignored",
      oracle: "The apparent reference occurs only inside a documentation string.",
    },
  ];

  for (const variant of variants) {
    const id = blindId(input.category, input.projectDir, input.base, variant.name);
    cases.push({
      id,
      category: input.category,
      projectDir: input.projectDir,
      filePath: `src/paired-benchmark/${id}.ts`,
      source: variant.source,
    });
    labels.push({
      id,
      expected: variant.expected,
      basis: variant.basis,
      oracle: variant.oracle,
    });
  }
}

function parseEnvNames(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function routePathFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const afterApp = normalized.slice(normalized.indexOf("/app/") + 5);
  return `/${afterApp.replace(/\/route\.[^.]+$/, "")}`;
}

function walkRouteFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walkRouteFiles(fullPath));
    else if (/^route\.(?:ts|tsx|js|jsx)$/.test(entry.name)) results.push(fullPath);
  }
  return results;
}

export function generateCorpus(): {
  cases: PairedCase[];
  labels: PairedLabel[];
  manifest: PairedManifest;
} {
  const cases: PairedCase[] = [];
  const labels: PairedLabel[] = [];
  const sourceHashes: Record<string, string> = {};

  // Exhaustively include every direct runtime dependency in Arthur's package.json.
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJsonText = fs.readFileSync(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(packageJsonText) as {
    dependencies?: Record<string, string>;
  };
  const packages = Object.keys(packageJson.dependencies ?? {}).sort();
  const packageSet = new Set(packages);
  sourceHashes["package.json"] = sha256(packageJsonText);

  for (const packageName of packages) {
    const installed = path.join(repoRoot, "node_modules", packageName, "package.json");
    if (!fs.existsSync(installed)) {
      throw new Error(`Cannot freeze corpus: ${packageName} is not installed. Run npm ci first.`);
    }
    let invalidPackage = mutateText(packageName, packageSet);
    while (fs.existsSync(path.join(repoRoot, "node_modules", invalidPackage, "package.json"))) {
      packageSet.add(invalidPackage);
      invalidPackage = mutateText(invalidPackage, packageSet);
    }
    addVariants(cases, labels, {
      category: "import",
      projectDir: ".",
      base: packageName,
      validSource: `import ${JSON.stringify(packageName)};`,
      invalidSource: `import ${JSON.stringify(invalidPackage)};`,
      ignoredCommentSource: `// import ${JSON.stringify(invalidPackage)};`,
      ignoredStringSource: `export const docs = ${JSON.stringify(`import ${JSON.stringify(invalidPackage)};`)};`,
      validOracle: `${packageName} is a direct dependency and has installed package metadata.`,
      invalidOracle: `${invalidPackage} is neither a direct dependency nor an installed package.`,
    });
  }

  // Exhaustively include every declared variable in the selected fixture env files.
  const envProjects = ["bench/fixtures/fixture-b", "bench/fixtures/fixture-c", "bench/fixtures/fixture-d"];
  for (const projectDir of envProjects) {
    const absoluteProject = path.join(repoRoot, projectDir);
    const envFile = fs.readdirSync(absoluteProject).find((name) => name.startsWith(".env"));
    if (!envFile) throw new Error(`No .env fixture found in ${projectDir}`);
    const relativeEnvPath = `${projectDir}/${envFile}`;
    const envText = fs.readFileSync(path.join(absoluteProject, envFile), "utf-8");
    const names = parseEnvNames(envText).sort();
    const occupied = new Set(names);
    sourceHashes[relativeEnvPath] = sha256(envText);

    for (const name of names) {
      const invalidName = mutateText(name, occupied);
      addVariants(cases, labels, {
        category: "env",
        projectDir,
        base: name,
        validSource: `export const value = process.env.${name};`,
        invalidSource: `export const value = process.env.${invalidName};`,
        ignoredCommentSource: `// export const value = process.env.${invalidName};`,
        ignoredStringSource: `export const docs = ${JSON.stringify(`process.env.${invalidName}`)};`,
        validOracle: `${name} is declared in ${relativeEnvPath}.`,
        invalidOracle: `${invalidName} is not declared in any env file for ${projectDir}.`,
      });
    }
  }

  // Exhaustively include every exported method from every fixture-c App Router route.
  const routeProject = "bench/fixtures/fixture-c";
  const routeRoot = path.join(repoRoot, routeProject, "src", "app");
  const routeEntries: Array<{ urlPath: string; method: string }> = [];
  for (const routeFile of walkRouteFiles(routeRoot).sort()) {
    const text = fs.readFileSync(routeFile, "utf-8");
    const relative = path.relative(repoRoot, routeFile).replace(/\\/g, "/");
    sourceHashes[relative] = sha256(text);
    const methods = [...text.matchAll(/\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]
      .map((match) => match[1]);
    const urlPath = routePathFromFile(routeFile);
    for (const method of methods) routeEntries.push({ urlPath, method });
  }
  const routeSet = new Set(routeEntries.map((entry) => entry.urlPath));
  for (const { urlPath, method } of routeEntries) {
    const parts = urlPath.split("/");
    const last = parts.at(-1)!;
    const invalidLast = mutateText(last, new Set([...routeSet].map((route) => route.split("/").at(-1)!)));
    const invalidPath = [...parts.slice(0, -1), invalidLast].join("/");
    const options = method === "GET" ? "" : `, { method: ${JSON.stringify(method)} }`;
    const validCall = `fetch(${JSON.stringify(urlPath)}${options})`;
    const invalidCall = `fetch(${JSON.stringify(invalidPath)}${options})`;
    addVariants(cases, labels, {
      category: "route",
      projectDir: routeProject,
      base: `${method} ${urlPath}`,
      validSource: `export const response = ${validCall};`,
      invalidSource: `export const response = ${invalidCall};`,
      ignoredCommentSource: `// export const response = ${invalidCall};`,
      ignoredStringSource: `export const docs = ${JSON.stringify(invalidCall)};`,
      validOracle: `${method} ${urlPath} is exported by a fixture route file.`,
      invalidOracle: `${method} ${invalidPath} has no matching fixture route file.`,
    });
  }

  cases.sort((a, b) => a.id.localeCompare(b.id));
  labels.sort((a, b) => a.id.localeCompare(b.id));
  const casesText = stableJson(cases);
  const labelsText = stableJson(labels);
  const categoryCounts = { import: 0, env: 0, route: 0 };
  for (const testCase of cases) categoryCounts[testCase.category]++;

  return {
    cases,
    labels,
    manifest: {
      benchmarkVersion: 1,
      seed,
      selectionProcedure:
        "All direct runtime dependencies in package.json, all declared env names in fixtures b/c/d, and all exported HTTP methods in fixture-c App Router route files; four fixed variants per reference.",
      caseCount: cases.length,
      categoryCounts,
      sourceHashes: Object.fromEntries(Object.entries(sourceHashes).sort()),
      casesSha256: sha256(casesText),
      labelsSha256: sha256(labelsText),
    },
  };
}

export function freezeCorpus(force = false): PairedManifest {
  for (const target of [casesPath, labelsPath, manifestPath]) {
    if (!force && fs.existsSync(target)) {
      throw new Error(`Refusing to overwrite locked corpus file: ${target}. Pass --force deliberately.`);
    }
  }
  const generated = generateCorpus();
  fs.writeFileSync(casesPath, stableJson(generated.cases), "utf-8");
  fs.writeFileSync(labelsPath, stableJson(generated.labels), "utf-8");
  fs.writeFileSync(manifestPath, stableJson(generated.manifest), "utf-8");
  return generated.manifest;
}

function verifySourceArtifacts(manifest: PairedManifest): void {
  for (const [relativePath, expectedHash] of Object.entries(manifest.sourceHashes)) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`Locked source artifact is missing: ${relativePath}`);
    if (sha256(fs.readFileSync(absolutePath)) !== expectedHash) {
      throw new Error(`Locked source artifact changed: ${relativePath}. Freeze a new benchmark version instead of silently rescoring.`);
    }
  }
}

/** Load prediction inputs without opening the separately stored labels. */
export function loadLockedCases(): {
  cases: PairedCase[];
  manifest: PairedManifest;
} {
  const casesText = fs.readFileSync(casesPath, "utf-8");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PairedManifest;
  if (sha256(casesText) !== manifest.casesSha256) throw new Error("cases.json hash does not match manifest.json");
  verifySourceArtifacts(manifest);
  const cases = JSON.parse(casesText) as PairedCase[];
  const caseIds = new Set(cases.map((testCase) => testCase.id));
  if (caseIds.size !== cases.length) throw new Error("Locked cases contain duplicate ids.");
  return { cases, manifest };
}

export function loadLockedCorpus(): {
  cases: PairedCase[];
  labels: PairedLabel[];
  manifest: PairedManifest;
} {
  const { cases, manifest } = loadLockedCases();
  const labelsText = fs.readFileSync(labelsPath, "utf-8");
  if (sha256(labelsText) !== manifest.labelsSha256) throw new Error("labels.json hash does not match manifest.json");
  const labels = JSON.parse(labelsText) as PairedLabel[];
  const caseIds = new Set(cases.map((testCase) => testCase.id));
  const labelIds = new Set(labels.map((label) => label.id));
  if (caseIds.size !== cases.length || labelIds.size !== labels.length) {
    throw new Error("Locked corpus contains duplicate ids.");
  }
  if (caseIds.size !== labelIds.size || [...caseIds].some((id) => !labelIds.has(id))) {
    throw new Error("cases.json and labels.json ids do not match.");
  }
  return {
    cases,
    labels,
    manifest,
  };
}
