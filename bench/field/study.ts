import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordAuditEvent, verifyAuditChain } from "./audit.js";
import { assertFrozenArthurBuild, pendingSelectionIds } from "./capture.js";
import { validateStudyDefinition } from "./definition.js";
import {
  assertSimpleId,
  blindId,
  normalizeText,
  readJson,
  sha256,
  writeJsonExclusive,
  writeTextExclusive,
} from "./storage.js";
import {
  assertStudyStatus,
  loadManifest,
  manifestPath,
  saveManifest,
} from "./study-store.js";
import type { CohortRules, DecisionRules, StudyManifest } from "./types.js";
import { FIELD_SCHEMA_VERSION } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const protocolPath = path.join(here, "PROTOCOL.md");
const planPath = path.join(here, "study-plan.json");
const activationPath = path.join(here, "activation.json");

interface StudyPlanFile {
  protocolVersion: number;
  selection: {
    minimumIncludedChanges: number;
    minimumRepositories: number;
    maximumChangesPerRepository: number;
    allowedExclusionReasons: string[];
  };
  decision: DecisionRules;
}

export interface ExclusionOptions {
  studyDir: string;
  repositoryId: string;
  reason: string;
  note: string;
  baseCommit?: string;
  resultCommit?: string;
}

function cohortFromPlan(plan: StudyPlanFile): CohortRules {
  return {
    minimumIncludedChanges: plan.selection.minimumIncludedChanges,
    minimumRepositories: plan.selection.minimumRepositories,
    maximumChangesPerRepository: plan.selection.maximumChangesPerRepository,
    allowedExclusionReasons: [...plan.selection.allowedExclusionReasons],
  };
}

export function initializeStudy(studyDir: string, requestedStudyId?: string): StudyManifest {
  const root = path.resolve(studyDir);
  if (fs.existsSync(manifestPath(root))) {
    throw new Error(`Study is already initialized: ${root}`);
  }
  const activation = assertFrozenArthurBuild();
  const protocol = normalizeText(fs.readFileSync(protocolPath, "utf-8"));
  const protocolSha256 = sha256(protocol);
  if (protocolSha256 !== activation.protocolSha256) {
    throw new Error(
      "The working field protocol differs from the publicly activated protocol. Start a new version instead of editing v1.",
    );
  }
  const plan = readJson<StudyPlanFile>(planPath);
  const planSha256 = sha256(normalizeText(fs.readFileSync(planPath, "utf-8")));
  if (planSha256 !== activation.studyPlanSha256) {
    throw new Error(
      "The working study plan differs from the publicly activated decision rules. Start a new protocol version instead of editing v1.",
    );
  }
  if (plan.protocolVersion !== activation.protocolVersion) {
    throw new Error("Study plan and activation record use different protocol versions.");
  }

  const fallbackId = `field-v${plan.protocolVersion}-${new Date().toISOString().slice(0, 10)}`;
  const studyId = assertSimpleId(requestedStudyId ?? fallbackId, "Study ID");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "captures"), { recursive: true });
  fs.mkdirSync(path.join(root, "selections"), { recursive: true });
  fs.mkdirSync(path.join(root, "review", "submissions"), { recursive: true });
  fs.mkdirSync(path.join(root, "retention"), { recursive: true });
  fs.mkdirSync(path.join(root, "exclusions"), { recursive: true });
  fs.mkdirSync(path.join(root, "comparator", "runs"), { recursive: true });

  writeTextExclusive(path.join(root, "protocol", "PROTOCOL.md"), protocol);
  writeTextExclusive(
    path.join(root, "protocol", "study-plan.json"),
    normalizeText(fs.readFileSync(planPath, "utf-8")),
  );
  writeTextExclusive(
    path.join(root, "protocol", "activation.json"),
    normalizeText(fs.readFileSync(activationPath, "utf-8")),
  );

  const manifest: StudyManifest = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    protocolVersion: plan.protocolVersion,
    studyId,
    status: "collecting",
    createdAt: new Date().toISOString(),
    activation,
    cohort: cohortFromPlan(plan),
    decisionRules: { ...plan.decision },
    captures: [],
    exclusions: [],
  };
  writeJsonExclusive(manifestPath(root), manifest);
  recordAuditEvent(root, "study_initialized", path.join(root, "protocol", "activation.json"));
  return manifest;
}

export function recordExclusion(options: ExclusionOptions): string {
  const manifest = loadManifest(options.studyDir);
  assertStudyStatus(manifest, ["collecting"]);
  validateStudyDefinition(options.studyDir, manifest);
  if (fs.existsSync(path.join(path.resolve(options.studyDir), "comparator", "collection-lock.json"))) {
    throw new Error("Collection is permanently closed because comparator setup has started.");
  }
  if (!manifest.cohort.allowedExclusionReasons.includes(options.reason)) {
    throw new Error(
      `Invalid exclusion reason. Allowed: ${manifest.cohort.allowedExclusionReasons.join(", ")}`,
    );
  }
  if (!options.note.trim()) throw new Error("Every exclusion requires a non-empty note.");
  for (const [label, commit] of [["base", options.baseCommit], ["result", options.resultCommit]] as const) {
    if (commit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) {
      throw new Error(`Excluded candidate ${label} commit must be a full Git object ID.`);
    }
  }
  const candidateId = blindId(
    "x",
    options.repositoryId,
    options.baseCommit ?? "",
    options.resultCommit ?? "",
    options.reason,
  );
  if (manifest.exclusions.some((entry) => entry.candidateId === candidateId)) {
    throw new Error(`Exclusion is already recorded: ${candidateId}`);
  }
  const exclusion = {
    candidateId,
    repositoryId: options.repositoryId,
    baseCommit: options.baseCommit,
    resultCommit: options.resultCommit,
    reason: options.reason,
    note: options.note.trim(),
    recordedAt: new Date().toISOString(),
  };
  const target = path.join(path.resolve(options.studyDir), "exclusions", `${candidateId}.json`);
  writeJsonExclusive(target, exclusion);
  manifest.exclusions.push(exclusion);
  saveManifest(options.studyDir, manifest);
  recordAuditEvent(options.studyDir, "candidate_excluded", target);
  return candidateId;
}

export function summarizeStudy(studyDir: string): Record<string, unknown> {
  const manifest = loadManifest(studyDir);
  const audit = verifyAuditChain(studyDir);
  const repositoryCounts = Object.fromEntries(
    [...new Set(manifest.captures.map((entry) => entry.repositoryId))]
      .sort()
      .map((repositoryId) => [
        repositoryId,
        manifest.captures.filter((entry) => entry.repositoryId === repositoryId).length,
      ]),
  );
  const totalCases = manifest.captures.reduce((sum, entry) => sum + entry.caseCount, 0);
  const totalBlockingFindings = manifest.captures.reduce(
    (sum, entry) => sum + entry.blockingFindingCount,
    0,
  );
  return {
    studyId: manifest.studyId,
    status: manifest.status,
    captures: manifest.captures.length,
    requiredCaptures: manifest.cohort.minimumIncludedChanges,
    repositories: Object.keys(repositoryCounts).length,
    requiredRepositories: manifest.cohort.minimumRepositories,
    repositoryCounts,
    totalCases,
    totalBlockingFindings,
    pendingSelections: pendingSelectionIds(studyDir, manifest.captures),
    exclusions: manifest.exclusions.length,
    comparator: manifest.comparator?.system ?? "not run",
    auditEvents: audit.length,
    auditHeadSha256: audit.at(-1)?.eventSha256,
    frozenAt: manifest.frozenAt,
    completedAt: manifest.completedAt,
  };
}
