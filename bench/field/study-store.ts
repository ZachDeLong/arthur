import fs from "node:fs";
import path from "node:path";
import { readJson, replaceJson } from "./storage.js";
import type { StudyManifest, StudyStatus } from "./types.js";

export function manifestPath(studyDir: string): string {
  return path.join(path.resolve(studyDir), "manifest.json");
}

export function loadManifest(studyDir: string): StudyManifest {
  const target = manifestPath(studyDir);
  if (!fs.existsSync(target)) {
    throw new Error(`Study is not initialized: ${path.resolve(studyDir)}`);
  }
  return readJson<StudyManifest>(target);
}

export function saveManifest(studyDir: string, manifest: StudyManifest): void {
  replaceJson(manifestPath(studyDir), manifest);
}

export function assertStudyStatus(
  manifest: StudyManifest,
  allowed: StudyStatus[],
): void {
  if (!allowed.includes(manifest.status)) {
    throw new Error(
      `Study status is ${manifest.status}; expected ${allowed.join(" or ")}.`,
    );
  }
}

export function captureDir(studyDir: string, changeId: string): string {
  return path.join(path.resolve(studyDir), "captures", changeId);
}
