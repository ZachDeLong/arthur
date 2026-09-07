import path from "node:path";
import { packageNameForSpecifier } from "./inventory.js";
import { readJson } from "./storage.js";
import { captureDir, loadManifest } from "./study-store.js";
import type {
  CaptureMetadata,
  GroundTruthContracts,
  PackageContract,
  ReferenceCase,
  ReviewPacket,
  StandardToolEvidence,
  ToolRun,
} from "./types.js";
import { FIELD_SCHEMA_VERSION } from "./types.js";

function contractFor(
  item: ReferenceCase,
  contracts: GroundTruthContracts,
): ReviewPacket["contract"] {
  if (item.domain === "env") return contracts.env;
  if (item.domain === "routes") return contracts.routes;
  const packageName = packageNameForSpecifier(item.target);
  return contracts.packages.find((contract) => contract.packageName === packageName) ?? {
    packageName,
    installed: false,
  } satisfies PackageContract;
}

export function buildReviewPackets(studyDir: string): ReviewPacket[] {
  const manifest = loadManifest(studyDir);
  const packets = manifest.captures.flatMap((capture) => {
    const directory = captureDir(studyDir, capture.changeId);
    const metadata = readJson<CaptureMetadata>(path.join(directory, "metadata.json"));
    const cases = readJson<ReferenceCase[]>(path.join(directory, "inventory.json"));
    const contracts = readJson<GroundTruthContracts>(path.join(directory, "contracts.json"));
    const standardTools = readJson<ToolRun[]>(path.join(directory, "tools.json"));
    return cases.map((item): ReviewPacket => ({
      caseId: item.caseId,
      changeId: item.changeId,
      domain: item.domain,
      target: item.target,
      raw: item.raw,
      location: item.location,
      context: item.context,
      contract: contractFor(item, contracts),
      evidence: {
        repositoryId: metadata.repositoryId,
        publicRepositoryUrl: metadata.publicRepositoryUrl,
        baseCommit: metadata.baseCommit,
        resultCommit: metadata.resultCommit,
        diffSha256: metadata.rawDiffSha256,
        sourceSha256: item.sourceSha256,
        standardTools: standardTools.map((tool) => ({
          kind: tool.kind,
          name: tool.name,
          command: tool.command,
        })),
        noStandardToolsReason: metadata.noStandardToolsReason,
      },
    }));
  });
  const unique = new Set(packets.map((packet) => packet.caseId));
  if (unique.size !== packets.length) throw new Error("Study contains duplicate case IDs.");
  return packets.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

export function buildStandardToolEvidence(studyDir: string): StandardToolEvidence {
  const manifest = loadManifest(studyDir);
  return {
    schemaVersion: FIELD_SCHEMA_VERSION,
    changes: manifest.captures
      .map((capture) => {
        const directory = captureDir(studyDir, capture.changeId);
        const metadata = readJson<CaptureMetadata>(path.join(directory, "metadata.json"));
        return {
          changeId: capture.changeId,
          repositoryId: capture.repositoryId,
          noStandardToolsReason: metadata.noStandardToolsReason,
          runs: readJson<ToolRun[]>(path.join(directory, "tools.json")),
        };
      })
      .sort((left, right) => left.changeId.localeCompare(right.changeId)),
  };
}
