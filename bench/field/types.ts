import type { ArthurReport, Finding } from "../../src/analysis/finding-schema.js";
import type { SourceLocation } from "../../src/analysis/registry.js";

export const FIELD_SCHEMA_VERSION = 1 as const;

export type StudyStatus = "collecting" | "comparing" | "frozen" | "adjudicating" | "complete";
export type ReferenceDomain = "imports" | "env" | "routes";
export type PredictionOutcome = "error" | "warning" | "clean";
export type ReviewLabel = "valid" | "actionable_invalid" | "ignored" | "uncertain";
export type ToolKind = "compiler" | "test" | "lint" | "other";

export interface ActivationRecord {
  protocolVersion: number;
  activationCommit: string;
  activatedAt: string;
  branch: string;
  protocolSha256: string;
  studyPlanSha256: string;
  checkerBuildSha256: string;
  checkerBuildInputs: string[];
}

export interface CohortRules {
  minimumIncludedChanges: number;
  minimumRepositories: number;
  maximumChangesPerRepository: number;
  allowedExclusionReasons: string[];
}

export interface DecisionRules {
  minimumIncrementalActionableDefects: number;
  minimumBlockingPrecision: number;
  maximumP95LatencyMs: number;
  minimumExternalDevelopersKeepingEnabled: number;
  allConditionsRequired: boolean;
  failureAction: string;
}

export interface CaptureIndexEntry {
  changeId: string;
  repositoryId: string;
  developerId: string;
  baseCommit: string;
  resultCommit: string;
  capturedAt: string;
  caseCount: number;
  blockingFindingCount: number;
  captureSha256: string;
}

export interface SelectionRecord {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  changeId: string;
  repositoryId: string;
  developerId: string;
  agentTool: string;
  agentEvidence: string;
  publicRepositoryUrl?: string;
  baseCommit: string;
  resultCommit: string;
  selectedAt: string;
  rawDiffSha256: string;
  caseInventorySha256: string;
  caseCount: number;
  relevantSourcePaths: string[];
  standardTools: ToolCommand[];
  noStandardToolsReason?: string;
  includedBeforeArthurPrediction: true;
}

export interface ExclusionRecord {
  candidateId: string;
  repositoryId: string;
  baseCommit?: string;
  resultCommit?: string;
  reason: string;
  note: string;
  recordedAt: string;
}

export interface StudyManifest {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  protocolVersion: number;
  studyId: string;
  status: StudyStatus;
  createdAt: string;
  activation: ActivationRecord;
  cohort: CohortRules;
  decisionRules: DecisionRules;
  captures: CaptureIndexEntry[];
  exclusions: ExclusionRecord[];
  comparator?: {
    system: string;
    model: string;
    requestedModel: string;
    promptSha256: string;
    predictionCount: number;
    predictionsSha256: string;
    inputTokens: number;
    outputTokens: number;
    pricing: ComparatorPricing;
    estimatedCostUsd: number;
    durationMs: number;
  };
  collectionClosedAt?: string;
  collectionLockSha256?: string;
  frozenAt?: string;
  lockSha256?: string;
  completedAt?: string;
}

export interface CodeContextLine {
  line: number;
  text: string;
  changed: boolean;
}

export interface ReferenceCase {
  caseId: string;
  changeId: string;
  repositoryId: string;
  domain: ReferenceDomain;
  target: string;
  raw: string;
  location: SourceLocation;
  context: CodeContextLine[];
  sourceSha256: string;
  inventoryMethods: string[];
}

export interface PackageContract {
  /** Ties workspace-scoped package facts to one blinded occurrence. */
  caseId?: string;
  packageName: string;
  sourcePath?: string;
  declaredVersion?: string;
  declarationManifestPath?: string;
  installed: boolean;
  installedManifest?: {
    name?: string;
    version?: string;
    exports?: unknown;
    main?: string;
    module?: string;
    types?: string;
    typings?: string;
  };
}

export interface GroundTruthContracts {
  packages: PackageContract[];
  env: {
    filesFound: string[];
    definedNames: string[];
  };
  routes: Array<{
    urlPath: string;
    filePath: string;
    methods: string[];
  }>;
}

export interface CasePrediction {
  caseId: string;
  outcome: PredictionOutcome;
  findingId?: string;
}

export interface ArthurCapture {
  system: "arthur";
  activationCommit: string;
  checkerBuildSha256: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  analysisDurationMs: number;
  durationMs: number;
  compiledBuildSha256: string;
  report: ArthurReport;
  predictions: CasePrediction[];
  unmatchedFindings: Finding[];
}

export interface ToolCommand {
  kind: ToolKind;
  name: string;
  command: string;
}

export interface ToolRun extends ToolCommand {
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  redactionCount: number;
  outputTruncated: boolean;
  executionError?: string;
}

export interface CaptureMetadata {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  changeId: string;
  repositoryId: string;
  developerId: string;
  agentTool: string;
  agentEvidence: string;
  publicRepositoryUrl?: string;
  baseCommit: string;
  resultCommit: string;
  capturedAt: string;
  rawDiffSha256: string;
  storedDiffSha256: string;
  diffRedactionCount: number;
  sourceRedactionCount: number;
  changedPaths: string[];
  relevantSourcePaths: string[];
  caseCount: number;
  worktreeCleanBefore: boolean;
  worktreeCleanAfter: boolean;
  noStandardToolsReason?: string;
  cliLatencyMeasured: boolean;
}

export interface ArtifactIndex {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
  aggregateSha256: string;
}

export interface ProjectArtifactBundle {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  files: Array<{
    path: string;
    rawSha256: string;
    storedSha256: string;
    bytes: number;
    encoding: "utf8" | "base64";
    content: string;
    redactionCount: number;
  }>;
}

export interface ReviewPacket {
  caseId: string;
  changeId: string;
  domain: ReferenceDomain;
  target: string;
  raw: string;
  location: SourceLocation;
  context: CodeContextLine[];
  contract: PackageContract | GroundTruthContracts["env"] | GroundTruthContracts["routes"];
  evidence: {
    repositoryId: string;
    publicRepositoryUrl?: string;
    baseCommit: string;
    resultCommit: string;
    diffSha256: string;
    sourceSha256: string;
    standardTools: Array<Pick<ToolRun, "kind" | "name" | "command">>;
    noStandardToolsReason?: string;
  };
}

export interface StandardToolEvidence {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  changes: Array<{
    changeId: string;
    repositoryId: string;
    noStandardToolsReason?: string;
    runs: ToolRun[];
  }>;
}

export interface ReviewSubmission {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  studyLockSha256: string;
  reviewerId: string;
  submittedAt: string;
  attestation: {
    didNotImplementEvaluatedCheckers: boolean;
    didNotSeeDetectorPredictions: boolean;
    reviewedIndependently: boolean;
  };
  labels: Array<{
    caseId: string;
    label: ReviewLabel;
    rationale: string;
    evidence?: string;
    caughtByStandardTools: boolean | null;
    caughtByToolNames: string[];
  }>;
}

export interface AdjudicationSubmission {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  studyLockSha256: string;
  adjudicatorId: string;
  submittedAt: string;
  attestation: {
    didNotImplementEvaluatedCheckers: boolean;
    didNotSeeDetectorPredictions: boolean;
  };
  decisions: Array<{
    caseId: string;
    label: Exclude<ReviewLabel, "uncertain">;
    rationale: string;
    caughtByStandardTools: boolean | null;
    caughtByToolNames: string[];
  }>;
}

export interface BaselineSubmission {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  studyLockSha256: string;
  assessorId: string;
  submittedAt: string;
  attestation: {
    didNotImplementEvaluatedCheckers: boolean;
    didNotSeeDetectorPredictions: boolean;
  };
  attributions: Array<{
    caseId: string;
    defectId: string;
    caughtByStandardTools: boolean;
    caughtByToolNames: string[];
    rationale: string;
  }>;
}

export interface RetentionDecision {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  developerId: string;
  externalToArthurImplementation: boolean;
  keepEnabled: boolean;
  recordedBeforeAggregateResults: boolean;
  recordedAt: string;
  note?: string;
}

export interface ComparatorPrediction {
  caseId: string;
  predictedInvalid: boolean;
  reason: string;
}

export interface ComparatorRun {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  system: string;
  provider: string;
  model: string;
  requestedModel: string;
  promptSha256: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  pricing: ComparatorPricing;
  estimatedCostUsd: number;
  durationMs: number;
  batches: Array<{
    artifactPath: string;
    artifactSha256: string;
    responseId: string;
    batchInputSha256: string;
    requestedModel: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }>;
  predictions: ComparatorPrediction[];
}

export interface ComparatorPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
}

export interface StudyLock {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  frozenAt: string;
  activationCommit: string;
  protocolSha256: string;
  studyPlanSha256: string;
  checkerBuildSha256: string;
  collectionLockSha256: string;
  captureIndexSha256: string;
  caseInventorySha256: string;
  arthurPredictionsSha256: string;
  comparatorRunSha256: string;
  comparatorPredictionsSha256: string;
  reviewPacketsSha256: string;
  standardToolEvidenceSha256: string;
}

export interface CollectionLock {
  schemaVersion: typeof FIELD_SCHEMA_VERSION;
  studyId: string;
  closedAt: string;
  captureIndexSha256: string;
  exclusionsSha256: string;
  caseIdsSha256: string;
  comparatorRequest: {
    provider: string;
    model: string;
    promptSha256: string;
    pricing: ComparatorPricing;
  };
}
