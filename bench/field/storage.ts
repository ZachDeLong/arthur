import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function blindId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(parts.join("\0")).slice(0, 24)}`;
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, stableJson(value), { encoding: "utf-8", flag: "wx" });
  fs.renameSync(temporary, filePath);
}

export function writeJsonExclusive(filePath: string, value: unknown): void {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite ${filePath}`);
  writeJson(filePath, value);
}

export function writeTextExclusive(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, { encoding: "utf-8", flag: "wx" });
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonLines(filePath: string, values: unknown[]): void {
  const body = values.map((value) => JSON.stringify(stableValue(value))).join("\n");
  writeTextExclusive(filePath, body.length > 0 ? `${body}\n` : "");
}

export function replaceJson(filePath: string, value: unknown): void {
  if (!fs.existsSync(filePath)) throw new Error(`Missing file: ${filePath}`);
  writeJson(filePath, value);
}

export function fileDigest(filePath: string): { sha256: string; bytes: number } {
  const content = fs.readFileSync(filePath);
  return { sha256: sha256(content), bytes: content.byteLength };
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /sk-proj-[A-Za-z0-9_-]{12,}/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
];

export function redactSecrets(value: string): { value: string; count: number } {
  let redacted = value;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      count++;
      return "[REDACTED_SECRET]";
    });
  }
  return { value: redacted, count };
}

export function redactDiff(value: string): { value: string; count: number } {
  const generic = redactSecrets(normalizeText(value));
  let count = generic.count;
  let envFile = false;
  let previousEnvFile = false;
  const isPrivateEnvPath = (rawPath: string) => {
    const filePath = rawPath.replace(/^b\//, "").replace(/^a\//, "").replace(/^"|"$/g, "");
    const base = path.posix.basename(filePath.replace(/\\/g, "/"));
    return /^\.env(?:\.|$)/.test(base) && !/\.example(?:\.|$)/.test(base);
  };
  const lines = generic.value.split("\n").map((line) => {
    if (line.startsWith("--- ")) {
      previousEnvFile = isPrivateEnvPath(line.slice(4));
      envFile = previousEnvFile;
      return line;
    }
    if (line.startsWith("+++ ")) {
      const nextPath = line.slice(4);
      envFile = nextPath === "/dev/null" ? previousEnvFile : isPrivateEnvPath(nextPath);
      return line;
    }
    if (!envFile || !/^[ +\-](?!---|\+\+\+)/.test(line)) return line;
    const match = line.match(/^([ +\-](?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).+$/);
    if (!match) return line;
    count++;
    return `${match[1]}[REDACTED_ENV_VALUE]`;
  });
  return { value: lines.join("\n"), count };
}

export function assertSimpleId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(trimmed)) {
    throw new Error(`${label} must use 1-80 letters, numbers, dots, dashes, or underscores.`);
  }
  return trimmed;
}
