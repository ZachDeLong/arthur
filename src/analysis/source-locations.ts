import type { DiffFile } from "../diff/resolver.js";
import type { SourceLocation } from "./registry.js";

export interface TextOccurrence {
  index: number;
  length: number;
}

export function positionAt(content: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const prefix = content.slice(0, safeOffset);
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    line: prefix.split("\n").length,
    column: safeOffset - lastNewline,
  };
}

export function occurrenceLocation(
  file: DiffFile,
  occurrence: TextOccurrence,
): SourceLocation {
  const start = positionAt(file.content, occurrence.index);
  const end = positionAt(file.content, occurrence.index + occurrence.length);
  return {
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

export function occurrenceTouchesChangedLines(
  file: DiffFile,
  occurrence: TextOccurrence,
): boolean {
  // Manually constructed DiffFiles from API consumers predate changed-line
  // metadata. Treat their full contents as changed for compatibility.
  if (file.changedLines === undefined) return true;
  if (file.changedLines.length === 0) return false;

  const start = positionAt(file.content, occurrence.index).line;
  const end = positionAt(file.content, occurrence.index + occurrence.length).line;
  return file.changedLines.some((line) => line >= start && line <= end);
}
