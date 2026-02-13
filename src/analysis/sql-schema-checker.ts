import fs from "node:fs";
import path from "node:path";
import { getAllFiles } from "../context/tree.js";

// --- Types ---

export interface SqlTable {
  name: string;            // SQL table name: 'user_accounts'
  variableName?: string;   // Drizzle variable export: 'userAccounts'
  columns: Map<string, string>; // column name → type
  filePath: string;
  source: "drizzle" | "sql";
}

export interface SqlSchema {
  tables: Map<string, SqlTable>;         // SQL table name → table
  variableToTable: Map<string, string>;  // Drizzle variable → SQL table name
}

export interface SqlSchemaRef {
  raw: string;
  category: "table" | "column";
  tableName?: string;
  columnName?: string;
  valid: boolean;
  hallucinationCategory?: "hallucinated-table" | "hallucinated-column";
  suggestion?: string;
}

export interface SqlSchemaAnalysis {
  totalRefs: number;
  checkedRefs: number;
  validRefs: number;
  hallucinations: SqlSchemaRef[];
  hallucinationRate: number;
  tablesIndexed: number;
  byCategory: {
    tables: { total: number; hallucinated: number };
    columns: { total: number; hallucinated: number };
  };
}

// --- SQL Keywords Skip Set ---

const SQL_KEYWORDS = new Set([
  "from", "where", "select", "insert", "into", "update", "delete",
  "set", "values", "join", "inner", "outer", "left", "right", "cross",
  "on", "and", "or", "not", "in", "is", "null", "as", "order", "by",
  "group", "having", "limit", "offset", "union", "all", "distinct",
  "create", "table", "alter", "drop", "index", "primary", "key",
  "foreign", "references", "constraint", "unique", "check", "default",
  "cascade", "restrict", "exists", "between", "like", "case", "when",
  "then", "else", "end", "asc", "desc", "true", "false", "count",
  "sum", "avg", "min", "max", "if", "returning", "with", "recursive",
]);

// --- Parser 1: Drizzle ---

/** Extract tables from a Drizzle schema file. */
export function parseDrizzleSchema(content: string, filePath: string): SqlTable[] {
  const tables: SqlTable[] = [];

  // Match: export const X = pgTable("Y", { ... }) or mysqlTable or sqliteTable
  const tableRegex = /export\s+const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*["']([^"']+)["']\s*,/g;

  for (const match of content.matchAll(tableRegex)) {
    const variableName = match[1];
    const sqlName = match[2];
    const matchEnd = match.index! + match[0].length;

    // Extract the column object — find the matching closing of the object arg
    const columns = extractDrizzleColumns(content, matchEnd);

    tables.push({
      name: sqlName,
      variableName,
      columns,
      filePath,
      source: "drizzle",
    });
  }

  return tables;
}

/** Extract column names from a Drizzle table definition's column object. */
function extractDrizzleColumns(content: string, startPos: number): Map<string, string> {
  const columns = new Map<string, string>();

  // Find opening brace of column object
  let i = startPos;
  while (i < content.length && content[i] !== "{") {
    // If we hit a paren, it's a callback syntax (t) => ({...})
    if (content[i] === "(") {
      // Skip to arrow => and find the object
      while (i < content.length && content.slice(i, i + 2) !== "=>") i++;
      if (i >= content.length) return columns;
      i += 2; // skip =>
      // Skip whitespace and optional (
      while (i < content.length && /[\s(]/.test(content[i])) i++;
      break;
    }
    i++;
  }

  if (i >= content.length || content[i] !== "{") return columns;
  i++; // skip opening {

  // Extract top-level keys
  let depth = 0;
  let currentKey = "";
  let inKey = true;

  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") {
      depth++;
      inKey = false;
    } else if (ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      if (ch === ":" && inKey && currentKey.trim()) {
        const key = currentKey.trim();
        // Extract type from the value (e.g., serial('id'), text('name'))
        const typeMatch = content.slice(i + 1, i + 100).match(/^\s*(\w+)\s*\(/);
        const colType = typeMatch ? typeMatch[1] : "unknown";
        columns.set(key, colType);
        currentKey = "";
        inKey = false;
      } else if (ch === "," || ch === "\n") {
        currentKey = "";
        inKey = true;
      } else if (inKey && /\w/.test(ch)) {
        currentKey += ch;
      } else if (inKey && /\s/.test(ch) && currentKey) {
        // Space after key word — keep collecting
      } else if (inKey && !/\s/.test(ch)) {
        currentKey = "";
      }
    }
    i++;
  }

  return columns;
}

// --- Parser 2: Raw SQL ---

/** Extract tables from a SQL file containing CREATE TABLE statements. */
export function parseSqlSchema(content: string, filePath: string): SqlTable[] {
  const tables: SqlTable[] = [];

  // Match CREATE TABLE statements
  const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(/gi;

  for (const match of content.matchAll(createRegex)) {
    const tableName = match[1];
    const matchEnd = match.index! + match[0].length;

    const columns = extractSqlColumns(content, matchEnd);

    tables.push({
      name: tableName,
      columns,
      filePath,
      source: "sql",
    });
  }

  return tables;
}

/** Constraint-start keywords to skip when parsing SQL columns. */
const CONSTRAINT_KEYWORDS = new Set([
  "primary", "foreign", "unique", "check", "constraint", "index",
]);

/** Extract column definitions from a CREATE TABLE body. */
function extractSqlColumns(content: string, startPos: number): Map<string, string> {
  const columns = new Map<string, string>();

  // Find the matching closing paren
  let depth = 1;
  let i = startPos;
  while (i < content.length && depth > 0) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") depth--;
    i++;
  }

  const body = content.slice(startPos, i - 1);
  const lines = body.split(",");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Strip quotes from identifier
    const cleaned = trimmed.replace(/^["'`]/, "").replace(/["'`]/, "");

    // Extract first word as column name
    const firstWordMatch = cleaned.match(/^(\w+)\s+(\w+)/);
    if (!firstWordMatch) continue;

    const [, word1, word2] = firstWordMatch;

    // Skip constraint-only lines
    if (CONSTRAINT_KEYWORDS.has(word1.toLowerCase())) continue;

    columns.set(word1, word2);
  }

  return columns;
}

// --- Schema Building ---

/** Auto-detect and parse all Drizzle and SQL schema files in a project. */
export function buildSqlSchema(projectDir: string): SqlSchema {
  const allFiles = getAllFiles(projectDir);
  const tables = new Map<string, SqlTable>();
  const variableToTable = new Map<string, string>();

  for (const filePath of allFiles) {
    const fullPath = path.join(projectDir, filePath);

    // Drizzle schemas: .ts/.js files containing pgTable/mysqlTable/sqliteTable
    if (/\.(ts|js)$/.test(filePath)) {
      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      if (/(?:pgTable|mysqlTable|sqliteTable)\s*\(/.test(content)) {
        const parsed = parseDrizzleSchema(content, filePath);
        for (const table of parsed) {
          tables.set(table.name, table);
          if (table.variableName) {
            variableToTable.set(table.variableName, table.name);
          }
        }
      }
    }

    // SQL files with CREATE TABLE
    if (/\.sql$/.test(filePath)) {
      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      if (/CREATE\s+TABLE/i.test(content)) {
        const parsed = parseSqlSchema(content, filePath);
        for (const table of parsed) {
          // Drizzle takes precedence (has variable names + better typing)
          if (!tables.has(table.name)) {
            tables.set(table.name, table);
          }
        }
      }
    }
  }

  return { tables, variableToTable };
}

// --- Reference Extraction ---

interface RawSqlRef {
  raw: string;
  tableName: string;
  columnName?: string;
}

/** Extract SQL/Drizzle table and column references from plan text. */
export function extractSqlRefs(planText: string, schema: SqlSchema): RawSqlRef[] {
  const refs: RawSqlRef[] = [];
  const seen = new Set<string>();

  const add = (raw: string, tableName: string, columnName?: string) => {
    const key = `${tableName}|${columnName ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ raw, tableName, columnName });
  };

  // Build a set of all known table names and variable names for column extraction
  const knownTableNames = new Set<string>();
  for (const [sqlName] of schema.tables) {
    knownTableNames.add(sqlName);
  }
  for (const [varName] of schema.variableToTable) {
    knownTableNames.add(varName);
  }

  // --- Drizzle-style references ---

  // db.select().from(X) / db.insert(X) / db.update(X) / db.delete(X)
  for (const m of planText.matchAll(/db\.(?:select\(\)[^)]*\.from|insert|update|delete)\s*\(\s*(\w+)/g)) {
    const name = m[1];
    if (!SQL_KEYWORDS.has(name.toLowerCase())) {
      add(m[0], name);
    }
  }

  // db.query.X.findMany() / db.query.X.findFirst() etc.
  for (const m of planText.matchAll(/db\.query\.(\w+)\.\w+/g)) {
    const name = m[1];
    if (!SQL_KEYWORDS.has(name.toLowerCase())) {
      add(m[0], name);
    }
  }

  // Drizzle filter functions: eq(X.column, ...), and column refs in general
  // Match: tableName.columnName in code-like contexts
  for (const m of planText.matchAll(/\b(\w+)\.(\w+)\b/g)) {
    const [raw, obj, prop] = m;
    // Only match if obj is a known table/variable OR looks like it could be one
    // (not a common JS object like console, Math, process, etc.)
    if (knownTableNames.has(obj) || isTableCandidate(obj, schema)) {
      if (!SQL_KEYWORDS.has(prop.toLowerCase()) && !isCommonJsProp(prop)) {
        add(raw, obj, prop);
      }
    }
  }

  // --- SQL-style references ---

  // SELECT ... FROM X / INSERT INTO X / UPDATE X SET / DELETE FROM X
  for (const m of planText.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+["'`]?(\w+)["'`]?/gi)) {
    const name = m[1];
    if (!SQL_KEYWORDS.has(name.toLowerCase())) {
      add(m[0], name);
    }
  }

  // X.column in WHERE/ON/SET clauses (SQL style)
  for (const m of planText.matchAll(/\b(\w+)\.(\w+)\b/g)) {
    const [raw, table, col] = m;
    if (SQL_KEYWORDS.has(table.toLowerCase())) continue;
    if (SQL_KEYWORDS.has(col.toLowerCase())) continue;
    if (isCommonJsProp(col)) continue;

    // Only if the table part resolves to a known or candidate table
    if (resolveTable(table, schema)) {
      add(raw, table, col);
    }
  }

  return refs;
}

/** Common JS properties that shouldn't be treated as column refs. */
const JS_PROPS = new Set([
  "length", "prototype", "constructor", "name", "toString", "valueOf",
  "call", "apply", "bind", "map", "filter", "reduce", "forEach",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat",
  "join", "indexOf", "includes", "find", "findFirst", "findMany",
  "findUnique", "create", "createMany", "values", "keys", "entries",
  "then", "catch", "finally", "log", "error", "warn", "info",
  "env", "resolve", "reject", "parse", "stringify", "from",
  "select", "insert", "update", "delete", "query", "table",
]);

function isCommonJsProp(prop: string): boolean {
  return JS_PROPS.has(prop);
}

/** Check if a name could be a table reference (not a known JS global/lib). */
const JS_GLOBALS = new Set([
  "console", "Math", "JSON", "Date", "Array", "Object", "String",
  "Number", "Boolean", "Promise", "Map", "Set", "RegExp", "Error",
  "process", "require", "module", "exports", "global", "window",
  "document", "navigator", "fetch", "Response", "Request", "URL",
  "Buffer", "fs", "path", "os", "crypto", "http", "https",
  "import", "export", "const", "let", "var", "function", "class",
  "db", "prisma", "ctx", "req", "res", "app", "router", "next",
]);

function isTableCandidate(name: string, schema: SqlSchema): boolean {
  if (JS_GLOBALS.has(name)) return false;
  if (SQL_KEYWORDS.has(name.toLowerCase())) return false;
  // It's a candidate if it resolves to something in the schema
  return resolveTable(name, schema) !== undefined;
}

/** Resolve a name to a SqlTable by checking SQL names and Drizzle variable names. */
function resolveTable(name: string, schema: SqlSchema): SqlTable | undefined {
  // Direct SQL table name match
  if (schema.tables.has(name)) return schema.tables.get(name);

  // Drizzle variable name → SQL table name
  const sqlName = schema.variableToTable.get(name);
  if (sqlName) return schema.tables.get(sqlName);

  return undefined;
}

// --- Fuzzy Suggestions ---

/** Find closest table name for a hallucinated one. */
function suggestTable(hallucinated: string, schema: SqlSchema): string | undefined {
  const lower = hallucinated.toLowerCase();

  // Check SQL table names
  for (const [name] of schema.tables) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return name;
    }
  }

  // Check Drizzle variable names
  for (const [varName] of schema.variableToTable) {
    if (varName.toLowerCase().includes(lower) || lower.includes(varName.toLowerCase())) {
      return varName;
    }
  }

  return undefined;
}

/** Find closest column name on a table. */
function suggestColumn(hallucinated: string, table: SqlTable): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [colName] of table.columns) {
    if (colName.toLowerCase().includes(lower) || lower.includes(colName.toLowerCase())) {
      return colName;
    }
  }
  return undefined;
}

// --- Main Analysis ---

/** Analyze SQL/Drizzle schema references in plan text against a project's schemas. */
export function analyzeSqlSchema(planText: string, projectDir: string): SqlSchemaAnalysis {
  const schema = buildSqlSchema(projectDir);

  // No SQL/Drizzle schemas found — nothing to check against
  if (schema.tables.size === 0) {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      tablesIndexed: 0,
      byCategory: {
        tables: { total: 0, hallucinated: 0 },
        columns: { total: 0, hallucinated: 0 },
      },
    };
  }

  const rawRefs = extractSqlRefs(planText, schema);
  const results: SqlSchemaRef[] = [];

  for (const ref of rawRefs) {
    const table = resolveTable(ref.tableName, schema);

    if (!table) {
      // Table doesn't exist
      const suggestion = suggestTable(ref.tableName, schema);
      results.push({
        raw: ref.raw,
        category: "table",
        tableName: ref.tableName,
        valid: false,
        hallucinationCategory: "hallucinated-table",
        suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
      });
      continue;
    }

    // Table exists — if no column ref, it's a valid table ref
    if (!ref.columnName) {
      results.push({
        raw: ref.raw,
        category: "table",
        tableName: ref.tableName,
        valid: true,
      });
      continue;
    }

    // Check column
    if (table.columns.has(ref.columnName)) {
      results.push({
        raw: ref.raw,
        category: "column",
        tableName: ref.tableName,
        columnName: ref.columnName,
        valid: true,
      });
    } else {
      const suggestion = suggestColumn(ref.columnName, table);
      results.push({
        raw: ref.raw,
        category: "column",
        tableName: ref.tableName,
        columnName: ref.columnName,
        valid: false,
        hallucinationCategory: "hallucinated-column",
        suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
      });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = results.filter((ref) => {
    const key = `${ref.raw}|${ref.category}|${ref.valid}|${ref.hallucinationCategory ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hallucinations = deduped.filter((r) => !r.valid);
  const totalRefs = deduped.length;
  const validRefs = deduped.filter((r) => r.valid).length;

  const tableRefs = deduped.filter((r) => r.category === "table");
  const columnRefs = deduped.filter((r) => r.category === "column");

  return {
    totalRefs,
    checkedRefs: totalRefs,
    validRefs,
    hallucinations,
    hallucinationRate: totalRefs > 0 ? hallucinations.length / totalRefs : 0,
    tablesIndexed: schema.tables.size,
    byCategory: {
      tables: {
        total: tableRefs.length,
        hallucinated: tableRefs.filter((r) => !r.valid).length,
      },
      columns: {
        total: columnRefs.length,
        hallucinated: columnRefs.filter((r) => !r.valid).length,
      },
    },
  };
}
