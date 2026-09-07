import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { recordAuditEvent } from "./audit.js";
import { loadConfig } from "../../src/config/manager.js";
import {
  formatBenchmarkModel,
  resolveBenchmarkLlm,
  runBenchmarkLlm,
  type BenchmarkLlmOptions,
} from "../harness/llm-provider.js";
import { arthurRepoRoot, pendingSelectionIds } from "./capture.js";
import { validateStudyDefinition } from "./definition.js";
import { buildReviewPackets } from "./packets.js";
import { fileDigest, readJson, sha256, stableJson, writeJsonExclusive } from "./storage.js";
import { assertStudyStatus, loadManifest, saveManifest } from "./study-store.js";
import type {
  ComparatorPrediction,
  ComparatorPricing,
  ComparatorRun,
  CollectionLock,
  ReviewPacket,
} from "./types.js";
import { FIELD_SCHEMA_VERSION } from "./types.js";

export const FIELD_COMPARATOR_SYSTEM_PROMPT = [
  "You are the fixed LLM comparator in a preregistered reference-integrity study.",
  "Judge only whether each live JavaScript/TypeScript reference is actionable and invalid in the pinned project facts.",
  "Do not infer detector output. A comment, documentation string, runtime-provided environment convention, or reference outside the stated contract is not an invalid blocking reference.",
  "Use only the supplied code context and ground-truth contract. Return valid JSON and exactly one prediction per case ID.",
].join(" ");

const MAX_CASES_PER_BATCH = 40;

function validatePricing(pricing: ComparatorPricing | undefined): ComparatorPricing {
  if (!pricing || !pricing.source.trim()) {
    throw new Error("Comparator pricing rates and a source are required before collection closes.");
  }
  for (const [label, value] of [
    ["input", pricing.inputUsdPerMillion],
    ["output", pricing.outputUsdPerMillion],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Comparator ${label} price must be a non-negative finite number.`);
    }
  }
  return { ...pricing, source: pricing.source.trim() };
}

interface SavedComparatorBatch {
  system: string;
  provider: string;
  responseId: string;
  requestedModel: string;
  model: string;
  promptSha256: string;
  batchInputSha256: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  rawOutput: string;
  predictions: ComparatorPrediction[];
}

function cohortReady(studyDir: string, manifest: ReturnType<typeof loadManifest>): void {
  const pending = pendingSelectionIds(studyDir, manifest.captures);
  if (pending.length > 0) {
    throw new Error(`Comparator cannot start with ${pending.length} selected capture(s) still incomplete.`);
  }
  const repositories = new Set(manifest.captures.map((entry) => entry.repositoryId));
  if (manifest.captures.length < manifest.cohort.minimumIncludedChanges) {
    throw new Error(
      `Comparator is frozen only after collection: ${manifest.captures.length}/${manifest.cohort.minimumIncludedChanges} changes.`,
    );
  }
  if (repositories.size < manifest.cohort.minimumRepositories) {
    throw new Error(
      `Comparator requires ${manifest.cohort.minimumRepositories} repositories; found ${repositories.size}.`,
    );
  }
}

function closeCollection(
  studyDir: string,
  manifest: ReturnType<typeof loadManifest>,
  packets: ReviewPacket[],
  comparatorRequest: CollectionLock["comparatorRequest"],
): CollectionLock {
  const target = path.join(path.resolve(studyDir), "comparator", "collection-lock.json");
  const captureIndexSha256 = sha256(stableJson(manifest.captures));
  const exclusionsSha256 = sha256(stableJson(manifest.exclusions));
  const caseIdsSha256 = sha256(stableJson(packets.map((packet) => packet.caseId).sort()));
  let lock: CollectionLock;
  if (fs.existsSync(target)) {
    lock = readJson<CollectionLock>(target);
    if (
      lock.studyId !== manifest.studyId ||
      lock.captureIndexSha256 !== captureIndexSha256 ||
      lock.exclusionsSha256 !== exclusionsSha256 ||
      lock.caseIdsSha256 !== caseIdsSha256
      || stableJson(lock.comparatorRequest) !== stableJson(comparatorRequest)
    ) {
      throw new Error("Collection changed after comparator setup started.");
    }
  } else {
    lock = {
      schemaVersion: FIELD_SCHEMA_VERSION,
      studyId: manifest.studyId,
      closedAt: new Date().toISOString(),
      captureIndexSha256,
      exclusionsSha256,
      caseIdsSha256,
      comparatorRequest,
    };
    writeJsonExclusive(target, lock);
    recordAuditEvent(studyDir, "collection_closed", target);
  }
  manifest.status = "comparing";
  manifest.collectionClosedAt = lock.closedAt;
  manifest.collectionLockSha256 = sha256(stableJson(lock));
  saveManifest(studyDir, manifest);
  return lock;
}

export function closeFieldCollection(
  studyDir: string,
  comparatorRequest: CollectionLock["comparatorRequest"],
): CollectionLock {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["collecting", "comparing"]);
  validateStudyDefinition(studyDir, manifest);
  cohortReady(studyDir, manifest);
  return closeCollection(studyDir, manifest, buildReviewPackets(studyDir), {
    ...comparatorRequest,
    pricing: validatePricing(comparatorRequest.pricing),
  });
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function buildPrompt(packets: ReviewPacket[]): string {
  const contracts = new Map<string, ReviewPacket["contract"]>();
  const compactCases = packets.map((packet) => {
    const contractId = `contract_${sha256(stableJson(packet.contract)).slice(0, 16)}`;
    contracts.set(contractId, packet.contract);
    return {
      caseId: packet.caseId,
      domain: packet.domain,
      target: packet.target,
      raw: packet.raw,
      location: packet.location,
      context: packet.context,
      contractId,
    };
  });
  return [
    "For each blinded case, return whether the reference is actionable and invalid.",
    "The contract field is project ground truth, not another detector's decision.",
    "Return JSON only in this exact shape:",
    '{"predictions":[{"caseId":"c_...","predictedInvalid":true,"reason":"brief factual reason"}]}',
    "",
    "GROUND-TRUTH CONTRACTS",
    JSON.stringify(Object.fromEntries([...contracts].sort(([left], [right]) => left.localeCompare(right)))),
    "",
    "BLINDED CASES",
    JSON.stringify(compactCases),
  ].join("\n");
}

export function parseComparatorPredictions(
  output: string,
  packets: ReviewPacket[],
): ComparatorPrediction[] {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Comparator response did not contain JSON.");
  const parsed = JSON.parse(output.slice(start, end + 1)) as {
    predictions?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(parsed.predictions)) {
    throw new Error("Comparator response omitted predictions[].");
  }
  const expected = new Set(packets.map((packet) => packet.caseId));
  const seen = new Set<string>();
  const predictions = parsed.predictions.map((item): ComparatorPrediction => {
    if (typeof item.caseId !== "string" || !expected.has(item.caseId)) {
      throw new Error(`Comparator returned unknown case ID: ${String(item.caseId)}`);
    }
    if (seen.has(item.caseId)) throw new Error(`Comparator duplicated ${item.caseId}.`);
    if (typeof item.predictedInvalid !== "boolean") {
      throw new Error(`Comparator returned a non-boolean decision for ${item.caseId}.`);
    }
    seen.add(item.caseId);
    return {
      caseId: item.caseId,
      predictedInvalid: item.predictedInvalid,
      reason: typeof item.reason === "string" ? item.reason : "",
    };
  });
  const missing = [...expected].filter((caseId) => !seen.has(caseId));
  if (missing.length > 0) throw new Error(`Comparator omitted ${missing.length} case(s).`);
  return predictions.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

async function runBatch(
  llm: BenchmarkLlmOptions,
  packets: ReviewPacket[],
): Promise<SavedComparatorBatch> {
  const prompt = buildPrompt(packets);
  const started = performance.now();
  const result = await runBenchmarkLlm({
    ...llm,
    systemPrompt: FIELD_COMPARATOR_SYSTEM_PROMPT,
    userMessage: prompt,
    maxOutputTokens: 16_000,
    anthropicThinking: "adaptive",
    anthropicEffort: "medium",
  });
  return {
    system: `${llm.provider}/${result.model}`,
    provider: llm.provider,
    responseId: result.responseId,
    requestedModel: llm.model,
    model: result.model,
    promptSha256: sha256(FIELD_COMPARATOR_SYSTEM_PROMPT),
    batchInputSha256: sha256(prompt),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: performance.now() - started,
    rawOutput: result.output,
    predictions: parseComparatorPredictions(result.output, packets),
  };
}

function validateSavedBatch(
  saved: SavedComparatorBatch,
  llm: BenchmarkLlmOptions,
  packets: ReviewPacket[],
): void {
  if (saved.provider !== llm.provider || saved.requestedModel !== llm.model) {
    throw new Error(
      `Saved comparator batch requested ${saved.provider}/${saved.requestedModel}, not ${formatBenchmarkModel(llm)}.`,
    );
  }
  if (saved.promptSha256 !== sha256(FIELD_COMPARATOR_SYSTEM_PROMPT)) {
    throw new Error("Saved comparator batch used a different system prompt.");
  }
  const expectedInput = sha256(buildPrompt(packets));
  if (saved.batchInputSha256 !== expectedInput) {
    throw new Error("Saved comparator batch used different case input.");
  }
  const expectedIds = packets.map((packet) => packet.caseId).sort();
  const actualIds = saved.predictions.map((item) => item.caseId).sort();
  if (stableJson(expectedIds) !== stableJson(actualIds)) {
    throw new Error("Saved comparator batch has a different case set.");
  }
  const reparsed = parseComparatorPredictions(saved.rawOutput, packets);
  if (stableJson(reparsed) !== stableJson(saved.predictions)) {
    throw new Error("Saved comparator predictions differ from its raw provider response.");
  }
}

export async function runFieldComparator(
  studyDir: string,
  llmOverride?: BenchmarkLlmOptions,
  pricingInput?: ComparatorPricing,
): Promise<ComparatorRun> {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["collecting", "comparing"]);
  validateStudyDefinition(studyDir, manifest);
  cohortReady(studyDir, manifest);
  if (manifest.comparator) {
    return readJson<ComparatorRun>(path.join(studyDir, "comparator", "predictions.json"));
  }

  const config = loadConfig(arthurRepoRoot);
  const llm = llmOverride ?? resolveBenchmarkLlm({
    anthropicApiKey: config.apiKey,
    anthropicModel: config.model,
  });
  const pricing = validatePricing(pricingInput);
  const packets = buildReviewPackets(studyDir);
  closeCollection(studyDir, manifest, packets, {
    provider: llm.provider,
    model: llm.model,
    promptSha256: sha256(FIELD_COMPARATOR_SYSTEM_PROMPT),
    pricing,
  });
  const grouped = new Map<string, ReviewPacket[]>();
  for (const packet of packets) {
    const group = grouped.get(packet.changeId) ?? [];
    group.push(packet);
    grouped.set(packet.changeId, group);
  }

  const runsDir = path.join(path.resolve(studyDir), "comparator", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const batches: Array<{ artifactPath: string; batch: SavedComparatorBatch }> = [];
  for (const [changeId, changePackets] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = [...changePackets].sort((left, right) => {
      const leftKey = sha256(`${manifest.studyId}\0${left.caseId}`);
      const rightKey = sha256(`${manifest.studyId}\0${right.caseId}`);
      return leftKey.localeCompare(rightKey);
    });
    const parts = chunks(ordered, MAX_CASES_PER_BATCH);
    for (let index = 0; index < parts.length; index++) {
      const target = path.join(runsDir, `${changeId}-${String(index + 1).padStart(3, "0")}.json`);
      let batch: SavedComparatorBatch;
      if (fs.existsSync(target)) {
        batch = readJson<SavedComparatorBatch>(target);
        validateSavedBatch(batch, llm, parts[index]);
      } else {
        batch = await runBatch(llm, parts[index]);
        writeJsonExclusive(target, batch);
      }
      batches.push({
        artifactPath: path.relative(path.resolve(studyDir), target).replace(/\\/g, "/"),
        batch,
      });
    }
  }

  const predictions = batches
    .flatMap(({ batch }) => batch.predictions)
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  const expectedIds = packets.map((packet) => packet.caseId).sort();
  const actualIds = predictions.map((prediction) => prediction.caseId);
  if (stableJson(expectedIds) !== stableJson(actualIds)) {
    throw new Error("Comparator aggregate does not contain exactly one prediction per case.");
  }
  const resolvedModels = new Set(batches.map(({ batch }) => batch.model));
  if (resolvedModels.size > 1) {
    throw new Error(`Provider resolved multiple model versions during one study: ${[...resolvedModels].join(", ")}`);
  }
  const resolvedModel = [...resolvedModels][0] ?? llm.model;
  const inputTokens = batches.reduce((sum, { batch }) => sum + batch.inputTokens, 0);
  const outputTokens = batches.reduce((sum, { batch }) => sum + batch.outputTokens, 0);
  const result: ComparatorRun = {
    schemaVersion: FIELD_SCHEMA_VERSION,
    studyId: manifest.studyId,
    system: `${llm.provider}/${resolvedModel}`,
    provider: llm.provider,
    model: resolvedModel,
    requestedModel: llm.model,
    promptSha256: sha256(FIELD_COMPARATOR_SYSTEM_PROMPT),
    createdAt: new Date().toISOString(),
    inputTokens,
    outputTokens,
    pricing,
    estimatedCostUsd:
      (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) /
      1_000_000,
    durationMs: batches.reduce((sum, { batch }) => sum + batch.durationMs, 0),
    batches: batches.map(({ artifactPath, batch }) => ({
      artifactPath,
      artifactSha256: fileDigest(path.join(path.resolve(studyDir), artifactPath)).sha256,
      responseId: batch.responseId,
      batchInputSha256: batch.batchInputSha256,
      requestedModel: batch.requestedModel,
      model: batch.model,
      inputTokens: batch.inputTokens,
      outputTokens: batch.outputTokens,
      durationMs: batch.durationMs,
    })),
    predictions,
  };
  const target = path.join(path.resolve(studyDir), "comparator", "predictions.json");
  writeJsonExclusive(target, result);
  const serialized = stableJson(result);
  manifest.comparator = {
    system: result.system,
    model: result.model,
    requestedModel: result.requestedModel,
    promptSha256: result.promptSha256,
    predictionCount: predictions.length,
    predictionsSha256: sha256(serialized),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    pricing: result.pricing,
    estimatedCostUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
  };
  saveManifest(studyDir, manifest);
  recordAuditEvent(studyDir, "comparator_predictions_frozen", target);
  return result;
}
