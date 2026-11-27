// Step 5.1 — contracts §4 rule 1, checked on the source: every export of a "use server" file is a public endpoint,
// so each one must start with the role guard. Reads the files; needs no database.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const DIRS = ["app", "lib", "components", "db"];

/** Endpoints that are open on purpose, or that only hand the form values to a guarded action. */
const NO_GUARD: Record<string, string> = {
  "lib/actions/session.ts#login": "public (contracts §4)",
  "lib/actions/session.ts#logout": "public: ends the session of the cookie it is given",
  "app/login/actions.ts#loginAction": "form wrapper of login",
  "app/change-password/actions.ts#changePasswordAction": "form wrapper of changeOwnPassword, which has the guard",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const isDirective = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isExpressionStatement(node) &&
  ts.isStringLiteral(node.expression) &&
  node.expression.text === "use server";

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

// The whole first statement, nothing chained onto the call (a `.catch()` would switch the guard off).
const GUARD_FIRST = /^(const \w+ = )?await requireRole\([^()]*\);$/;

interface Endpoint {
  name: string; // "file#function"
  guarded: boolean;
}

function scan() {
  const endpoints: Endpoint[] = [];
  const problems: string[] = [];
  for (const path of DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))) {
    const file = relative(ROOT, path).replaceAll("\\", "/");
    const source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const isActionFile = isDirective(source.statements[0]);

    // An inline "use server" inside a function body would be an endpoint this test cannot see.
    const findInline = (node: ts.Node) => {
      if (isDirective(node) && node !== source.statements[0]) problems.push(`${file}: inline "use server"`);
      ts.forEachChild(node, findInline);
    };
    findInline(source);
    if (!isActionFile) continue;

    const local = new Map<string, ts.FunctionDeclaration>();
    for (const s of source.statements) if (ts.isFunctionDeclaration(s) && s.name) local.set(s.name.text, s);
    const startsWithGuard = (fn: ts.FunctionDeclaration) =>
      GUARD_FIRST.test(fn.body?.statements[0]?.getText(source) ?? "");

    for (const s of source.statements) {
      // `export { x }`, `export * from`, `export default x`: an endpoint whose body this test would not read.
      if (ts.isExportDeclaration(s) || ts.isExportAssignment(s)) {
        problems.push(`${file}: a re-export or default export`);
        continue;
      }
      if (!isExported(s)) continue;
      if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) continue;
      if (!ts.isFunctionDeclaration(s) || !s.name) {
        problems.push(`${file}: an export that is not a function declaration`);
        continue;
      }
      // Either the guard itself, or `return helper(...)` of a helper in the same file that starts with the guard.
      const first = s.body?.statements[0];
      // No `await` in the helper's arguments: nothing may run before the guard.
      const delegate =
        first &&
        ts.isReturnStatement(first) &&
        first.expression &&
        ts.isCallExpression(first.expression) &&
        !/\bawait\b/.test(first.getText(source))
          ? local.get(first.expression.expression.getText(source))
          : undefined;
      const guarded = startsWithGuard(s) || (delegate !== undefined && !isExported(delegate) && startsWithGuard(delegate));
      endpoints.push({ name: `${file}#${s.name.text}`, guarded });
    }
  }
  return { endpoints, problems };
}

describe("step 5.1: every server action starts with the role guard", () => {
  const { endpoints, problems } = scan();

  it("finds the action files", () => {
    expect(endpoints.length).toBeGreaterThan(60);
    expect(problems).toEqual([]);
  });

  it("each export starts with requireRole, except the listed open ones", () => {
    const unguarded = endpoints.filter((e) => !e.guarded).map((e) => e.name);
    expect(unguarded.sort()).toEqual(Object.keys(NO_GUARD).sort());
  });
});
