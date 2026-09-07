import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordAuditEvent, verifyAuditChain } from "../bench/field/audit.js";
import { assertFrozenArthurBuild, captureChange } from "../bench/field/capture.js";
import {
  closeFieldCollection,
  parseComparatorPredictions,
} from "../bench/field/comparator.js";
import { freezeStudy } from "../bench/field/freeze.js";
import { buildReferenceInventory } from "../bench/field/inventory.js";
import {
  createAdjudicationTemplate,
  createBaselineTemplate,
  createReviewTemplate,
  recordRetention,
  submitAdjudication,
  submitBaseline,
  submitReview,
} from "../bench/field/review.js";
import { scoreFieldStudy } from "../bench/field/score.js";
import {
  fileDigest,
  readJson,
  readJsonLines,
  redactDiff,
  sha256,
  stableJson,
  writeJson,
} from "../bench/field/storage.js";
import { captureDir, loadManifest, saveManifest } from "../bench/field/study-store.js";
import { initializeStudy, recordExclusion } from "../bench/field/study.js";
import type {
  ArtifactIndex,
  ArthurCapture,
  CaptureMetadata,
  ComparatorRun,
  GroundTruthContracts,
  ReferenceCase,
  ReviewPacket,
  SelectionRecord,
  StandardToolEvidence,
  ToolRun,
} from "../bench/field/types.js";
import { FIELD_SCHEMA_VERSION } from "../bench/field/types.js";
import type { DiffFile } from "../src/diff/resolver.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeProjectFile(directory: string, relativePath: string, content: string): void {
  const target = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

function createGitFixture(): { directory: string; baseCommit: string; resultCommit: string; secret: string } {
  const directory = temporaryDirectory("arthur-field-project-");
  git(directory, ["init"]);
  git(directory, ["config", "user.name", "Field Test"]);
  git(directory, ["config", "user.email", "field@example.test"]);
  writeProjectFile(directory, "package.json", JSON.stringify({ name: "field-fixture", version: "1.0.0" }));
  writeProjectFile(directory, ".env.example", "KNOWN_SERVICE_URL=https://example.test\n");
  writeProjectFile(
    directory,
    "src/app/api/health/route.ts",
    "export async function GET() { return new Response('ok'); }\n",
  );
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-m", "base"]);
  const baseCommit = git(directory, ["rev-parse", "HEAD"]);

  writeProjectFile(
    directory,
    "src/change.ts",
    [
      'import value from "made-up-field-package";',
      "export const endpoint = process.env.MISSING_SERVICE_URL;",
      "export const request = fetch('/api/missing');",
      "void value;",
      "void endpoint;",
      "void request;",
      "",
    ].join("\n"),
  );
  const secret = `sk-ant-${"a".repeat(30)}`;
  writeProjectFile(directory, ".env", `PRIVATE_TOKEN=${secret}\n`);
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-m", "agent change"]);
  return { directory, baseCommit, resultCommit: git(directory, ["rev-parse", "HEAD"]), secret };
}

function sourceLocation(pathName: string, line: number) {
  return { path: pathName, line, column: 1, endLine: line, endColumn: 10 };
}

function makeCase(
  caseId: string,
  changeId: string,
  repositoryId: string,
  domain: ReferenceCase["domain"],
  target: string,
  line: number,
): ReferenceCase {
  return {
    caseId,
    changeId,
    repositoryId,
    domain,
    target,
    raw: target,
    location: sourceLocation("src/change.ts", line),
    context: [{ line, text: target, changed: true }],
    sourceSha256: sha256(`${changeId}:${target}`),
    inventoryMethods: ["independent-test"],
  };
}

function minimalReport(cases: ReferenceCase[], predictions: ArthurCapture["predictions"]): ArthurCapture {
  const findings = predictions.flatMap((prediction) => {
    if (prediction.outcome !== "error") return [];
    const item = cases.find((candidate) => candidate.caseId === prediction.caseId)!;
    return [{
      findingId: `f_${prediction.caseId}`,
      checker: item.domain,
      severity: "error" as const,
      category: "test-finding",
      target: item.target,
      message: "test finding",
      location: item.location,
    }];
  });
  return {
    system: "arthur",
    activationCommit: assertFrozenArthurBuild().activationCommit,
    checkerBuildSha256: assertFrozenArthurBuild().checkerBuildSha256,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    durationMs: 5,
    analysisDurationMs: 1,
    compiledBuildSha256: "synthetic-compiled-build",
    report: {
      schemaVersion: "1.1",
      timestamp: "2026-09-07T00:00:00.000Z",
      projectDir: "synthetic",
      summary: {
        totalChecked: cases.length,
        totalFindings: findings.length,
        totalErrors: findings.length,
        totalWarnings: 0,
        checkerResults: [],
      },
      findings,
    },
    predictions,
    unmatchedFindings: [],
  };
}

function writeSyntheticCapture(
  studyDir: string,
  changeId: string,
  repositoryId: string,
  developerId: string,
  cases: ReferenceCase[],
  predictions: ArthurCapture["predictions"],
): { aggregateSha256: string; blockingFindings: number } {
  const directory = captureDir(studyDir, changeId);
  fs.mkdirSync(directory, { recursive: true });
  const metadata: CaptureMetadata = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    changeId,
    repositoryId,
    developerId,
    agentTool: "test-agent",
    agentEvidence: "synthetic harness evidence",
    baseCommit: `${changeId}-base`,
    resultCommit: `${changeId}-result`,
    capturedAt: `2026-09-07T00:${changeId.slice(-2)}:00.000Z`,
    rawDiffSha256: sha256(`${changeId}-raw`),
    storedDiffSha256: sha256(`${changeId}\n`),
    diffRedactionCount: 0,
    sourceRedactionCount: 0,
    changedPaths: ["src/change.ts"],
    relevantSourcePaths: ["src/change.ts"],
    caseCount: cases.length,
    worktreeCleanBefore: true,
    worktreeCleanAfter: true,
    noStandardToolsReason: undefined,
    cliLatencyMeasured: true,
  };
  const contracts: GroundTruthContracts = {
    packages: [{ packageName: "missing-package", installed: false }],
    env: { filesFound: [".env.example"], definedNames: ["KNOWN_VALUE"] },
    routes: [],
  };
  const tools: ToolRun[] = [{
    kind: "compiler",
    name: "typecheck",
    command: "npm run check",
    startedAt: "2026-09-07T00:00:00.000Z",
    durationMs: 10,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ok",
    stderr: "",
    redactionCount: 0,
    outputTruncated: false,
  }];
  const selection: SelectionRecord = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: loadManifest(studyDir).studyId,
    changeId,
    repositoryId,
    developerId,
    agentTool: "test-agent",
    agentEvidence: "synthetic harness evidence",
    baseCommit: metadata.baseCommit,
    resultCommit: metadata.resultCommit,
    selectedAt: metadata.capturedAt,
    rawDiffSha256: metadata.rawDiffSha256,
    caseInventorySha256: sha256(stableJson(cases)),
    caseCount: cases.length,
    relevantSourcePaths: ["src/change.ts"],
    standardTools: [{ kind: "compiler", name: "typecheck", command: "npm run check" }],
    includedBeforeArthurPrediction: true,
  };
  const selectionPath = path.join(studyDir, "selections", `${changeId}.json`);
  writeJson(selectionPath, selection);
  recordAuditEvent(studyDir, "candidate_selected_before_prediction", selectionPath);
  const arthur = minimalReport(cases, predictions);
  writeJson(path.join(directory, "metadata.json"), metadata);
  fs.writeFileSync(path.join(directory, "diff.patch"), `${changeId}\n`, "utf-8");
  writeJson(path.join(directory, "sources.json"), []);
  writeJson(path.join(directory, "project-artifacts.json"), {
    schemaVersion: FIELD_SCHEMA_VERSION,
    files: [],
  });
  writeJson(path.join(directory, "inventory.json"), cases);
  writeJson(path.join(directory, "contracts.json"), contracts);
  writeJson(path.join(directory, "arthur.json"), arthur);
  writeJson(path.join(directory, "tools.json"), tools);
  const names = [
    "arthur.json",
    "contracts.json",
    "diff.patch",
    "inventory.json",
    "metadata.json",
    "project-artifacts.json",
    "sources.json",
    "tools.json",
  ];
  const files = names.map((name) => ({ path: name, ...fileDigest(path.join(directory, name)) }));
  const artifacts: ArtifactIndex = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    files,
    aggregateSha256: sha256(stableJson(files)),
  };
  writeJson(path.join(directory, "artifacts.json"), artifacts);
  recordAuditEvent(studyDir, "change_captured", path.join(directory, "artifacts.json"));
  return { aggregateSha256: artifacts.aggregateSha256, blockingFindings: arthur.report.findings.length };
}

function fillReview(
  filePath: string,
  labels: Record<string, "valid" | "actionable_invalid" | "ignored" | "uncertain">,
): void {
  const review = readJson<Record<string, any>>(filePath);
  review.attestation = {
    didNotImplementEvaluatedCheckers: true,
    didNotSeeDetectorPredictions: true,
    reviewedIndependently: true,
  };
  for (const item of review.labels) {
    item.label = labels[item.caseId];
    item.rationale = `Independent rationale for ${item.caseId}`;
    item.caughtByStandardTools = item.label === "actionable_invalid" ? false : null;
    item.caughtByToolNames = [];
  }
  writeJson(filePath, review);
}

describe("field benchmark", () => {
  it("locks the activated build and inventories only live supported references", () => {
    expect(assertFrozenArthurBuild().activationCommit).toBe(
      "2d914e5e41637726dbb440dda4aed47ea148febb",
    );
    const source = [
      'import live from "left-pad";',
      'import local from "./local";',
      "const value = process.env.SERVICE_TOKEN;",
      "fetch('/api/items', { method: 'POST' });",
      '// import fake from "comment-package";',
      'const documentation = "process.env.DOCUMENTED_ONLY";',
      "fetch('/api/dynamic', requestOptions);",
    ].join("\n");
    const file: DiffFile = {
      path: "src/change.ts",
      content: source,
      changedLines: [1, 2, 3, 4, 5, 6, 7],
      status: "added",
    };
    const cases = buildReferenceInventory([file], "d_blind", "repo-1");
    expect(cases).toHaveLength(6);
    expect(cases.map((item) => [item.domain, item.target])).toEqual(
      expect.arrayContaining([
        ["imports", "left-pad"],
        ["env", "SERVICE_TOKEN"],
        ["routes", "POST /api/items"],
        ["imports", "comment-package"],
        ["env", "DOCUMENTED_ONLY"],
        ["routes", "ANY /api/dynamic"],
      ]),
    );
  });

  it("captures a clean committed Git change, redacts secrets, and hashes every artifact", () => {
    const studyDir = temporaryDirectory("arthur-field-study-");
    initializeStudy(studyDir, "capture-smoke");
    const fixture = createGitFixture();
    const compiledCliAvailable = fs.existsSync(
      path.join(process.cwd(), "dist", "bin", "arthur.js"),
    );
    const directory = captureChange({
      studyDir,
      projectDir: fixture.directory,
      baseRef: fixture.baseCommit,
      resultRef: fixture.resultCommit,
      repositoryId: "repo-1",
      developerId: "dev-1",
      agentTool: "Codex",
      agentEvidence: "Recorded task test-1",
      noStandardToolsReason: "Fixture intentionally has no scripts.",
      skipCliMeasurementForTests: !compiledCliAvailable,
    });
    const metadata = readJson<CaptureMetadata>(path.join(directory, "metadata.json"));
    const arthur = readJson<ArthurCapture>(path.join(directory, "arthur.json"));
    const contracts = readJson<GroundTruthContracts>(path.join(directory, "contracts.json"));
    const storedDiff = fs.readFileSync(path.join(directory, "diff.patch"), "utf-8");
    const artifacts = readJson<ArtifactIndex>(path.join(directory, "artifacts.json"));

    expect(metadata.caseCount).toBe(3);
    expect(metadata.diffRedactionCount).toBeGreaterThan(0);
    expect(storedDiff).not.toContain(fixture.secret);
    expect(storedDiff).toContain("[REDACTED_ENV_VALUE]");
    expect(arthur.predictions.every((item) => item.outcome === "error")).toBe(true);
    expect(arthur.unmatchedFindings).toEqual([]);
    expect(contracts.packages).toEqual([
      expect.objectContaining({ packageName: "made-up-field-package", installed: false }),
    ]);
    expect(contracts.env.definedNames).toContain("KNOWN_SERVICE_URL");
    expect(contracts.routes).toEqual([
      expect.objectContaining({ urlPath: "/api/health", methods: ["GET"] }),
    ]);
    expect(metadata.cliLatencyMeasured).toBe(compiledCliAvailable);
    if (compiledCliAvailable) {
      expect(arthur.compiledBuildSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(arthur.durationMs).toBeGreaterThan(0);
    }
    expect(artifacts.files).toHaveLength(8);
    expect(loadManifest(studyDir).captures).toHaveLength(1);
    const events = verifyAuditChain(studyDir);
    expect(events.map((event) => event.type)).toEqual([
      "study_initialized",
      "candidate_selected_before_prediction",
      "change_captured",
    ]);
    expect(git(fixture.directory, ["status", "--porcelain"])).toBe("");
  });

  it("redacts added, deleted, and context values from private env diffs", () => {
    const secret = `sk-ant-${"z".repeat(30)}`;
    const patchText = [
      "diff --git a/.env.local b/.env.local",
      "--- a/.env.local",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      `-TOKEN=${secret}`,
      " EXISTING=value-that-must-not-be-stored",
      "",
    ].join("\n");
    const result = redactDiff(patchText);
    expect(result.value).not.toContain(secret);
    expect(result.value).not.toContain("value-that-must-not-be-stored");
    expect(result.value).toContain("-TOKEN=[REDACTED_ENV_VALUE]");
    expect(result.value).toContain(" EXISTING=[REDACTED_ENV_VALUE]");
  });

  it("requires the comparator to return one strict decision per blinded ID", () => {
    const packet = {
      caseId: "c_test_case_000000000001",
      changeId: "d_test_change_0000000001",
      domain: "env" as const,
      target: "SERVICE_URL",
      raw: "process.env.SERVICE_URL",
      location: sourceLocation("src/change.ts", 1),
      context: [{ line: 1, text: "process.env.SERVICE_URL", changed: true }],
      contract: { filesFound: [".env.example"], definedNames: [] },
      evidence: {
        baseCommit: "base",
        resultCommit: "result",
        diffSha256: sha256("diff"),
        sourceSha256: sha256("source"),
      },
    } satisfies ReviewPacket;
    expect(parseComparatorPredictions(
      JSON.stringify({
        predictions: [{
          caseId: packet.caseId,
          predictedInvalid: true,
          reason: "not defined",
        }],
      }),
      [packet],
    )).toEqual([{ caseId: packet.caseId, predictedInvalid: true, reason: "not defined" }]);
    expect(() => parseComparatorPredictions('{"predictions":[]}', [packet])).toThrow(/omitted/i);
  });

  it("rejects attempts to move preregistered decision rules", () => {
    const studyDir = temporaryDirectory("arthur-field-tamper-");
    const manifest = initializeStudy(studyDir, "tamper-test");
    manifest.decisionRules.minimumBlockingPrecision = 0;
    saveManifest(studyDir, manifest);
    expect(() => recordExclusion({
      studyDir,
      repositoryId: "repo-1",
      reason: "not_agent_authored",
      note: "test exclusion",
    })).toThrow(/decision rules differ/i);
  });

  it("runs the full frozen, blinded, adjudicated scoring workflow and preserves a negative decision", () => {
    const studyDir = temporaryDirectory("arthur-field-lifecycle-");
    const manifest = initializeStudy(studyDir, "lifecycle-test");
    const actionableId = "c_actionable_case_000001";
    const validId = "c_valid_case_00000000002";
    const ignoredId = "c_ignored_case_000000003";

    for (let index = 0; index < 50; index++) {
      const changeId = `d_change_${String(index).padStart(3, "0")}`;
      const repositoryId = `repo-${Math.floor(index / 10) + 1}`;
      const developerId = `dev-${Math.floor(index / 10) + 1}`;
      const cases = index === 0
        ? [
            makeCase(actionableId, changeId, repositoryId, "imports", "missing-package", 1),
            makeCase(validId, changeId, repositoryId, "env", "KNOWN_VALUE", 2),
          ]
        : index === 1
          ? [makeCase(ignoredId, changeId, repositoryId, "env", "PORT", 1)]
          : [];
      const predictions = cases.map((item) => ({
        caseId: item.caseId,
        outcome: item.caseId === validId ? "clean" as const : "error" as const,
        findingId: item.caseId === validId ? undefined : `f_${item.caseId}`,
      }));
      const capture = writeSyntheticCapture(
        studyDir,
        changeId,
        repositoryId,
        developerId,
        cases,
        predictions,
      );
      manifest.captures.push({
        changeId,
        repositoryId,
        developerId,
        baseCommit: `${changeId}-base`,
        resultCommit: `${changeId}-result`,
        capturedAt: `2026-09-07T00:${String(index).padStart(2, "0")}:00.000Z`,
        caseCount: cases.length,
        blockingFindingCount: capture.blockingFindings,
        captureSha256: capture.aggregateSha256,
      });
    }

    saveManifest(studyDir, manifest);
    closeFieldCollection(studyDir, {
      provider: "test",
      model: "fixed-test-model",
      promptSha256: sha256("fixed prompt"),
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        source: "test rate card",
      },
    });
    expect(() => closeFieldCollection(studyDir, {
      provider: "test",
      model: "changed-after-close",
      promptSha256: sha256("fixed prompt"),
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        source: "test rate card",
      },
    })).toThrow(/collection changed/i);
    expect(() => recordExclusion({
      studyDir,
      repositoryId: "repo-5",
      reason: "not_agent_authored",
      note: "too late",
    })).toThrow(/status is comparing/i);
    const comparingManifest = loadManifest(studyDir);
    const comparatorBatchPath = path.join(
      studyDir,
      "comparator",
      "runs",
      "synthetic-batch.json",
    );
    writeJson(comparatorBatchPath, {
      responseId: "response-test-1",
      rawOutput: "synthetic comparator output retained for audit",
    });
    const comparator: ComparatorRun = {
      schemaVersion: FIELD_SCHEMA_VERSION,
      studyId: comparingManifest.studyId,
      system: "test/comparator",
      provider: "test",
      model: "fixed-test-model",
      requestedModel: "fixed-test-model",
      promptSha256: sha256("fixed prompt"),
      createdAt: "2026-09-07T01:00:00.000Z",
      inputTokens: 100,
      outputTokens: 20,
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        source: "test rate card",
      },
      estimatedCostUsd: 0.00014,
      durationMs: 1000,
      batches: [{
        artifactPath: "comparator/runs/synthetic-batch.json",
        artifactSha256: fileDigest(comparatorBatchPath).sha256,
        responseId: "response-test-1",
        batchInputSha256: sha256("synthetic batch input"),
        requestedModel: "fixed-test-model",
        model: "fixed-test-model",
        inputTokens: 100,
        outputTokens: 20,
        durationMs: 1000,
      }],
      predictions: [
        { caseId: actionableId, predictedInvalid: true, reason: "missing" },
        { caseId: validId, predictedInvalid: false, reason: "defined" },
        { caseId: ignoredId, predictedInvalid: false, reason: "runtime convention" },
      ].sort((left, right) => left.caseId.localeCompare(right.caseId)),
    };
    writeJson(path.join(studyDir, "comparator", "predictions.json"), comparator);
    comparingManifest.comparator = {
      system: comparator.system,
      model: comparator.model,
      requestedModel: comparator.requestedModel,
      promptSha256: comparator.promptSha256,
      predictionCount: comparator.predictions.length,
      predictionsSha256: sha256(stableJson(comparator)),
      inputTokens: comparator.inputTokens,
      outputTokens: comparator.outputTokens,
      pricing: comparator.pricing,
      estimatedCostUsd: comparator.estimatedCostUsd,
      durationMs: comparator.durationMs,
    };
    saveManifest(studyDir, comparingManifest);
    recordAuditEvent(
      studyDir,
      "comparator_predictions_frozen",
      path.join(studyDir, "comparator", "predictions.json"),
    );

    const lock = freezeStudy(studyDir);
    expect(lock.activationCommit).toBe(assertFrozenArthurBuild().activationCommit);
    const packets = readJsonLines<ReviewPacket>(
      path.join(studyDir, "frozen", "review-packets.jsonl"),
    );
    const packetText = JSON.stringify(packets);
    expect(packetText).not.toContain("predictedInvalid");
    expect(packetText).not.toContain("findingId");
    expect(packetText).not.toContain('"outcome"');
    expect(packets[0].evidence.standardTools).toEqual([
      { kind: "compiler", name: "typecheck", command: "npm run check" },
    ]);
    const standardToolEvidence = readJson<StandardToolEvidence>(
      path.join(studyDir, "frozen", "standard-tool-evidence.json"),
    );
    expect(standardToolEvidence.changes[0].runs).toEqual([
      expect.objectContaining({ name: "typecheck", exitCode: 0, stdout: "ok" }),
    ]);

    const firstReview = path.join(studyDir, "reviewer-1-template.json");
    const secondReview = path.join(studyDir, "reviewer-2-template.json");
    createReviewTemplate(studyDir, "reviewer-1", firstReview);
    createReviewTemplate(studyDir, "reviewer-2", secondReview);
    fillReview(firstReview, {
      [actionableId]: "actionable_invalid",
      [validId]: "valid",
      [ignoredId]: "ignored",
    });
    fillReview(secondReview, {
      [actionableId]: "actionable_invalid",
      [validId]: "uncertain",
      [ignoredId]: "ignored",
    });
    const secondReviewContents = readJson<Record<string, any>>(secondReview);
    const secondActionable = secondReviewContents.labels.find(
      (item: Record<string, any>) => item.caseId === actionableId,
    );
    secondActionable.caughtByStandardTools = true;
    secondActionable.caughtByToolNames = ["typecheck"];
    writeJson(secondReview, secondReviewContents);
    submitReview(studyDir, firstReview);
    submitReview(studyDir, secondReview);

    const adjudicationFile = path.join(studyDir, "adjudication-template.json");
    expect(createAdjudicationTemplate(studyDir, "reviewer-3", adjudicationFile)).toBe(2);
    const adjudication = readJson<Record<string, any>>(adjudicationFile);
    adjudication.attestation = {
      didNotImplementEvaluatedCheckers: true,
      didNotSeeDetectorPredictions: true,
    };
    for (const decision of adjudication.decisions) {
      if (decision.caseId === actionableId) {
        decision.label = "actionable_invalid";
        decision.rationale = "The import is invalid, but the recorded typecheck did not report it.";
        decision.caughtByStandardTools = false;
        decision.caughtByToolNames = [];
      } else {
        decision.label = "valid";
        decision.rationale = "The variable is present in the frozen contract.";
        decision.caughtByStandardTools = null;
        decision.caughtByToolNames = [];
      }
    }
    writeJson(adjudicationFile, adjudication);
    submitAdjudication(studyDir, adjudicationFile);

    const baselineFile = path.join(studyDir, "baseline-template.json");
    expect(createBaselineTemplate(studyDir, "assessor-1", baselineFile)).toBe(1);
    const baseline = readJson<Record<string, any>>(baselineFile);
    baseline.attestation = {
      didNotImplementEvaluatedCheckers: true,
      didNotSeeDetectorPredictions: true,
    };
    expect(baseline.attributions[0].caughtByStandardTools).toBe(false);
    baseline.attributions[0].defectId = "defect-1";
    baseline.attributions[0].rationale = "This occurrence is one underlying defect.";
    writeJson(baselineFile, baseline);
    submitBaseline(studyDir, baselineFile);

    for (const developerId of ["dev-1", "dev-2", "dev-3"]) {
      recordRetention(studyDir, {
        developerId,
        externalToArthurImplementation: true,
        keepEnabled: true,
        recordedBeforeAggregateResults: true,
      });
    }

    const report = scoreFieldStudy(studyDir);
    expect(report.arthur.counts).toMatchObject({ tp: 1, fp: 1, fn: 0, tn: 1 });
    expect(report.comparator.counts).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 2 });
    expect(report.review.adjudicatedCases).toBe(2);
    expect(report.incremental.defectsCaughtByArthurOnly).toBe(1);
    expect(report.incremental.arthurOnlyDefectsClustered95).not.toBeNull();
    expect(report.paired.accuracyDifference).toBeCloseTo(-1 / 3);
    expect(report.paired.accuracyDifferenceClustered95).not.toBeNull();
    expect(report.arthur.diffFalseBlockRateClustered95).not.toBeNull();
    expect(report.arthur.p95LatencyClustered95).not.toBeNull();
    expect(report.comparator.estimatedCostUsd).toBe(0.00014);
    expect(report.arthur.falseBlockedChanges).toEqual(["d_change_001"]);
    expect(report.decision.continueDevelopment).toBe(false);
    expect(report.decision.criteria.incrementalActionableDefects.passed).toBe(false);
    expect(report.decision.criteria.blockingPrecision.passed).toBe(false);
    expect(loadManifest(studyDir).status).toBe("complete");
    expect(verifyAuditChain(studyDir).length).toBe(112);
  }, 30_000);
});
