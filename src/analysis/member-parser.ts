/**
 * Shared member-parsing utilities for extracting properties/methods from
 * TypeScript interface, class, and enum body text.
 *
 * Used by package-api-checker to validate member access on imported types.
 */

export interface TypeMember {
  name: string;
  kind: "property" | "method" | "enum-member";
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

/** Parse enum members from body. */
export function parseEnumMembers(body: string): Map<string, TypeMember> {
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
