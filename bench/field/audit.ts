import fs from "node:fs";
import path from "node:path";
import { fileDigest, readJsonLines, sha256, stableJson } from "./storage.js";

export interface AuditEvent {
  index: number;
  recordedAt: string;
  type: string;
  artifactPath: string;
  artifactSha256: string;
  previousEventSha256: string | null;
  eventSha256: string;
}

function auditPath(studyDir: string): string {
  return path.join(path.resolve(studyDir), "audit.jsonl");
}

function eventHash(event: Omit<AuditEvent, "eventSha256">): string {
  return sha256(stableJson(event));
}

function relativeArtifact(studyDir: string, artifactPath: string): string {
  const root = path.resolve(studyDir);
  const target = path.resolve(artifactPath);
  const relative = path.relative(root, target).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("Audited artifact must be a file inside the study directory.");
  }
  return relative;
}

export function verifyAuditChain(studyDir: string, verifyArtifacts = true): AuditEvent[] {
  const events = readJsonLines<AuditEvent>(auditPath(studyDir));
  let previous: string | null = null;
  const artifacts = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.index !== index + 1 || event.previousEventSha256 !== previous) {
      throw new Error(`Audit chain order is invalid at event ${index + 1}.`);
    }
    const { eventSha256, ...unsigned } = event;
    if (eventHash(unsigned) !== eventSha256) {
      throw new Error(`Audit event hash is invalid at event ${event.index}.`);
    }
    if (artifacts.has(event.artifactPath)) {
      throw new Error(`Audit chain contains a duplicate immutable artifact: ${event.artifactPath}`);
    }
    artifacts.add(event.artifactPath);
    if (verifyArtifacts) {
      const root = path.resolve(studyDir);
      const target = path.resolve(root, event.artifactPath);
      if (!target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Audit event escapes the study directory: ${event.artifactPath}`);
      }
      if (!fs.existsSync(target)) {
        throw new Error(`Audited artifact disappeared: ${event.artifactPath}`);
      }
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      if (!realTarget.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error(`Audited artifact resolves outside the study directory: ${event.artifactPath}`);
      }
      if (fileDigest(target).sha256 !== event.artifactSha256) {
        throw new Error(`Audited artifact changed or disappeared: ${event.artifactPath}`);
      }
    }
    previous = event.eventSha256;
  }
  return events;
}

export function recordAuditEvent(studyDir: string, type: string, artifactPath: string): AuditEvent {
  const events = verifyAuditChain(studyDir);
  const artifactRelative = relativeArtifact(studyDir, artifactPath);
  const unsigned: Omit<AuditEvent, "eventSha256"> = {
    index: events.length + 1,
    recordedAt: new Date().toISOString(),
    type,
    artifactPath: artifactRelative,
    artifactSha256: fileDigest(path.resolve(artifactPath)).sha256,
    previousEventSha256: events.at(-1)?.eventSha256 ?? null,
  };
  const event: AuditEvent = { ...unsigned, eventSha256: eventHash(unsigned) };
  fs.appendFileSync(auditPath(studyDir), `${JSON.stringify(event)}\n`, "utf-8");
  return event;
}
