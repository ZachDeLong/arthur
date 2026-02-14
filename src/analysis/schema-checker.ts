import fs from "node:fs";

// --- Schema Parsing ---

export interface PrismaField {
  name: string;
  type: string;
  isRelation: boolean;
  relationModel?: string;
}

export interface PrismaModel {
  name: string;
  fields: Map<string, PrismaField>;
  accessor: string; // camelCase version for prisma.X
}

export interface PrismaSchema {
  models: Map<string, PrismaModel>;
  enums: Set<string>;
  accessorToModel: Map<string, string>; // accessor -> model name
}

/** Valid Prisma Client methods on a model delegate. */
const VALID_PRISMA_METHODS = new Set([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Convert PascalCase model name to camelCase accessor. */
function toAccessor(modelName: string): string {
  return modelName[0].toLowerCase() + modelName.slice(1);
}

/** Parse a schema.prisma file into structured data. */
export function parseSchema(schemaPath: string): PrismaSchema {
  const content = fs.readFileSync(schemaPath, "utf-8");
  const models = new Map<string, PrismaModel>();
  const enums = new Set<string>();
  const accessorToModel = new Map<string, string>();

  // Extract enums
  const enumRegex = /^enum\s+(\w+)\s*\{/gm;
  for (const match of content.matchAll(enumRegex)) {
    enums.add(match[1]);
  }

  // Extract models with their fields
  const modelRegex = /^model\s+(\w+)\s*\{([\s\S]*?)^}/gm;
  for (const match of content.matchAll(modelRegex)) {
    const modelName = match[1];
    const body = match[2];
    const fields = new Map<string, PrismaField>();

    // Parse fields (skip @@directives and blank lines)
    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("@@") || trimmed.startsWith("//")) {
        continue;
      }

      // Match field: name Type ...
      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?\??/);
      if (!fieldMatch) continue;

      const [, fieldName, fieldType] = fieldMatch;

      // Skip if it looks like a directive keyword
      if (["model", "enum", "generator", "datasource"].includes(fieldName)) {
        continue;
      }

      // Determine if it's a relation field
      const isRelation = models.has(fieldType) ||
        content.includes(`model ${fieldType}`) ||
        trimmed.includes("@relation");

      fields.set(fieldName, {
        name: fieldName,
        type: fieldType,
        isRelation: isRelation || trimmed.includes("@relation"),
        relationModel: (isRelation || trimmed.includes("@relation")) ? fieldType : undefined,
      });
    }

    const accessor = toAccessor(modelName);
    models.set(modelName, { name: modelName, fields, accessor });
    accessorToModel.set(accessor, modelName);
  }

  // Second pass: fix relation detection for forward references
  for (const model of models.values()) {
    for (const field of model.fields.values()) {
      if (!field.isRelation && models.has(field.type)) {
        field.isRelation = true;
        field.relationModel = field.type;
      }
    }
  }

  return { models, enums, accessorToModel };
}

// --- Plan Reference Extraction ---

export type HallucinationCategory =
  | "hallucinated-model"
  | "hallucinated-field"
  | "invalid-method"
  | "wrong-relation";

export interface SchemaRef {
  raw: string;
  category: "model" | "field" | "method" | "relation";
  modelAccessor?: string;
  fieldName?: string;
  methodName?: string;
  valid: boolean;
  hallucinationCategory?: HallucinationCategory;
  suggestion?: string;
}

export interface SchemaAnalysis {
  totalRefs: number;
  validRefs: number;
  hallucinations: SchemaRef[];
  hallucinationRate: number;
  byCategory: {
    models: { total: number; hallucinated: number };
    fields: { total: number; hallucinated: number };
    methods: { total: number; invalid: number };
    relations: { total: number; wrong: number };
  };
}

/**
 * Detect Prisma client variable names from code by looking for
 * X.Y.method() where method is a known Prisma method.
 * Handles plans that use `db.`, `client.`, `prismaClient.`, etc.
 */
function detectPrismaClientNames(codeText: string): Set<string> {
  const names = new Set<string>();
  const methodList = [...VALID_PRISMA_METHODS].join("|");
  const pattern = new RegExp(`(\\w+)\\.(\\w+)\\.(${methodList})\\b`, "g");
  for (const match of codeText.matchAll(pattern)) {
    names.add(match[1]);
  }
  // Always include 'prisma' as the default
  names.add("prisma");
  return names;
}

/** Build a regex that matches any detected client name followed by .accessor.method */
function buildAccessorRegex(clientNames: Set<string>): RegExp {
  const escaped = [...clientNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})\\.(\\w+)\\.(\\w+)`, "g");
}

/** Build a regex for findContextModel that matches any detected client name. */
function buildClientDotRegex(clientNames: Set<string>): RegExp {
  const escaped = [...clientNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})\\.(\\w+)\\.`, "g");
}

/** Extract code blocks and inline code spans from markdown text. */
function extractCodeRegions(text: string): string[] {
  const regions: string[] = [];

  // Fenced code blocks
  const fencedRegex = /```[\s\S]*?```/g;
  for (const match of text.matchAll(fencedRegex)) {
    regions.push(match[0]);
  }

  // Inline code spans
  const inlineRegex = /`([^`]+)`/g;
  for (const match of text.matchAll(inlineRegex)) {
    regions.push(match[1]);
  }

  return regions;
}

/** Find the closest valid accessor for a hallucinated one. */
function suggestAccessor(
  hallucinated: string,
  schema: PrismaSchema,
): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [accessor] of schema.accessorToModel) {
    if (accessor.toLowerCase().includes(lower) || lower.includes(accessor.toLowerCase())) {
      return accessor;
    }
  }
  return undefined;
}

/** Find the closest valid field name on a model. */
function suggestField(
  hallucinated: string,
  model: PrismaModel,
): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [fieldName] of model.fields) {
    const fieldLower = fieldName.toLowerCase();
    // Check common substitution patterns
    if (fieldLower.includes(lower) || lower.includes(fieldLower)) {
      return fieldName;
    }
  }
  return undefined;
}

/** Extract and classify all Prisma references from plan text. */
export function analyzeSchema(
  planText: string,
  schema: PrismaSchema,
): SchemaAnalysis {
  const refs: SchemaRef[] = [];
  const codeRegions = extractCodeRegions(planText);
  const codeText = codeRegions.join("\n");

  // Detect Prisma client variable names (prisma, db, client, etc.)
  const clientNames = detectPrismaClientNames(codeText);

  // 1. Extract client.model.method() references
  const accessorMethodRegex = buildAccessorRegex(clientNames);
  for (const match of codeText.matchAll(accessorMethodRegex)) {
    const [raw, accessor, method] = match;
    // Extract the client variable name from the raw match
    const clientVar = raw.slice(0, raw.indexOf("."));

    // Check model accessor
    if (!schema.accessorToModel.has(accessor)) {
      const suggestion = suggestAccessor(accessor, schema);
      refs.push({
        raw: `${clientVar}.${accessor}`,
        category: "model",
        modelAccessor: accessor,
        valid: false,
        hallucinationCategory: "hallucinated-model",
        suggestion: suggestion ? `${clientVar}.${suggestion}` : undefined,
      });
    } else {
      refs.push({
        raw: `${clientVar}.${accessor}`,
        category: "model",
        modelAccessor: accessor,
        valid: true,
      });
    }

    // Check method validity
    if (!VALID_PRISMA_METHODS.has(method)) {
      refs.push({
        raw: `.${method}`,
        category: "method",
        modelAccessor: accessor,
        methodName: method,
        valid: false,
        hallucinationCategory: "invalid-method",
      });
    } else {
      refs.push({
        raw: `.${method}`,
        category: "method",
        modelAccessor: accessor,
        methodName: method,
        valid: true,
      });
    }
  }

  // 2. Extract field references in query objects (where, orderBy, select, by, data)
  // Only extract top-level keys (depth 0) to avoid false positives from nested objects
  const queryBlockRegex = /(?:where|orderBy|select|by|data)\s*:\s*\{/g;
  for (const match of codeText.matchAll(queryBlockRegex)) {
    const blockStart = match.index! + match[0].length;
    const topLevelKeys = extractTopLevelKeys(codeText, blockStart);
    const contextModel = findContextModel(codeText, match.index!, schema, clientNames);

    if (!contextModel) continue;
    const model = schema.models.get(contextModel);
    if (!model) continue;

    for (const fieldName of topLevelKeys) {
      // Skip common non-field keys
      if (["true", "false", "null", "undefined", "desc", "asc", "not", "in", "gte", "lte", "gt", "lt", "contains", "startsWith", "endsWith", "equals", "mode", "some", "every", "none", "_count", "_sum", "_avg", "_min", "_max"].includes(fieldName)) {
        continue;
      }
      if (!model.fields.has(fieldName)) {
        // Skip if this key is a valid relation name (used for nested filtering)
        if (!isNestedRelationContext(fieldName, model)) {
          const suggestion = suggestField(fieldName, model);
          refs.push({
            raw: `${fieldName}`,
            category: "field",
            modelAccessor: toAccessor(contextModel),
            fieldName,
            valid: false,
            hallucinationCategory: "hallucinated-field",
            suggestion,
          });
        }
      } else {
        refs.push({
          raw: `${fieldName}`,
          category: "field",
          modelAccessor: toAccessor(contextModel),
          fieldName,
          valid: true,
        });
      }
    }
  }

  // 3. Extract include/relation references (top-level keys only)
  const includeRegex = /include\s*:\s*\{/g;
  for (const match of codeText.matchAll(includeRegex)) {
    const blockStart = match.index! + match[0].length;
    const topLevelKeys = extractTopLevelKeys(codeText, blockStart);
    const contextModel = findContextModel(codeText, match.index!, schema, clientNames);

    if (!contextModel) continue;
    const model = schema.models.get(contextModel);
    if (!model) continue;

    for (const relationName of topLevelKeys) {
      if (relationName === "_count") continue; // Special Prisma key

      const field = model.fields.get(relationName);
      if (!field) {
        const suggestion = findRelationSuggestion(relationName, model);
        refs.push({
          raw: `include: { ${relationName} }`,
          category: "relation",
          modelAccessor: toAccessor(contextModel),
          fieldName: relationName,
          valid: false,
          hallucinationCategory: "wrong-relation",
          suggestion,
        });
      } else if (!field.isRelation) {
        refs.push({
          raw: `include: { ${relationName} }`,
          category: "relation",
          modelAccessor: toAccessor(contextModel),
          fieldName: relationName,
          valid: false,
          hallucinationCategory: "wrong-relation",
          suggestion: `${relationName} is not a relation field`,
        });
      } else {
        refs.push({
          raw: `include: { ${relationName} }`,
          category: "relation",
          modelAccessor: toAccessor(contextModel),
          fieldName: relationName,
          valid: true,
        });
      }
    }
  }

  // Deduplicate refs by raw + category + valid
  const seen = new Set<string>();
  const deduped = refs.filter((ref) => {
    const key = `${ref.raw}|${ref.category}|${ref.valid}|${ref.hallucinationCategory ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hallucinations = deduped.filter((r) => !r.valid);
  const totalRefs = deduped.length;
  const validRefs = deduped.filter((r) => r.valid).length;

  const modelRefs = deduped.filter((r) => r.category === "model");
  const fieldRefs = deduped.filter((r) => r.category === "field");
  const methodRefs = deduped.filter((r) => r.category === "method");
  const relationRefs = deduped.filter((r) => r.category === "relation");

  return {
    totalRefs,
    validRefs,
    hallucinations,
    hallucinationRate: totalRefs > 0 ? hallucinations.length / totalRefs : 0,
    byCategory: {
      models: {
        total: modelRefs.length,
        hallucinated: modelRefs.filter((r) => !r.valid).length,
      },
      fields: {
        total: fieldRefs.length,
        hallucinated: fieldRefs.filter((r) => !r.valid).length,
      },
      methods: {
        total: methodRefs.length,
        invalid: methodRefs.filter((r) => !r.valid).length,
      },
      relations: {
        total: relationRefs.length,
        wrong: relationRefs.filter((r) => !r.valid).length,
      },
    },
  };
}

/**
 * Extract top-level object keys from a block starting after the opening `{`.
 * Tracks brace depth to only return keys at depth 0.
 */
function extractTopLevelKeys(text: string, startPos: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = startPos;
  let currentKey = "";
  let inKey = true;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
      inKey = false;
    } else if (ch === "}") {
      if (depth === 0) break; // End of our block
      depth--;
    } else if (depth === 0) {
      if (ch === ":" && inKey && currentKey.trim()) {
        keys.push(currentKey.trim());
        currentKey = "";
        inKey = false;
      } else if (ch === "," || ch === "\n") {
        currentKey = "";
        inKey = true;
      } else if (inKey && /\w/.test(ch)) {
        currentKey += ch;
      } else if (inKey && /\s/.test(ch) && currentKey) {
        // Space after key word — keep collecting until we see ':'
      } else if (inKey && !/\s/.test(ch)) {
        currentKey = "";
      }
    }
    i++;
  }

  return keys;
}

/**
 * Try to find which Prisma model is being queried near a given position.
 * Returns undefined if the position is inside a nested context (e.g., select inside include)
 * where we can't reliably determine the model.
 */
function findContextModel(
  codeText: string,
  position: number,
  schema: PrismaSchema,
  clientNames?: Set<string>,
): string | undefined {
  // Look backwards from position for the nearest client.X reference
  const preceding = codeText.slice(Math.max(0, position - 500), position);
  const clientDotRegex = clientNames
    ? buildClientDotRegex(clientNames)
    : /prisma\.(\w+)\./g;
  const matches = [...preceding.matchAll(clientDotRegex)];
  if (matches.length === 0) return undefined;

  const lastMatch = matches[matches.length - 1];
  const accessor = lastMatch[1];

  // Check if we're inside a nested context (e.g., select/where inside include)
  // by counting unmatched braces between the prisma.X call and our position
  const betweenText = preceding.slice(lastMatch.index! + lastMatch[0].length);
  let depth = 0;
  for (const ch of betweenText) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  // If depth > 1, we're nested inside a sub-object (like include: { author: { select: { HERE } } })
  // The top-level query args are at depth 1 (inside the findMany({ ... }))
  if (depth > 1) return undefined;

  const modelName = schema.accessorToModel.get(accessor);
  if (modelName) return modelName;

  // Accessor is hallucinated — fuzzy-match so field validation still runs
  const suggested = suggestAccessor(accessor, schema);
  return suggested ? schema.accessorToModel.get(suggested) : undefined;
}

/** Check if a field name is being used as a nested relation selector. */
function isNestedRelationContext(fieldName: string, model: PrismaModel): boolean {
  const field = model.fields.get(fieldName);
  return field?.isRelation ?? false;
}

/** Find a relation field suggestion for a wrong relation include. */
function findRelationSuggestion(
  hallucinated: string,
  model: PrismaModel,
): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const [fieldName, field] of model.fields) {
    if (!field.isRelation) continue;
    const fieldLower = fieldName.toLowerCase();
    if (fieldLower.includes(lower) || lower.includes(fieldLower)) {
      return fieldName;
    }
  }
  // Return the list of valid relation fields
  const relations = [...model.fields.values()]
    .filter((f) => f.isRelation)
    .map((f) => f.name);
  if (relations.length > 0) {
    return `valid relations: ${relations.join(", ")}`;
  }
  return undefined;
}
