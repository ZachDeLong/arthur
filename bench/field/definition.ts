import fs from "node:fs";
import path from "node:path";
import { normalizeText, readJson, sha256, stableJson } from "./storage.js";
import type { DecisionRules, StudyManifest } from "./types.js";

interface LockedStudyPlan {
  protocolVersion: number;
  selection: {
    minimumIncludedChanges: number;
    minimumRepositories: number;
    maximumChangesPerRepository: number;
    allowedExclusionReasons: string[];
  };
  decision: DecisionRules;
}

export function validateStudyDefinition(studyDir: string, manifest: StudyManifest): void {
  const protocolDir = path.join(path.resolve(studyDir), "protocol");
  const protocolPath = path.join(protocolDir, "PROTOCOL.md");
  const planPath = path.join(protocolDir, "study-plan.json");
  const activationPath = path.join(protocolDir, "activation.json");
  for (const target of [protocolPath, planPath, activationPath]) {
    if (!fs.existsSync(target)) throw new Error(`Missing locked study definition: ${target}`);
  }
  if (sha256(normalizeText(fs.readFileSync(protocolPath, "utf-8"))) !== manifest.activation.protocolSha256) {
    throw new Error("Locked protocol snapshot changed after study initialization.");
  }
  if (sha256(normalizeText(fs.readFileSync(planPath, "utf-8"))) !== manifest.activation.studyPlanSha256) {
    throw new Error("Locked study-plan snapshot changed after study initialization.");
  }
  const savedActivation = readJson<typeof manifest.activation>(activationPath);
  if (stableJson(savedActivation) !== stableJson(manifest.activation)) {
    throw new Error("Study activation record changed after initialization.");
  }
  const plan = readJson<LockedStudyPlan>(planPath);
  const expectedCohort = {
    minimumIncludedChanges: plan.selection.minimumIncludedChanges,
    minimumRepositories: plan.selection.minimumRepositories,
    maximumChangesPerRepository: plan.selection.maximumChangesPerRepository,
    allowedExclusionReasons: plan.selection.allowedExclusionReasons,
  };
  if (manifest.protocolVersion !== plan.protocolVersion) {
    throw new Error("Manifest protocol version differs from the locked plan.");
  }
  if (stableJson(manifest.cohort) !== stableJson(expectedCohort)) {
    throw new Error("Manifest cohort rules differ from the locked study plan.");
  }
  if (stableJson(manifest.decisionRules) !== stableJson(plan.decision)) {
    throw new Error("Manifest decision rules differ from the locked study plan.");
  }
}
