/** Prompt definition from prompts.json */
export interface PromptDefinition {
  id: string;
  fixture: "fixture-a" | "fixture-b";
  task: string;
  systemContext: string;
  allowedNewPaths: string[];
}

// --- Tier 2: Intent Drift Detection ---

/** Categories of drift that can be injected into a plan. */
export type DriftCategory =
  | "scope-creep"
  | "feature-drift"
  | "wrong-abstraction"
  | "missing-requirement"
  | "wrong-problem"
  | "tech-mismatch";

/** Methods for injecting drift into a plan. */
export type DriftMethod = "append" | "replace" | "remove-and-replace";

/** Injection definition within a drift spec. */
export interface DriftInjection {
  method: DriftMethod;
  appendText?: string;
  searchPattern?: string;
  replaceText?: string;
}

/** Full drift spec (one entry in drift-specs.json). */
export interface DriftSpec {
  id: string;
  promptId: string;
  category: DriftCategory;
  severity: "major" | "minor";
  description: string;
  injection: DriftInjection;
  expectedSignals: string[];
}

/** Detection result for a single drift spec. */
export interface DriftDetection {
  specId: string;
  category: DriftCategory;
  injectionApplied: boolean;
  detected: boolean;
  method: "critical-callout" | "alignment-section" | "signal-match" | null;
  matchedSignals: string[];
}

/** Tier 2 result for a single prompt. */
export interface Tier2Result {
  promptId: string;
  fixture: string;
  detections: DriftDetection[];
  detectionRate: number;
}

/** Classification of an extracted file path */
export type PathClassification = "valid" | "intentionalNew" | "hallucinated";

/** Result of path analysis for a single run */
export interface PathAnalysis {
  extractedPaths: string[];
  validPaths: string[];
  intentionalNewPaths: string[];
  hallucinatedPaths: string[];
  hallucinationRate: number;
}

/** Detection result for a single hallucinated path */
export interface PathDetection {
  path: string;
  detected: boolean;
  method: "direct" | "sentiment" | "section" | null;
}

/** Tier 1 result for a single prompt run */
export interface Tier1Result {
  promptId: string;
  fixture: string;
  pathAnalysis: PathAnalysis;
  detections: PathDetection[];
  detectionRate: number;
}

/** Complete result for a single prompt run */
export interface BenchmarkRun {
  promptId: string;
  fixture: string;
  task: string;
  generatedPlan: string;
  verifierOutput: string;
  tier1: Tier1Result;
  tier2?: Tier2Result;
  driftVerifierOutputs?: Record<string, string>;
  apiUsage: ApiUsage;
  timestamp: string;
}

/** API usage tracking */
export interface ApiUsage {
  planInputTokens: number;
  planOutputTokens: number;
  verifyInputTokens: number;
  verifyOutputTokens: number;
}

// --- Tier 3: Real-World Refactoring Verification ---

/** Evaluation result for a single arm (vanilla or arthur-assisted). */
export interface Tier3EvaluationResult {
  arm: string;
  build: {
    pass: boolean;
    errors: string[];
  };
  appTsx: {
    originalLines: number;
    currentLines: number;
    reductionPct: number;
  };
  extractedFiles: {
    hooks: string[];
    components: string[];
    total: number;
  };
  hallucinatedImports: {
    count: number;
    paths: string[];
  };
  diffStats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  compositeScore: number;
}

/** Head-to-head comparison of vanilla vs arthur-assisted. */
export interface Tier3Comparison {
  vanilla: Tier3EvaluationResult;
  arthurAssisted: Tier3EvaluationResult;
  buildDelta: "both-pass" | "arthur-only" | "vanilla-only" | "both-fail";
  scoreDelta: number;
  fileCountDelta: number;
  reductionDelta: number;
  hallucinatedImportsDelta: number;
  verdict: string;
}

/** Manual qualitative assessment (filled in by hand). */
export interface Tier3Qualitative {
  codeReadability: { vanilla: number; arthurAssisted: number };
  separationOfConcerns: { vanilla: number; arthurAssisted: number };
  overallPreference: "vanilla" | "arthur-assisted" | "tie";
  notes: string;
}

/** Aggregated summary across all runs */
export interface BenchmarkSummary {
  tier1: {
    avgHallucinationRate: number;
    avgDetectionRate: number;
    perRun: Array<{
      promptId: string;
      hallucinationRate: number;
      detectionRate: number;
    }>;
  };
  tier2?: {
    avgDetectionRate: number;
    perCategory: Record<string, number>;
    perMethod: Record<string, number>;
    perSpec: Array<{
      specId: string;
      category: string;
      injectionApplied: boolean;
      detected: boolean;
      method: string | null;
    }>;
  };
  apiUsage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
  };
}
