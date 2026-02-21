#!/usr/bin/env node

/**
 * Arthur MCP Server
 *
 * Exposes Arthur's static analysis and plan verification as MCP tools
 * for direct integration with Claude Code.
 *
 * Tools:
 *   check_paths            — deterministic path validation (no API key)
 *   check_schema           — deterministic Prisma schema validation (no API key)
 *   check_imports          — deterministic package import validation (no API key)
 *   check_env              — deterministic env variable validation (no API key)
 *   check_types            — deterministic TypeScript type validation (no API key)
 *   check_routes           — deterministic Next.js API route validation (no API key)
 *   check_sql_schema       — deterministic Drizzle/SQL schema validation (no API key)
 *   check_supabase_schema  — deterministic Supabase schema validation (no API key)
 *   check_all              — runs all deterministic checkers in one call (no API key)
 *   verify_plan            — full pipeline: static analysis + LLM review (requires ANTHROPIC_API_KEY)
 *   update_session_context — record decisions/insights to survive context compression
 *   get_session_context    — read back session context after compression
 *
 * Prisma schema auto-detected at prisma/schema.prisma (or schemaPath override).
 *
 * CRITICAL: No console.log() — stdout is reserved for JSON-RPC protocol.
 * Use console.error() for debug output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

import { analyzePaths, findClosestPaths, getDirectoryContext } from "../src/analysis/path-checker.js";
import { getAllFiles } from "../src/context/tree.js";
import {
  parseSchema,
  analyzeSchema,
  type SchemaAnalysis,
} from "../src/analysis/schema-checker.js";
import { analyzeImports } from "../src/analysis/import-checker.js";
import { analyzePackageApi } from "../src/analysis/package-api-checker.js";
import { analyzeEnv, parseEnvFiles } from "../src/analysis/env-checker.js";
import { analyzeTypes, buildTypeIndex } from "../src/analysis/type-checker.js";
import { analyzeApiRoutes, buildRouteIndex } from "../src/analysis/api-route-checker.js";
import { analyzeSqlSchema, buildSqlSchema } from "../src/analysis/sql-schema-checker.js";
import { analyzeSupabaseSchema, parseSupabaseSchema, findSupabaseTypesFile } from "../src/analysis/supabase-schema-checker.js";
import { formatStaticFindings } from "../src/analysis/formatter.js";
import { buildContext } from "../src/context/builder.js";
import { buildUserMessage, getSystemPrompt } from "../src/verifier/prompt.js";
import { streamVerification } from "../src/verifier/client.js";
import { loadConfig } from "../src/config/manager.js";
import { logCatch, buildCatchFindings } from "../src/logging/catches.js";

// Import registry + all checker registrations
import { getCheckers } from "../src/analysis/registry.js";
import { buildJsonReport } from "../src/analysis/finding-schema.js";
import "../src/analysis/checkers/index.js";

const server = new McpServer({
  name: "arthur",
  version: "0.1.0",
});

// --- check_paths ---

server.tool(
  "check_paths",
  "Check file paths referenced in a plan against the actual project tree. Catches hallucinated paths that don't exist. No API key required.",
  {
    planText: z.string().describe("The plan text to check for file path references"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzePaths(planText, projectDir);
      const lines: string[] = [];

      const checked = analysis.extractedPaths.length;
      const hallucinated = analysis.hallucinatedPaths.length;
      const intentionalNew = analysis.intentionalNewPaths.length;
      const valid = checked - hallucinated - intentionalNew;

      // Get actual files for ground truth context
      const actualFiles = getAllFiles(projectDir);

      lines.push(`## Path Analysis`);
      lines.push(``);
      lines.push(`**${checked}** paths checked — **${valid}** valid, **${hallucinated}** hallucinated, **${intentionalNew}** intentional new`);
      lines.push(`**${actualFiles.size}** total files indexed in project`);

      if (hallucinated > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Paths`);
        for (const p of analysis.hallucinatedPaths) {
          lines.push(`- \`${p}\` — **NOT FOUND**`);

          // Closest matches
          const closest = findClosestPaths(p, actualFiles);
          if (closest.length > 0) {
            lines.push(`  - Closest matches: ${closest.map(c => `\`${c}\``).join(", ")}`);
          }

          // Directory context — show what actually exists near the expected location
          const dirFiles = getDirectoryContext(p, actualFiles);
          if (dirFiles.length > 0) {
            const parentDir = p.substring(0, p.lastIndexOf("/"));
            lines.push(`  - Files in \`${parentDir}/\`: ${dirFiles.slice(0, 8).map(f => `\`${f}\``).join(", ")}${dirFiles.length > 8 ? ` (+${dirFiles.length - 8} more)` : ""}`);
          }
        }
      }

      if (intentionalNew > 0) {
        lines.push(``);
        lines.push(`### Intentional New Files`);
        for (const p of analysis.intentionalNewPaths) {
          lines.push(`- \`${p}\` — new file (CREATE signal found)`);
        }
      }

      if (analysis.validPaths.length > 0) {
        lines.push(``);
        lines.push(`### Valid Paths`);
        const show = analysis.validPaths.slice(0, 10);
        for (const p of show) {
          lines.push(`- \`${p}\` — exists`);
        }
        if (analysis.validPaths.length > 10) {
          lines.push(`- ... and ${analysis.validPaths.length - 10} more`);
        }
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_paths",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("paths", checked, hallucinated, analysis.hallucinatedPaths),
        totalChecked: checked,
        totalHallucinated: hallucinated,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_schema ---

server.tool(
  "check_schema",
  "Check Prisma schema references in a plan against a schema.prisma file. Catches hallucinated models, fields, methods, and relations. Auto-detects prisma/schema.prisma if schemaPath not provided. No API key required.",
  {
    planText: z.string().describe("The plan text to check for Prisma schema references"),
    projectDir: z.string().optional().describe("Absolute path to the project directory (for auto-detecting prisma/schema.prisma)"),
    schemaPath: z.string().optional().describe("Absolute path to the schema.prisma file (overrides auto-detection)"),
  },
  async ({ planText, projectDir, schemaPath }) => {
    try {
      const resolvedPath = schemaPath
        ?? (projectDir && fs.existsSync(path.join(projectDir, "prisma/schema.prisma"))
          ? path.join(projectDir, "prisma/schema.prisma")
          : undefined);

      if (!resolvedPath) {
        return {
          content: [{ type: "text", text: "No schema found. Provide schemaPath or projectDir with prisma/schema.prisma." }],
          isError: true,
        };
      }

      const schema = parseSchema(resolvedPath);
      const analysis = analyzeSchema(planText, schema);
      const lines: string[] = [];

      const { totalRefs, hallucinations, byCategory } = analysis;

      lines.push(`## Schema Analysis`);
      lines.push(``);
      lines.push(`**${totalRefs}** schema refs — **${totalRefs - hallucinations.length}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinations`);
        for (const h of hallucinations) {
          const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
          lines.push(`- \`${h.raw}\` — ${h.hallucinationCategory}${suggestion}`);

          // For hallucinated models, list all available models
          if (h.hallucinationCategory === "hallucinated-model") {
            const available = [...schema.accessorToModel.entries()]
              .map(([accessor, model]) => `\`${accessor}\` (${model})`)
              .join(", ");
            lines.push(`  - Available models: ${available}`);
          }

          // For hallucinated fields, list all fields on the target model
          if (h.hallucinationCategory === "hallucinated-field" && h.modelAccessor) {
            const modelName = schema.accessorToModel.get(h.modelAccessor);
            const model = modelName ? schema.models.get(modelName) : undefined;
            if (model) {
              const fields = [...model.fields.values()]
                .map(f => `\`${f.name}\` (${f.type}${f.isRelation ? ", relation" : ""})`)
                .join(", ");
              lines.push(`  - Fields on ${modelName}: ${fields}`);
            }
          }

          // For wrong relations, list available relation fields
          if (h.hallucinationCategory === "wrong-relation" && h.modelAccessor) {
            const modelName = schema.accessorToModel.get(h.modelAccessor);
            const model = modelName ? schema.models.get(modelName) : undefined;
            if (model) {
              const relations = [...model.fields.values()]
                .filter(f => f.isRelation)
                .map(f => `\`${f.name}\` → ${f.relationModel}`)
                .join(", ");
              lines.push(`  - Available relations on ${modelName}: ${relations || "none"}`);
            }
          }
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.models.total > 0) {
        parts.push(`${byCategory.models.total - byCategory.models.hallucinated}/${byCategory.models.total} models`);
      }
      if (byCategory.fields.total > 0) {
        parts.push(`${byCategory.fields.total - byCategory.fields.hallucinated}/${byCategory.fields.total} fields`);
      }
      if (byCategory.methods.total > 0) {
        parts.push(`${byCategory.methods.total - byCategory.methods.invalid}/${byCategory.methods.total} methods`);
      }
      if (byCategory.relations.total > 0) {
        parts.push(`${byCategory.relations.total - byCategory.relations.wrong}/${byCategory.relations.total} relations`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      // Always include schema summary as ground truth
      lines.push(``);
      lines.push(`### Schema Ground Truth`);
      for (const [modelName, model] of schema.models) {
        const fieldNames = [...model.fields.values()]
          .map(f => f.name + (f.isRelation ? ` → ${f.relationModel}` : ""))
          .join(", ");
        lines.push(`- **${modelName}** (accessor: \`${model.accessor}\`): ${fieldNames}`);
      }
      if (schema.enums.size > 0) {
        lines.push(`- **Enums:** ${[...schema.enums].join(", ")}`);
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_schema",
        projectDir: path.basename(projectDir ?? resolvedPath),
        findings: buildCatchFindings("schema", totalRefs, hallucinations.length, hallucinations.map(h => h.raw)),
        totalChecked: totalRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_imports ---

server.tool(
  "check_imports",
  "Check package imports referenced in a plan against the project's node_modules. Catches hallucinated packages and invalid subpath imports. No API key required.",
  {
    planText: z.string().describe("The plan text to check for import/require statements"),
    projectDir: z.string().describe("Absolute path to the project directory (must have node_modules)"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeImports(planText, projectDir);
      const lines: string[] = [];

      const { checkedImports, validImports, hallucinations, skippedImports } = analysis;

      lines.push(`## Import Analysis`);
      lines.push(``);
      lines.push(`**${checkedImports}** imports checked — **${validImports}** valid, **${hallucinations.length}** hallucinated, **${skippedImports}** skipped (relative/builtin)`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Imports`);
        for (const h of hallucinations) {
          const reason = h.reason === "package-not-found" ? "package not found" : "subpath not exported";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${reason}${suggestion}`);
        }

        // List installed packages as ground truth for package-not-found errors
        const hasPackageErrors = hallucinations.some(h => h.reason === "package-not-found");
        if (hasPackageErrors) {
          const pkgJsonPath = path.join(projectDir, "package.json");
          if (fs.existsSync(pkgJsonPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
              const deps = Object.keys(pkg.dependencies ?? {});
              const devDeps = Object.keys(pkg.devDependencies ?? {});
              lines.push(``);
              lines.push(`### Installed Packages`);
              if (deps.length > 0) lines.push(`- **dependencies:** ${deps.map(d => `\`${d}\``).join(", ")}`);
              if (devDeps.length > 0) lines.push(`- **devDependencies:** ${devDeps.map(d => `\`${d}\``).join(", ")}`);
            } catch { /* ignore parse errors */ }
          }
        }
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_imports",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("imports", checkedImports, hallucinations.length, hallucinations.map(h => h.raw)),
        totalChecked: checkedImports,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_env ---

server.tool(
  "check_env",
  "Check environment variable references in a plan against the project's .env* files. Catches hallucinated env var names. No API key required.",
  {
    planText: z.string().describe("The plan text to check for env variable references"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeEnv(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, skippedRefs, envFilesFound } = analysis;

      lines.push(`## Env Variable Analysis`);
      lines.push(``);

      if (envFilesFound.length === 0) {
        lines.push(`No .env* files found in project — nothing to check against.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${checkedRefs}** env vars checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated, **${skippedRefs}** skipped (runtime)`);
      lines.push(`Sources: ${envFilesFound.join(", ")}`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Env Variables`);
        for (const h of hallucinations) {
          const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
          lines.push(`- \`${h.varName}\` — not in env files${suggestion}`);
        }
      }

      // Always include all defined env vars as ground truth
      const { vars } = parseEnvFiles(projectDir);
      if (vars.size > 0) {
        lines.push(``);
        lines.push(`### Defined Env Variables`);
        lines.push([...vars].map(v => `\`${v}\``).join(", "));
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_env",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("env", checkedRefs, hallucinations.length, hallucinations.map(h => h.varName)),
        totalChecked: checkedRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_types ---

server.tool(
  "check_types",
  "Check TypeScript type references in a plan against the project's .ts/.tsx files. Catches hallucinated type names and member access. No API key required.",
  {
    planText: z.string().describe("The plan text to check for TypeScript type references"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeTypes(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, skippedRefs, byCategory } = analysis;

      lines.push(`## TypeScript Type Analysis`);
      lines.push(``);

      if (checkedRefs === 0 && skippedRefs === 0) {
        lines.push(`No type references found in plan text.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${checkedRefs}** types checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated, **${skippedRefs}** skipped (builtins)`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Types`);
        const typeIndex = buildTypeIndex(projectDir);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-type" ? "type not found" : "member not found";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

          // For hallucinated members, show available members on the type
          if (h.hallucinationCategory === "hallucinated-member" && h.typeName) {
            const decl = typeIndex.get(h.typeName);
            if (decl && decl.members.size > 0) {
              const members = [...decl.members.keys()].join("`, `");
              lines.push(`  - Members on ${h.typeName}: \`${members}\``);
            }
          }
        }

        // List project types as ground truth for type-not-found errors
        const hasTypeErrors = hallucinations.some(h => h.hallucinationCategory === "hallucinated-type");
        if (hasTypeErrors) {
          const index = buildTypeIndex(projectDir);
          if (index.size > 0) {
            lines.push(``);
            lines.push(`### Available Project Types`);
            const typesByFile = new Map<string, string[]>();
            for (const [name, decl] of index) {
              const existing = typesByFile.get(decl.sourceFile) ?? [];
              existing.push(`${name} (${decl.kind})`);
              typesByFile.set(decl.sourceFile, existing);
            }
            for (const [file, types] of typesByFile) {
              lines.push(`- \`${file}\`: ${types.join(", ")}`);
            }
          }
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.types.total > 0) {
        parts.push(`${byCategory.types.total - byCategory.types.hallucinated}/${byCategory.types.total} types`);
      }
      if (byCategory.members.total > 0) {
        parts.push(`${byCategory.members.total - byCategory.members.hallucinated}/${byCategory.members.total} members`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_types",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("types", checkedRefs, hallucinations.length, hallucinations.map(h => h.raw)),
        totalChecked: checkedRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_routes ---

server.tool(
  "check_routes",
  "Check API route references in a plan against the project's Next.js App Router route files. Catches hallucinated routes and invalid HTTP methods. No API key required.",
  {
    planText: z.string().describe("The plan text to check for API route references"),
    projectDir: z.string().describe("Absolute path to the project directory (must use Next.js App Router)"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeApiRoutes(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, routesIndexed } = analysis;

      lines.push(`## API Route Analysis`);
      lines.push(``);

      if (routesIndexed === 0) {
        lines.push(`No Next.js App Router route files found in project.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${routesIndexed}** routes indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Routes`);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-route" ? "route not found" : "method not allowed";
          const method = h.method ? `${h.method} ` : "";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${method}${h.urlPath}\` — ${category}${suggestion}`);
        }
      }

      // Always include all available routes as ground truth
      const routeIndex = buildRouteIndex(projectDir);
      if (routeIndex.size > 0) {
        lines.push(``);
        lines.push(`### Available Routes`);
        for (const [urlPath, route] of routeIndex) {
          const methods = route.methods.size > 0 ? [...route.methods].join(", ") : "no exports";
          lines.push(`- \`${urlPath}\` [${methods}] → \`${route.filePath}\``);
        }
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_routes",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("routes", checkedRefs, hallucinations.length, hallucinations.map(h => `${h.method ?? ""} ${h.urlPath}`.trim())),
        totalChecked: checkedRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_sql_schema ---

server.tool(
  "check_sql_schema",
  "Check SQL/Drizzle schema references in a plan against the project's Drizzle table definitions and SQL CREATE TABLE statements. Catches hallucinated table and column names. No API key required.",
  {
    planText: z.string().describe("The plan text to check for SQL/Drizzle schema references"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeSqlSchema(planText, projectDir);
      const sqlSchema = buildSqlSchema(projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, tablesIndexed, byCategory } = analysis;

      lines.push(`## SQL Schema Analysis`);
      lines.push(``);

      if (tablesIndexed === 0) {
        lines.push(`No Drizzle or SQL CREATE TABLE schemas found in project.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${tablesIndexed}** tables indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinations`);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-table" ? "table not found" : "column not found";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

          // For hallucinated tables, list all available tables
          if (h.hallucinationCategory === "hallucinated-table") {
            const tableNames = [...sqlSchema.tables.keys()].join("`, `");
            lines.push(`  - Available tables: \`${tableNames}\``);
          }

          // For hallucinated columns, list all columns on the target table
          if (h.hallucinationCategory === "hallucinated-column" && h.tableName) {
            const table = sqlSchema.tables.get(h.tableName)
              ?? sqlSchema.tables.get(sqlSchema.variableToTable.get(h.tableName) ?? "");
            if (table) {
              const cols = [...table.columns.entries()]
                .map(([name, type]) => `\`${name}\` (${type})`)
                .join(", ");
              lines.push(`  - Columns on ${table.name}: ${cols}`);
            }
          }
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.tables.total > 0) {
        parts.push(`${byCategory.tables.total - byCategory.tables.hallucinated}/${byCategory.tables.total} tables`);
      }
      if (byCategory.columns.total > 0) {
        parts.push(`${byCategory.columns.total - byCategory.columns.hallucinated}/${byCategory.columns.total} columns`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      // Always include schema ground truth
      lines.push(``);
      lines.push(`### SQL Schema Ground Truth`);
      for (const [tableName, table] of sqlSchema.tables) {
        const varNote = table.variableName ? ` (var: \`${table.variableName}\`)` : "";
        const cols = [...table.columns.entries()]
          .map(([name, type]) => `${name} (${type})`)
          .join(", ");
        lines.push(`- **${tableName}**${varNote} [${table.source}]: ${cols}`);
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_sql_schema",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("sqlSchema", checkedRefs, hallucinations.length, hallucinations.map(h => h.raw)),
        totalChecked: checkedRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_supabase_schema ---

server.tool(
  "check_supabase_schema",
  "Check Supabase table, column, and function references in a plan against the project's generated database.types.ts file. Catches hallucinated tables, columns, and RPC functions. Auto-detects the types file. No API key required.",
  {
    planText: z.string().describe("The plan text to check for Supabase references (.from(), .select(), .eq(), .rpc(), etc.)"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeSupabaseSchema(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, tablesIndexed, functionsIndexed, enumsIndexed, typesFilePath, byCategory } = analysis;

      lines.push(`## Supabase Schema Analysis`);
      lines.push(``);

      if (tablesIndexed === 0 && !typesFilePath) {
        lines.push(`No Supabase generated types file found in project.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**Source:** \`${typesFilePath}\``);
      lines.push(`**${tablesIndexed}** tables, **${functionsIndexed}** functions, **${enumsIndexed}** enums indexed`);
      lines.push(`**${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinations`);

        const fullPath = path.join(projectDir, typesFilePath!);
        const schema = parseSupabaseSchema(fullPath);

        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-table" ? "table not found"
            : h.hallucinationCategory === "hallucinated-column" ? "column not found"
            : "function not found";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

          if (h.hallucinationCategory === "hallucinated-table") {
            const tableNames = [...schema.tables.keys()].join("`, `");
            lines.push(`  - Available tables: \`${tableNames}\``);
          }

          if (h.hallucinationCategory === "hallucinated-column" && h.tableName) {
            const table = schema.tables.get(h.tableName);
            if (table) {
              const cols = [...table.columns.entries()]
                .map(([name, type]) => `\`${name}\` (${type})`)
                .join(", ");
              lines.push(`  - Columns on ${table.name}: ${cols}`);
            }
          }

          if (h.hallucinationCategory === "hallucinated-function") {
            const funcNames = [...schema.functions.keys()].join("`, `");
            if (funcNames) lines.push(`  - Available functions: \`${funcNames}\``);
          }
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.tables.total > 0) {
        parts.push(`${byCategory.tables.total - byCategory.tables.hallucinated}/${byCategory.tables.total} tables`);
      }
      if (byCategory.columns.total > 0) {
        parts.push(`${byCategory.columns.total - byCategory.columns.hallucinated}/${byCategory.columns.total} columns`);
      }
      if (byCategory.functions.total > 0) {
        parts.push(`${byCategory.functions.total - byCategory.functions.hallucinated}/${byCategory.functions.total} functions`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      // Always include schema ground truth
      if (typesFilePath) {
        const fullPath = path.join(projectDir, typesFilePath);
        const schema = parseSupabaseSchema(fullPath);

        lines.push(``);
        lines.push(`### Supabase Schema Ground Truth`);
        for (const [tableName, table] of schema.tables) {
          const cols = [...table.columns.entries()]
            .map(([name, type]) => `${name} (${type})`)
            .join(", ");
          lines.push(`- **${tableName}**: ${cols}`);
        }
        if (schema.functions.size > 0) {
          lines.push(``);
          lines.push(`**Functions:** ${[...schema.functions.keys()].map(f => `\`${f}\``).join(", ")}`);
        }
        if (schema.enums.size > 0) {
          lines.push(`**Enums:** ${[...schema.enums.entries()].map(([name, vals]) => `\`${name}\` (${vals.join(", ")})`).join(", ")}`);
        }
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_supabase_schema",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("supabaseSchema", checkedRefs, hallucinations.length, hallucinations.map(h => h.raw)),
        totalChecked: checkedRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_express_routes ---

server.tool(
  "check_express_routes",
  "Check Express/Fastify route references in a plan against the project's route definitions. Catches hallucinated routes and invalid HTTP methods. Auto-detects Express or Fastify from package.json. No API key required.",
  {
    planText: z.string().describe("The plan text to check for route references"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const { analyzeExpressRoutes, buildExpressRouteIndex } = await import("../src/analysis/express-route-checker.js");
      const analysis = analyzeExpressRoutes(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, routesIndexed, framework } = analysis;

      const frameworkLabel = framework === "both" ? "Express + Fastify"
        : framework === "fastify" ? "Fastify"
        : "Express";

      lines.push(`## ${frameworkLabel} Route Analysis`);
      lines.push(``);

      if (framework === "none") {
        lines.push(`No Express or Fastify dependency found in package.json.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (routesIndexed === 0) {
        lines.push(`${frameworkLabel} detected but no route definitions found in source files.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${routesIndexed}** routes indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Routes`);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-route" ? "route not found" : "method not allowed";
          const method = h.method ? `${h.method} ` : "";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${method}${h.urlPath}\` — ${category}${suggestion}`);
        }
      }

      // Always include full route table as ground truth
      const index = buildExpressRouteIndex(projectDir);
      if (index.size > 0) {
        lines.push(``);
        lines.push(`### Available Routes`);
        for (const [urlPath, routes] of index) {
          const methods = [...new Set(routes.map(r => r.method))].join(", ");
          const file = routes[0].filePath;
          lines.push(`- \`${urlPath}\` [${methods}] → \`${file}\``);
        }
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_express_routes",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("expressRoutes", checkedRefs, hallucinations.length, hallucinations.map(h => `${h.method ?? ""} ${h.urlPath}`.trim())),
        totalChecked: checkedRefs,
        totalHallucinated: hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_package_api ---

server.tool(
  "check_package_api",
  "Check package API usage in a plan against real .d.ts type definitions in node_modules. Catches hallucinated named imports (e.g., import { parseEmail } from 'zod') and hallucinated member access (e.g., z.isEmail()). Experimental. No API key required.",
  {
    planText: z.string().describe("The plan text to check for package API references (import statements and member access)"),
    projectDir: z.string().describe("Absolute path to the project directory (must have node_modules)"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzePackageApi(planText, projectDir);
      const lines: string[] = [];

      lines.push(`## Package API Analysis`);
      lines.push(``);

      if (!analysis.applicable) {
        lines.push(`No packages with type definitions found to validate against.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${analysis.checkedBindings}** named imports checked, **${analysis.checkedMembers}** member accesses checked — **${analysis.hallucinations.length}** hallucinated`);

      if (analysis.hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated API Usage`);
        for (const h of analysis.hallucinations) {
          const category = h.category === "hallucinated-named-import" ? "not exported" : "member not found";
          const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
          lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
          if (h.availableExports) {
            lines.push(`  - Available exports: ${h.availableExports}`);
          }
        }
      }

      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_package_api",
        projectDir: path.basename(projectDir),
        findings: buildCatchFindings("packageApi", analysis.checkedBindings + analysis.checkedMembers, analysis.hallucinations.length, analysis.hallucinations.map(h => h.raw)),
        totalChecked: analysis.checkedBindings + analysis.checkedMembers,
        totalHallucinated: analysis.hallucinations.length,
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_all (registry-driven) ---

server.tool(
  "check_all",
  "Run ALL deterministic checks against a plan in a single call: paths, Prisma schema, SQL/Drizzle schema, Supabase schema, imports, env vars, and API routes. Returns a comprehensive report with ground truth context for every finding. Auto-detects which checkers are relevant. No API key required. This is the recommended tool — use this instead of calling individual checkers.",
  {
    planText: z.string().describe("The plan text to verify against the project"),
    projectDir: z.string().describe("Absolute path to the project directory"),
    schemaPath: z.string().optional().describe("Absolute path to schema.prisma (auto-detected if omitted)"),
    format: z.enum(["text", "json"]).optional().default("text").describe("Output format: 'text' for markdown (default), 'json' for machine-readable ArthurReport"),
  },
  async ({ planText, projectDir, schemaPath, format }) => {
    try {
      const options: Record<string, string> = {};
      if (schemaPath) options.schemaPath = schemaPath;

      // Run all non-experimental checkers and collect results
      const checkerResults: { checker: import("../src/analysis/registry.js").CheckerDefinition; result: import("../src/analysis/registry.js").CheckerResult }[] = [];
      const catchFindings: Record<string, { checked: number; hallucinated: number; items: string[] } | null> = {};

      for (const checker of getCheckers()) {
        const result = checker.run(planText, projectDir, options);
        checkerResults.push({ checker, result });
        catchFindings[checker.catchKey] = result.applicable
          ? { checked: result.checked, hallucinated: result.hallucinated, items: result.catchItems }
          : null;
      }

      const totalChecked = checkerResults.reduce((sum, { result }) => sum + (result.applicable ? result.checked : 0), 0);
      const totalIssues = checkerResults.reduce((sum, { result }) => sum + (result.applicable ? result.hallucinated : 0), 0);

      // Log catches
      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_all",
        projectDir: path.basename(projectDir),
        findings: catchFindings,
        totalChecked,
        totalHallucinated: totalIssues,
      });

      // JSON output
      if (format === "json") {
        const report = buildJsonReport(checkerResults, projectDir);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      // Text (markdown) output — existing behavior
      const lines: string[] = [];
      lines.push(`# Arthur Verification Report`);
      lines.push(``);

      for (const { checker, result } of checkerResults) {
        if (result.applicable) {
          lines.push(...checker.formatForCheckAll(result, projectDir));
        }
      }

      // Summary
      lines.push(`---`);
      if (totalIssues === 0) {
        lines.push(`**All checks passed.** No hallucinated references found.`);
      } else {
        lines.push(`**${totalIssues} issue(s) found.** Fix the hallucinated references above using the ground truth provided.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- verify_plan ---

server.tool(
  "verify_plan",
  "Full plan verification: static analysis (paths, imports, env vars, types, API routes, SQL schemas + optional Prisma schema) followed by LLM review. Requires ANTHROPIC_API_KEY environment variable.",
  {
    planText: z.string().describe("The plan text to verify"),
    projectDir: z.string().describe("Absolute path to the project directory"),
    prompt: z.string().optional().describe("Original user request (for intent alignment checking)"),
    schemaPath: z.string().optional().describe("Absolute path to schema.prisma for Prisma schema validation"),
    model: z.string().optional().describe("Claude model to use (default: from config or claude-sonnet-4-5-20250929)"),
  },
  async ({ planText, projectDir, prompt, schemaPath, model }) => {
    try {
      // Load config for API key and model default
      const config = loadConfig(projectDir);
      const apiKey = config.apiKey;

      if (!apiKey) {
        return {
          content: [{
            type: "text",
            text: "Error: No API key found. Set the ANTHROPIC_API_KEY environment variable to use verify_plan. The check_paths and check_schema tools work without an API key.",
          }],
          isError: true,
        };
      }

      const resolvedModel = model ?? config.model;

      // 1. Build context
      const context = buildContext({
        projectDir,
        planText,
        prompt,
        tokenBudget: config.tokenBudget,
      });

      // 2. Run all checkers via registry
      const options: Record<string, string> = {};
      if (schemaPath) options.schemaPath = schemaPath;

      const results = new Map<string, import("../src/analysis/registry.js").CheckerResult>();
      for (const checker of getCheckers()) {
        results.set(checker.id, checker.run(planText, projectDir, options));
      }

      // 3. Format static findings for LLM context
      const staticFindings = formatStaticFindings(results);

      // 4. Build LLM prompt
      const systemPrompt = getSystemPrompt();
      const userMessage = buildUserMessage(context, staticFindings);

      // 5. Stream verification (collect full output)
      let fullText = "";
      await streamVerification({
        apiKey,
        model: resolvedModel,
        systemPrompt,
        userMessage,
        onText: (text) => { fullText += text; },
      });

      // 6. Assemble output: static findings + LLM review
      const outputParts: string[] = [];

      if (staticFindings) {
        outputParts.push(staticFindings);
        outputParts.push("---");
      }

      outputParts.push(`## LLM Verification (${resolvedModel})`);
      outputParts.push(``);
      outputParts.push(fullText);

      return { content: [{ type: "text", text: outputParts.join("\n\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- update_session_context ---

server.tool(
  "update_session_context",
  "Record a key decision, insight, or context from the current conversation to a session file. This survives context compression. Call this after meaningful exchanges — decisions made, directions killed, requirements clarified. Not every message, just turning points.",
  {
    projectDir: z.string().describe("Absolute path to the project directory (session file stored in .arthur/sessions/)"),
    entry: z.string().describe("The decision, insight, or context to record. Be concise but complete — this is what a fresh context will read to understand what happened."),
    category: z.enum(["decision", "insight", "requirement", "correction", "context"]).optional()
      .describe("Category of the entry (default: context)"),
  },
  async ({ projectDir, entry, category }) => {
    try {
      const sessionDir = path.join(projectDir, ".arthur", "sessions");
      fs.mkdirSync(sessionDir, { recursive: true });

      // One session file per day — append entries
      const today = new Date().toISOString().split("T")[0];
      const sessionFile = path.join(sessionDir, `${today}.md`);

      const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
      const cat = category ?? "context";
      const line = `- **[${timestamp}] [${cat}]** ${entry}\n`;

      // Create file with header if new
      if (!fs.existsSync(sessionFile)) {
        fs.writeFileSync(sessionFile, `# Session Context — ${today}\n\n`, "utf-8");
      }

      fs.appendFileSync(sessionFile, line, "utf-8");

      // Read back the full session for the response
      const content = fs.readFileSync(sessionFile, "utf-8");
      const entryCount = (content.match(/^- \*\*/gm) || []).length;

      return {
        content: [{
          type: "text",
          text: `Recorded. Session file: ${sessionFile} (${entryCount} entries today)`,
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- get_session_context ---

server.tool(
  "get_session_context",
  "Read the current session context file. Use this at the start of a conversation or after context compression to recover decisions and insights from earlier in the session.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    date: z.string().optional().describe("Date to read (YYYY-MM-DD format, default: today)"),
  },
  async ({ projectDir, date }) => {
    try {
      const targetDate = date ?? new Date().toISOString().split("T")[0];
      const sessionFile = path.join(projectDir, ".arthur", "sessions", `${targetDate}.md`);

      if (!fs.existsSync(sessionFile)) {
        return {
          content: [{
            type: "text",
            text: `No session context for ${targetDate}. Nothing has been recorded yet.`,
          }],
        };
      }

      const content = fs.readFileSync(sessionFile, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[arthur-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[arthur-mcp] Fatal error:", err);
  process.exit(1);
});
