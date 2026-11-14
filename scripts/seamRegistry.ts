// @effect-diagnostics nodeBuiltinImport:off - hashes with node:crypto and reports CLI failures through process.exitCode.
// The ++ seam registry (plusplus/seams.json): schemas, validation, anchor
// location, fingerprints, and the refresh shared by bootstrap and the sync
// flow. Rules live in plusplus/ARCHITECTURE.md. Anchors are only ever
// evaluated against upstream commits, never the fork tree.
// Local: `node scripts/seamRegistry.ts check` or `bootstrap [--upstream-ref <sha>]`.
import * as NodeCrypto from "node:crypto";

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

export const SEAM_REGISTRY_PATH = "plusplus/seams.json";
export const SYNC_HISTORY_PATH = "plusplus/sync-history.json";

const FEATURE_ID_PATTERN = /^[a-z0-9-]+$/;
const SEAM_ID_SUFFIX_PATTERN = /^[a-z0-9-]+$/;
const GLOB_OR_BACKSLASH_PATTERN = /[*?[\]\\]/;
const STRUCTURED_KEY_EXTENSION = /\.(json|ya?ml)$/;
const CONTEXT_LINES = 2;
const JSON_PRINT_WIDTH = 80;
const FINGERPRINT_HEX_LENGTH = 16;

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Fingerprint = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{16}$/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Delta = Schema.Tuple([Count, Count]);
export type Delta = typeof Delta.Type;

// Order matters: {symbol, text} must be tried before {text}.
export const SeamAnchor = Schema.Union([
  Schema.Struct({ symbol: Schema.String, text: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ key: Schema.String }),
  Schema.Struct({ file: Schema.Literal(true) }),
]);
export type SeamAnchor = typeof SeamAnchor.Type;

export const SeamMechanism = Schema.Literals([
  "hook",
  "mount",
  "config",
  "override",
  "swap",
  "generated",
]);
export type SeamMechanism = typeof SeamMechanism.Type;

export const Seam = Schema.Struct({
  id: Schema.String,
  feature: Schema.String,
  mechanism: SeamMechanism,
  anchor: SeamAnchor,
  reason: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
  fingerprint: Fingerprint,
});
export type Seam = typeof Seam.Type;

export const RegistryFile = Schema.Union([
  Schema.Struct({ delta: Delta, seams: Schema.NonEmptyArray(Seam) }),
  Schema.Struct({
    delta: Delta,
    legacy: Schema.Literal(true),
    reason: Schema.optionalKey(Schema.String),
  }),
]);
export type RegistryFile = typeof RegistryFile.Type;

export const Sibling = Schema.Struct({
  feature: Schema.String,
  upstream: Schema.String,
  plusplus: Schema.String,
  fingerprint: Fingerprint,
});
export type Sibling = typeof Sibling.Type;

export const SeamRegistry = Schema.Struct({
  version: Schema.Literal(1),
  upstreamRef: Sha,
  features: Schema.Record(
    Schema.String,
    Schema.Struct({ title: Schema.String, issue: Schema.optionalKey(Schema.Int) }),
  ),
  files: Schema.Record(Schema.String, RegistryFile),
  siblings: Schema.Array(Sibling),
});
export type SeamRegistry = typeof SeamRegistry.Type;

export const SyncHistory = Schema.Struct({
  version: Schema.Literal(1),
  syncs: Schema.Array(
    Schema.Struct({
      tag: Schema.String,
      upstreamRef: Schema.optionalKey(Sha),
      previousUpstreamRef: Schema.optionalKey(Sha),
      // Rows migrated from the retired inventory carry the merge commit instead.
      commit: Schema.optionalKey(Sha),
      conflicts: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          hunks: Schema.optionalKey(Count),
          features: Schema.Array(Schema.String),
        }),
      ),
      dropped: Schema.Array(Schema.String),
    }),
  ),
});
export type SyncHistory = typeof SyncHistory.Type;
export type SyncHistoryEntry = SyncHistory["syncs"][number];

export class SeamRegistryError extends Schema.TaggedError<SeamRegistryError>()(
  "SeamRegistryError",
  { message: Schema.String },
) {}

const decodeRegistryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SeamRegistry), {
  onExcessProperty: "error",
});
const decodeSyncHistoryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SyncHistory), {
  onExcessProperty: "error",
});

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function isNormalizedRepoFilePath(path: string): boolean {
  if (path.length === 0 || path.trim() !== path) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (GLOB_OR_BACKSLASH_PATTERN.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const isFileAnchor = (anchor: SeamAnchor): boolean => "file" in anchor;

function validateSeam(
  path: string,
  seam: Seam,
  features: SeamRegistry["features"],
  seenIds: Set<string>,
): Array<string> {
  const issues: Array<string> = [];
  const problem = (message: string) => issues.push(`${seam.id} (${path}): ${message}`);

  if (seenIds.has(seam.id)) problem("duplicate seam id");
  seenIds.add(seam.id);
  if (!(seam.feature in features)) problem(`unknown feature ${seam.feature}`);
  const prefix = `${seam.feature}.`;
  if (!seam.id.startsWith(prefix) || !SEAM_ID_SUFFIX_PATTERN.test(seam.id.slice(prefix.length))) {
    problem(`id must match ${seam.feature}.<a-z0-9-> `);
  }
  if (seam.mechanism === "override" && seam.reason === undefined) {
    problem("an override needs a reason");
  }
  if (seam.mechanism === "swap" && (seam.target === undefined || !isFileAnchor(seam.anchor))) {
    problem("a swap needs a target and a {file:true} anchor");
  }
  if (seam.mechanism === "generated" && !isFileAnchor(seam.anchor)) {
    problem("a generated seam needs a {file:true} anchor");
  }
  if (seam.target !== undefined && seam.mechanism !== "swap") {
    problem("only a swap carries a target");
  }
  if ("key" in seam.anchor && !STRUCTURED_KEY_EXTENSION.test(path)) {
    problem("key anchors only work on .json, .yml and .yaml files");
  }
  return issues;
}

export function validateSeamRegistry(registry: SeamRegistry): Array<string> {
  const issues: Array<string> = [];
  for (const id of Object.keys(registry.features)) {
    if (!FEATURE_ID_PATTERN.test(id)) issues.push(`feature ${id}: id must match [a-z0-9-]+`);
  }

  const paths = Object.keys(registry.files);
  if (paths.some((path, index) => index > 0 && compareText(paths[index - 1]!, path) >= 0)) {
    issues.push("files keys must be unique and sorted");
  }
  const seenIds = new Set<string>();
  for (const [path, entry] of Object.entries(registry.files)) {
    if (!isNormalizedRepoFilePath(path)) {
      issues.push(`${path}: not a normalized repo-relative file path`);
    }
    if ("legacy" in entry) continue;
    for (const seam of entry.seams) {
      issues.push(...validateSeam(path, seam, registry.features, seenIds));
    }
  }

  for (const sibling of registry.siblings) {
    const label = `sibling ${sibling.upstream}`;
    if (!(sibling.feature in registry.features)) {
      issues.push(`${label}: unknown feature ${sibling.feature}`);
    }
    for (const path of [sibling.upstream, sibling.plusplus]) {
      if (!isNormalizedRepoFilePath(path)) {
        issues.push(`${label}: ${path} is not a normalized repo-relative file path`);
      }
    }
  }
  return issues;
}

export type RegionLookup =
  | { readonly _tag: "Found"; readonly text: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Ambiguous"; readonly matches: number };

const found = (text: string): RegionLookup => ({ _tag: "Found", text });
const MISSING: RegionLookup = { _tag: "Missing" };
const lookupOf = (matches: ReadonlyArray<string>): RegionLookup => {
  const [only] = matches;
  if (only === undefined) return MISSING;
  return matches.length === 1 ? found(only) : { _tag: "Ambiguous", matches: matches.length };
};

export function normalizeRegion(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  return lines.slice(start, end).join("\n");
}

export function fingerprintOf(region: string): string {
  const digest = NodeCrypto.createHash("sha256").update(normalizeRegion(region)).digest("hex");
  return `sha256:${digest.slice(0, FINGERPRINT_HEX_LENGTH)}`;
}

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

type Declaration = { readonly region: ts.Node; readonly scope: ts.Node | undefined };

type NamedStatement =
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ModuleDeclaration;

const isNamedStatement = (node: ts.Node): node is NamedStatement =>
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isEnumDeclaration(node) ||
  ts.isModuleDeclaration(node);

function topLevelDeclarations(file: ts.SourceFile, name: string): Array<Declaration> {
  const declarations: Array<Declaration> = [];
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declarator of statement.declarationList.declarations) {
        if (ts.isIdentifier(declarator.name) && declarator.name.text === name) {
          declarations.push({ region: statement, scope: declarator.initializer });
        }
      }
    } else if (isNamedStatement(statement) && statement.name?.text === name) {
      declarations.push({ region: statement, scope: statement });
    }
  }
  return declarations;
}

// Reaches the object literal of `Schema.Struct({…})`, `{…} as const`, and
// `Schema.Struct({…}).pipe(…)` initializers.
function objectLiteralOf(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(node)) return node;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return objectLiteralOf(node.expression);
  }
  if (ts.isCallExpression(node)) {
    return node.arguments.find(ts.isObjectLiteralExpression) ?? objectLiteralOf(node.expression);
  }
  if (ts.isPropertyAccessExpression(node)) return objectLiteralOf(node.expression);
  return undefined;
}

function membersOf(scope: ts.Node | undefined): ReadonlyArray<ts.Node> {
  if (scope === undefined) return [];
  if (
    ts.isClassDeclaration(scope) ||
    ts.isInterfaceDeclaration(scope) ||
    ts.isTypeLiteralNode(scope) ||
    ts.isEnumDeclaration(scope)
  ) {
    return scope.members;
  }
  if (ts.isTypeAliasDeclaration(scope)) return membersOf(scope.type);
  return objectLiteralOf(scope)?.properties ?? [];
}

function memberName(member: ts.Node): string | undefined {
  const name = (member as { name?: ts.Node }).name;
  if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  return undefined;
}

function memberScope(member: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAssignment(member) || ts.isPropertyDeclaration(member))
    return member.initializer;
  if (ts.isPropertySignature(member)) return member.type;
  return member;
}

function resolveSymbol(source: ts.SourceFile, symbol: string): Array<Declaration> {
  const [first = "", ...rest] = symbol.split(".");
  let candidates = topLevelDeclarations(source, first);
  for (const segment of rest) {
    candidates = candidates.flatMap((candidate) =>
      membersOf(candidate.scope)
        .filter((member) => memberName(member) === segment)
        .map((member) => ({ region: member, scope: memberScope(member) })),
    );
  }
  return candidates;
}

// The one line containing `text` plus CONTEXT_LINES either side, clamped to the region.
function lineWindow(region: string, text: string): RegionLookup {
  const lines = region.split(/\r?\n/);
  const hits = lines.flatMap((line, index) => (line.trim().includes(text) ? [index] : []));
  const [hit] = hits;
  if (hit === undefined) return MISSING;
  if (hits.length > 1) return { _tag: "Ambiguous", matches: hits.length };
  return found(lines.slice(Math.max(0, hit - CONTEXT_LINES), hit + CONTEXT_LINES + 1).join("\n"));
}

function locateSymbol(path: string, source: string, symbol: string, text?: string): RegionLookup {
  const file = ts.createSourceFile(
    path,
    stripBom(source),
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(path),
  );
  const regions = resolveSymbol(file, symbol).map((declaration) =>
    declaration.region.getText(file),
  );
  const symbolRegion = lookupOf(regions);
  if (symbolRegion._tag !== "Found" || text === undefined) return symbolRegion;
  return lineWindow(symbolRegion.text, text);
}

function locateJsonKey(source: string, dottedKey: string): RegionLookup {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(source));
  } catch {
    return MISSING;
  }
  for (const segment of dottedKey.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return MISSING;
    if (!Object.hasOwn(value, segment)) return MISSING;
    value = (value as Record<string, unknown>)[segment];
  }
  return found(JSON.stringify(value, null, 2));
}

const YAML_KEY_PATTERN =
  /^(\s*)(?:"([^"]*)"|'([^']*)'|([^\s:#'"-][^:#]*?|-[^\s:#][^:#]*?))\s*:(?:\s|$)/;

const isYamlContent = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

function yamlKeyOf(line: string): { indent: number; key: string } | undefined {
  const match = YAML_KEY_PATTERN.exec(line);
  if (match === null) return undefined;
  return { indent: match[1]!.length, key: (match[2] ?? match[3] ?? match[4] ?? "").trim() };
}

// Block mappings only: flow mappings, anchors, and aliases locate as missing.
function locateYamlKey(source: string, dottedKey: string): RegionLookup {
  const lines = stripBom(source).split(/\r?\n/);
  let from = 0;
  let to = lines.length;
  let parentIndent = -1;
  let region: ReadonlyArray<string> = [];
  for (const segment of dottedKey.split(".")) {
    const childIndent = lines.slice(from, to).filter(isYamlContent).map(indentOf)[0];
    if (childIndent === undefined || childIndent <= parentIndent) return MISSING;
    const hits = lines.flatMap((line, index) => {
      if (index < from || index >= to || !isYamlContent(line)) return [];
      const parsed = yamlKeyOf(line);
      return parsed?.indent === childIndent && parsed.key === segment ? [index] : [];
    });
    const [hit] = hits;
    if (hit === undefined) return MISSING;
    if (hits.length > 1) return { _tag: "Ambiguous", matches: hits.length };
    let end = hit + 1;
    while (end < to && (!isYamlContent(lines[end]!) || indentOf(lines[end]!) > childIndent)) end++;
    while (end > hit + 1 && !isYamlContent(lines[end - 1]!)) end--;
    region = lines.slice(hit, end);
    from = hit + 1;
    to = end;
    parentIndent = childIndent;
  }
  return found(region.join("\n"));
}

export function locateRegion(path: string, source: string, anchor: SeamAnchor): RegionLookup {
  if ("file" in anchor) return found(source);
  if ("key" in anchor) {
    return /\.json$/.test(path)
      ? locateJsonKey(source, anchor.key)
      : locateYamlKey(source, anchor.key);
  }
  if ("symbol" in anchor) return locateSymbol(path, source, anchor.symbol, anchor.text);
  return lineWindow(source, anchor.text);
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

const runGit = Effect.fn("seamRegistry.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdin: "ignore",
        env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SeamRegistryError({
            message: `failed to start git ${args.join(" ")}: ${String(cause)}`,
          }),
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
      (cause) =>
        new SeamRegistryError({
          message: `failed while reading git ${args.join(" ")}: ${String(cause)}`,
        }),
    ),
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const git = Effect.fn("seamRegistry.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const result = yield* runGit(cwd, args, env);
  if (result.exitCode !== 0) {
    return yield* new SeamRegistryError({
      message: `git ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    });
  }
  return result.stdout;
});

// None when the path is not in the commit; any other failure is an error.
export const readFileAt = Effect.fn("seamRegistry.readFileAt")(function* (
  cwd: string,
  ref: string,
  path: string,
) {
  const listing = yield* git(cwd, ["ls-tree", "-z", ref, "--", path]);
  if (listing.length === 0) return Option.none<string>();
  return Option.some(yield* git(cwd, ["show", `${ref}:${path}`]));
});

const parseNullSeparated = (output: string): Array<string> =>
  output.split("\0").filter((value) => value.length > 0);

// Fork footprint against upstream: modified and deleted upstream paths only,
// so ++-owned additions never appear. `--no-renames` reports a rename as its
// deletion (plus an addition that is not upstream-owned).
export const forkDeltas = Effect.fn("seamRegistry.forkDeltas")(function* (
  cwd: string,
  upstreamRef: string,
  forkTree: string,
) {
  const output = yield* git(cwd, [
    "diff",
    "--numstat",
    "--no-renames",
    "--diff-filter=MD",
    "-z",
    upstreamRef,
    forkTree,
  ]);
  const deltas = new Map<string, Delta>();
  for (const record of parseNullSeparated(output)) {
    const [added, removed, ...pathParts] = record.split("\t");
    const path = pathParts.join("\t");
    const addedCount = Number(added);
    const removedCount = Number(removed);
    if (!Number.isInteger(addedCount) || !Number.isInteger(removedCount)) {
      return yield* new SeamRegistryError({
        message: `${path}: binary fork delta cannot be recorded (numstat ${added}/${removed})`,
      });
    }
    deltas.set(path, [addedCount, removedCount]);
  }
  return deltas;
});

export interface RefreshInput {
  readonly cwd: string;
  readonly registry: SeamRegistry;
  readonly upstreamRef: string;
  readonly forkTree: string;
}

export interface RefreshResult {
  readonly registry: SeamRegistry;
  readonly unregistered: Array<string>;
  readonly dropped: Array<string>;
  readonly broken: Array<string>;
  readonly deltas: ReadonlyMap<string, Delta>;
}

const describeAnchor = (anchor: SeamAnchor): string => JSON.stringify(anchor);

function refreshSeam(
  path: string,
  source: Option.Option<string>,
  seam: Seam,
): { seam: Seam; broken: string | undefined } {
  const label = `${seam.id} (${path}) ${describeAnchor(seam.anchor)}`;
  if (Option.isNone(source))
    return { seam, broken: `${label}: file is absent at the upstream ref` };
  const lookup = locateRegion(path, source.value, seam.anchor);
  if (lookup._tag === "Missing") return { seam, broken: `${label}: anchor is missing` };
  if (lookup._tag === "Ambiguous") {
    return { seam, broken: `${label}: anchor is ambiguous (${lookup.matches} matches)` };
  }
  return { seam: { ...seam, fingerprint: fingerprintOf(lookup.text) }, broken: undefined };
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareText(a, b)));

const refreshEntry = Effect.fn("seamRegistry.refreshEntry")(function* (
  input: RefreshInput,
  path: string,
  entry: RegistryFile,
  delta: Delta,
) {
  if ("legacy" in entry) return { entry: { ...entry, delta }, broken: [] as Array<string> };
  const source = yield* readFileAt(input.cwd, input.upstreamRef, path);
  const [first, ...rest] = entry.seams;
  const head = refreshSeam(path, source, first);
  const tail = rest.map((seam) => refreshSeam(path, source, seam));
  return {
    entry: {
      delta,
      seams: [head.seam, ...tail.map((result) => result.seam)] satisfies [Seam, ...Seam[]],
    },
    broken: [head, ...tail].flatMap((result) =>
      result.broken === undefined ? [] : [result.broken],
    ),
  };
});

const refreshSibling = Effect.fn("seamRegistry.refreshSibling")(function* (
  input: RefreshInput,
  sibling: Sibling,
) {
  const source = yield* readFileAt(input.cwd, input.upstreamRef, sibling.upstream);
  if (Option.isNone(source)) {
    return { sibling, broken: `sibling ${sibling.upstream}: file is absent at the upstream ref` };
  }
  return { sibling: { ...sibling, fingerprint: fingerprintOf(source.value) }, broken: undefined };
});

// Re-anchors the registry on `upstreamRef`: sets the ref, recomputes every
// fingerprint and delta, drops entries whose path left the fork delta, and
// reports delta paths that have no entry. Existing seams and reasons are kept.
export const refreshRegistry = Effect.fn("seamRegistry.refreshRegistry")(function* (
  input: RefreshInput,
) {
  const deltas = yield* forkDeltas(input.cwd, input.upstreamRef, input.forkTree);
  const files: Record<string, RegistryFile> = {};
  const dropped: Array<string> = [];
  const broken: Array<string> = [];
  for (const [path, entry] of Object.entries(input.registry.files)) {
    const delta = deltas.get(path);
    if (delta === undefined) {
      dropped.push(path);
      continue;
    }
    const refreshed = yield* refreshEntry(input, path, entry, delta);
    files[path] = refreshed.entry;
    broken.push(...refreshed.broken);
  }
  const siblings: Array<Sibling> = [];
  for (const sibling of input.registry.siblings) {
    const refreshed = yield* refreshSibling(input, sibling);
    siblings.push(refreshed.sibling);
    if (refreshed.broken !== undefined) broken.push(refreshed.broken);
  }
  const unregistered = [...deltas.keys()]
    .filter((path) => !(path in input.registry.files))
    .sort(compareText);
  return {
    registry: {
      ...input.registry,
      upstreamRef: input.upstreamRef,
      files: sortedRecord(files),
      siblings,
    },
    unregistered,
    dropped: dropped.sort(compareText),
    broken,
    deltas,
  } satisfies RefreshResult;
});

export function withLegacyEntries(
  registry: SeamRegistry,
  paths: ReadonlyArray<{ readonly path: string; readonly delta: Delta }>,
): SeamRegistry {
  const added = Object.fromEntries(
    paths.map(({ path, delta }) => [path, { delta, legacy: true as const }]),
  );
  return { ...registry, files: sortedRecord({ ...registry.files, ...added }) };
}

// Fingerprint drift between two registries on the same paths; used by `check`.
export function fingerprintMismatches(
  stored: SeamRegistry,
  recomputed: SeamRegistry,
): Array<string> {
  const mismatches: Array<string> = [];
  for (const [path, entry] of Object.entries(stored.files)) {
    const fresh = recomputed.files[path];
    if ("legacy" in entry || fresh === undefined || "legacy" in fresh) continue;
    entry.seams.forEach((seam, index) => {
      if (fresh.seams[index]?.fingerprint !== seam.fingerprint) {
        mismatches.push(`${seam.id} (${path}): stored fingerprint ${seam.fingerprint} is stale`);
      }
    });
  }
  stored.siblings.forEach((sibling, index) => {
    if (recomputed.siblings[index]?.fingerprint !== sibling.fingerprint) {
      mismatches.push(
        `sibling ${sibling.upstream}: stored fingerprint ${sibling.fingerprint} is stale`,
      );
    }
  });
  return mismatches;
}

export function upsertSyncEntry(history: SyncHistory, entry: SyncHistoryEntry): SyncHistory {
  const without = history.syncs.filter(
    (existing) => entry.upstreamRef === undefined || existing.upstreamRef !== entry.upstreamRef,
  );
  return { ...history, syncs: [...without, entry] };
}

// Serialization: matches the oxfmt JSON layout so `vp fmt` never rewrites it.
// Objects always expand, arrays of primitives stay on one line when they fit.

const isPrimitive = (value: unknown): boolean => typeof value !== "object" || value === null;

function formatJsonValue(value: unknown, depth: number, prefixWidth: number): string {
  if (isPrimitive(value)) return JSON.stringify(value);
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (indent.length + prefixWidth + inline.length + 1 <= JSON_PRINT_WIDTH) return inline;
    }
    const items = value.map((item) => `${childIndent}${formatJsonValue(item, depth + 1, 0)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const members = entries.map(([key, child]) => {
    const prefix = `${JSON.stringify(key)}: `;
    return `${childIndent}${prefix}${formatJsonValue(child, depth + 1, childIndent.length + prefix.length)}`;
  });
  return `{\n${members.join(",\n")}\n${indent}}`;
}

export const serializeJson = (value: unknown): string => `${formatJsonValue(value, 0, 0)}\n`;

export function serializeRegistry(registry: SeamRegistry): string {
  return serializeJson({ ...registry, files: sortedRecord(registry.files) });
}

export const serializeSyncHistory = (history: SyncHistory): string => serializeJson(history);

export const parseSeamRegistry = Effect.fn("seamRegistry.parse")(function* (text: string) {
  const registry = yield* decodeRegistryJson(text).pipe(
    Effect.mapError(
      (cause) =>
        new SeamRegistryError({ message: `the seam registry is not valid: ${cause.message}` }),
    ),
  );
  const issues = validateSeamRegistry(registry);
  if (issues.length > 0) {
    return yield* new SeamRegistryError({
      message: `the seam registry fails validation:\n  ${issues.join("\n  ")}`,
    });
  }
  return registry;
});

export const parseSyncHistory = Effect.fn("seamRegistry.parseHistory")(function* (text: string) {
  return yield* decodeSyncHistoryJson(text).pipe(
    Effect.mapError(
      (cause) =>
        new SeamRegistryError({ message: `the sync history is not valid: ${cause.message}` }),
    ),
  );
});

// Tree of the working directory (tracked and unignored files) built in a
// throwaway copy of the index, so the repository's own index is never touched.
// Equals HEAD^{tree} on a clean checkout.
export const snapshotWorkingTree = Effect.fn("seamRegistry.snapshotWorkingTree")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs
    .makeTempDirectoryScoped({ prefix: "seam-registry-index-" })
    .pipe(
      Effect.mapError(
        (cause) => new SeamRegistryError({ message: `no temp directory: ${cause.message}` }),
      ),
    );
  const indexPath = path.resolve(
    cwd,
    (yield* git(cwd, ["rev-parse", "--git-path", "index"])).trim(),
  );
  const snapshotIndex = path.join(tempDir, "index");
  yield* fs
    .copyFile(indexPath, snapshotIndex)
    .pipe(
      Effect.mapError(
        (cause) => new SeamRegistryError({ message: `cannot copy the index: ${cause.message}` }),
      ),
    );
  const env = { GIT_INDEX_FILE: snapshotIndex };
  yield* git(cwd, ["add", "--all"], env);
  return (yield* git(cwd, ["write-tree"], env)).trim();
}, Effect.scoped);

const BOOTSTRAP_UPSTREAM_FLAG = "--upstream-ref";

const loadRegistryFile = Effect.fn("seamRegistry.loadRegistryFile")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(root, SEAM_REGISTRY_PATH))
    .pipe(
      Effect.mapError(
        (cause) =>
          new SeamRegistryError({ message: `cannot read ${SEAM_REGISTRY_PATH}: ${cause.message}` }),
      ),
    );
  return yield* parseSeamRegistry(text);
});

export const bootstrapRegistry = Effect.fn("seamRegistry.bootstrap")(function* (
  root: string,
  upstreamRefOverride: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* loadRegistryFile(root);
  const upstreamRef = upstreamRefOverride ?? registry.upstreamRef;
  const forkTree = yield* snapshotWorkingTree(root);
  const refreshed = yield* refreshRegistry({ cwd: root, registry, upstreamRef, forkTree });
  if (refreshed.broken.length > 0) {
    return yield* new SeamRegistryError({
      message: `anchors do not resolve at ${upstreamRef}:\n  ${refreshed.broken.join("\n  ")}`,
    });
  }
  const completed = withLegacyEntries(
    refreshed.registry,
    refreshed.unregistered.map((unregisteredPath) => ({
      path: unregisteredPath,
      delta: refreshed.deltas.get(unregisteredPath) ?? [0, 0],
    })),
  );
  const issues = validateSeamRegistry(completed);
  if (issues.length > 0) {
    return yield* new SeamRegistryError({
      message: `bootstrap result is invalid:\n  ${issues.join("\n  ")}`,
    });
  }
  yield* fs.writeFileString(path.join(root, SEAM_REGISTRY_PATH), serializeRegistry(completed)).pipe(
    Effect.mapError(
      (cause) =>
        new SeamRegistryError({
          message: `cannot write ${SEAM_REGISTRY_PATH}: ${cause.message}`,
        }),
    ),
  );
  yield* Console.log(
    `bootstrap: ${Object.keys(completed.files).length} files at ${upstreamRef} ` +
      `(${refreshed.unregistered.length} added as legacy, ${refreshed.dropped.length} dropped)`,
  );
});

// Registry keys must equal the fork's modified and deleted upstream paths, and
// every anchor must resolve at upstreamRef with its stored fingerprint.
export const checkRegistry = Effect.fn("seamRegistry.check")(function* (root: string) {
  const registry = yield* loadRegistryFile(root);
  const forkTree = yield* snapshotWorkingTree(root);
  const refreshed = yield* refreshRegistry({
    cwd: root,
    registry,
    upstreamRef: registry.upstreamRef,
    forkTree,
  });
  const problems = [
    ...refreshed.unregistered.map((path) => `unregistered fork delta: ${path}`),
    ...refreshed.dropped.map((path) => `registry entry without a fork delta: ${path}`),
    ...refreshed.broken,
    ...fingerprintMismatches(registry, refreshed.registry),
  ];
  if (problems.length > 0) {
    return yield* new SeamRegistryError({
      message: `seam registry check failed:\n  ${problems.join("\n  ")}`,
    });
  }
  yield* Console.log(
    `seam registry ok: ${Object.keys(registry.files).length} files, upstreamRef ${registry.upstreamRef}`,
  );
});

if (import.meta.main) {
  const [command, ...flags] = process.argv.slice(2);
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
    if (command === "check") return yield* checkRegistry(root);
    if (command === "bootstrap") {
      const flagIndex = flags.indexOf(BOOTSTRAP_UPSTREAM_FLAG);
      const upstreamRef = flagIndex === -1 ? undefined : flags[flagIndex + 1];
      return yield* bootstrapRegistry(root, upstreamRef);
    }
    return yield* new SeamRegistryError({
      message: `usage: node scripts/seamRegistry.ts <check | bootstrap [${BOOTSTRAP_UPSTREAM_FLAG} <sha>]>`,
    });
  }).pipe(
    Effect.catch((error) =>
      Console.error(error.message).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
