import fs from "node:fs";
import path from "node:path";
import { recordAuditEvent } from "./audit.js";
import {
  assertSimpleId,
  readJson,
  readJsonLines,
  writeJsonExclusive,
} from "./storage.js";
import { assertStudyStatus, loadManifest, saveManifest } from "./study-store.js";
import type {
  AdjudicationSubmission,
  BaselineSubmission,
  ReferenceCase,
  RetentionDecision,
  ReviewLabel,
  ReviewPacket,
  ReviewSubmission,
  ToolRun,
} from "./types.js";
import { FIELD_SCHEMA_VERSION } from "./types.js";

const REVIEW_LABELS = new Set<ReviewLabel>([
  "valid",
  "actionable_invalid",
  "ignored",
  "uncertain",
]);
const FINAL_REVIEW_LABELS = new Set<string>(["valid", "actionable_invalid", "ignored"]);

function frozenPath(studyDir: string, name: string): string {
  return path.join(path.resolve(studyDir), "frozen", name);
}

function reviewSubmissions(studyDir: string): ReviewSubmission[] {
  const directory = path.join(path.resolve(studyDir), "review", "submissions");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<ReviewSubmission>(path.join(directory, name)));
}

function expectedCaseIds(studyDir: string): string[] {
  return readJson<ReferenceCase[]>(frozenPath(studyDir, "cases.json"))
    .map((item) => item.caseId)
    .sort();
}

function assertExactIds(actual: string[], expected: string[], label: string): void {
  if (new Set(actual).size !== actual.length) throw new Error(`${label} contains duplicate case IDs.`);
  const normalized = [...actual].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    const missing = expected.filter((id) => !normalized.includes(id));
    const unknown = normalized.filter((id) => !expected.includes(id));
    throw new Error(`${label} case mismatch: ${missing.length} missing, ${unknown.length} unknown.`);
  }
}

function assertReviewAttestation(review: ReviewSubmission): void {
  if (
    !review.attestation.didNotImplementEvaluatedCheckers ||
    !review.attestation.didNotSeeDetectorPredictions ||
    !review.attestation.reviewedIndependently
  ) {
    throw new Error("All reviewer independence and blinding attestations must be true.");
  }
}

function assertStandardToolDecision(
  item: {
    caseId: string;
    label: ReviewLabel | Exclude<ReviewLabel, "uncertain">;
    caughtByStandardTools: boolean | null;
    caughtByToolNames: string[];
  },
  packet: ReviewPacket,
  source: string,
): void {
  if (!Array.isArray(item.caughtByToolNames)) {
    throw new Error(`${source} caughtByToolNames must be an array for ${item.caseId}.`);
  }
  if (new Set(item.caughtByToolNames).size !== item.caughtByToolNames.length) {
    throw new Error(`${source} contains duplicate standard-tool names for ${item.caseId}.`);
  }
  const available = new Set(packet.evidence.standardTools.map((tool) => tool.name));
  const unknown = item.caughtByToolNames.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`${source} names unrecorded tools for ${item.caseId}: ${unknown.join(", ")}`);
  }
  if (item.label !== "actionable_invalid") {
    if (item.caughtByStandardTools !== null || item.caughtByToolNames.length > 0) {
      throw new Error(`${source} may attribute standard tools only for actionable-invalid ${item.caseId}.`);
    }
    return;
  }
  if (typeof item.caughtByStandardTools !== "boolean") {
    throw new Error(`${source} must decide standard-tool detection for ${item.caseId}.`);
  }
  if (item.caughtByStandardTools !== (item.caughtByToolNames.length > 0)) {
    throw new Error(`${source} standard-tool decision and named tools disagree for ${item.caseId}.`);
  }
}

function sameStandardToolDecision(
  left: ReviewSubmission["labels"][number],
  right: ReviewSubmission["labels"][number],
): boolean {
  return left.caughtByStandardTools === right.caughtByStandardTools &&
    JSON.stringify([...left.caughtByToolNames].sort()) ===
      JSON.stringify([...right.caughtByToolNames].sort());
}

export function createReviewTemplate(
  studyDir: string,
  reviewerIdInput: string,
  outputPath: string,
): void {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["frozen", "adjudicating"]);
  const reviewerId = assertSimpleId(reviewerIdInput, "Reviewer ID");
  const packets = readJsonLines<ReviewPacket>(frozenPath(studyDir, "review-packets.jsonl"));
  writeJsonExclusive(path.resolve(outputPath), {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    studyLockSha256: manifest.lockSha256,
    reviewerId,
    submittedAt: null,
    attestation: {
      didNotImplementEvaluatedCheckers: false,
      didNotSeeDetectorPredictions: false,
      reviewedIndependently: false,
    },
    instructions: "Set all attestations true and fill one label/rationale per case. For actionable_invalid, inspect frozen/standard-tool-evidence.json and set caughtByStandardTools plus the explicit catching tool names; otherwise leave that decision null with no names. Then submit with the field CLI.",
    labels: packets.map((packet) => ({
      caseId: packet.caseId,
      label: null,
      rationale: "",
      evidence: "",
      caughtByStandardTools: null,
      caughtByToolNames: [],
    })),
  });
}

export function submitReview(studyDir: string, inputPath: string): string {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["frozen", "adjudicating"]);
  const review = readJson<ReviewSubmission>(path.resolve(inputPath));
  const reviewerId = assertSimpleId(review.reviewerId, "Reviewer ID");
  if (review.studyId !== manifest.studyId || review.studyLockSha256 !== manifest.lockSha256) {
    throw new Error("Review targets a different study or frozen lock.");
  }
  assertReviewAttestation(review);
  const existing = reviewSubmissions(studyDir);
  if (existing.length >= 2) throw new Error("The two preregistered primary review slots are filled.");
  if (existing.some((item) => item.reviewerId === reviewerId)) {
    throw new Error(`Reviewer already submitted: ${reviewerId}`);
  }
  const expected = expectedCaseIds(studyDir);
  assertExactIds(review.labels.map((item) => item.caseId), expected, "Review");
  const packets = new Map(
    readJsonLines<ReviewPacket>(frozenPath(studyDir, "review-packets.jsonl"))
      .map((packet) => [packet.caseId, packet]),
  );
  for (const item of review.labels) {
    if (!REVIEW_LABELS.has(item.label)) throw new Error(`Invalid review label for ${item.caseId}.`);
    if (!item.rationale?.trim()) throw new Error(`Review rationale is required for ${item.caseId}.`);
    assertStandardToolDecision(item, packets.get(item.caseId)!, "Review");
  }
  const normalized: ReviewSubmission = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    studyLockSha256: manifest.lockSha256!,
    reviewerId,
    submittedAt: new Date().toISOString(),
    attestation: { ...review.attestation },
    labels: review.labels
      .map((item) => ({
        ...item,
        caughtByToolNames: [...item.caughtByToolNames].sort(),
      }))
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  };
  const target = path.join(path.resolve(studyDir), "review", "submissions", `${reviewerId}.json`);
  writeJsonExclusive(target, normalized);
  recordAuditEvent(studyDir, "primary_review_submitted", target);
  manifest.status = "adjudicating";
  saveManifest(studyDir, manifest);
  return target;
}

function disputedCases(reviews: ReviewSubmission[]): Array<{
  caseId: string;
  labels: Array<{
    reviewerId: string;
    label: ReviewLabel;
    rationale: string;
    caughtByStandardTools: boolean | null;
    caughtByToolNames: string[];
  }>;
}> {
  if (reviews.length !== 2) throw new Error(`Exactly two primary reviews are required; found ${reviews.length}.`);
  const right = new Map(reviews[1].labels.map((item) => [item.caseId, item]));
  return reviews[0].labels.flatMap((leftItem) => {
    const rightItem = right.get(leftItem.caseId);
    if (!rightItem) throw new Error(`Second review omitted ${leftItem.caseId}.`);
    if (
      leftItem.label === rightItem.label &&
      leftItem.label !== "uncertain" &&
      sameStandardToolDecision(leftItem, rightItem)
    ) return [];
    return [{
      caseId: leftItem.caseId,
      labels: [
        {
          reviewerId: reviews[0].reviewerId,
          label: leftItem.label,
          rationale: leftItem.rationale,
          caughtByStandardTools: leftItem.caughtByStandardTools,
          caughtByToolNames: leftItem.caughtByToolNames,
        },
        {
          reviewerId: reviews[1].reviewerId,
          label: rightItem.label,
          rationale: rightItem.rationale,
          caughtByStandardTools: rightItem.caughtByStandardTools,
          caughtByToolNames: rightItem.caughtByToolNames,
        },
      ],
    }];
  });
}

export function createAdjudicationTemplate(
  studyDir: string,
  adjudicatorIdInput: string,
  outputPath: string,
): number {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["adjudicating"]);
  const adjudicatorId = assertSimpleId(adjudicatorIdInput, "Adjudicator ID");
  const reviews = reviewSubmissions(studyDir);
  if (reviews.some((item) => item.reviewerId === adjudicatorId)) {
    throw new Error("The adjudicator must be different from both primary reviewers.");
  }
  const disputes = disputedCases(reviews);
  writeJsonExclusive(path.resolve(outputPath), {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    studyLockSha256: manifest.lockSha256,
    adjudicatorId,
    submittedAt: null,
    attestation: {
      didNotImplementEvaluatedCheckers: false,
      didNotSeeDetectorPredictions: false,
    },
    reviewerLabels: disputes,
    instructions: "Resolve every listed case to valid, actionable_invalid, or ignored. For actionable_invalid, also resolve standard-tool detection from frozen/standard-tool-evidence.json. Do not open detector prediction files.",
    decisions: disputes.map((item) => ({
      caseId: item.caseId,
      label: null,
      rationale: "",
      caughtByStandardTools: null,
      caughtByToolNames: [],
    })),
  });
  return disputes.length;
}

export function submitAdjudication(studyDir: string, inputPath: string): string {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["adjudicating"]);
  const target = path.join(path.resolve(studyDir), "review", "adjudication.json");
  if (fs.existsSync(target)) throw new Error("Adjudication is already submitted.");
  const adjudication = readJson<AdjudicationSubmission>(path.resolve(inputPath));
  const adjudicatorId = assertSimpleId(adjudication.adjudicatorId, "Adjudicator ID");
  if (
    adjudication.studyId !== manifest.studyId ||
    adjudication.studyLockSha256 !== manifest.lockSha256
  ) {
    throw new Error("Adjudication targets a different study or frozen lock.");
  }
  if (
    !adjudication.attestation.didNotImplementEvaluatedCheckers ||
    !adjudication.attestation.didNotSeeDetectorPredictions
  ) {
    throw new Error("All adjudicator independence and blinding attestations must be true.");
  }
  const reviews = reviewSubmissions(studyDir);
  if (reviews.some((item) => item.reviewerId === adjudicatorId)) {
    throw new Error("The adjudicator must differ from both primary reviewers.");
  }
  const expected = disputedCases(reviews).map((item) => item.caseId).sort();
  assertExactIds(adjudication.decisions.map((item) => item.caseId), expected, "Adjudication");
  const packets = new Map(
    readJsonLines<ReviewPacket>(frozenPath(studyDir, "review-packets.jsonl"))
      .map((packet) => [packet.caseId, packet]),
  );
  for (const decision of adjudication.decisions) {
    if (!FINAL_REVIEW_LABELS.has(decision.label)) {
      throw new Error(`Adjudication must resolve ${decision.caseId} to a non-uncertain label.`);
    }
    if (!decision.rationale?.trim()) {
      throw new Error(`Adjudication rationale is required for ${decision.caseId}.`);
    }
    assertStandardToolDecision(decision, packets.get(decision.caseId)!, "Adjudication");
  }
  const normalized: AdjudicationSubmission = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    studyLockSha256: manifest.lockSha256!,
    adjudicatorId,
    submittedAt: new Date().toISOString(),
    attestation: { ...adjudication.attestation },
    decisions: adjudication.decisions
      .map((item) => ({
        ...item,
        caughtByToolNames: [...item.caughtByToolNames].sort(),
      }))
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  };
  writeJsonExclusive(target, normalized);
  recordAuditEvent(studyDir, "adjudication_submitted", target);
  return target;
}

export function resolveGroundTruth(studyDir: string): {
  labels: Map<string, Exclude<ReviewLabel, "uncertain">>;
  standardTools: Map<string, { caught: boolean; toolNames: string[] }>;
  reviews: ReviewSubmission[];
  disputedCaseIds: string[];
} {
  const reviews = reviewSubmissions(studyDir);
  if (reviews.length !== 2) throw new Error(`Exactly two primary reviews are required; found ${reviews.length}.`);
  const disputes = disputedCases(reviews);
  const disputeIds = new Set(disputes.map((item) => item.caseId));
  const adjudicationPath = path.join(path.resolve(studyDir), "review", "adjudication.json");
  let decisions = new Map<string, Exclude<ReviewLabel, "uncertain">>();
  if (disputes.length > 0) {
    if (!fs.existsSync(adjudicationPath)) {
      throw new Error(`${disputes.length} case(s) still require third-reviewer adjudication.`);
    }
    const adjudication = readJson<AdjudicationSubmission>(adjudicationPath);
    decisions = new Map(adjudication.decisions.map((item) => [item.caseId, item.label]));
    assertExactIds([...decisions.keys()], [...disputeIds].sort(), "Saved adjudication");
  }
  const second = new Map(reviews[1].labels.map((item) => [item.caseId, item.label]));
  const secondItems = new Map(reviews[1].labels.map((item) => [item.caseId, item]));
  const labels = new Map<string, Exclude<ReviewLabel, "uncertain">>();
  const standardTools = new Map<string, { caught: boolean; toolNames: string[] }>();
  const adjudicated = fs.existsSync(adjudicationPath)
    ? new Map(
        readJson<AdjudicationSubmission>(adjudicationPath).decisions
          .map((item) => [item.caseId, item]),
      )
    : new Map<string, AdjudicationSubmission["decisions"][number]>();
  for (const item of reviews[0].labels) {
    if (disputeIds.has(item.caseId)) {
      const finalLabel = decisions.get(item.caseId)!;
      labels.set(item.caseId, finalLabel);
      if (finalLabel === "actionable_invalid") {
        const decision = adjudicated.get(item.caseId)!;
        standardTools.set(item.caseId, {
          caught: decision.caughtByStandardTools!,
          toolNames: [...decision.caughtByToolNames],
        });
      }
      continue;
    }
    const right = second.get(item.caseId);
    if (item.label !== right || item.label === "uncertain") {
      throw new Error(`Unresolved review disagreement for ${item.caseId}.`);
    }
    labels.set(item.caseId, item.label);
    if (item.label === "actionable_invalid") {
      const rightItem = secondItems.get(item.caseId)!;
      if (!sameStandardToolDecision(item, rightItem)) {
        throw new Error(`Unresolved standard-tool disagreement for ${item.caseId}.`);
      }
      standardTools.set(item.caseId, {
        caught: item.caughtByStandardTools!,
        toolNames: [...item.caughtByToolNames],
      });
    }
  }
  return { labels, standardTools, reviews, disputedCaseIds: [...disputeIds].sort() };
}

export function createBaselineTemplate(studyDir: string, assessorIdInput: string, outputPath: string): number {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["adjudicating"]);
  const assessorId = assertSimpleId(assessorIdInput, "Assessor ID");
  const { labels, standardTools } = resolveGroundTruth(studyDir);
  const cases = readJson<ReferenceCase[]>(frozenPath(studyDir, "cases.json"));
  const actionable = cases.filter((item) => labels.get(item.caseId) === "actionable_invalid");
  const availableTools = new Map<string, string[]>();
  for (const capture of manifest.captures) {
    const runs = readJson<ToolRun[]>(
      path.join(path.resolve(studyDir), "captures", capture.changeId, "tools.json"),
    );
    availableTools.set(capture.changeId, runs.map((run) => run.name));
  }
  writeJsonExclusive(path.resolve(outputPath), {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    studyLockSha256: manifest.lockSha256,
    assessorId,
    submittedAt: null,
    attestation: {
      didNotImplementEvaluatedCheckers: false,
      didNotSeeDetectorPredictions: false,
    },
    instructions: "Standard-tool detection is copied from the resolved blinded reviews. Group occurrences of one underlying bug under the same defectId without opening detector prediction files.",
    attributions: actionable.map((item) => ({
      caseId: item.caseId,
      availableToolNames: availableTools.get(item.changeId) ?? [],
      defectId: "",
      caughtByStandardTools: standardTools.get(item.caseId)!.caught,
      caughtByToolNames: standardTools.get(item.caseId)!.toolNames,
      rationale: "",
    })),
  });
  return actionable.length;
}

export function submitBaseline(studyDir: string, inputPath: string): string {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["adjudicating"]);
  const target = path.join(path.resolve(studyDir), "review", "baseline.json");
  if (fs.existsSync(target)) throw new Error("Standard-tool attribution is already submitted.");
  const baseline = readJson<BaselineSubmission>(path.resolve(inputPath));
  const assessorId = assertSimpleId(baseline.assessorId, "Assessor ID");
  if (baseline.studyId !== manifest.studyId || baseline.studyLockSha256 !== manifest.lockSha256) {
    throw new Error("Baseline attribution targets a different study or frozen lock.");
  }
  if (
    !baseline.attestation?.didNotImplementEvaluatedCheckers ||
    !baseline.attestation.didNotSeeDetectorPredictions
  ) {
    throw new Error("Baseline grouping requires independence and detector-blinding attestations.");
  }
  const { labels, standardTools } = resolveGroundTruth(studyDir);
  const expected = [...labels]
    .filter(([, label]) => label === "actionable_invalid")
    .map(([caseId]) => caseId)
    .sort();
  assertExactIds(baseline.attributions.map((item) => item.caseId), expected, "Baseline attribution");
  const cases = new Map(
    readJson<ReferenceCase[]>(frozenPath(studyDir, "cases.json"))
      .map((item) => [item.caseId, item]),
  );
  const availableByChange = new Map<string, Set<string>>();
  for (const capture of manifest.captures) {
    const runs = readJson<ToolRun[]>(
      path.join(path.resolve(studyDir), "captures", capture.changeId, "tools.json"),
    );
    availableByChange.set(capture.changeId, new Set(runs.map((run) => run.name)));
  }
  const defectChanges = new Map<string, string>();
  for (const item of baseline.attributions) {
    assertSimpleId(item.defectId, `Defect ID for ${item.caseId}`);
    if (typeof item.caughtByStandardTools !== "boolean") {
      throw new Error(`caughtByStandardTools must be boolean for ${item.caseId}.`);
    }
    if (!item.rationale?.trim()) throw new Error(`Baseline rationale is required for ${item.caseId}.`);
    if (!item.caughtByStandardTools && item.caughtByToolNames.length > 0) {
      throw new Error(`${item.caseId} lists catching tools while caughtByStandardTools is false.`);
    }
    if (item.caughtByStandardTools && item.caughtByToolNames.length === 0) {
      throw new Error(`${item.caseId} must name the standard tool that caught it.`);
    }
    const testCase = cases.get(item.caseId)!;
    const resolvedTools = standardTools.get(item.caseId)!;
    if (
      item.caughtByStandardTools !== resolvedTools.caught ||
      JSON.stringify([...item.caughtByToolNames].sort()) !==
        JSON.stringify([...resolvedTools.toolNames].sort())
    ) {
      throw new Error(`Baseline cannot change the reviewers' standard-tool decision for ${item.caseId}.`);
    }
    const available = availableByChange.get(testCase.changeId) ?? new Set<string>();
    const unknownTools = item.caughtByToolNames.filter((name) => !available.has(name));
    if (unknownTools.length > 0) {
      throw new Error(`${item.caseId} names unrecorded tools: ${unknownTools.join(", ")}`);
    }
    const previousChange = defectChanges.get(item.defectId);
    if (previousChange && previousChange !== testCase.changeId) {
      throw new Error(`Defect ID ${item.defectId} cannot span multiple changes.`);
    }
    defectChanges.set(item.defectId, testCase.changeId);
  }
  const normalized: BaselineSubmission = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    studyLockSha256: manifest.lockSha256!,
    assessorId,
    submittedAt: new Date().toISOString(),
    attestation: { ...baseline.attestation },
    attributions: [...baseline.attributions].sort((left, right) => left.caseId.localeCompare(right.caseId)),
  };
  writeJsonExclusive(target, normalized);
  recordAuditEvent(studyDir, "baseline_attribution_submitted", target);
  return target;
}

export function recordRetention(
  studyDir: string,
  decision: Omit<RetentionDecision, "schemaVersion" | "studyId" | "recordedAt">,
): string {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["frozen", "adjudicating"]);
  const developerId = assertSimpleId(decision.developerId, "Developer ID");
  if (!manifest.captures.some((capture) => capture.developerId === developerId)) {
    throw new Error("Retention decisions are accepted only from developers represented in the cohort.");
  }
  if (!decision.externalToArthurImplementation || !decision.recordedBeforeAggregateResults) {
    throw new Error("Counted retention decisions must be external and recorded before aggregate results.");
  }
  const target = path.join(path.resolve(studyDir), "retention", `${developerId}.json`);
  writeJsonExclusive(target, {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    developerId,
    externalToArthurImplementation: true,
    keepEnabled: decision.keepEnabled,
    recordedBeforeAggregateResults: true,
    recordedAt: new Date().toISOString(),
    note: decision.note,
  } satisfies RetentionDecision);
  recordAuditEvent(studyDir, "retention_decision_recorded", target);
  return target;
}
