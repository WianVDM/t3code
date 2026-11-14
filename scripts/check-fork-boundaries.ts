// @effect-diagnostics nodeBuiltinImport:off - reports violations through process.exitCode like check-changed.
// Advisory ++ fork-boundary checker (advisory until B12). Classifies every path
// this branch changes against the fork-inventory policy read from the trusted
// base commit, never from the head checkout, so a PR cannot approve its own
// new upstream implementation or policy. Any Git, JSON, or policy error fails
// closed. Local: `node scripts/check-fork-boundaries.ts [base-ref]`, defaulting
// to origin/main; stacked callers pass the immediate parent ref; CI passes the
// PR base sha or the push's before sha.
import ts from "typescript-legacy";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  FORK_INVENTORY_PATH,
  ForkInventory,
  parseNameStatusZ,
  validateForkInventory,
} from "./forkInventory.ts";

export const DEFAULT_BASE_REF = "origin/main";

const FULL_SHA = /^[0-9a-f]{40}$/;
const TS_FILE = /\.tsx?$/;

export type BoundaryChange = { readonly status: "A" | "D" | "M"; readonly path: string };

export type BoundaryVerdict =
  | "ALLOW_OWNED"
  | "ALLOW_INFRASTRUCTURE"
  | "ALLOW_THIN_SEAM"
  | "POLICY_CHANGED"
  | "UNCLASSIFIED"
  | "UPSTREAM_DELETION_TOUCHED"
  | "SEAM_NON_TS"
  | "SEAM_NOT_THIN"
  | "SEAM_DELETED"
  | "STALE_UPSTREAM_PATH";

export interface BoundaryFinding {
  readonly change: "A" | "D" | "M";
  readonly path: string;
  readonly verdict: BoundaryVerdict;
  readonly entry: string | undefined;
  readonly reason: string;
}

export const ALLOWED_VERDICTS: ReadonlySet<BoundaryVerdict> = new Set([
  "ALLOW_OWNED",
  "ALLOW_INFRASTRUCTURE",
  "ALLOW_THIN_SEAM",
]);

export const isViolation = (finding: BoundaryFinding): boolean =>
  !ALLOWED_VERDICTS.has(finding.verdict);

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

const git = Effect.fn("forkBoundaries.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdin: "ignore",
        env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => `fork-boundaries: failed to start git ${args.join(" ")}: ${String(cause)}`,
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) => `fork-boundaries: failed while reading git ${args.join(" ")}: ${String(cause)}`,
    ),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(
      `fork-boundaries: git ${args.join(" ")} exited with code ${exitCode}: ${stderr.trim()}`,
    );
  }
  return stdout;
}, Effect.scoped);

// --no-renames reports a rename as its old and new path; an R record is still
// flattened so a rename of an upstream path fails on both of its halves.
export function collectChanges(diffOutput: string, untrackedOutput: string): BoundaryChange[] {
  const changes: BoundaryChange[] = [];
  const seen = new Set<string>();
  const add = (status: "A" | "D" | "M", path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    changes.push({ status, path });
  };
  for (const record of parseNameStatusZ(diffOutput)) {
    if (record.status === "R") {
      add("D", record.upstreamPath ?? record.path);
      add("A", record.path);
    } else {
      add(record.status, record.path);
    }
  }
  for (const line of untrackedOutput.split("\n")) {
    const path = line.trim();
    if (path.length > 0) add("A", path);
  }
  return changes;
}

const UPPER_TAG = /^[A-Z]/;

const isMemberChain = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) || (ts.isPropertyAccessExpression(node) && isMemberChain(node.expression));

const isMountTag = (tag: ts.JsxTagNameExpression): boolean => {
  if (ts.isIdentifier(tag)) return UPPER_TAG.test(tag.text);
  if (ts.isPropertyAccessExpression(tag)) {
    return UPPER_TAG.test(tag.name.text) && isMemberChain(tag.expression);
  }
  return false;
};

const isLiteralExpression = (node: ts.Expression): boolean =>
  ts.isStringLiteral(node) ||
  ts.isNumericLiteral(node) ||
  ts.isBigIntLiteral(node) ||
  node.kind === ts.SyntaxKind.TrueKeyword ||
  node.kind === ts.SyntaxKind.FalseKeyword ||
  node.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand));

// Mount props stay declarative: literals, identifiers, member accesses, and
// nested mounts. Anything callable (arrows, calls, templates with
// substitutions, spreads) is logic and makes the element a non-mount.
const isAllowedPropExpression = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) ||
  (ts.isPropertyAccessExpression(node) && isMemberChain(node)) ||
  isLiteralExpression(node) ||
  isAllowedMount(node);

const isAllowedAttribute = (property: ts.JsxAttributeLike): boolean =>
  ts.isJsxAttribute(property) &&
  (property.initializer === undefined ||
    ts.isStringLiteral(property.initializer) ||
    isAllowedMount(property.initializer) ||
    (ts.isJsxExpression(property.initializer) &&
      property.initializer.expression !== undefined &&
      isAllowedPropExpression(property.initializer.expression)));

const isAllowedMountChild = (child: ts.JsxChild): boolean =>
  (ts.isJsxText(child) && child.text.trim().length === 0) ||
  isAllowedMount(child) ||
  (ts.isJsxExpression(child) && child.expression !== undefined && isAllowedMount(child.expression));

function isAllowedMount(node: ts.Node): boolean {
  if (ts.isJsxSelfClosingElement(node)) {
    return isMountTag(node.tagName) && node.attributes.properties.every(isAllowedAttribute);
  }
  if (ts.isJsxElement(node)) {
    const { tagName, attributes } = node.openingElement;
    return (
      isMountTag(tagName) &&
      attributes.properties.every(isAllowedAttribute) &&
      node.children.every(isAllowedMountChild)
    );
  }
  return false;
}

// Structural serialization: kinds and token texts only, so trivia, comments,
// formatting, and positions never distinguish two files. Imports and allowed
// mounts drop out; whitespace-only JSX text drops out so a mount can be
// inserted between existing children.
function serializeNode(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isImportDeclaration(node)) return undefined;
  if (isAllowedMount(node)) return undefined;
  if (ts.isJsxText(node) && node.text.trim().length === 0) return undefined;
  const parts: Array<string> = [];
  ts.forEachChild(node, (child) => {
    const serialized = serializeNode(child, source);
    if (serialized !== undefined) parts.push(serialized);
  });
  const text = node.getChildCount(source) === 0 ? node.getText(source) : undefined;
  return `${ts.SyntaxKind[node.kind]}${text === undefined ? "" : `[${text}]`}(${parts.join(",")})`;
}

const normalizedStatements = (source: ts.SourceFile): Array<string> =>
  source.statements
    .map((statement) => serializeNode(statement, source))
    .filter((serialized): serialized is string => serialized !== undefined);

const statementKind = (serialized: string): string => serialized.split(/[[ (]/)[0] ?? "unknown";

// A thin seam edit only adds, removes, or retunes imports and typed JSX
// mounts; every other statement must serialize identically. Returns the
// violation reason, or undefined when the edit is thin.
export function thinSeamViolation(
  path: string,
  baseText: string,
  headText: string,
): string | undefined {
  const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  // git show returns LF while a Windows working tree can hold CRLF; normalize
  // so line endings alone never make a seam edit look non-thin.
  const parse = (text: string) =>
    ts.createSourceFile(
      path,
      text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
  const base = normalizedStatements(parse(baseText));
  const head = normalizedStatements(parse(headText));
  const length = Math.max(base.length, head.length);
  for (let index = 0; index < length; index++) {
    if (base[index] !== head[index]) {
      const kind = statementKind(base[index] ?? head[index] ?? "");
      return `statement ${index + 1} (${kind}) changes code beyond imports and typed JSX mounts`;
    }
  }
  return undefined;
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const isSeamPath = (inventory: ForkInventory, path: string): boolean =>
  inventory.entries.some((entry) => entry.path === path && entry.category === "integration-seam");

// The seam files classifyChanges will send through thinSeamViolation; the
// Effect layer preloads their base and head texts into a map for this lookup.
export const seamAnalysisPaths = (
  inventory: ForkInventory,
  changes: ReadonlyArray<BoundaryChange>,
): Array<string> =>
  changes
    .filter(
      ({ status, path }) => status !== "D" && TS_FILE.test(path) && isSeamPath(inventory, path),
    )
    .map(({ path }) => path);

export function classifyChanges(
  inventory: ForkInventory,
  changes: ReadonlyArray<BoundaryChange>,
  analyzeThinSeam: (path: string) => string | undefined,
): BoundaryFinding[] {
  const infrastructure = new Set(inventory.boundaryInfrastructure);
  const ownedRoots = inventory.plusplusOwnedRoots.map((root) => `${root}/`);
  const entryByPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  const renamedFrom = new Map(
    inventory.entries.flatMap((entry) =>
      entry.change === "renamed" && entry.upstreamPath !== undefined
        ? ([[entry.upstreamPath, entry]] as const)
        : [],
    ),
  );
  const finding = (
    change: "A" | "D" | "M",
    path: string,
    verdict: BoundaryVerdict,
    entry: string | undefined,
    reason: string,
  ): BoundaryFinding => ({ change, path, verdict, entry, reason });

  const findings = changes.map(({ status: change, path }) => {
    if (path === FORK_INVENTORY_PATH) {
      return finding(
        change,
        path,
        "POLICY_CHANGED",
        undefined,
        "policy is only trusted from the base commit; a head-side policy edit grants nothing",
      );
    }
    if (infrastructure.has(path)) {
      return finding(
        change,
        path,
        "ALLOW_INFRASTRUCTURE",
        undefined,
        "listed in the base boundaryInfrastructure policy; selects full CI",
      );
    }
    const entry = entryByPath.get(path);
    if (entry?.category === "plusplus-owned" || ownedRoots.some((root) => path.startsWith(root))) {
      return finding(change, path, "ALLOW_OWNED", entry?.id, "++ owned path");
    }
    if (entry?.category === "integration-seam") {
      if (change === "D") {
        return finding(
          change,
          path,
          "SEAM_DELETED",
          entry.id,
          "a seam must stay present; deletion is not a thin edit",
        );
      }
      if (!TS_FILE.test(path)) {
        return finding(
          change,
          path,
          "SEAM_NON_TS",
          entry.id,
          "only TS/TSX seams may change, and only thinly",
        );
      }
      const violation = analyzeThinSeam(path);
      return violation === undefined
        ? finding(
            change,
            path,
            "ALLOW_THIN_SEAM",
            entry.id,
            "imports and typed JSX mounts only; remaining AST identical",
          )
        : finding(change, path, "SEAM_NOT_THIN", entry.id, violation);
    }
    const renamed = renamedFrom.get(path);
    if (renamed !== undefined) {
      return finding(
        change,
        path,
        "STALE_UPSTREAM_PATH",
        renamed.id,
        "the pre-rename path of a baseline rename must stay gone",
      );
    }
    if (entry !== undefined) {
      return finding(
        change,
        path,
        "UPSTREAM_DELETION_TOUCHED",
        entry.id,
        "a baseline upstream deletion must stay deleted",
      );
    }
    return finding(
      change,
      path,
      "UNCLASSIFIED",
      undefined,
      "no base policy entry or owned root covers this upstream path",
    );
  });
  return findings.sort(byPath);
}

export function renderReport(
  base: string,
  baseRef: string,
  forkPoint: string,
  findings: ReadonlyArray<BoundaryFinding>,
): string {
  const lines = [`fork-boundaries: base ${base} (${baseRef}), fork point ${forkPoint}`];
  for (const { change, verdict, path, entry, reason } of findings) {
    lines.push(`  ${change}  ${verdict.padEnd(25)} ${path}  [${entry ?? "-"}]  ${reason}`);
  }
  const violations = findings.filter(isViolation).length;
  lines.push(
    violations === 0
      ? `  ${findings.length} changed path(s), no violations`
      : `  ${violations} violation(s) across ${findings.length} changed path(s)`,
  );
  return lines.join("\n");
}

const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ForkInventory), {
  onExcessProperty: "error",
});

export interface BoundaryRun {
  readonly base: string;
  readonly forkPoint: string;
  readonly findings: BoundaryFinding[];
}

export const checkForkBoundaries = Effect.fn("forkBoundaries.check")(function* (
  cwd: string,
  baseRef: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const base = (yield* git(cwd, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).pipe(
    Effect.orElseSucceed(() => ""),
  )).trim();
  if (!FULL_SHA.test(base)) {
    return yield* Effect.fail(
      `fork-boundaries: cannot resolve base ref ${baseRef} to a commit; refusing to guess a policy`,
    );
  }
  const forkPoint = (yield* git(cwd, ["merge-base", base, "HEAD"]).pipe(
    Effect.orElseSucceed(() => ""),
  )).trim();
  if (!FULL_SHA.test(forkPoint)) {
    return yield* Effect.fail(
      `fork-boundaries: no merge base between ${baseRef} and HEAD; refusing to guess a policy`,
    );
  }

  const policyText = yield* git(cwd, ["show", `${base}:${FORK_INVENTORY_PATH}`]).pipe(
    Effect.mapError(
      (error) =>
        `fork-boundaries: cannot read the trusted policy ${FORK_INVENTORY_PATH} at base ${base}: ${error}`,
    ),
  );
  const inventory = yield* decodePolicy(policyText).pipe(
    Effect.mapError(
      (cause) =>
        `fork-boundaries: the trusted policy at base ${base} is not valid: ${String(cause)}`,
    ),
  );
  const issues = validateForkInventory(inventory);
  if (issues.length > 0) {
    return yield* Effect.fail(
      `fork-boundaries: the trusted policy at base ${base} fails validation:\n  ${issues.join("\n  ")}`,
    );
  }

  const diff = yield* git(cwd, ["diff", "--name-status", "--no-renames", "-z", forkPoint]);
  const untracked = yield* git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const changes = collectChanges(diff, untracked);

  const seamResults = new Map<string, string | undefined>();
  for (const seamPath of seamAnalysisPaths(inventory, changes)) {
    const baseText = Option.getOrUndefined(
      yield* Effect.option(git(cwd, ["show", `${forkPoint}:${seamPath}`])),
    );
    const headText = Option.getOrUndefined(
      yield* Effect.option(fs.readFileString(path.join(cwd, seamPath))),
    );
    seamResults.set(
      seamPath,
      baseText === undefined
        ? "cannot read this seam at the fork point; refusing to treat it as thin"
        : headText === undefined
          ? "cannot read the working-tree file; refusing to treat it as thin"
          : thinSeamViolation(seamPath, baseText, headText),
    );
  }

  const findings = classifyChanges(inventory, changes, (seamPath) =>
    seamResults.has(seamPath)
      ? seamResults.get(seamPath)
      : "no thin-seam analysis ran for this path; refusing to treat it as thin",
  );
  return { base, forkPoint, findings } satisfies BoundaryRun;
});

if (import.meta.main) {
  const baseRef = process.argv[2] ?? DEFAULT_BASE_REF;
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const run = yield* checkForkBoundaries(root, baseRef);
    yield* Console.log(renderReport(run.base, baseRef, run.forkPoint, run.findings));
    return !run.findings.some(isViolation);
  }).pipe(
    Effect.catch((message) => Console.error(message).pipe(Effect.as(false))),
    // exitCode, not a failed exit: runMain calls process.exit() on failure and
    // piped stdout is asynchronous, which would cut off the report.
    Effect.flatMap((ok) =>
      Effect.sync(() => {
        if (!ok) process.exitCode = 1;
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
