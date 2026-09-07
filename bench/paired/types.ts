export type PairedCategory = "import" | "env" | "route";
export type PairedOutcome = "error" | "clean" | "ignored";

export interface PairedCase {
  id: string;
  category: PairedCategory;
  projectDir: string;
  filePath: string;
  source: string;
}
export interface PairedLabel {
  id: string;
  expected: PairedOutcome;
  basis: "artifact-valid" | "artifact-invalid" | "language-ignored";
  oracle: string;
}

export interface PairedManifest {
  benchmarkVersion: 1;
  seed: string;
  selectionProcedure: string;
  caseCount: number;
  categoryCounts: Record<PairedCategory, number>;
  sourceHashes: Record<string, string>;
  casesSha256: string;
  labelsSha256: string;
}

export interface PairedPrediction {
  id: string;
  outcome: PairedOutcome;
  reason: string;
}

export interface PredictionRun {
  system: string;
  corpusSha256: string;
  repetition: number;
  predictions: PairedPrediction[];
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}
