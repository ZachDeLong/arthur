import path from "node:path";
import * as ts from "typescript";

export interface PositionedOccurrence {
  index: number;
  length: number;
}

export interface ImportSourceOccurrence extends PositionedOccurrence {
  source: string;
}

export interface EnvSourceOccurrence extends PositionedOccurrence {
  varName: string;
  raw: string;
}

export interface RouteSourceOccurrence extends PositionedOccurrence {
  raw: string;
  urlPath: string;
  method?: string;
  changeIndex: number;
  changeLength: number;
}

function scriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function parse(filePath: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function stringPosition(node: ts.StringLiteralLike): PositionedOccurrence {
  return { index: node.getStart() + 1, length: node.text.length };
}

export function extractTypeScriptImports(filePath: string, content: string): ImportSourceOccurrence[] {
  const sourceFile = parse(filePath, content);
  const occurrences: ImportSourceOccurrence[] = [];
  const seen = new Set<string>();

  const add = (literal: ts.StringLiteralLike) => {
    const position = stringPosition(literal);
    const key = `${position.index}:${literal.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push({ source: literal.text, ...position });
  };

  walk(sourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier);
      return;
    }

    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const argument = node.arguments[0];
    if ((isRequire || isDynamicImport) && ts.isStringLiteralLike(argument)) add(argument);
  });

  return occurrences.sort((a, b) => a.index - b.index);
}

function expressionText(node: ts.Expression, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, "");
}

export function extractTypeScriptEnvRefs(filePath: string, content: string): EnvSourceOccurrence[] {
  const sourceFile = parse(filePath, content);
  const occurrences: EnvSourceOccurrence[] = [];
  const seen = new Set<string>();

  const add = (node: ts.Node, varName: string) => {
    const index = node.getStart(sourceFile);
    const raw = node.getText(sourceFile);
    const key = `${index}:${varName}`;
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push({ varName, raw, index, length: raw.length });
  };

  walk(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const owner = expressionText(node.expression, sourceFile);
      if (["process.env", "import.meta.env", "Bun.env"].includes(owner)) {
        add(node, node.name.text);
      }
      return;
    }

    if (ts.isElementAccessExpression(node)) {
      const owner = expressionText(node.expression, sourceFile);
      const varName = stringValue(node.argumentExpression);
      if (["process.env", "import.meta.env", "Bun.env"].includes(owner) && varName) {
        add(node, varName);
      }
      return;
    }

    if (ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && ["process.env", "import.meta.env", "Bun.env"].includes(
        expressionText(node.initializer, sourceFile),
      )) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken) continue;
        const key = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (key) add(element, key);
      }
      return;
    }

    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const owner = expressionText(node.expression, sourceFile);
    const varName = stringValue(node.arguments[0]);
    if (varName && ["Deno.env.get", "Bun.env.get"].includes(owner)) add(node, varName);
  });

  return occurrences.sort((a, b) => a.index - b.index);
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function methodFromFetchOptions(argument: ts.Expression | undefined): string | undefined {
  if (!argument) return "GET";
  if (!ts.isObjectLiteralExpression(argument)) return undefined;
  for (const property of argument.properties) {
    if (ts.isSpreadAssignment(property)) return undefined;
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name)?.toLowerCase() !== "method") continue;
    return stringValue(property.initializer)?.toUpperCase();
  }
  return "GET";
}

export function extractTypeScriptRouteRefs(filePath: string, content: string): RouteSourceOccurrence[] {
  const sourceFile = parse(filePath, content);
  const occurrences: RouteSourceOccurrence[] = [];

  const add = (literal: ts.StringLiteralLike, owner: ts.Node, method?: string) => {
    const urlPath = literal.text.split("?")[0].replace(/\/$/, "");
    if (!urlPath.startsWith("/api/")) return;
    const position = stringPosition(literal);
    occurrences.push({
      raw: `${method ? `${method} ` : ""}${urlPath}`,
      urlPath,
      method,
      ...position,
      changeIndex: owner.getStart(sourceFile),
      changeLength: owner.getWidth(sourceFile),
    });
  };

  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0];
      if (!ts.isStringLiteralLike(first)) return;

      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        add(first, node, methodFromFetchOptions(node.arguments[1]));
        return;
      }

      if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "axios") {
        const method = node.expression.name.text.toUpperCase();
        if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
          add(first, node, method);
        }
      }
      return;
    }

    if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "URL"
      && node.arguments?.length) {
      const first = node.arguments[0];
      if (ts.isStringLiteralLike(first)) add(first, node);
    }
  });

  return occurrences.sort((a, b) => a.index - b.index);
}
