import fs from "node:fs";
import path from "node:path";
import { getAllFiles } from "../context/tree.js";

// --- Types ---

export interface SupabaseTable {
  name: string;
  columns: Map<string, string>; // column name → TS type
}

export interface SupabaseFunction {
  name: string;
  args: Map<string, string>; // arg name → TS type
  returnType: string;
}

export interface SupabaseSchema {
  tables: Map<string, SupabaseTable>;
  functions: Map<string, SupabaseFunction>;
  enums: Map<string, string[]>; // enum name → literal values
}

export interface SupabaseSchemaRef {
  raw: string;
  category: "table" | "column" | "function";
  tableName?: string;
  columnName?: string;
  functionName?: string;
  valid: boolean;
  hallucinationCategory?: "hallucinated-table" | "hallucinated-column" | "hallucinated-function";
  suggestion?: string;
}

export interface SupabaseSchemaAnalysis {
  totalRefs: number;
  checkedRefs: number;
  validRefs: number;
  hallucinations: SupabaseSchemaRef[];
  hallucinationRate: number;
  tablesIndexed: number;
  functionsIndexed: number;
  enumsIndexed: number;
  typesFilePath?: string;
  byCategory: {
    tables: { total: number; hallucinated: number };
    columns: { total: number; hallucinated: number };
    functions: { total: number; hallucinated: number };
  };
}

// --- Auto-detection ---

/** Find the Supabase generated types file by scanning for the Database type signature. */
export function findSupabaseTypesFile(projectDir: string): string | undefined {
  const allFiles = getAllFiles(projectDir);

  // Check common paths first for fast detection
  const commonPaths = [
    "lib/types/database.types.ts",
    "types/supabase.ts",
    "src/types/database.types.ts",
    "src/types/supabase.ts",
    "database.types.ts",
    "types/database.types.ts",
    "src/database.types.ts",
    "lib/database.types.ts",
    "src/lib/database.types.ts",
  ];

  for (const candidate of commonPaths) {
    if (allFiles.has(candidate)) {
      const fullPath = path.join(projectDir, candidate);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (isSupabaseTypesFile(content)) return candidate;
      } catch { /* skip */ }
    }
  }

  // Fall back to scanning all .ts files
  for (const filePath of allFiles) {
    if (!filePath.endsWith(".ts")) continue;
    // Skip node_modules, .next, dist, etc.
    if (/node_modules|\.next|dist|\.git/.test(filePath)) continue;

    const fullPath = path.join(projectDir, filePath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (isSupabaseTypesFile(content)) return filePath;
    } catch { /* skip */ }
  }

  return undefined;
}

/** Check if file content matches the Supabase generated types signature. */
function isSupabaseTypesFile(content: string): boolean {
  return /export\s+type\s+Database\s*=/.test(content) && /Tables:\s*\{/.test(content);
}

// --- Parser ---

/** Parse a Supabase generated types file into a SupabaseSchema. */
export function parseSupabaseSchema(filePath: string): SupabaseSchema {
  const content = fs.readFileSync(filePath, "utf-8");
  const tables = new Map<string, SupabaseTable>();
  const functions = new Map<string, SupabaseFunction>();
  const enums = new Map<string, string[]>();

  // Parse Tables — match: tableName: { Row: { col: type; ... } }
  // The generated format has each table as a key under Tables: { }
  const tablesSection = extractSection(content, "Tables");
  if (tablesSection) {
    parseTables(tablesSection, tables);
  }

  // Parse Functions — match: funcName: { Args: { ... }; Returns: ... }
  const functionsSection = extractSection(content, "Functions");
  if (functionsSection) {
    parseFunctions(functionsSection, functions);
  }

  // Parse Enums — match: enumName: "val1" | "val2" | ...
  const enumsSection = extractSection(content, "Enums");
  if (enumsSection) {
    parseEnums(enumsSection, enums);
  }

  return { tables, functions, enums };
}

/** Extract a top-level section (Tables, Functions, Enums) from the public schema. */
function extractSection(content: string, sectionName: string): string | undefined {
  // Find the section key at the right nesting level
  const regex = new RegExp(`\\b${sectionName}:\\s*\\{`);
  const match = regex.exec(content);
  if (!match) return undefined;

  // Find the matching closing brace
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }

  return content.slice(start, i - 1);
}

/** Parse table definitions from the Tables section content. */
function parseTables(section: string, tables: Map<string, SupabaseTable>): void {
  // Each table: tableName: { Row: { ... }, Insert: { ... }, Update: { ... }, ... }
  // We want the table name and the Row columns.
  // Match table name followed by its object block
  const tableRegex = /(\w+):\s*\{/g;
  let match;

  while ((match = tableRegex.exec(section)) !== null) {
    const tableName = match[0 + 1];
    // Skip internal keys like Row, Insert, Update, Relationships
    if (["Row", "Insert", "Update", "Relationships"].includes(tableName)) continue;

    const blockStart = match.index + match[0].length;
    const block = extractBraceBlock(section, blockStart);
    if (!block) continue;

    // Find the Row section within this table block
    const rowSection = extractSection(block, "Row");
    if (!rowSection) continue;

    const columns = parseFieldList(rowSection);
    tables.set(tableName, { name: tableName, columns });

    // Skip past this table's block to avoid matching inner keys
    tableRegex.lastIndex = blockStart + block.length;
  }
}

/** Parse function definitions from the Functions section content. */
function parseFunctions(section: string, functions: Map<string, SupabaseFunction>): void {
  const funcRegex = /(\w+):\s*\{/g;
  let match;

  while ((match = funcRegex.exec(section)) !== null) {
    const funcName = match[1];
    if (["Args", "Returns"].includes(funcName)) continue;

    const blockStart = match.index + match[0].length;
    const block = extractBraceBlock(section, blockStart);
    if (!block) continue;

    const args = new Map<string, string>();
    const argsSection = extractSection(block, "Args");
    if (argsSection) {
      for (const [k, v] of parseFieldList(argsSection)) {
        args.set(k, v);
      }
    }

    // Extract return type
    const returnMatch = block.match(/Returns:\s*([^\n;}{]+)/);
    const returnType = returnMatch ? returnMatch[1].trim() : "unknown";

    functions.set(funcName, { name: funcName, args, returnType });

    funcRegex.lastIndex = blockStart + block.length;
  }
}

/** Parse enum definitions from the Enums section content. */
function parseEnums(section: string, enums: Map<string, string[]>): void {
  // Each enum: enumName: "val1" | "val2" | "val3"
  const enumRegex = /(\w+):\s*([^\n]+)/g;
  let match;

  while ((match = enumRegex.exec(section)) !== null) {
    const enumName = match[1];
    const valuesStr = match[2];

    // Extract string literals from the union type
    const values: string[] = [];
    const litRegex = /["']([^"']+)["']/g;
    let litMatch;
    while ((litMatch = litRegex.exec(valuesStr)) !== null) {
      values.push(litMatch[1]);
    }

    if (values.length > 0) {
      enums.set(enumName, values);
    }
  }
}

/** Parse a field list like { name: type; age: number; } into a Map. */
function parseFieldList(section: string): Map<string, string> {
  const fields = new Map<string, string>();
  // Match: fieldName: type (terminated by ; or newline)
  const fieldRegex = /(\w+)\s*:\s*([^;\n]+)/g;
  let match;

  while ((match = fieldRegex.exec(section)) !== null) {
    const name = match[1];
    const type = match[2].trim();
    fields.set(name, type);
  }

  return fields;
}

/** Extract content within matching braces starting from a position (after opening brace). */
function extractBraceBlock(content: string, start: number): string | undefined {
  let depth = 1;
  let i = start;
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) return undefined;
  return content.slice(start, i - 1);
}

// --- Reference Extraction ---

interface RawSupabaseRef {
  raw: string;
  tableName?: string;
  columnName?: string;
  functionName?: string;
}

/**
 * Find the nearest .from('table') preceding a match position.
 * Only looks within the same "chain" — stops at blank lines, which indicate
 * a different query/code block. Returns undefined if no confident match.
 */
function findNearestFrom(planText: string, position: number): string | undefined {
  // Look back up to 500 chars but stop at blank lines (query boundary)
  const start = Math.max(0, position - 500);
  const beforeText = planText.slice(start, position);

  // Stop at the last blank line (two consecutive newlines = different query)
  const lastBlankLine = beforeText.lastIndexOf("\n\n");
  const searchText = lastBlankLine >= 0 ? beforeText.slice(lastBlankLine) : beforeText;

  // Find the last .from('X') in this chunk
  const fromMatch = searchText.match(/\.from\(\s*["'](\w+)["']\s*\)(?!.*\.from\()/);
  return fromMatch ? fromMatch[1] : undefined;
}

/** Extract Supabase table, column, and function references from plan text. */
export function extractSupabaseRefs(planText: string, schema: SupabaseSchema): RawSupabaseRef[] {
  const refs: RawSupabaseRef[] = [];
  const seen = new Set<string>();

  const add = (raw: string, opts: { tableName?: string; columnName?: string; functionName?: string }) => {
    const key = `${opts.tableName ?? ""}|${opts.columnName ?? ""}|${opts.functionName ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ raw, ...opts });
  };

  // --- .from('table_name') — table reference (high confidence) ---
  for (const m of planText.matchAll(/\.from\(\s*["'](\w+)["']\s*\)/g)) {
    add(m[0], { tableName: m[1] });
  }

  // --- .select('col1, col2, relation(nested_col)') — column references ---
  // Only extract columns when we can confidently attribute them to a table.
  for (const m of planText.matchAll(/\.select\(\s*["']([^"']+)["']\s*\)/g)) {
    const tableName = findNearestFrom(planText, m.index!);
    if (tableName) {
      parseSelectColumns(m[1], tableName, schema, add);
    }
    // No table found → skip column validation rather than guess wrong
  }

  // --- Filter methods: .eq('column', value), .neq(), .gt(), etc. ---
  const filterMethods = ["eq", "neq", "gt", "gte", "lt", "lte", "order", "is", "in", "like", "ilike", "match", "not", "filter"];
  const filterPattern = new RegExp(`\\.(${filterMethods.join("|")})\\(\\s*["'](\\w+)["']`, "g");

  for (const m of planText.matchAll(filterPattern)) {
    const columnName = m[2];
    const tableName = findNearestFrom(planText, m.index!);
    // Only validate column if we have a confident table attribution
    if (tableName) {
      add(m[0], { tableName, columnName });
    }
  }

  // --- .rpc('function_name') — function reference (high confidence) ---
  for (const m of planText.matchAll(/\.rpc\(\s*["'](\w+)["']\s*[,)]/g)) {
    add(m[0], { functionName: m[1] });
  }

  return refs;
}

/** Parse a Supabase .select() string into column references.
 *
 *  Handles:
 *  - Simple columns: "col1, col2"
 *  - Relation syntax: "relation(col1, col2)"
 *  - Aliased relations: "alias:relation(col1)"
 *  - Inner joins: "relation!inner(col1)"
 *  - Column aliases: "alias:col" — extracts "col" (the real column)
 *  - Wildcards: "*" — skipped
 */
function parseSelectColumns(
  selectStr: string,
  tableName: string,
  schema: SupabaseSchema,
  add: (raw: string, opts: { tableName?: string; columnName?: string }) => void,
): void {
  // Split on commas, respecting parentheses
  let depth = 0;
  let current = "";
  const parts: string[] = [];

  for (const ch of selectStr) {
    if (ch === "(") { depth++; current += ch; }
    else if (ch === ")") { depth--; current += ch; }
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    if (part === "*" || part === "") continue;

    // Relation syntax: "relation(cols)", "alias:relation(cols)", "relation!inner(cols)"
    // Strip optional alias prefix ("alias:") and join hint ("!inner", "!left")
    const relationMatch = part.match(/^(?:\w+:)?(\w+)(?:!\w+)?\((.+)\)$/);
    if (relationMatch) {
      const relationName = relationMatch[1];
      // Only validate relation as table if it exists in schema (avoids FP on aliases)
      if (schema.tables.has(relationName)) {
        add(`.select('...${relationName}...')`, { tableName: relationName });
        const nestedCols = relationMatch[2].split(",").map(c => c.trim()).filter(Boolean);
        for (const col of nestedCols) {
          // Strip alias prefix from nested cols too ("alias:col" → "col")
          const colName = col.includes(":") ? col.split(":").pop()! : col;
          if (/^\w+$/.test(colName)) {
            add(`.select('...${relationName}(${colName})...')`, { tableName: relationName, columnName: colName });
          }
        }
      }
      // Relation name not in schema → skip entirely (could be an alias, not a real table)
      continue;
    }

    // Column alias: "alias:real_column" → extract "real_column"
    const aliasMatch = part.match(/^\w+:(\w+)$/);
    if (aliasMatch) {
      add(`.select('...${aliasMatch[1]}...')`, { tableName, columnName: aliasMatch[1] });
      continue;
    }

    // Simple column name (bare identifier only)
    if (/^\w+$/.test(part)) {
      add(`.select('...${part}...')`, { tableName, columnName: part });
    }
    // Anything else (aggregates, casts, complex expressions) → skip
  }
}

// --- Fuzzy Suggestions ---

function suggestTable(hallucinated: string, schema: SupabaseSchema): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [name] of schema.tables) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return name;
    }
  }
  return undefined;
}

function suggestColumn(hallucinated: string, table: SupabaseTable): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [colName] of table.columns) {
    if (colName.toLowerCase().includes(lower) || lower.includes(colName.toLowerCase())) {
      return colName;
    }
  }
  return undefined;
}

function suggestFunction(hallucinated: string, schema: SupabaseSchema): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [name] of schema.functions) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return name;
    }
  }
  return undefined;
}

// --- Main Analysis ---

/** Analyze Supabase schema references in plan text against a project's generated types. */
export function analyzeSupabaseSchema(planText: string, projectDir: string): SupabaseSchemaAnalysis {
  const typesFile = findSupabaseTypesFile(projectDir);

  // No Supabase types file found
  if (!typesFile) {
    return {
      totalRefs: 0, checkedRefs: 0, validRefs: 0,
      hallucinations: [], hallucinationRate: 0,
      tablesIndexed: 0, functionsIndexed: 0, enumsIndexed: 0,
      byCategory: {
        tables: { total: 0, hallucinated: 0 },
        columns: { total: 0, hallucinated: 0 },
        functions: { total: 0, hallucinated: 0 },
      },
    };
  }

  const fullPath = path.join(projectDir, typesFile);
  const schema = parseSupabaseSchema(fullPath);

  if (schema.tables.size === 0) {
    return {
      totalRefs: 0, checkedRefs: 0, validRefs: 0,
      hallucinations: [], hallucinationRate: 0,
      tablesIndexed: 0, functionsIndexed: 0, enumsIndexed: 0,
      typesFilePath: typesFile,
      byCategory: {
        tables: { total: 0, hallucinated: 0 },
        columns: { total: 0, hallucinated: 0 },
        functions: { total: 0, hallucinated: 0 },
      },
    };
  }

  const rawRefs = extractSupabaseRefs(planText, schema);
  const results: SupabaseSchemaRef[] = [];

  for (const ref of rawRefs) {
    // Function reference
    if (ref.functionName) {
      if (schema.functions.has(ref.functionName)) {
        results.push({
          raw: ref.raw, category: "function", functionName: ref.functionName, valid: true,
        });
      } else {
        const suggestion = suggestFunction(ref.functionName, schema);
        results.push({
          raw: ref.raw, category: "function", functionName: ref.functionName,
          valid: false, hallucinationCategory: "hallucinated-function",
          suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
        });
      }
      continue;
    }

    // Table reference
    if (ref.tableName) {
      const table = schema.tables.get(ref.tableName);

      if (!table) {
        const suggestion = suggestTable(ref.tableName, schema);
        results.push({
          raw: ref.raw, category: "table", tableName: ref.tableName,
          valid: false, hallucinationCategory: "hallucinated-table",
          suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
        });
        continue;
      }

      // Table exists — if no column, it's a valid table ref
      if (!ref.columnName) {
        results.push({
          raw: ref.raw, category: "table", tableName: ref.tableName, valid: true,
        });
        continue;
      }

      // Check column
      if (table.columns.has(ref.columnName)) {
        results.push({
          raw: ref.raw, category: "column", tableName: ref.tableName,
          columnName: ref.columnName, valid: true,
        });
      } else {
        const suggestion = suggestColumn(ref.columnName, table);
        results.push({
          raw: ref.raw, category: "column", tableName: ref.tableName,
          columnName: ref.columnName, valid: false,
          hallucinationCategory: "hallucinated-column",
          suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
        });
      }
    }
  }

  // Deduplicate
  const seenKeys = new Set<string>();
  const deduped = results.filter((ref) => {
    const key = `${ref.raw}|${ref.category}|${ref.valid}|${ref.hallucinationCategory ?? ""}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const hallucinations = deduped.filter((r) => !r.valid);
  const totalRefs = deduped.length;
  const validRefs = deduped.filter((r) => r.valid).length;

  const tableRefs = deduped.filter((r) => r.category === "table");
  const columnRefs = deduped.filter((r) => r.category === "column");
  const functionRefs = deduped.filter((r) => r.category === "function");

  return {
    totalRefs,
    checkedRefs: totalRefs,
    validRefs,
    hallucinations,
    hallucinationRate: totalRefs > 0 ? hallucinations.length / totalRefs : 0,
    tablesIndexed: schema.tables.size,
    functionsIndexed: schema.functions.size,
    enumsIndexed: schema.enums.size,
    typesFilePath: typesFile,
    byCategory: {
      tables: {
        total: tableRefs.length,
        hallucinated: tableRefs.filter((r) => !r.valid).length,
      },
      columns: {
        total: columnRefs.length,
        hallucinated: columnRefs.filter((r) => !r.valid).length,
      },
      functions: {
        total: functionRefs.length,
        hallucinated: functionRefs.filter((r) => !r.valid).length,
      },
    },
  };
}
