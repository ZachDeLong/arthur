import fs from "node:fs";
import path from "node:path";
import { getAllFiles } from "../context/tree.js";

// --- Types ---

export interface TypeMember {
  name: string;
  kind: "property" | "method" | "enum-member";
}

export interface TypeDeclaration {
  name: string;
  kind: "interface" | "type" | "enum" | "class";
  members: Map<string, TypeMember>;
  sourceFile: string;
}

export interface TypeRef {
  raw: string;
  typeName: string;
  memberName?: string;
  valid: boolean;
  hallucinationCategory?: "hallucinated-type" | "hallucinated-member";
  suggestion?: string;
}

export interface TypeAnalysis {
  totalRefs: number;
  checkedRefs: number;
  validRefs: number;
  hallucinations: TypeRef[];
  hallucinationRate: number;
  skippedRefs: number;
  byCategory: {
    types: { total: number; hallucinated: number };
    members: { total: number; hallucinated: number };
  };
}

// --- Skip Set (builtins / globals) ---

const BUILTIN_TYPES = new Set([
  // TS primitives / wrappers
  "String", "Number", "Boolean", "Object", "Symbol", "BigInt", "Function",
  "Array", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "Promise", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array",
  "Float32Array", "Float64Array", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "Proxy", "Reflect", "JSON", "Math", "Intl", "Iterator", "AsyncIterator",
  // TS utility types
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract",
  "NonNullable", "ReturnType", "Parameters", "ConstructorParameters", "InstanceType",
  "ThisParameterType", "OmitThisParameter", "Awaited", "Uppercase", "Lowercase",
  "Capitalize", "Uncapitalize", "NoInfer", "Prettify",
  // DOM / Web API
  "Request", "Response", "Headers", "URL", "URLSearchParams",
  "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLFormElement",
  "HTMLButtonElement", "HTMLAnchorElement", "HTMLImageElement",
  "Element", "Node", "Document", "Window", "Event", "MouseEvent", "KeyboardEvent",
  "FormData", "Blob", "File", "FileReader", "AbortController", "AbortSignal",
  "ReadableStream", "WritableStream", "TransformStream",
  "WebSocket", "XMLHttpRequest", "FormEvent", "ChangeEvent",
  "MediaQueryList", "IntersectionObserver", "MutationObserver", "ResizeObserver",
  // React
  "React", "Component", "PureComponent", "JSX",
  "ReactNode", "ReactElement", "FC", "FunctionComponent",
  "Dispatch", "SetStateAction", "RefObject", "MutableRefObject",
  "ContextType", "PropsWithChildren", "PropsWithRef",
  "SyntheticEvent", "BaseSyntheticEvent",
  // Node.js
  "Buffer", "Stream", "EventEmitter", "Readable", "Writable", "Transform", "Duplex",
  "IncomingMessage", "ServerResponse", "Server",
  "ChildProcess", "Worker",
  // Framework types
  "NextRequest", "NextResponse", "NextPage", "GetServerSideProps", "GetStaticProps",
  "PrismaClient", "Prisma",
  "Express", "Router",
  // Testing
  "Mock", "SpyInstance",
  // Console
  "Console",
  // Iterables
  "Iterable", "AsyncIterable", "IterableIterator", "AsyncIterableIterator",
  "Generator", "AsyncGenerator",
  "PromiseLike",
]);

// Single-char generics
const GENERIC_SINGLE = /^[A-Z]$/;

// --- Declaration Parsing ---

/** Parse TypeScript declarations from file content. */
export function parseTypeDeclarations(content: string, sourceFile: string): TypeDeclaration[] {
  const declarations: TypeDeclaration[] = [];

  // Interfaces
  const interfaceRegex = /^(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w\s,<>]+)?\s*\{([\s\S]*?)^\}/gm;
  for (const match of content.matchAll(interfaceRegex)) {
    const name = match[1];
    const body = match[2];
    declarations.push({
      name,
      kind: "interface",
      members: parseObjectMembers(body),
      sourceFile,
    });
  }

  // Type object literals: type Foo = { ... }
  const typeObjRegex = /^(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=\s*\{([\s\S]*?)^\}/gm;
  for (const match of content.matchAll(typeObjRegex)) {
    const name = match[1];
    const body = match[2];
    declarations.push({
      name,
      kind: "type",
      members: parseObjectMembers(body),
      sourceFile,
    });
  }

  // Simple type aliases: type Foo = string | number (no object body)
  const simpleTypeRegex = /^(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=[^{]/gm;
  for (const match of content.matchAll(simpleTypeRegex)) {
    const name = match[1];
    // Don't duplicate if already found as object type
    if (!declarations.some(d => d.name === name)) {
      declarations.push({
        name,
        kind: "type",
        members: new Map(),
        sourceFile,
      });
    }
  }

  // Enums
  const enumRegex = /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of content.matchAll(enumRegex)) {
    const name = match[1];
    const body = match[2];
    declarations.push({
      name,
      kind: "enum",
      members: parseEnumMembers(body),
      sourceFile,
    });
  }

  // Classes
  const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)[\s\S]*?)?\s*\{([\s\S]*?)^\}/gm;
  for (const match of content.matchAll(classRegex)) {
    const name = match[1];
    const body = match[2];
    declarations.push({
      name,
      kind: "class",
      members: parseClassMembers(body),
      sourceFile,
    });
  }

  return declarations;
}

/** Parse members from interface/type object body. */
export function parseObjectMembers(body: string): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    // Method signature: methodName(...) or methodName<T>(...)
    const methodMatch = trimmed.match(/^(\w+)\??\s*[(<]/);
    if (methodMatch) {
      const name = methodMatch[1];
      if (!isKeyword(name)) {
        members.set(name, { name, kind: "method" });
        continue;
      }
    }

    // Property: name?: Type or readonly name: Type
    const propMatch = trimmed.match(/^(?:readonly\s+)?(\w+)\??\s*:/);
    if (propMatch) {
      const name = propMatch[1];
      members.set(name, { name, kind: "property" });
    }
  }
  return members;
}

/** Parse enum members from body. */
function parseEnumMembers(body: string): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    const match = trimmed.match(/^(\w+)(?:\s*=|\s*,|\s*$)/);
    if (match) {
      const name = match[1];
      members.set(name, { name, kind: "enum-member" });
    }
  }
  return members;
}

/** Parse class members from body. */
export function parseClassMembers(body: string): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    // Method: [modifiers] name(...) or name<T>(...)
    const methodMatch = trimmed.match(
      /^(?:(?:public|private|protected|static|abstract|async|override|readonly)\s+)*(\w+)\??\s*[(<]/,
    );
    if (methodMatch) {
      const name = methodMatch[1];
      if (!isKeyword(name) && name !== "constructor") {
        members.set(name, { name, kind: "method" });
        continue;
      }
    }

    // Property: [modifiers] name: Type
    const propMatch = trimmed.match(
      /^(?:(?:public|private|protected|static|abstract|override|readonly)\s+)*(\w+)\??\s*[:=]/,
    );
    if (propMatch) {
      const name = propMatch[1];
      if (!isKeyword(name) && name !== "constructor") {
        members.set(name, { name, kind: "property" });
      }
    }
  }
  return members;
}

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "return", "throw", "try", "catch", "finally", "new", "delete", "typeof",
  "void", "in", "of", "instanceof", "yield", "await", "import", "export",
  "default", "const", "let", "var", "function", "class", "extends", "super",
  "this", "constructor",
]);

function isKeyword(name: string): boolean {
  return KEYWORDS.has(name);
}

// --- Type Index ---

type TypeIndex = Map<string, TypeDeclaration>;

/** Build a type index from all .ts/.tsx files in the project. */
export function buildTypeIndex(projectDir: string): TypeIndex {
  const index: TypeIndex = new Map();
  const allFiles = getAllFiles(projectDir);

  for (const relPath of allFiles) {
    if (!relPath.endsWith(".ts") && !relPath.endsWith(".tsx")) continue;
    // Skip .d.ts files (ambient declarations — covered by import-checker for packages)
    if (relPath.endsWith(".d.ts")) continue;

    const fullPath = path.join(projectDir, relPath);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const declarations = parseTypeDeclarations(content, relPath);
    for (const decl of declarations) {
      // Last scanned wins for duplicate names (rare — would be a TS compile error)
      index.set(decl.name, decl);
    }
  }

  return index;
}

// --- Common Method Names (not type member access) ---

/** Method names on built-in objects (Array, Map, Set, Promise, etc.) that shouldn't
 *  be treated as type member accesses. Filters Items.map, Engagements.set, etc. */
const COMMON_METHODS = new Set([
  // Array
  "map", "filter", "reduce", "forEach", "find", "some", "every", "includes",
  "push", "pop", "shift", "unshift", "splice", "slice", "concat", "flat", "flatMap",
  "sort", "reverse", "fill", "at", "indexOf", "lastIndexOf", "findIndex",
  // Map / Set
  "get", "set", "has", "delete", "clear", "entries", "values", "keys",
  // Promise
  "then", "catch", "finally", "resolve", "reject",
  // Object
  "toString", "valueOf", "toJSON", "assign", "freeze",
  // Misc
  "from", "of", "isArray", "parse", "stringify",
  "log", "error", "warn", "info", "debug",
  "join", "split", "replace", "match", "search", "trim",
  "length", "size", "next", "return", "throw",
  "addEventListener", "removeEventListener",
  "createElement", "getElementById", "querySelector",
  "groupBy", "apply", "call", "bind",
]);

// --- Common PascalCase English Words (not types) ---

/** Words that appear PascalCase in markdown headings/prose but are never types.
 *  Keeps false positives from plan headings like "## 3. Create the API Route" */
const COMMON_WORDS = new Set([
  // Action verbs
  "Create", "Update", "Delete", "Get", "Set", "Add", "Remove", "Fetch",
  "Post", "Put", "Patch", "List", "Find", "Search", "Sort", "Filter",
  "Group", "Handle", "Process", "Parse", "Build", "Run", "Test", "Testing",
  "Check", "Validate", "Verify", "Init", "Setup", "Start", "Stop",
  "Deploy", "Install", "Enable", "Disable", "Configure", "Implement",
  "Migrate", "Refactor", "Move", "Copy", "Rename", "Extract", "Merge",
  "Integrate", "Define", "Register", "Mount", "Connect", "Initialize",
  // Descriptors / prose words
  "Top", "Bottom", "Left", "Right", "First", "Last", "Next", "Previous",
  "Current", "Default", "Aggregate", "Calculate", "Compute", "Total",
  "Average", "Each", "All", "Any", "Some", "None", "Every",
  "Step", "Phase", "Stage", "Level", "Section", "Overview",
  "Summary", "Details", "Description", "Implementation",
  "Note", "Todo", "Fix", "Bug", "Feature", "Issue",
  "This", "That", "Also", "Then", "Here", "There", "Where", "When",
]);

// --- Code Region Extraction ---

/** Extract code regions (fenced code blocks + inline backtick spans) from plan text. */
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

// --- "Create" Signal Detection ---

/** Check if the plan signals intent to create a new type (not referencing existing). */
function hasCreateSignal(typeName: string, planText: string): boolean {
  // Prose patterns: "create interface X", "define new type X", etc.
  const prosePatterns = [
    new RegExp(`create\\s+(?:a\\s+)?(?:new\\s+)?(?:interface|type|enum|class)\\s+\`?${typeName}\`?`, "i"),
    new RegExp(`define\\s+(?:a\\s+)?(?:new\\s+)?(?:interface|type|enum|class)\\s+\`?${typeName}\`?`, "i"),
    new RegExp(`add\\s+(?:a\\s+)?(?:new\\s+)?(?:interface|type|enum|class)\\s+\`?${typeName}\`?`, "i"),
    new RegExp(`new\\s+(?:interface|type|enum|class)\\s+\`?${typeName}\`?`, "i"),
  ];
  if (prosePatterns.some(p => p.test(planText))) return true;

  // Code block declarations: interface X {, type X =, enum X {, class X {
  // Catches prop types like DateRangeFilterProps defined inside planned code blocks
  const codePatterns = [
    new RegExp(`(?:export\\s+)?interface\\s+${typeName}\\s*(?:extends|\\{)`, "m"),
    new RegExp(`(?:export\\s+)?type\\s+${typeName}\\s*(?:<[^>]*>)?\\s*=`, "m"),
    new RegExp(`(?:export\\s+)?(?:const\\s+)?enum\\s+${typeName}\\s*\\{`, "m"),
    new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${typeName}\\s*(?:extends|implements|\\{)`, "m"),
    // Function component declarations: function TierBreakdown( or export default function X(
    new RegExp(`(?:export\\s+)?(?:default\\s+)?function\\s+${typeName}\\s*[(<]`, "m"),
    // Const component declarations: const TierBreakdown: FC = or const TierBreakdown = (
    new RegExp(`(?:export\\s+)?const\\s+${typeName}\\s*[:=]`, "m"),
  ];
  return codePatterns.some(p => p.test(planText));
}

// --- Type Reference Extraction ---

interface RawTypeRef {
  typeName: string;
  memberName?: string;
  raw: string;
}

/** Extract type references from code regions of plan text. */
export function extractTypeRefs(planText: string): RawTypeRef[] {
  const codeRegions = extractCodeRegions(planText);
  const codeText = codeRegions.join("\n");

  const refs: RawTypeRef[] = [];
  const seen = new Set<string>();

  const add = (typeName: string, memberName?: string, raw?: string) => {
    const key = memberName ? `${typeName}.${memberName}` : typeName;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ typeName, memberName, raw: raw ?? key });
  };

  // PascalCase pattern: starts with uppercase, at least 2 chars, must contain at least one lowercase
  // Filters all-caps acronyms like ISO, API, SQL that aren't type references
  const isPascalCase = (s: string) => /^[A-Z][a-zA-Z0-9]+$/.test(s) && /[a-z]/.test(s);

  // 1. Type annotations: `: TypeName` or `as TypeName`
  for (const match of codeText.matchAll(/(?::|\bas)\s+([A-Z]\w+)/g)) {
    const name = match[1];
    if (isPascalCase(name)) add(name);
  }

  // 2. Generic params: <TypeName> or <TypeName, TypeName2>
  for (const match of codeText.matchAll(/<([A-Z]\w+(?:\s*,\s*[A-Z]\w+)*)>/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim();
      if (isPascalCase(name)) add(name);
    }
  }

  // 3. Member access: TypeName.member (PascalCase.camelCase/lowercase)
  // Use \b to avoid matching mid-word (e.g., authorEngagements.set → "Engagements.set")
  for (const match of codeText.matchAll(/\b([A-Z]\w+)\.([a-z]\w*)/g)) {
    const typeName = match[1];
    const memberName = match[2];
    if (isPascalCase(typeName) && !COMMON_METHODS.has(memberName)) {
      add(typeName, memberName, `${typeName}.${memberName}`);
    }
  }

  // 4. Bracket access: TypeName['member']
  for (const match of codeText.matchAll(/([A-Z]\w+)\[['"](\w+)['"]\]/g)) {
    const typeName = match[1];
    const memberName = match[2];
    if (isPascalCase(typeName)) {
      add(typeName, memberName, `${typeName}['${memberName}']`);
    }
  }

  // 5. extends/implements clauses
  for (const match of codeText.matchAll(/(?:extends|implements)\s+([A-Z]\w+)/g)) {
    const name = match[1];
    if (isPascalCase(name)) add(name);
  }

  // 6. new ClassName(
  for (const match of codeText.matchAll(/new\s+([A-Z]\w+)\s*\(/g)) {
    const name = match[1];
    if (isPascalCase(name)) add(name);
  }

  return refs;
}

// --- Fuzzy Suggestions ---

/** Find the closest matching type name for a hallucinated one. */
function suggestTypeName(hallucinated: string, index: TypeIndex): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const name of index.keys()) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return name;
    }
  }
  return undefined;
}

/** Find the closest matching member name for a hallucinated one. */
function suggestMemberName(
  hallucinated: string,
  decl: TypeDeclaration,
): string | undefined {
  const lower = hallucinated.toLowerCase();
  for (const name of decl.members.keys()) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase())) {
      return name;
    }
  }
  return undefined;
}

// --- Main Analysis ---

/** Analyze TypeScript type references in plan text against a project's type index. */
export function analyzeTypes(planText: string, projectDir: string): TypeAnalysis {
  const index = buildTypeIndex(projectDir);

  // No .ts files — nothing to check
  if (index.size === 0) {
    return {
      totalRefs: 0,
      checkedRefs: 0,
      validRefs: 0,
      hallucinations: [],
      hallucinationRate: 0,
      skippedRefs: 0,
      byCategory: {
        types: { total: 0, hallucinated: 0 },
        members: { total: 0, hallucinated: 0 },
      },
    };
  }

  const rawRefs = extractTypeRefs(planText);
  const hallucinations: TypeRef[] = [];
  let skippedRefs = 0;
  let checkedRefs = 0;
  let validRefs = 0;
  let typesTotal = 0;
  let typesHallucinated = 0;
  let membersTotal = 0;
  let membersHallucinated = 0;

  for (const ref of rawRefs) {
    // Skip builtins, single-char generics, and common English words
    if (BUILTIN_TYPES.has(ref.typeName) || GENERIC_SINGLE.test(ref.typeName) || COMMON_WORDS.has(ref.typeName)) {
      skippedRefs++;
      continue;
    }

    // Skip types the plan intends to create
    if (hasCreateSignal(ref.typeName, planText)) {
      skippedRefs++;
      continue;
    }

    checkedRefs++;
    const decl = index.get(ref.typeName);

    if (!decl) {
      // Type name not found in project
      typesTotal++;
      typesHallucinated++;
      const suggestion = suggestTypeName(ref.typeName, index);
      hallucinations.push({
        raw: ref.raw,
        typeName: ref.typeName,
        memberName: ref.memberName,
        valid: false,
        hallucinationCategory: "hallucinated-type",
        suggestion,
      });
      continue;
    }

    // Type exists — check member if present
    typesTotal++;

    if (ref.memberName) {
      membersTotal++;

      if (decl.members.size === 0) {
        // Type has no indexed members (simple alias, intersection, etc.)
        // Can't validate member — count as valid to avoid false positives
        validRefs++;
        continue;
      }

      if (!decl.members.has(ref.memberName)) {
        membersHallucinated++;
        const suggestion = suggestMemberName(ref.memberName, decl);
        let memberHint = suggestion ? suggestion : undefined;
        // If no substring match and few members, list them all
        if (!memberHint && decl.members.size <= 8) {
          memberHint = `valid members: ${[...decl.members.keys()].join(", ")}`;
        }
        hallucinations.push({
          raw: ref.raw,
          typeName: ref.typeName,
          memberName: ref.memberName,
          valid: false,
          hallucinationCategory: "hallucinated-member",
          suggestion: memberHint,
        });
        continue;
      }
    }

    validRefs++;
  }

  const hallucinationRate = checkedRefs > 0 ? hallucinations.length / checkedRefs : 0;

  return {
    totalRefs: rawRefs.length,
    checkedRefs,
    validRefs,
    hallucinations,
    hallucinationRate,
    skippedRefs,
    byCategory: {
      types: { total: typesTotal, hallucinated: typesHallucinated },
      members: { total: membersTotal, hallucinated: membersHallucinated },
    },
  };
}
