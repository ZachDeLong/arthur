import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordAuditEvent, verifyAuditChain } from "./audit.js";
import { buildJsonReport, type Finding } from "../../src/analysis/finding-schema.js";
import { runAllCheckers } from "../../src/analysis/run-all.js";
import {
  isJavaScriptSourceFile,
  resolveDiffFiles,
  type DiffFile,
} from "../../src/diff/resolver.js";
import "../../src/analysis/checkers/index.js";
import { validateStudyDefinition } from "./definition.js";
import { fingerprintArthurBuild } from "./fingerprint.js";
import { buildGroundTruthContracts, buildReferenceInventory } from "./inventory.js";
import {
  blindId,
  assertSimpleId,
  fileDigest,
  normalizeText,
  readJson,
  redactDiff,
  redactSecrets,
  sha256,
  stableJson,
  writeJson,
  writeTextExclusive,
} from "./storage.js";
import {
  assertStudyStatus,
  captureDir,
  loadManifest,
  saveManifest,
} from "./study-store.js";
import type {
  ActivationRecord,
  ArtifactIndex,
  ArthurCapture,
  CaptureMetadata,
  CasePrediction,
  GroundTruthContracts,
  ProjectArtifactBundle,
  ReferenceCase,
  ReferenceDomain,
  SelectionRecord,
  PredictionOutcome,
  ToolCommand,
  ToolRun,
} from "./types.js";
import { FIELD_SCHEMA_VERSION } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const arthurRepoRoot = path.resolve(here, "../..");
const activationPath = path.join(here, "activation.json");
const MAX_TOOL_OUTPUT = 1024 * 1024;

export interface CaptureOptions {
  studyDir: string;
  projectDir: string;
  baseRef: string;
  resultRef?: string;
  repositoryId: string;
  developerId: string;
  agentTool: string;
  agentEvidence: string;
  publicRepositoryUrl?: string;
  tools?: ToolCommand[];
  noStandardToolsReason?: string;
  toolTimeoutMs?: number;
  /** Test-only escape hatch because clean CI runs test before creating dist/. */
  skipCliMeasurementForTests?: boolean;
}

function collectRuntimeFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return collectRuntimeFiles(target);
      return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
    })
    .sort();
}

function compiledBuildFingerprint(): string {
  const roots = [
    path.join(arthurRepoRoot, "dist", "bin", "arthur.js"),
    path.join(arthurRepoRoot, "dist", "src", "analysis"),
    path.join(arthurRepoRoot, "dist", "src", "config"),
    path.join(arthurRepoRoot, "dist", "src", "diff"),
  ];
  const files = roots.flatMap((root) => {
    if (!fs.existsSync(root)) return [];
    return fs.statSync(root).isFile() ? [root] : collectRuntimeFiles(root);
  });
  if (files.length === 0) {
    throw new Error("Compiled Arthur CLI is missing. Run npm run build before field collection.");
  }
  const entries = files.map((filePath) => ({
    path: path.relative(arthurRepoRoot, filePath).replace(/\\/g, "/"),
    sha256: sha256(fs.readFileSync(filePath)),
  }));
  return sha256(stableJson(entries));
}

function findingSignature(report: { findings: Finding[] }): string {
  return stableJson(report.findings.map((finding) => ({
    checker: finding.checker,
    severity: finding.severity,
    category: finding.category,
    target: finding.target,
    location: finding.location,
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right))));
}

function runCompiledArthur(
  projectDir: string,
  baseCommit: string,
  expectedReport: { findings: Finding[] },
): { durationMs: number; compiledBuildSha256: string } {
  const cliPath = path.join(arthurRepoRoot, "dist", "bin", "arthur.js");
  const compiledBuildSha256 = compiledBuildFingerprint();
  const started = performance.now();
  const result = spawnSync(process.execPath, [
    cliPath,
    "check",
    "--diff",
    baseCommit,
    "--project",
    projectDir,
    "--format",
    "json",
    "--coverage-mode",
    "off",
    "--min-checked-refs",
    "0",
  ], {
    cwd: arthurRepoRoot,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = performance.now() - started;
  if (result.error) throw new Error(`Compiled Arthur CLI failed: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Compiled Arthur CLI exited unexpectedly (${result.status}): ${result.stderr}`);
  }
  const output = typeof result.stdout === "string" ? result.stdout : "";
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Compiled Arthur CLI did not return a JSON report.");
  const actual = JSON.parse(output.slice(start, end + 1)) as { findings?: Finding[] };
  if (!Array.isArray(actual.findings)) throw new Error("Compiled Arthur CLI report omitted findings[].");
  if (findingSignature({ findings: actual.findings }) !== findingSignature(expectedReport)) {
    throw new Error("Compiled Arthur CLI findings differ from the frozen in-process checker build.");
  }
  return { durationMs, compiledBuildSha256 };
}

function runGitBuffer(projectDir: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runGit(projectDir: string, args: string[]): string {
  return runGitBuffer(projectDir, args).toString("utf-8").trimEnd();
}

function resolveCommit(projectDir: string, ref: string): string {
  try {
    return runGit(projectDir, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`Git ref does not resolve to a commit: ${ref}`);
  }
}

function assertRepositoryRoot(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  let root: string;
  try {
    root = path.resolve(runGit(resolved, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`Not a Git repository: ${resolved}`);
  }
  const canonicalRoot = fs.realpathSync.native(root);
  const canonicalResolved = fs.realpathSync.native(resolved);
  if (canonicalRoot.toLowerCase() !== canonicalResolved.toLowerCase()) {
    throw new Error(`--project must be the repository root: ${root}`);
  }
  return canonicalRoot;
}

function worktreeStatus(projectDir: string): string {
  return runGit(projectDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function assertAncestor(projectDir: string, baseCommit: string, resultCommit: string): void {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", baseCommit, resultCommit],
    { cwd: projectDir, stdio: "ignore" },
  );
  if (result.status !== 0) {
    throw new Error("The base commit must be an ancestor of the result commit.");
  }
}

function currentActivation(): ActivationRecord {
  return readJson<ActivationRecord>(activationPath);
}

export function assertFrozenArthurBuild(): ActivationRecord {
  const activation = currentActivation();
  const actual = fingerprintArthurBuild(arthurRepoRoot);
  if (actual !== activation.checkerBuildSha256) {
    throw new Error(
      "Arthur checker build differs from the activated field-study build. " +
      `Expected ${activation.checkerBuildSha256}, found ${actual}. Start a new protocol version instead of tuning v1.`,
    );
  }
  return activation;
}

function domainForChecker(checker: string): ReferenceDomain | undefined {
  if (checker === "imports" || checker === "env" || checker === "routes") return checker;
  return undefined;
}

function locationKey(
  domain: ReferenceDomain,
  location: { path: string; line: number; column: number },
): string {
  return `${domain}\0${location.path.replace(/\\/g, "/")}\0${location.line}\0${location.column}`;
}

function predictCases(
  cases: ReferenceCase[],
  findings: Finding[],
): { predictions: CasePrediction[]; unmatchedFindings: Finding[] } {
  const casesByLocation = new Map(
    cases.map((item) => [locationKey(item.domain, item.location), item]),
  );
  const outcomes = new Map<string, PredictionOutcome>(
    cases.map((item) => [item.caseId, "clean"]),
  );
  const findingIds = new Map<string, string>();
  const unmatchedFindings: Finding[] = [];

  for (const finding of findings) {
    const domain = domainForChecker(finding.checker);
    if (!domain) continue;
    if (!finding.location) {
      unmatchedFindings.push(finding);
      continue;
    }
    const item = casesByLocation.get(locationKey(domain, finding.location));
    if (!item) {
      unmatchedFindings.push(finding);
      continue;
    }
    const next = finding.severity === "warning" ? "warning" : "error";
    if (outcomes.get(item.caseId) !== "error") outcomes.set(item.caseId, next);
    findingIds.set(item.caseId, finding.findingId);
  }

  return {
    predictions: cases.map((item) => ({
      caseId: item.caseId,
      outcome: outcomes.get(item.caseId) ?? "clean",
      findingId: findingIds.get(item.caseId),
    })),
    unmatchedFindings,
  };
}

function sanitizeSourceFiles(files: DiffFile[]): {
  files: Array<Omit<DiffFile, "content"> & { content: string; redactionCount: number }>;
  redactionCount: number;
} {
  let redactionCount = 0;
  const sanitized = files
    .filter((file) => isJavaScriptSourceFile(file.path))
    .map((file) => {
      const result = redactSecrets(normalizeText(file.content));
      redactionCount += result.count;
      return { ...file, content: result.value, redactionCount: result.count };
    });
  return { files: sanitized, redactionCount };
}

function relevantProjectArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  return base === "package.json" ||
    ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].includes(base) ||
    /^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/.test(base) ||
    /^(?:eslint\.config|next\.config)\.(?:js|cjs|mjs|ts)$/.test(base) ||
    /^\.eslintrc(?:\..+)?$/.test(base) ||
    ["turbo.json", "nx.json"].includes(base) ||
    (/^\.env(?:\..+)?\.example$/.test(base) || base === ".env.example");
}

function captureProjectArtifacts(projectDir: string): {
  bundle: ProjectArtifactBundle;
  redactionCount: number;
} {
  const tracked = runGit(projectDir, ["ls-files", "-z", "--"])
    .split("\0")
    .filter(Boolean)
    .filter(relevantProjectArtifact)
    .sort();
  if (tracked.length > 500) {
    throw new Error(`Project has ${tracked.length} relevant configuration files; the safety cap is 500.`);
  }
  let totalBytes = 0;
  let redactionCount = 0;
  const files = tracked.map((relativePath) => {
    const content = runGitBuffer(projectDir, ["show", `HEAD:${relativePath}`]);
    totalBytes += content.byteLength;
    if (totalBytes > 20 * 1024 * 1024) {
      throw new Error("Relevant project configuration exceeds the 20 MB capture safety cap.");
    }
    const binary = relativePath.endsWith(".lockb") || content.includes(0);
    if (binary) {
      return {
        path: relativePath.replace(/\\/g, "/"),
        rawSha256: sha256(content),
        storedSha256: sha256(content),
        bytes: content.byteLength,
        encoding: "base64" as const,
        content: content.toString("base64"),
        redactionCount: 0,
      };
    }
    const normalized = normalizeText(content.toString("utf-8"));
    const redacted = redactSecrets(normalized);
    redactionCount += redacted.count;
    return {
      path: relativePath.replace(/\\/g, "/"),
      rawSha256: sha256(normalized),
      storedSha256: sha256(redacted.value),
      bytes: content.byteLength,
      encoding: "utf8" as const,
      content: redacted.value,
      redactionCount: redacted.count,
    };
  });
  return { bundle: { schemaVersion: FIELD_SCHEMA_VERSION, files }, redactionCount };
}

function sanitizeCases(cases: ReferenceCase[]): ReferenceCase[] {
  return cases.map((item) => ({
    ...item,
    raw: redactSecrets(item.raw).value,
    target: redactSecrets(item.target).value,
    context: item.context.map((line) => ({
      ...line,
      text: redactSecrets(line.text).value,
    })),
  }));
}

function runTool(projectDir: string, tool: ToolCommand, timeoutMs: number): ToolRun {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(tool.command, {
    cwd: projectDir,
    shell: true,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const rawStdout = typeof result.stdout === "string" ? result.stdout : "";
  const rawStderr = typeof result.stderr === "string" ? result.stderr : "";
  const outputTruncated = rawStdout.length > MAX_TOOL_OUTPUT || rawStderr.length > MAX_TOOL_OUTPUT;
  const stdout = redactSecrets(rawStdout.slice(0, MAX_TOOL_OUTPUT));
  const stderr = redactSecrets(rawStderr.slice(0, MAX_TOOL_OUTPUT));
  const command = redactSecrets(tool.command);
  const executionError = result.error ? redactSecrets(result.error.message).value : undefined;
  return {
    kind: tool.kind,
    name: tool.name,
    command: command.value,
    startedAt,
    durationMs: performance.now() - started,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.name === "ETIMEDOUT" || result.signal === "SIGTERM",
    stdout: stdout.value,
    stderr: stderr.value,
    redactionCount: stdout.count + stderr.count + command.count,
    outputTruncated,
    executionError,
  };
}

function createArtifactIndex(directory: string): ArtifactIndex {
  const paths = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "artifacts.json")
    .map((entry) => entry.name)
    .sort();
  const files = paths.map((relativePath) => ({
    path: relativePath,
    ...fileDigest(path.join(directory, relativePath)),
  }));
  return {
    schemaVersion: FIELD_SCHEMA_VERSION,
    files,
    aggregateSha256: sha256(stableJson(files)),
  };
}

function blockingFindingCount(arthur: ArthurCapture): number {
  return arthur.report.findings.filter((finding) => finding.severity === "error").length;
}

function selectionsDirectory(studyDir: string): string {
  return path.join(path.resolve(studyDir), "selections");
}

export function listSelectionRecords(studyDir: string): SelectionRecord[] {
  const directory = selectionsDirectory(studyDir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<SelectionRecord>(path.join(directory, name)));
}

export function pendingSelectionIds(
  studyDir: string,
  captures: Array<{ changeId: string }>,
): string[] {
  const completed = new Set(captures.map((capture) => capture.changeId));
  return listSelectionRecords(studyDir)
    .map((selection) => selection.changeId)
    .filter((changeId) => !completed.has(changeId))
    .sort();
}

function lockSelection(
  studyDir: string,
  input: Omit<SelectionRecord, "selectedAt">,
): SelectionRecord {
  const target = path.join(selectionsDirectory(studyDir), `${input.changeId}.json`);
  if (fs.existsSync(target)) {
    const saved = readJson<SelectionRecord>(target);
    const { selectedAt: _savedAt, ...savedInput } = saved;
    if (stableJson(savedInput) !== stableJson(input)) {
      throw new Error(`Pending selection ${input.changeId} does not match this capture attempt.`);
    }
    const relative = path.relative(path.resolve(studyDir), target).replace(/\\/g, "/");
    const event = verifyAuditChain(studyDir).find((item) => item.artifactPath === relative);
    if (event?.type !== "candidate_selected_before_prediction") {
      throw new Error(`Pending selection ${input.changeId} is missing its pre-prediction audit event.`);
    }
    return saved;
  }
  const selection: SelectionRecord = { ...input, selectedAt: new Date().toISOString() };
  writeJson(target, selection);
  recordAuditEvent(studyDir, "candidate_selected_before_prediction", target);
  return selection;
}

function validatedTools(options: CaptureOptions): ToolCommand[] {
  const tools = options.tools ?? [];
  if (tools.length === 0 && !options.noStandardToolsReason?.trim()) {
    throw new Error("Provide at least one --tool or a --no-tools-reason.");
  }
  const toolNames = new Set<string>();
  for (const tool of tools) {
    if (!["compiler", "test", "lint", "other"].includes(tool.kind)) {
      throw new Error(`Invalid standard-tool kind: ${String(tool.kind)}`);
    }
    assertSimpleId(tool.name, "Tool name");
    if (toolNames.has(tool.name)) throw new Error(`Duplicate standard-tool name: ${tool.name}`);
    if (!tool.command.trim()) throw new Error(`Standard-tool command is empty: ${tool.name}`);
    if (/\barthur(?:-mcp)?\b/i.test(`${tool.name} ${tool.command}`)) {
      throw new Error(`Arthur cannot be recorded as an existing standard tool: ${tool.name}`);
    }
    toolNames.add(tool.name);
  }
  return tools;
}

export function captureChange(options: CaptureOptions): string {
  const repositoryId = assertSimpleId(options.repositoryId, "Repository ID");
  const developerId = assertSimpleId(options.developerId, "Developer ID");
  if (!options.agentTool.trim() || !options.agentEvidence.trim()) {
    throw new Error("Agent name and authorship evidence are required.");
  }
  const tools = validatedTools(options);
  const toolTimeoutMs = options.toolTimeoutMs ?? 120_000;
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1_000 || toolTimeoutMs > 30 * 60_000) {
    throw new Error("Standard-tool timeout must be an integer from 1000 to 1800000 ms.");
  }
  if (options.publicRepositoryUrl) {
    let url: URL;
    try {
      url = new URL(options.publicRepositoryUrl);
    } catch {
      throw new Error("--public-url must be a valid HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("--public-url must be a valid HTTP(S) URL.");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("--public-url cannot contain credentials, query parameters, or fragments.");
    }
  }
  const manifest = loadManifest(options.studyDir);
  assertStudyStatus(manifest, ["collecting"]);
  validateStudyDefinition(options.studyDir, manifest);
  if (fs.existsSync(path.join(path.resolve(options.studyDir), "comparator", "collection-lock.json"))) {
    throw new Error("Collection is permanently closed because comparator setup has started.");
  }
  if (manifest.comparator) {
    throw new Error("Collection is closed because comparator predictions are already frozen.");
  }
  const activation = assertFrozenArthurBuild();
  if (manifest.activation.checkerBuildSha256 !== activation.checkerBuildSha256) {
    throw new Error("Study manifest was initialized for a different Arthur build.");
  }

  const projectDir = assertRepositoryRoot(options.projectDir);
  const dirtyBefore = worktreeStatus(projectDir);
  if (dirtyBefore) {
    throw new Error("The target repository must be clean before capture. Commit the agent change first.");
  }

  const resultCommit = resolveCommit(projectDir, options.resultRef ?? "HEAD");
  const headCommit = resolveCommit(projectDir, "HEAD");
  if (resultCommit !== headCommit) {
    throw new Error("The result commit must be checked out as HEAD so Arthur sees the pinned project state.");
  }
  const baseCommit = resolveCommit(projectDir, options.baseRef);
  if (baseCommit === resultCommit) throw new Error("Base and result commits are identical.");
  assertAncestor(projectDir, baseCommit, resultCommit);

  const changeId = blindId("d", repositoryId, baseCommit, resultCommit);
  const selections = listSelectionRecords(options.studyDir);
  const alreadySelected = selections.some((entry) => entry.changeId === changeId);
  const priorForRepo = selections.filter((entry) => entry.repositoryId === repositoryId).length;
  if (!alreadySelected && priorForRepo >= manifest.cohort.maximumChangesPerRepository) {
    throw new Error(
      `Repository ${repositoryId} reached the ${manifest.cohort.maximumChangesPerRepository}-change cap. Record an exclusion instead.`,
    );
  }

  if (manifest.captures.some((entry) => entry.changeId === changeId)) {
    throw new Error(`Change is already captured: ${changeId}`);
  }
  const finalDir = captureDir(options.studyDir, changeId);
  if (fs.existsSync(finalDir)) throw new Error(`Capture directory already exists: ${finalDir}`);

  const files = resolveDiffFiles(projectDir, baseCommit, { includeUntracked: false });
  const sourceFiles = files.filter((file) => isJavaScriptSourceFile(file.path));
  if (sourceFiles.length === 0) {
    throw new Error("The change has no eligible JavaScript or TypeScript source files.");
  }
  const rawDiff = runGit(projectDir, ["diff", "--binary", "--full-index", baseCommit, resultCommit, "--"]);
  const storedDiff = redactDiff(`${rawDiff}\n`);
  const rawCases = buildReferenceInventory(files, changeId, repositoryId);
  const cases = sanitizeCases(rawCases);
  const contracts: GroundTruthContracts = buildGroundTruthContracts(projectDir, files, rawCases);
  const evidence = redactSecrets(options.agentEvidence);
  const agentTool = redactSecrets(options.agentTool);
  lockSelection(options.studyDir, {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    changeId,
    repositoryId,
    developerId,
    agentTool: agentTool.value,
    agentEvidence: evidence.value,
    publicRepositoryUrl: options.publicRepositoryUrl,
    baseCommit,
    resultCommit,
    rawDiffSha256: sha256(normalizeText(`${rawDiff}\n`)),
    caseInventorySha256: sha256(stableJson(cases)),
    caseCount: cases.length,
    relevantSourcePaths: sourceFiles.map((file) => file.path).sort(),
    standardTools: tools.map((tool) => ({
      ...tool,
      command: redactSecrets(tool.command).value,
    })),
    noStandardToolsReason: options.noStandardToolsReason?.trim() || undefined,
    includedBeforeArthurPrediction: true,
  });

  const started = performance.now();
  const summary = runAllCheckers(
    { mode: "source", text: files.map((file) => file.content).join("\n"), files },
    projectDir,
  );
  const report = buildJsonReport(summary.checkerResults, projectDir);
  const predictionResult = predictCases(rawCases, report.findings);
  const analysisDurationMs = performance.now() - started;
  if (options.skipCliMeasurementForTests && process.env.NODE_ENV !== "test") {
    throw new Error("CLI latency measurement can be skipped only under the test runner.");
  }
  const cliMeasurement = options.skipCliMeasurementForTests
    ? { durationMs: analysisDurationMs, compiledBuildSha256: "test-only-not-measured" }
    : runCompiledArthur(projectDir, baseCommit, report);
  const arthur: ArthurCapture = {
    system: "arthur",
    activationCommit: activation.activationCommit,
    checkerBuildSha256: activation.checkerBuildSha256,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    analysisDurationMs,
    durationMs: cliMeasurement.durationMs,
    compiledBuildSha256: cliMeasurement.compiledBuildSha256,
    report,
    ...predictionResult,
  };

  const toolRuns = tools.map((tool) => runTool(
    projectDir,
    tool,
    toolTimeoutMs,
  ));
  const dirtyAfter = worktreeStatus(projectDir);
  if (dirtyAfter) {
    throw new Error(
      "A standard-tool command changed the target worktree. Restore or commit those changes before capturing again; Arthur did not modify it.",
    );
  }

  const sanitizedSources = sanitizeSourceFiles(files);
  const projectArtifacts = captureProjectArtifacts(projectDir);
  const metadata: CaptureMetadata = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    changeId,
    repositoryId,
    developerId,
    agentTool: agentTool.value,
    agentEvidence: evidence.value,
    publicRepositoryUrl: options.publicRepositoryUrl,
    baseCommit,
    resultCommit,
    capturedAt: new Date().toISOString(),
    rawDiffSha256: sha256(normalizeText(`${rawDiff}\n`)),
    storedDiffSha256: sha256(storedDiff.value),
    diffRedactionCount: storedDiff.count,
    sourceRedactionCount:
      sanitizedSources.redactionCount +
      projectArtifacts.redactionCount +
      evidence.count +
      agentTool.count,
    changedPaths: runGit(projectDir, ["diff", "--name-only", baseCommit, resultCommit, "--"])
      .split(/\r?\n/)
      .filter(Boolean),
    relevantSourcePaths: sourceFiles.map((file) => file.path).sort(),
    caseCount: cases.length,
    worktreeCleanBefore: true,
    worktreeCleanAfter: true,
    noStandardToolsReason: options.noStandardToolsReason?.trim() || undefined,
    cliLatencyMeasured: !options.skipCliMeasurementForTests,
  };

  const capturesRoot = path.dirname(finalDir);
  fs.mkdirSync(capturesRoot, { recursive: true });
  const temporaryDir = path.join(capturesRoot, `.${changeId}.${process.pid}.tmp`);
  if (fs.existsSync(temporaryDir)) {
    throw new Error(`Temporary capture path already exists: ${temporaryDir}`);
  }
  fs.mkdirSync(temporaryDir);

  try {
    writeJson(path.join(temporaryDir, "metadata.json"), metadata);
    writeTextExclusive(path.join(temporaryDir, "diff.patch"), storedDiff.value);
    writeJson(path.join(temporaryDir, "sources.json"), sanitizedSources.files);
    writeJson(path.join(temporaryDir, "project-artifacts.json"), projectArtifacts.bundle);
    writeJson(path.join(temporaryDir, "inventory.json"), cases);
    writeJson(path.join(temporaryDir, "contracts.json"), contracts);
    writeJson(path.join(temporaryDir, "arthur.json"), arthur);
    writeJson(path.join(temporaryDir, "tools.json"), toolRuns);
    const artifacts = createArtifactIndex(temporaryDir);
    writeJson(path.join(temporaryDir, "artifacts.json"), artifacts);
    fs.renameSync(temporaryDir, finalDir);

    manifest.captures.push({
      changeId,
      repositoryId,
      developerId,
      baseCommit,
      resultCommit,
      capturedAt: metadata.capturedAt,
      caseCount: cases.length,
      blockingFindingCount: blockingFindingCount(arthur),
      captureSha256: artifacts.aggregateSha256,
    });
    manifest.captures.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    saveManifest(options.studyDir, manifest);
    recordAuditEvent(
      options.studyDir,
      "change_captured",
      path.join(finalDir, "artifacts.json"),
    );
  } catch (error) {
    if (fs.existsSync(temporaryDir)) {
      const resolvedTemp = path.resolve(temporaryDir);
      const resolvedRoot = `${path.resolve(capturesRoot)}${path.sep}`;
      if (resolvedTemp.startsWith(resolvedRoot)) {
        fs.rmSync(resolvedTemp, { recursive: true, force: true });
      }
    }
    throw error;
  }

  return finalDir;
}
