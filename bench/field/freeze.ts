import fs from "node:fs";
import path from "node:path";
import { recordAuditEvent, verifyAuditChain } from "./audit.js";
import { assertFrozenArthurBuild, pendingSelectionIds } from "./capture.js";
import { validateStudyDefinition } from "./definition.js";
import { buildReviewPackets, buildStandardToolEvidence } from "./packets.js";
import {
  fileDigest,
  readJson,
  sha256,
  stableJson,
  stableValue,
  writeJson,
  writeJsonLines,
} from "./storage.js";
import {
  assertStudyStatus,
  captureDir,
  loadManifest,
  saveManifest,
} from "./study-store.js";
import type {
  ArtifactIndex,
  ArthurCapture,
  CaptureMetadata,
  ComparatorRun,
  CollectionLock,
  ReferenceCase,
  SelectionRecord,
  StudyLock,
} from "./types.js";
import { FIELD_SCHEMA_VERSION } from "./types.js";

function validateCohort(manifest: ReturnType<typeof loadManifest>): void {
  if (manifest.captures.length < manifest.cohort.minimumIncludedChanges) {
    throw new Error(
      `Cannot freeze: ${manifest.captures.length}/${manifest.cohort.minimumIncludedChanges} included changes.`,
    );
  }
  const repositoryCounts = new Map<string, number>();
  for (const capture of manifest.captures) {
    repositoryCounts.set(
      capture.repositoryId,
      (repositoryCounts.get(capture.repositoryId) ?? 0) + 1,
    );
  }
  if (repositoryCounts.size < manifest.cohort.minimumRepositories) {
    throw new Error(
      `Cannot freeze: ${repositoryCounts.size}/${manifest.cohort.minimumRepositories} repositories.`,
    );
  }
  const overCap = [...repositoryCounts].filter(
    ([, count]) => count > manifest.cohort.maximumChangesPerRepository,
  );
  if (overCap.length > 0) {
    throw new Error(`Repository cap exceeded: ${overCap.map(([id]) => id).join(", ")}`);
  }
}

export function validateCaptureArtifacts(directory: string, expectedAggregate: string): void {
  const index = readJson<ArtifactIndex>(path.join(directory, "artifacts.json"));
  if (new Set(index.files.map((entry) => entry.path)).size !== index.files.length) {
    throw new Error(`Capture artifact index contains duplicate paths: ${directory}`);
  }
  const required = [
    "arthur.json",
    "contracts.json",
    "diff.patch",
    "inventory.json",
    "metadata.json",
    "project-artifacts.json",
    "sources.json",
    "tools.json",
  ];
  const indexed = new Set(index.files.map((entry) => entry.path));
  const missingRequired = required.filter((name) => !indexed.has(name));
  if (missingRequired.length > 0) {
    throw new Error(`Capture is missing required artifacts: ${missingRequired.join(", ")}`);
  }
  const actualFiles = index.files.map((entry) => {
    const root = path.resolve(directory);
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Capture artifact path escapes its directory: ${entry.path}`);
    }
    if (!fs.existsSync(target)) throw new Error(`Missing capture artifact: ${target}`);
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Capture artifact resolves outside its directory: ${entry.path}`);
    }
    const actual = fileDigest(target);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      throw new Error(`Capture artifact changed after collection: ${target}`);
    }
    return entry;
  });
  const aggregate = sha256(stableJson(actualFiles));
  if (aggregate !== index.aggregateSha256 || aggregate !== expectedAggregate) {
    throw new Error(`Capture aggregate hash mismatch: ${directory}`);
  }
}

export function freezeStudy(studyDir: string): StudyLock {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["comparing"]);
  validateStudyDefinition(studyDir, manifest);
  const auditEvents = verifyAuditChain(studyDir);
  const pending = pendingSelectionIds(studyDir, manifest.captures);
  if (pending.length > 0) {
    throw new Error(`Cannot freeze with ${pending.length} selected capture(s) still incomplete.`);
  }
  const audited = new Map(auditEvents.map((event) => [event.artifactPath, event]));
  for (const capture of manifest.captures) {
    const expectedPath = path.relative(
      path.resolve(studyDir),
      path.join(captureDir(studyDir, capture.changeId), "artifacts.json"),
    ).replace(/\\/g, "/");
    const captureEvent = audited.get(expectedPath);
    if (captureEvent?.type !== "change_captured") {
      throw new Error(`Capture is missing its append-only audit event: ${capture.changeId}`);
    }
    const selectionPath = `selections/${capture.changeId}.json`;
    const selectionEvent = audited.get(selectionPath);
    if (
      selectionEvent?.type !== "candidate_selected_before_prediction" ||
      selectionEvent.index >= captureEvent.index
    ) {
      throw new Error(`Capture was not irrevocably selected before prediction: ${capture.changeId}`);
    }
  }
  for (const exclusion of manifest.exclusions) {
    const expectedPath = `exclusions/${exclusion.candidateId}.json`;
    if (audited.get(expectedPath)?.type !== "candidate_excluded") {
      throw new Error(`Exclusion is missing its append-only audit event: ${exclusion.candidateId}`);
    }
  }
  const comparatorEvent = auditEvents.find(
    (event) => event.artifactPath === "comparator/predictions.json",
  );
  if (comparatorEvent?.type !== "comparator_predictions_frozen") {
    throw new Error("Comparator predictions are missing their append-only audit event.");
  }
  const collectionLockPath = path.join(path.resolve(studyDir), "comparator", "collection-lock.json");
  const collectionLock = readJson<CollectionLock>(collectionLockPath);
  const collectionLockSha256 = sha256(stableJson(collectionLock));
  if (
    collectionLockSha256 !== manifest.collectionLockSha256 ||
    collectionLock.captureIndexSha256 !== sha256(stableJson(manifest.captures)) ||
    collectionLock.exclusionsSha256 !== sha256(stableJson(manifest.exclusions))
  ) {
    throw new Error("Collection changed after it was closed.");
  }
  const collectionEvent = auditEvents.find(
    (event) => event.artifactPath === "comparator/collection-lock.json",
  );
  if (collectionEvent?.type !== "collection_closed") {
    throw new Error("Collection lock is missing its append-only audit event.");
  }
  const activation = assertFrozenArthurBuild(manifest.activation);
  validateCohort(manifest);
  if (!manifest.comparator) {
    throw new Error("Run the fixed LLM comparator before freezing the study.");
  }

  const cases: ReferenceCase[] = [];
  const arthurPredictions: Array<{ caseId: string; outcome: string; findingId?: string }> = [];
  const compiledBuilds = new Set<string>();
  for (const capture of manifest.captures) {
    const directory = captureDir(studyDir, capture.changeId);
    validateCaptureArtifacts(directory, capture.captureSha256);
    const captureCases = readJson<ReferenceCase[]>(path.join(directory, "inventory.json"));
    const arthur = readJson<ArthurCapture>(path.join(directory, "arthur.json"));
    const metadata = readJson<CaptureMetadata>(path.join(directory, "metadata.json"));
    const selection = readJson<SelectionRecord>(
      path.join(path.resolve(studyDir), "selections", `${capture.changeId}.json`),
    );
    if (
      selection.studyId !== manifest.studyId ||
      selection.changeId !== capture.changeId ||
      selection.repositoryId !== capture.repositoryId ||
      selection.developerId !== capture.developerId ||
      selection.baseCommit !== capture.baseCommit ||
      selection.resultCommit !== capture.resultCommit ||
      selection.rawDiffSha256 !== metadata.rawDiffSha256 ||
      selection.caseInventorySha256 !== sha256(stableJson(captureCases)) ||
      selection.caseCount !== captureCases.length ||
      !selection.includedBeforeArthurPrediction
    ) {
      throw new Error(`Pre-prediction selection lock differs from capture ${capture.changeId}.`);
    }
    if (!metadata.cliLatencyMeasured || !arthur.compiledBuildSha256) {
      throw new Error(`${capture.changeId} does not contain a real compiled-CLI latency measurement.`);
    }
    compiledBuilds.add(arthur.compiledBuildSha256);
    const unmatchedBlocking = arthur.unmatchedFindings.filter(
      (finding) => finding.severity === "error",
    );
    if (unmatchedBlocking.length > 0) {
      throw new Error(
        `${capture.changeId} has ${unmatchedBlocking.length} blocking Arthur finding(s) outside the blinded inventory. Resolve the extractor gap under a new protocol version.`,
      );
    }
    cases.push(...captureCases);
    arthurPredictions.push(...arthur.predictions);
  }
  if (compiledBuilds.size !== 1) {
    throw new Error(`Cohort used ${compiledBuilds.size} different compiled Arthur builds.`);
  }
  cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  arthurPredictions.sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) {
    throw new Error("Duplicate case IDs found while freezing.");
  }
  if (sha256(stableJson(cases.map((item) => item.caseId))) !== collectionLock.caseIdsSha256) {
    throw new Error("Case inventory changed after collection was closed.");
  }
  if (stableJson(cases.map((item) => item.caseId)) !== stableJson(arthurPredictions.map((item) => item.caseId))) {
    throw new Error("Arthur predictions do not cover the frozen case inventory exactly.");
  }

  const comparator = readJson<ComparatorRun>(
    path.join(path.resolve(studyDir), "comparator", "predictions.json"),
  );
  const studyRoot = path.resolve(studyDir);
  const comparatorRunsRoot = path.join(studyRoot, "comparator", "runs");
  if (new Set(comparator.batches.map((batch) => batch.artifactPath)).size !== comparator.batches.length) {
    throw new Error("Comparator run contains duplicate batch artifacts.");
  }
  for (const batch of comparator.batches) {
    const target = path.resolve(studyRoot, batch.artifactPath);
    if (!target.startsWith(`${comparatorRunsRoot}${path.sep}`) || !fs.existsSync(target)) {
      throw new Error(`Comparator batch artifact is missing or outside its run directory: ${batch.artifactPath}`);
    }
    const realRunsRoot = fs.realpathSync(comparatorRunsRoot);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(`${realRunsRoot}${path.sep}`)) {
      throw new Error(`Comparator batch artifact resolves outside its run directory: ${batch.artifactPath}`);
    }
    if (fileDigest(target).sha256 !== batch.artifactSha256) {
      throw new Error(`Comparator batch artifact changed after prediction: ${batch.artifactPath}`);
    }
  }
  if (sha256(stableJson(comparator)) !== manifest.comparator.predictionsSha256) {
    throw new Error("Comparator predictions changed after they were recorded.");
  }
  const comparatorPredictions = [...comparator.predictions]
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (stableJson(cases.map((item) => item.caseId)) !== stableJson(comparatorPredictions.map((item) => item.caseId))) {
    throw new Error("Comparator predictions do not cover the frozen case inventory exactly.");
  }

  const packets = buildReviewPackets(studyDir).sort((left, right) => {
    const leftKey = sha256(`${manifest.studyId}\0packet\0${left.caseId}`);
    const rightKey = sha256(`${manifest.studyId}\0packet\0${right.caseId}`);
    return leftKey.localeCompare(rightKey);
  });
  const standardToolEvidence = buildStandardToolEvidence(studyDir);
  const frozenAt = new Date().toISOString();
  const packetText = packets.map((packet) => JSON.stringify(stableValue(packet))).join("\n") + (packets.length ? "\n" : "");
  const lock: StudyLock = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    frozenAt,
    activationCommit: manifest.activation.activationCommit,
    protocolSha256: manifest.activation.protocolSha256,
    studyPlanSha256: manifest.activation.studyPlanSha256,
    checkerBuildSha256: manifest.activation.checkerBuildSha256,
    collectionLockSha256,
    captureIndexSha256: sha256(stableJson(manifest.captures)),
    caseInventorySha256: sha256(stableJson(cases)),
    arthurPredictionsSha256: sha256(stableJson(arthurPredictions)),
    comparatorRunSha256: sha256(stableJson(comparator)),
    comparatorPredictionsSha256: sha256(stableJson(comparatorPredictions)),
    reviewPacketsSha256: sha256(packetText),
    standardToolEvidenceSha256: sha256(stableJson(standardToolEvidence)),
  };

  const frozenDir = path.join(studyRoot, "frozen");
  if (fs.existsSync(frozenDir)) throw new Error(`Frozen directory already exists: ${frozenDir}`);
  const temporary = path.join(studyRoot, `.frozen.${process.pid}.tmp`);
  if (fs.existsSync(temporary)) throw new Error(`Temporary freeze directory exists: ${temporary}`);
  fs.mkdirSync(temporary);
  try {
    writeJson(path.join(temporary, "cases.json"), cases);
    writeJson(path.join(temporary, "arthur-predictions.json"), arthurPredictions);
    writeJson(path.join(temporary, "comparator-predictions.json"), comparatorPredictions);
    writeJsonLines(path.join(temporary, "review-packets.jsonl"), packets);
    writeJson(path.join(temporary, "standard-tool-evidence.json"), standardToolEvidence);
    writeJson(path.join(temporary, "lock.json"), lock);
    fs.renameSync(temporary, frozenDir);
  } catch (error) {
    if (fs.existsSync(temporary)) {
      const resolved = path.resolve(temporary);
      if (resolved.startsWith(`${studyRoot}${path.sep}`)) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
    throw error;
  }

  manifest.status = "frozen";
  manifest.frozenAt = frozenAt;
  manifest.lockSha256 = sha256(stableJson(lock));
  saveManifest(studyDir, manifest);
  recordAuditEvent(studyDir, "study_frozen", path.join(frozenDir, "lock.json"));
  return lock;
}
