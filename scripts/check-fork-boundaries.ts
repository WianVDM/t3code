// @effect-diagnostics nodeBuiltinImport:off - reports violations through process.exitCode like check-changed.
// ++ fork-boundary checker: holds a PR to the seam registry (plusplus/ARCHITECTURE.md,
// "PR guard"). Policy comes from the trusted base registry, the PR's claims from the
// head registry, and anchors are only judged against upstream text at the base
// upstreamRef, which a PR cannot move. Any Git, JSON, or policy error fails closed.
// Local: `node scripts/check-fork-boundaries.ts [base-ref]` checks the working tree
// against origin/main by default; CI adds `--head <sha> --summary <file>`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  SEAM_REGISTRY_PATH,
  collectStreamAsString,
  compareText,
  fingerprintOf,
  forkDeltas,
  locateRegion,
  parseSeamRegistry,
  readFileAt,
  registryProblems,
  snapshotWorkingTree,
  type Delta,
  type RegistryFile,
  type SeamRegistry,
  type SeamRegistryError,
  type Seam,
  type Sibling,
} from "./seamRegistry.ts";

export const DEFAULT_BASE_REF = "origin/main";

const FULL_SHA = /^[0-9a-f]{40}$/;
const WORKING_TREE_LABEL = "working tree";
const EXEMPT_PR_NUMBER = 50;

export type ChangeStatus = "A" | "D" | "M";

export type BoundaryChange = { readonly status: ChangeStatus; readonly path: string };

export type BoundaryVerdict =
  | "ALLOW_OWNED"
  | "ALLOW_UPSTREAM_EQUAL"
  | "ALLOW_REGISTERED"
  | "REGISTRY_INVALID"
  | "UPSTREAM_REF_MOVED"
  | "UNREGISTERED"
  | "STALE_ENTRY"
  | "DELTA_EXCEEDED"
  | "UPSTREAM_DELETED"
  | "ANCHOR_BROKEN"
  | "SYNC_REGISTRY_INCONSISTENT";

export interface BoundaryFinding {
  readonly path: string;
  readonly verdict: BoundaryVerdict;
  readonly detail: string;
}

export const ALLOWED_VERDICTS: ReadonlySet<BoundaryVerdict> = new Set([
  "ALLOW_OWNED",
  "ALLOW_UPSTREAM_EQUAL",
  "ALLOW_REGISTERED",
]);

export const isViolation = (finding: BoundaryFinding): boolean =>
  !ALLOWED_VERDICTS.has(finding.verdict);

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

const registryError = (error: SeamRegistryError): string => `fork-boundaries: ${error.message}`;

export interface NameStatusRecord {
  readonly status: "A" | "D" | "M" | "R";
  readonly path: string;
  readonly upstreamPath?: string;
}

// `git diff --name-status -M -z` output: NUL-separated, renames carry two paths.
// Any other status letter (copy, typechange, unmerged) is rejected: skipping it
// would misread the path tokens that follow as further statuses.
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
    } else {
      throw new Error(
        `parseNameStatusZ: unsupported git name-status "${token}" at token ${index}; only A, D, M, and R records are supported`,
      );
    }
  }
  return records;
}

// --no-renames reports a rename as its old and new path; an R record is still
// flattened so a rename of an upstream path fails on both of its halves.
export function collectChanges(diffOutput: string): BoundaryChange[] {
  const changes: BoundaryChange[] = [];
  const seen = new Set<string>();
  const add = (status: ChangeStatus, path: string) => {
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
  return changes;
}

const entryOf = (registry: SeamRegistry, path: string): RegistryFile | undefined =>
  Object.hasOwn(registry.files, path) ? registry.files[path] : undefined;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// A path is touched when the PR changes it or when its registry entry differs
// between base and head (added, removed, or edited).
export function touchedPaths(
  changes: ReadonlyArray<BoundaryChange>,
  baseRegistry: SeamRegistry,
  headRegistry: SeamRegistry,
): Map<string, ChangeStatus | undefined> {
  const touched = new Map<string, ChangeStatus | undefined>(
    changes.map(({ path, status }) => [path, status]),
  );
  const keys = new Set([...Object.keys(baseRegistry.files), ...Object.keys(headRegistry.files)]);
  for (const path of keys) {
    if (touched.has(path)) continue;
    if (!sameJson(entryOf(baseRegistry, path), entryOf(headRegistry, path))) {
      touched.set(path, undefined);
    }
  }
  return touched;
}

// Siblings whose record is new or changed in head, matched by upstream path.
export function touchedSiblings(
  baseRegistry: SeamRegistry,
  headRegistry: SeamRegistry,
): Array<Sibling> {
  const baseByUpstream = new Map(
    baseRegistry.siblings.map((sibling) => [sibling.upstream, sibling]),
  );
  return headRegistry.siblings.filter(
    (sibling) => !sameJson(baseByUpstream.get(sibling.upstream), sibling),
  );
}

const seamLabel = (seam: Seam): string => `${seam.id} ${JSON.stringify(seam.anchor)}`;

export function seamAnchorProblems(
  path: string,
  upstreamText: string | undefined,
  seams: ReadonlyArray<Seam>,
): Array<string> {
  if (upstreamText === undefined) {
    return seams.map((seam) => `${seamLabel(seam)}: ${path} is absent at the upstream ref`);
  }
  return seams.flatMap((seam) => {
    const lookup = locateRegion(path, upstreamText, seam.anchor);
    if (lookup._tag === "Missing") return [`${seamLabel(seam)}: anchor is missing`];
    if (lookup._tag === "Ambiguous") {
      return [`${seamLabel(seam)}: anchor is ambiguous (${lookup.matches} matches)`];
    }
    const actual = fingerprintOf(lookup.text);
    return actual === seam.fingerprint
      ? []
      : [`${seamLabel(seam)}: fingerprint ${seam.fingerprint} does not match upstream ${actual}`];
  });
}

export function siblingAnchorProblem(
  sibling: Sibling,
  upstreamText: string | undefined,
): string | undefined {
  if (upstreamText === undefined)
    return `sibling ${sibling.upstream} is absent at the upstream ref`;
  const actual = fingerprintOf(upstreamText);
  return actual === sibling.fingerprint
    ? undefined
    : `sibling fingerprint ${sibling.fingerprint} does not match upstream ${actual}`;
}

export interface PathFacts {
  readonly path: string;
  readonly change: ChangeStatus | undefined;
  readonly upstreamOwned: boolean;
  readonly entry: RegistryFile | undefined;
  readonly delta: Delta | undefined;
  readonly anchorProblems: ReadonlyArray<string>;
}

const deltaText = ([added, removed]: Delta): string => `+${added} -${removed}`;

// Checks 1-4 for one touched path; a path collects every failure it earns.
export function classifyPath(facts: PathFacts): Array<BoundaryFinding> {
  const { path, change, upstreamOwned, entry, delta } = facts;
  if (!upstreamOwned && entry === undefined) {
    return [{ path, verdict: "ALLOW_OWNED", detail: "absent at upstreamRef: ++ owned" }];
  }
  const failures: Array<BoundaryFinding> = [];
  const fail = (verdict: BoundaryVerdict, detail: string) =>
    failures.push({ path, verdict, detail });

  if (upstreamOwned && change === "D") {
    fail("UPSTREAM_DELETED", "an upstream-owned file may not be deleted or renamed");
  }
  if (delta !== undefined && entry === undefined) {
    fail("UNREGISTERED", `fork delta ${deltaText(delta)} has no registry entry`);
  }
  if (delta === undefined && entry !== undefined) {
    fail("STALE_ENTRY", "the file no longer differs from upstream; remove the registry entry");
  }
  if (delta !== undefined && entry !== undefined) {
    const [recordedAdded, recordedRemoved] = entry.delta;
    if (delta[0] > recordedAdded || delta[1] > recordedRemoved) {
      fail(
        "DELTA_EXCEEDED",
        `delta ${deltaText(delta)} exceeds the recorded ${deltaText(entry.delta)}; raise the entry to accept it`,
      );
    }
  }
  for (const problem of facts.anchorProblems) fail("ANCHOR_BROKEN", problem);

  if (failures.length > 0) return failures;
  return entry === undefined
    ? [{ path, verdict: "ALLOW_UPSTREAM_EQUAL", detail: "identical to upstreamRef" }]
    : [
        {
          path,
          verdict: "ALLOW_REGISTERED",
          detail: `within the recorded ${deltaText(entry.delta)}`,
        },
      ];
}

export type RegistryChangeKind = "added" | "raised" | "new seam" | "new sibling";

export interface RegistryChange {
  readonly path: string;
  readonly kind: RegistryChangeKind;
  readonly detail: string;
}

const grew = (before: Delta, after: Delta): boolean => after[0] > before[0] || after[1] > before[1];

const seamIdsOf = (entry: RegistryFile | undefined): ReadonlySet<string> =>
  new Set(entry === undefined || "legacy" in entry ? [] : entry.seams.map((seam) => seam.id));

function entryChanges(
  path: string,
  before: RegistryFile | undefined,
  after: RegistryFile,
): Array<RegistryChange> {
  const changes: Array<RegistryChange> = [];
  if (before === undefined) {
    const shape = "legacy" in after ? "legacy" : "seams";
    changes.push({ path, kind: "added", detail: `${shape}, delta ${deltaText(after.delta)}` });
  } else if (grew(before.delta, after.delta)) {
    changes.push({
      path,
      kind: "raised",
      detail: `${deltaText(before.delta)} -> ${deltaText(after.delta)}`,
    });
  }
  if ("legacy" in after) return changes;
  const knownSeams = seamIdsOf(before);
  for (const seam of after.seams.filter(({ id }) => !knownSeams.has(id))) {
    changes.push({ path, kind: "new seam", detail: `${seam.id} (${seam.mechanism})` });
  }
  return changes;
}

const KIND_ORDER: Record<RegistryChangeKind, number> = {
  added: 0,
  raised: 1,
  "new seam": 2,
  "new sibling": 3,
};

// Check 5: every entry a PR adds or raises is a maintainer decision. Unchanged
// and lowered entries are not listed.
export function summarizeRegistryChanges(
  baseRegistry: SeamRegistry,
  headRegistry: SeamRegistry,
): Array<RegistryChange> {
  const changes = Object.keys(headRegistry.files).flatMap((path) =>
    entryChanges(path, entryOf(baseRegistry, path), headRegistry.files[path]!),
  );
  const knownSiblings = new Set(baseRegistry.siblings.map((sibling) => sibling.upstream));
  for (const sibling of headRegistry.siblings) {
    if (knownSiblings.has(sibling.upstream)) continue;
    changes.push({
      path: sibling.upstream,
      kind: "new sibling",
      detail: `${sibling.plusplus} (${sibling.feature})`,
    });
  }
  return changes.sort(
    (a, b) => compareText(a.path, b.path) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
}

export interface SyncDesignation {
  readonly upstreamSync: string | undefined;
  readonly designationError: string | undefined;
  readonly syncMerge: string | undefined;
}

// Exempt only for a verified designation (#50) whose merge validation passed.
export const isDesignatedSyncPr = ({
  upstreamSync,
  designationError,
  syncMerge,
}: SyncDesignation): boolean =>
  upstreamSync === "true" && designationError === "false" && syncMerge === "success";

// The decision reads these three variables and nothing else: labels, title,
// branch name and the event payload are PR-author controlled.
export const designationFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): SyncDesignation => ({
  upstreamSync: env["UPSTREAM_SYNC"],
  designationError: env["SYNC_DESIGNATION_ERROR"],
  syncMerge: env["SYNC_MERGE_RESULT"],
});

export interface BoundaryRun {
  readonly base: string;
  readonly head: string;
  readonly forkPoint: string;
  readonly upstreamRef: string;
  readonly mode: "checked" | "exempt";
  readonly registryChanges: ReadonlyArray<RegistryChange>;
  readonly findings: ReadonlyArray<BoundaryFinding>;
}

const codeSpan = (text: string): string => `\`${text.replace(/[`|\r\n]/g, " ")}\``;

export function renderReport(run: BoundaryRun): string {
  const violations = run.findings.filter(isViolation);
  const allowed = run.findings.filter((finding) => !isViolation(finding));
  const mode =
    run.mode === "exempt" ? `exempt (designated upstream-sync PR #${EXEMPT_PR_NUMBER})` : "checked";
  const lines = [
    "## Fork boundaries",
    "",
    `- base ${codeSpan(run.base)}, head ${codeSpan(run.head)}, fork point ${codeSpan(run.forkPoint)}`,
    `- upstreamRef ${codeSpan(run.upstreamRef)}`,
    `- mode: ${mode}`,
    "",
    `### Registry entries this PR adds or raises (${run.registryChanges.length})`,
    "",
  ];
  if (run.registryChanges.length === 0) {
    lines.push(run.mode === "exempt" ? "(skipped for a designated sync PR)" : "(none)");
  } else {
    lines.push("| Change | Path | Detail |", "| :-- | :-- | :-- |");
    for (const { kind, path, detail } of run.registryChanges) {
      lines.push(`| ${kind} | ${codeSpan(path)} | ${codeSpan(detail)} |`);
    }
  }
  lines.push("", `### Violations (${violations.length})`, "");
  if (violations.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("| Verdict | Path | Detail |", "| :-- | :-- | :-- |");
    for (const { verdict, path, detail } of violations) {
      lines.push(`| ${verdict} | ${codeSpan(path)} | ${codeSpan(detail)} |`);
    }
  }
  lines.push(
    "",
    `### Allowed (${allowed.length})`,
    "",
    "<details>",
    "<summary>Paths</summary>",
    "",
  );
  for (const { verdict, path, detail } of allowed) {
    lines.push(`- ${verdict} ${codeSpan(path)}: ${codeSpan(detail)}`);
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

const treePaths = Effect.fn("forkBoundaries.treePaths")(function* (cwd: string, ref: string) {
  const output = yield* git(cwd, ["ls-tree", "-r", "--name-only", "-z", ref]).pipe(
    Effect.mapError(
      (error) =>
        `fork-boundaries: cannot list the tree of ${ref}; refusing to guess ownership: ${error}`,
    ),
  );
  return new Set(output.split("\0").filter((path) => path.length > 0));
});

const resolveCommit = Effect.fn("forkBoundaries.resolveCommit")(function* (
  cwd: string,
  ref: string,
) {
  const resolved = (yield* git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.orElseSucceed(() => ""),
  )).trim();
  return FULL_SHA.test(resolved) ? resolved : undefined;
});

const loadBaseRegistry = Effect.fn("forkBoundaries.loadBaseRegistry")(function* (
  cwd: string,
  base: string,
) {
  const text = yield* git(cwd, ["show", `${base}:${SEAM_REGISTRY_PATH}`]).pipe(
    Effect.mapError(
      (error) =>
        `fork-boundaries: cannot read the trusted policy ${SEAM_REGISTRY_PATH} at base ${base}: ${error}`,
    ),
  );
  return yield* parseSeamRegistry(text).pipe(
    Effect.mapError(
      (error) =>
        `fork-boundaries: the trusted policy at base ${base} is not valid: ${error.message}`,
    ),
  );
});

// A bad head registry is a finding, not a crash, so the report still says why.
const loadHeadRegistry = Effect.fn("forkBoundaries.loadHeadRegistry")(function* (
  cwd: string,
  headTree: string,
) {
  return yield* git(cwd, ["show", `${headTree}:${SEAM_REGISTRY_PATH}`]).pipe(
    Effect.flatMap((text) =>
      parseSeamRegistry(text).pipe(Effect.mapError((error) => error.message)),
    ),
    Effect.map((registry) => ({ registry, problem: undefined })),
    Effect.catch((problem) => Effect.succeed({ registry: undefined, problem })),
  );
});

const upstreamTextOf = (cwd: string, upstreamRef: string, path: string) =>
  readFileAt(cwd, upstreamRef, path).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(registryError),
  );

interface RegistryContext {
  readonly cwd: string;
  readonly upstreamRef: string;
  readonly upstreamPaths: ReadonlySet<string>;
  readonly deltas: ReadonlyMap<string, Delta>;
  readonly baseRegistry: SeamRegistry;
  readonly headRegistry: SeamRegistry;
}

const classifyTouched = Effect.fn("forkBoundaries.classifyTouched")(function* (
  context: RegistryContext,
  changes: ReadonlyArray<BoundaryChange>,
) {
  const { cwd, upstreamRef, upstreamPaths, deltas, baseRegistry, headRegistry } = context;
  const findings: Array<BoundaryFinding> = [];
  for (const [path, change] of touchedPaths(changes, baseRegistry, headRegistry)) {
    const entry = entryOf(headRegistry, path);
    const seams = entry === undefined || "legacy" in entry ? [] : entry.seams;
    const upstreamText =
      seams.length === 0 ? undefined : yield* upstreamTextOf(cwd, upstreamRef, path);
    findings.push(
      ...classifyPath({
        path,
        change,
        upstreamOwned: upstreamPaths.has(path),
        entry,
        delta: deltas.get(path),
        anchorProblems: seams.length === 0 ? [] : seamAnchorProblems(path, upstreamText, seams),
      }),
    );
  }
  for (const sibling of touchedSiblings(baseRegistry, headRegistry)) {
    const problem = siblingAnchorProblem(
      sibling,
      yield* upstreamTextOf(cwd, upstreamRef, sibling.upstream),
    );
    if (problem !== undefined) {
      findings.push({ path: sibling.upstream, verdict: "ANCHOR_BROKEN", detail: problem });
    }
  }
  return findings;
});

// Array.sort is stable, so a path keeps the order its failures were collected in.
const sortFindings = (findings: ReadonlyArray<BoundaryFinding>): Array<BoundaryFinding> =>
  [...findings].sort((a, b) => compareText(a.path, b.path));

export interface CheckOptions {
  readonly baseRef: string;
  readonly headSha: string | undefined;
  readonly exempt: boolean;
}

export const checkForkBoundaries = Effect.fn("forkBoundaries.check")(function* (
  cwd: string,
  options: CheckOptions,
) {
  const { baseRef, headSha, exempt } = options;
  const base = yield* resolveCommit(cwd, baseRef);
  if (base === undefined) {
    return yield* Effect.fail(
      `fork-boundaries: cannot resolve base ref ${baseRef} to a commit; refusing to guess a policy`,
    );
  }
  if (headSha !== undefined && !FULL_SHA.test(headSha)) {
    return yield* Effect.fail(
      `fork-boundaries: --head must be a full 40-hex commit sha, got "${headSha}"`,
    );
  }
  const headTree =
    headSha === undefined
      ? yield* snapshotWorkingTree(cwd).pipe(Effect.mapError(registryError))
      : (yield* git(cwd, ["rev-parse", "--verify", `${headSha}^{tree}`])).trim();
  const forkPoint = (yield* git(cwd, ["merge-base", base, headSha ?? "HEAD"]).pipe(
    Effect.orElseSucceed(() => ""),
  )).trim();
  if (!FULL_SHA.test(forkPoint)) {
    return yield* Effect.fail(
      `fork-boundaries: no merge base between ${baseRef} and ${headSha ?? "HEAD"}; refusing to guess a policy`,
    );
  }

  const baseRegistry = yield* loadBaseRegistry(cwd, base);
  const run = {
    base,
    head: headSha ?? WORKING_TREE_LABEL,
    forkPoint,
    upstreamRef: baseRegistry.upstreamRef,
    mode: exempt ? "exempt" : "checked",
    registryChanges: [],
  } as const;

  const headLoad = yield* loadHeadRegistry(cwd, headTree);
  if (headLoad.registry === undefined) {
    const detail = `the head registry cannot be used: ${headLoad.problem}`;
    return {
      ...run,
      findings: [{ path: SEAM_REGISTRY_PATH, verdict: "REGISTRY_INVALID", detail }],
    } satisfies BoundaryRun;
  }
  const headRegistry = headLoad.registry;

  if (exempt) {
    const problems = yield* registryProblems({
      cwd,
      registry: headRegistry,
      forkTree: headTree,
    }).pipe(Effect.mapError(registryError));
    const findings = problems.map((detail) => ({
      path: SEAM_REGISTRY_PATH,
      verdict: "SYNC_REGISTRY_INCONSISTENT" as const,
      detail,
    }));
    return { ...run, findings } satisfies BoundaryRun;
  }

  if (headRegistry.upstreamRef !== baseRegistry.upstreamRef) {
    const detail = `upstreamRef moves ${baseRegistry.upstreamRef} -> ${headRegistry.upstreamRef}; only a designated sync PR may move it`;
    return {
      ...run,
      findings: [{ path: SEAM_REGISTRY_PATH, verdict: "UPSTREAM_REF_MOVED", detail }],
    } satisfies BoundaryRun;
  }

  const changes = collectChanges(
    yield* git(cwd, ["diff", "--name-status", "--no-renames", "-z", forkPoint, headTree]),
  );
  const findings = yield* classifyTouched(
    {
      cwd,
      upstreamRef: baseRegistry.upstreamRef,
      upstreamPaths: yield* treePaths(cwd, baseRegistry.upstreamRef),
      deltas: yield* forkDeltas(cwd, baseRegistry.upstreamRef, headTree).pipe(
        Effect.mapError(registryError),
      ),
      baseRegistry,
      headRegistry,
    },
    changes,
  );
  return {
    ...run,
    registryChanges: summarizeRegistryChanges(baseRegistry, headRegistry),
    findings: sortFindings(findings),
  } satisfies BoundaryRun;
});

export interface ParsedArguments {
  readonly baseRef: string;
  readonly headSha: string | undefined;
  readonly summaryPath: string | undefined;
}

// `[base-ref] [--head <sha>] [--summary <file>]`; anything else is rejected so a
// typo cannot silently weaken a CI invocation.
export function parseArguments(argv: ReadonlyArray<string>): ParsedArguments {
  let baseRef: string | undefined;
  let headSha: string | undefined;
  let summaryPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--head" || argument === "--summary") {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === "--head") headSha = value;
      else summaryPath = value;
    } else if (argument.startsWith("--") || baseRef !== undefined) {
      throw new Error(`unexpected argument ${argument}`);
    } else {
      baseRef = argument;
    }
  }
  return { baseRef: baseRef ?? DEFAULT_BASE_REF, headSha, summaryPath };
}

if (import.meta.main) {
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const parsed = yield* Effect.try({
      try: () => parseArguments(process.argv.slice(2)),
      catch: (error) => `fork-boundaries: ${(error as Error).message}`,
    });
    const run = yield* checkForkBoundaries(cwd, {
      baseRef: parsed.baseRef,
      headSha: parsed.headSha,
      exempt: isDesignatedSyncPr(designationFromEnv(process.env)),
    });
    const report = renderReport(run);
    yield* Console.log(report);
    if (parsed.summaryPath !== undefined) {
      yield* fs
        .writeFileString(parsed.summaryPath, `${report}\n`, { flag: "a" })
        .pipe(Effect.mapError((cause) => `fork-boundaries: cannot write the summary: ${cause}`));
    }
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
