export interface CodeVerifierConfig {
  apiKey?: string;
  model: string;
  tokenBudget: number;
}

export const DEFAULT_CONFIG: CodeVerifierConfig = {
  model: "claude-sonnet-4-5-20250929",
  tokenBudget: 80_000,
};

export const GLOBAL_CONFIG_DIR = ".codeverifier";
export const GLOBAL_CONFIG_FILE = "config.json";
export const PROJECT_CONFIG_DIR = ".codeverifier";
export const PROJECT_CONFIG_FILE = "config.json";
export const SESSIONS_DIR = "sessions";
