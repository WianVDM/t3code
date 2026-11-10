import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const FORK_INVENTORY_PATH = "config/fork-inventory.json";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ENTRY_ID_PATTERN = /^(OWN|DEL|SEAM)-\d{3}$/;
const EXCEPTION_ID_PATTERN = /^EXC-\d{2}$/;

const CATEGORY_ID_PREFIXES = {
  "plusplus-owned": "OWN",
  "upstream-owned": "DEL",
  "integration-seam": "SEAM",
} as const;

const CATEGORY_CHANGES: Record<ForkInventoryCategory, ReadonlyArray<ForkInventoryChange>> = {
  "plusplus-owned": ["added"],
  "upstream-owned": ["deleted"],
  "integration-seam": ["modified", "renamed"],
};

export const ForkInventoryCategory = Schema.Union([
  Schema.Literal("plusplus-owned"),
  Schema.Literal("upstream-owned"),
  Schema.Literal("integration-seam"),
]);
export type ForkInventoryCategory = typeof ForkInventoryCategory.Type;

export const ForkInventoryChange = Schema.Union([
  Schema.Literal("added"),
  Schema.Literal("deleted"),
  Schema.Literal("modified"),
  Schema.Literal("renamed"),
]);
export type ForkInventoryChange = typeof ForkInventoryChange.Type;

const ExceptionTask = Schema.Union([
  Schema.Literal("A2"),
  Schema.Literal("A5"),
  Schema.Literal("A7"),
]);

export const ForkInventoryEntry = Schema.Struct({
  id: Schema.String,
  category: ForkInventoryCategory,
  change: ForkInventoryChange,
  path: Schema.String,
  upstreamPath: Schema.optional(Schema.String),
});
export type ForkInventoryEntry = typeof ForkInventoryEntry.Type;

export const ForkInventoryException = Schema.Struct({
  id: Schema.String,
  appliesTo: Schema.Array(ExceptionTask),
  rationale: Schema.String,
  entryIds: Schema.Array(Schema.String),
});
export type ForkInventoryException = typeof ForkInventoryException.Type;

export const ForkInventoryConflict = Schema.Struct({
  commit: Schema.String,
  subject: Schema.String,
  conflictedFiles: Schema.Array(Schema.String),
});
export type ForkInventoryConflict = typeof ForkInventoryConflict.Type;

export const ForkInventoryBaseline = Schema.Struct({
  forkRef: Schema.String,
  upstreamRef: Schema.String,
  mergeBase: Schema.String,
  counts: Schema.Struct({
    total: Schema.Number,
    plusplusOwned: Schema.Number,
    upstreamOwned: Schema.Number,
    integrationSeam: Schema.Number,
    sharedModified: Schema.Number,
    renamed: Schema.Number,
  }),
});
export type ForkInventoryBaseline = typeof ForkInventoryBaseline.Type;

export const ForkInventory = Schema.Struct({
  version: Schema.Literal(1),
  issue: Schema.String,
  baseline: ForkInventoryBaseline,
  plusplusOwnedRoots: Schema.Array(Schema.String),
  boundaryInfrastructure: Schema.Array(Schema.String),
  conflictHistory: Schema.Array(ForkInventoryConflict),
  exceptions: Schema.Array(ForkInventoryException),
  entries: Schema.Array(ForkInventoryEntry),
});
export type ForkInventory = typeof ForkInventory.Type;

export class ForkInventoryGitError extends Schema.TaggedError<ForkInventoryGitError>()(
  "ForkInventoryGitError",
  { message: Schema.String },
) {}

export interface NameStatusRecord {
  readonly status: "A" | "D" | "M" | "R";
  readonly path: string;
  readonly upstreamPath?: string;
}

// `git diff --name-status -M -z` output: NUL-separated, renames carry two paths.
export function parseNameStatusZ(output: string): NameStatusRecord[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const records: NameStatusRecord[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) break;
    const letter = token[0];
    if (letter === "R") {
      const upstreamPath = tokens[++index];
      const path = tokens[++index];
      if (upstreamPath === undefined || path === undefined) break;
      records.push({ status: "R", path, upstreamPath });
    } else if (letter === "A" || letter === "D" || letter === "M") {
      const path = tokens[++index];
      if (path === undefined) break;
      records.push({ status: letter, path });
    }
  }
  return records;
}

const GLOB_OR_BACKSLASH_PATTERN = /[*?[\]\\]/;

function isNormalizedRepoFilePath(path: string): boolean {
  if (path.length === 0 || path.trim() !== path) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (GLOB_OR_BACKSLASH_PATTERN.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const numbered = (prefix: string, index: number): string =>
  `${prefix}-${String(index + 1).padStart(3, "0")}`;

// Stable IDs: sorted by path within each category, so the same diff always
// produces the same inventory.
export function buildBaselineEntries(
  records: ReadonlyArray<NameStatusRecord>,
): ForkInventoryEntry[] {
  const added = records.filter((record) => record.status === "A").sort(byPath);
  const deleted = records.filter((record) => record.status === "D").sort(byPath);
  const seam = records
    .filter((record) => record.status === "M" || record.status === "R")
    .map((record) => ({
      record,
      change: record.status === "M" ? ("modified" as const) : ("renamed" as const),
    }))
    .sort((a, b) => byPath(a.record, b.record));
  return [
    ...added.map((record, index) => ({
      id: numbered("OWN", index),
      category: "plusplus-owned" as const,
      change: "added" as const,
      path: record.path,
    })),
    ...deleted.map((record, index) => ({
      id: numbered("DEL", index),
      category: "upstream-owned" as const,
      change: "deleted" as const,
      path: record.path,
    })),
    ...seam.map(({ record, change }, index) => ({
      id: numbered("SEAM", index),
      category: "integration-seam" as const,
      change,
      path: record.path,
      ...(record.upstreamPath !== undefined ? { upstreamPath: record.upstreamPath } : {}),
    })),
  ];
}

export function validateForkInventory(inventory: ForkInventory): string[] {
  const issues: string[] = [];
  const entryById = new Map<string, ForkInventoryEntry>();
  const seenPaths = new Map<string, string>();

  for (const entry of inventory.entries) {
    if (entryById.has(entry.id)) issues.push(`${entry.id}: duplicate entry id`);
    entryById.set(entry.id, entry);

    if (!ENTRY_ID_PATTERN.test(entry.id)) {
      issues.push(`${entry.id}: id must match OWN|DEL|SEAM-###`);
      continue;
    }
    const prefix = entry.id.slice(0, entry.id.indexOf("-"));
    if (CATEGORY_ID_PREFIXES[entry.category] !== prefix) {
      issues.push(`${entry.id}: category ${entry.category} does not match id prefix ${prefix}`);
    }
    if (!CATEGORY_CHANGES[entry.category].includes(entry.change)) {
      issues.push(
        `${entry.id}: change ${entry.change} is not valid for category ${entry.category}`,
      );
    }
    if (entry.change === "renamed" && entry.upstreamPath === undefined) {
      issues.push(`${entry.id}: renamed entry is missing upstreamPath`);
    }
    if (entry.change !== "renamed" && entry.upstreamPath !== undefined) {
      issues.push(`${entry.id}: upstreamPath is only valid on renamed entries`);
    }
    for (const path of [entry.path, entry.upstreamPath]) {
      if (path === undefined) continue;
      const previous = seenPaths.get(path);
      if (previous !== undefined)
        issues.push(`${entry.id}: path ${path} is also classified by ${previous}`);
      else seenPaths.set(path, entry.id);
    }
  }

  const perPrefix = new Map<string, number>();
  for (const entry of inventory.entries) {
    const prefix = entry.id.slice(0, entry.id.indexOf("-"));
    perPrefix.set(prefix, (perPrefix.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of perPrefix) {
    for (let index = 1; index <= count; index++) {
      const expected = `${prefix}-${String(index).padStart(3, "0")}`;
      if (!entryById.has(expected)) issues.push(`missing sequential id ${expected}`);
    }
  }

  const counts = {
    total: inventory.entries.length,
    plusplusOwned: inventory.entries.filter((entry) => entry.category === "plusplus-owned").length,
    upstreamOwned: inventory.entries.filter((entry) => entry.category === "upstream-owned").length,
    integrationSeam: inventory.entries.filter((entry) => entry.category === "integration-seam")
      .length,
    sharedModified: inventory.entries.filter((entry) => entry.change === "modified").length,
    renamed: inventory.entries.filter((entry) => entry.change === "renamed").length,
  };
  for (const [key, actual] of Object.entries(counts)) {
    const recorded = inventory.baseline.counts[key as keyof typeof counts];
    if (recorded !== actual)
      issues.push(`baseline count ${key} is ${recorded}, entries give ${actual}`);
  }

  for (const ref of ["forkRef", "upstreamRef", "mergeBase"] as const) {
    if (!COMMIT_SHA_PATTERN.test(inventory.baseline[ref])) {
      issues.push(`baseline ${ref} is not a full lowercase commit sha`);
    }
  }

  const seenExceptionIds = new Set<string>();
  for (const exception of inventory.exceptions) {
    if (seenExceptionIds.has(exception.id)) issues.push(`${exception.id}: duplicate exception id`);
    seenExceptionIds.add(exception.id);
    if (!EXCEPTION_ID_PATTERN.test(exception.id))
      issues.push(`${exception.id}: id must match EXC-##`);
    if (exception.rationale.trim().length === 0) issues.push(`${exception.id}: rationale is empty`);
    if (exception.appliesTo.length === 0) issues.push(`${exception.id}: appliesTo is empty`);
    if (exception.entryIds.length === 0) issues.push(`${exception.id}: entryIds is empty`);
    for (const entryId of exception.entryIds) {
      const entry = entryById.get(entryId);
      if (entry === undefined) {
        issues.push(`${exception.id}: references unknown entry ${entryId}`);
        continue;
      }
      if (entry.category === "upstream-owned" && !exception.appliesTo.includes("A2")) {
        issues.push(`${exception.id}: references deleted entry ${entryId} without applying to A2`);
      }
      if (
        entry.category === "integration-seam" &&
        !exception.appliesTo.some((task) => task === "A5" || task === "A7")
      ) {
        issues.push(
          `${exception.id}: references seam entry ${entryId} without applying to A5 or A7`,
        );
      }
      if (entry.category === "plusplus-owned") {
        issues.push(
          `${exception.id}: exceptions must not reference plusplus-owned entry ${entryId}`,
        );
      }
    }
  }

  const seenBoundaryPaths = new Set<string>();
  for (const path of inventory.boundaryInfrastructure) {
    if (seenBoundaryPaths.has(path)) issues.push(`boundaryInfrastructure: duplicate path ${path}`);
    seenBoundaryPaths.add(path);
    if (!isNormalizedRepoFilePath(path)) {
      issues.push(`boundaryInfrastructure: ${path} is not a normalized repo-relative file path`);
    }
    if (path === FORK_INVENTORY_PATH) {
      issues.push(
        `boundaryInfrastructure: must not list the policy file ${FORK_INVENTORY_PATH} itself`,
      );
    }
  }

  for (const root of inventory.plusplusOwnedRoots) {
    const prefix = `${root}/`;
    const entriesUnderRoot = inventory.entries.filter(
      (entry) => entry.path.startsWith(prefix) || entry.upstreamPath?.startsWith(prefix) === true,
    );
    // A root with no baseline entries postdates the pinned baseline (e.g. packages/plusplus);
    // coverage is only required for roots that existed at the baseline.
    const existedAtBaseline = entriesUnderRoot.length > 0;
    if (
      existedAtBaseline &&
      !entriesUnderRoot.some((entry) => entry.category === "plusplus-owned")
    ) {
      issues.push(`plusplusOwnedRoots: ${root} contains no plusplus-owned entry`);
    }
    for (const entry of entriesUnderRoot) {
      if (entry.category === "plusplus-owned") continue;
      issues.push(`plusplusOwnedRoots: ${root} contains non-fork path ${entry.path}`);
    }
  }

  for (const conflict of inventory.conflictHistory) {
    if (!COMMIT_SHA_PATTERN.test(conflict.commit)) {
      issues.push(`conflictHistory: ${conflict.commit} is not a full lowercase commit sha`);
    }
    if (conflict.subject.trim().length === 0)
      issues.push(`conflictHistory: ${conflict.commit} has no subject`);
    if (conflict.conflictedFiles.length === 0) {
      issues.push(`conflictHistory: ${conflict.commit} lists no conflicted files`);
    }
  }

  return issues;
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

const git = Effect.fn("forkInventory.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", args, {
        cwd,
        stdin: "ignore",
        env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ForkInventoryGitError({
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
        new ForkInventoryGitError({
          message: `failed while reading git ${args.join(" ")}: ${String(cause)}`,
        }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new ForkInventoryGitError({
      message: `git ${args.join(" ")} exited with code ${exitCode}.\n${stderr.trim()}`,
    });
  }
  return stdout;
}, Effect.scoped);

export interface BaselineReproduction {
  readonly issues: string[];
  readonly entries: ForkInventoryEntry[];
}

// Re-derives the recorded baseline from the local object database only: the
// pinned shas must already exist, and nothing is fetched.
export const reproduceBaseline = Effect.fn("forkInventory.reproduceBaseline")(function* (
  cwd: string,
  inventory: ForkInventory,
) {
  const { baseline } = inventory;
  const issues: string[] = [];

  const mergeBase = (yield* git(cwd, [
    "merge-base",
    baseline.upstreamRef,
    baseline.forkRef,
  ])).trim();
  if (mergeBase !== baseline.mergeBase) {
    issues.push(
      `merge-base of the recorded refs is ${mergeBase}, inventory records ${baseline.mergeBase}`,
    );
  }

  const diffOutput = yield* git(cwd, [
    "diff",
    "--name-status",
    "-M",
    "-z",
    baseline.mergeBase,
    baseline.forkRef,
  ]);
  const entries = buildBaselineEntries(parseNameStatusZ(diffOutput));

  if (entries.length !== inventory.entries.length) {
    issues.push(
      `recomputed ${entries.length} baseline paths, inventory records ${inventory.entries.length}`,
    );
  }
  const recordedById = new Map(inventory.entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    const recorded = recordedById.get(entry.id);
    if (recorded === undefined) {
      issues.push(`recomputed ${entry.id} (${entry.path}) is missing from the inventory`);
      continue;
    }
    if (
      recorded.path !== entry.path ||
      recorded.category !== entry.category ||
      recorded.change !== entry.change ||
      recorded.upstreamPath !== entry.upstreamPath
    ) {
      issues.push(`recomputed ${entry.id} does not match the recorded entry for ${entry.path}`);
    }
  }

  const sharedModified = entries.filter((entry) => entry.change === "modified").length;
  if (sharedModified !== baseline.counts.sharedModified) {
    issues.push(
      `recomputed ${sharedModified} shared modified files, inventory records ${baseline.counts.sharedModified}`,
    );
  }
  return { issues, entries } satisfies BaselineReproduction;
}, Effect.scoped);
