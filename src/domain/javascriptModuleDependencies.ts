import * as t from "@babel/types";

import { analyzeParsedJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import type { ParsedJavaScriptSource } from "./javascriptSourceParser.js";

/** Module dependency syntax forms recognized from source without execution. */
export type ModuleDependencyKind = "static_import" | "dynamic_import" | "require";

/** One literal module dependency declared by source syntax. */
export interface ModuleDependency {
  readonly kind: ModuleDependencyKind;
  readonly specifier: string;
}

/** Literal dependencies of one parsed source and whether the scan saw the whole file. */
export interface ModuleDependencyScan {
  readonly dependencies: readonly ModuleDependency[];
  /**
   * False when the parser recovered from syntax errors: nodes after an
   * unrecoverable point are missing, so the dependency list is a subset.
   */
  readonly complete: boolean;
}

/** Recognize one module dependency with a literal specifier on a syntax node. */
export const moduleDependencyOf = (node: t.Node): ModuleDependency | null => {
  if (
    t.isImportDeclaration(node) ||
    t.isExportAllDeclaration(node) ||
    t.isExportNamedDeclaration(node)
  )
    return node.source === null || node.source === undefined
      ? null
      : { kind: "static_import", specifier: node.source.value };
  if (t.isImportExpression(node) && t.isStringLiteral(node.source))
    return { kind: "dynamic_import", specifier: node.source.value };
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee, { name: "require" }) &&
    t.isStringLiteral(node.arguments[0])
  )
    return { kind: "require", specifier: node.arguments[0].value };
  // `import x = require("m")` is only legal at module top level and always
  // refers to the host loader, so it needs no unbound-`require` check. The
  // `moduleReference` is an entity name for a local alias instead, which
  // declares no dependency.
  if (
    t.isTSImportEqualsDeclaration(node) &&
    t.isTSExternalModuleReference(node.moduleReference)
  )
    return {
      kind: "require",
      specifier: node.moduleReference.expression.value,
    };
  return null;
};

const unboundRequireLocations = (
  parsed: ParsedJavaScriptSource,
): ReadonlySet<string> =>
  new Set(
    analyzeParsedJavaScriptSemantics(parsed)
      .references.filter(
        ({ name, role, resolution }) =>
          name === "require" && role === "read" && resolution === "unbound",
      )
      .map(
        ({ location }) =>
          `${String(location.start.line)}:${String(location.start.column)}`,
      ),
  );

/**
 * Collect unique literal module dependencies in document order. A `require`
 * call counts only when `require` is unbound in the source, so bundler
 * wrappers that define their own `require` do not produce dependencies.
 * Dynamic specifiers built from expressions are not represented; callers
 * report them as unknown rather than guessing.
 */
export const scanModuleDependencies = (
  parsed: ParsedJavaScriptSource,
): ModuleDependencyScan => {
  const seen = new Set<string>();
  const dependencies: ModuleDependency[] = [];
  let unboundRequires: ReadonlySet<string> | undefined;
  t.traverseFast(parsed, (node) => {
    const dependency = moduleDependencyOf(node);
    if (dependency === null) return;
    if (dependency.kind === "require" && t.isCallExpression(node)) {
      unboundRequires ??= unboundRequireLocations(parsed);
      const location = node.callee.loc?.start;
      if (
        location === undefined ||
        !unboundRequires.has(
          `${String(location.line)}:${String(location.column)}`,
        )
      )
        return;
    }
    const key = `${dependency.kind}\0${dependency.specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    dependencies.push(dependency);
  });
  return { dependencies, complete: parsed.errors.length === 0 };
};
