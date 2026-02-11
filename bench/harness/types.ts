/** Prompt definition from prompts.json */
export interface PromptDefinition {
  id: string;
  fixture: "fixture-a" | "fixture-b";
  task: string;
  systemContext: string;
  allowedNewPaths: string[];
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
  apiUsage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
  };
}
