import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config/schema.js";
import { getProjectConfigDir } from "../config/manager.js";

const MAX_SESSIONS = 3;

interface SessionEntry {
  timestamp: string;
  planSnippet: string;
  feedback: string;
}

function getSessionsDir(projectDir: string): string {
  const configDir = getProjectConfigDir(projectDir);
  const dir = path.join(configDir, SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionsFile(projectDir: string): string {
  return path.join(getSessionsDir(projectDir), "history.json");
}

function loadSessions(projectDir: string): SessionEntry[] {
  const filePath = getSessionsFile(projectDir);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionEntry[];
  } catch {
    return [];
  }
}

/** Save a verification session. Keeps only the last MAX_SESSIONS entries. */
export function saveSession(
  projectDir: string,
  planText: string,
  feedback: string,
): void {
  const sessions = loadSessions(projectDir);
  sessions.push({
    timestamp: new Date().toISOString(),
    planSnippet: planText.slice(0, 200),
    feedback,
  });

  // Keep only the last N
  while (sessions.length > MAX_SESSIONS) {
    sessions.shift();
  }

  const filePath = getSessionsFile(projectDir);
  fs.writeFileSync(filePath, JSON.stringify(sessions, null, 2) + "\n", "utf-8");
}

/** Load the most recent session feedback (if any). */
export function loadLastFeedback(projectDir: string): string | undefined {
  const sessions = loadSessions(projectDir);
  if (sessions.length === 0) return undefined;
  return sessions[sessions.length - 1].feedback;
}
