#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { classifyPath, classifyPaths } from "../.github/scripts/pr-ownership-label.cjs";

export const EXPECTED_REMOTES = {
  origin: "WianVDM/t3code",
  upstream: "pingdotgg/t3code",
} as const;

const TAG_REF_PREFIX = "refs/tags/";
// Namespaced so a same-named fork tag is never clobbered by the upstream release.
const UPSTREAM_RELEASE_REF_PREFIX = "refs/upstream-sync/";
const UPSTREAM_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\.(0|[1-9]\d*)$/;
const FORK_SEQUENCE_PATTERN = /^(0|[1-9]\d*)$/;
const DEFAULT_BASE_REF = "origin/main";
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
// Only the schedule may ask for it; a dispatched tag must stay strict.
const LATEST_TAG_KEYWORD = "latest";
const FULL_OBJECT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SUMMARY_SECTION_PATH_LIMIT = 200;
const CONFLICT_MARKER_PATTERN = /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:[\t ].*)?$/;
const VERIFIED_MERGE_RECORD_NAME = "upstream-sync.verified.json";

// Finish re-checks this record and commits only the parents and tree verify approved.
export const VerifiedMergeRecord = Schema.Struct({
  head: Schema.String,
  mergeHead: Schema.String,
  tree: Schema.String,
});
export type VerifiedMergeRecord = typeof VerifiedMergeRecord.Type;

const VerifiedMergeRecordJson = Schema.fromJsonString(VerifiedMergeRecord);
const encodeVerifiedMergeRecord = Schema.encodeEffect(VerifiedMergeRecordJson);
const decodeVerifiedMergeRecord = Schema.decodeEffect(VerifiedMergeRecordJson);

export const DRY_RUN_REPORT_SCHEMA_VERSION = 1;

export const DryRunStatus = Schema.Literals([
  "already_integrated",
  "clean",
  "conflict",
  "merge_verification_failed",
  "error",
]);
export type DryRunStatus = typeof DryRunStatus.Type;

export const ClassifiedPathEntry = Schema.Struct({
  path: Schema.String,
  category: Schema.Literals(["fork", "seam", "shared"]),
  diverged: Schema.Boolean,
});
export type ClassifiedPathEntry = typeof ClassifiedPathEntry.Type;

export const DryRunConflictEntry = Schema.Struct({
  path: Schema.String,
  stages: Schema.Array(Schema.Number),
});
export type DryRunConflictEntry = typeof DryRunConflictEntry.Type;

const NullableHex = Schema.NullOr(Schema.String);

// Versioned so the protected sync PR automation (#50) can consume it blindly.
export const DryRunReport = Schema.Struct({
  schemaVersion: Schema.Literal(DRY_RUN_REPORT_SCHEMA_VERSION),
  requestedTag: Schema.String,
  tag: NullableHex,
  baseSha: NullableHex,
  mergeBaseSha: NullableHex,
  upstreamSha: NullableHex,
  mergeCommit: NullableHex,
  tree: NullableHex,
  status: DryRunStatus,
  incomingPaths: Schema.Array(Schema.String),
  classification: Schema.Struct({
    fork: Schema.Array(ClassifiedPathEntry),
    seam: Schema.Array(ClassifiedPathEntry),
    shared: Schema.Array(ClassifiedPathEntry),
  }),
  conflicts: Schema.Array(DryRunConflictEntry),
  windowsPackages: Schema.Array(Schema.String),
});
export type DryRunReport = typeof DryRunReport.Type;

const DryRunReportJson = Schema.fromJsonString(DryRunReport);
export const decodeDryRunReport = Schema.decodeEffect(DryRunReportJson);
const encodeDryRunReport = Schema.encodeEffect(DryRunReportJson);

// The effect diagnostics forbid JSON.stringify inside Effect generators, so
// every stringification goes through these pure helpers.
const jsonText = (value: unknown): string => JSON.stringify(value);
const prettyJsonText = (value: unknown): string => JSON.stringify(value, null, 2);

export class UpstreamSyncError extends Schema.TaggedError<UpstreamSyncError>()(
  "UpstreamSyncError",
  { message: Schema.String },
) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
}) {
  override get message(): string {
    const details = [this.stderr.trim(), this.stdout.trim()]
      .filter((output) => output.length > 0)
      .join("\n");
    return `git ${this.args.join(" ")} exited with code ${this.exitCode}.${details ? `\n${details}` : ""}`;
  }
}

export interface UpstreamSyncOptions {
  readonly tag: string;
  readonly cwd: string;
}

export function parseUpstreamTag(tag: string): string | undefined {
  return UPSTREAM_TAG_PATTERN.test(tag) ? tag.slice(1) : undefined;
}

export type UpstreamTagKind = "stable" | "nightly";

// Nightly tags are valid for disposable dry runs; maintainer phases stay stable-only.
export function parseUpstreamTagKind(tag: string): UpstreamTagKind | undefined {
  if (UPSTREAM_TAG_PATTERN.test(tag)) return "stable";
  const match = NIGHTLY_TAG_PATTERN.exec(tag);
  if (match === null) return undefined;
  const year = Number(match[4]);
  const month = Number(match[5]);
  const day = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 && leapYear ? 29 : MONTH_LENGTHS[month - 1]!;
  return day <= daysInMonth ? "nightly" : undefined;
}

export function parseGitHubRepository(remote: string): string | undefined {
  const match =
    /^(?:(?:https?|git):\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)\/?$/i.exec(
      remote.trim(),
    );
  const owner = match?.[1];
  const repository = match?.[2]?.replace(/\.git$/i, "");
  if (
    !owner ||
    !repository ||
    !/^[A-Za-z0-9-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    return undefined;
  }
  return `${owner}/${repository}`.toLowerCase();
}

export function parseNullSeparated(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

export function parseLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseLsRemoteTags(output: string): string[] {
  return parseLines(output).flatMap((line) => {
    const fields = line.split(/\s+/);
    const ref = fields.length === 2 ? fields[1] : undefined;
    if (!ref?.startsWith(TAG_REF_PREFIX) || ref.endsWith("^{}")) return [];
    return [ref.slice(TAG_REF_PREFIX.length)];
  });
}

export function nextForkTag(tag: string, tags: Iterable<string>): string {
  if (parseUpstreamTag(tag) === undefined) {
    throw new Error(`Invalid upstream tag "${tag}". Expected vX.Y.Z.`);
  }

  const prefix = `${tag}-fork.`;
  let highest = 0n;
  for (const candidate of tags) {
    if (!candidate.startsWith(prefix)) continue;
    const sequence = candidate.slice(prefix.length);
    if (!FORK_SEQUENCE_PATTERN.test(sequence)) continue;
    const value = BigInt(sequence);
    if (value > highest) highest = value;
  }
  return `${prefix}${highest + 1n}`;
}

export function findConflictMarkers(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => CONFLICT_MARKER_PATTERN.test(line));
}

export function findAddedConflictMarkers(patch: string): string[] {
  return patch.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("+") || line.startsWith("+++")) return [];
    return findConflictMarkers(line.slice(1));
  });
}

const compareVersionParts = (a: ReadonlyArray<bigint>, b: ReadonlyArray<bigint>): number => {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
};

// Greatest strict stable tag; prereleases, fork tags, and malformed names never win.
export function selectLatestUpstreamTag(tags: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestParts: ReadonlyArray<bigint> | undefined;
  for (const candidate of tags) {
    const version = parseUpstreamTag(candidate);
    if (version === undefined) continue;
    const parts = version.split(".").map((part) => BigInt(part));
    if (bestParts !== undefined && compareVersionParts(parts, bestParts) <= 0) continue;
    best = candidate;
    bestParts = parts;
  }
  return best;
}

// `git ls-files -u -s -z` entries look like `<mode> <sha> <stage>\t<path>\0`.
export function parseConflictStages(
  paths: ReadonlyArray<string>,
  lsFilesUnmergedOutput: string,
): Array<DryRunConflictEntry> {
  const stagesByPath = new Map<string, Array<number>>();
  for (const entry of lsFilesUnmergedOutput.split("\0")) {
    if (entry.length === 0) continue;
    const tabIndex = entry.indexOf("\t");
    if (tabIndex < 0) continue;
    const stage = Number(entry.slice(0, tabIndex).split(/\s+/)[2]);
    if (!Number.isInteger(stage)) continue;
    const entryPath = entry.slice(tabIndex + 1);
    const stages = stagesByPath.get(entryPath) ?? [];
    stages.push(stage);
    stagesByPath.set(entryPath, stages);
  }
  return paths.map((path) => ({
    path,
    stages: [...(stagesByPath.get(path) ?? [])].sort((a, b) => a - b),
  }));
}

const summaryList = (lines: ReadonlyArray<string>): Array<string> =>
  lines.length <= SUMMARY_SECTION_PATH_LIMIT
    ? [...lines]
    : [
        ...lines.slice(0, SUMMARY_SECTION_PATH_LIMIT),
        `- …and ${lines.length - SUMMARY_SECTION_PATH_LIMIT} more (full list in the JSON report)`,
      ];

export function renderDryRunSummary(report: DryRunReport, detail: string | null): string {
  const value = (label: string, text: string | null): string =>
    `- ${label}: ${text === null ? "(unresolved)" : `\`${text}\``}`;
  const lines: Array<string> = [
    "# Upstream sync dry run",
    "",
    `- Status: **${report.status}**`,
    `- Requested tag: ${JSON.stringify(report.requestedTag)}`,
    value("Resolved tag", report.tag),
    value("Fork base", report.baseSha),
    value("Merge base", report.mergeBaseSha),
    value("Upstream commit", report.upstreamSha),
    value("Dry-run merge commit", report.mergeCommit),
    value("Merged tree", report.tree),
    `- Windows packages: ${
      report.windowsPackages.length === 0
        ? "(none)"
        : report.windowsPackages.map((dir) => `\`${dir}\``).join(" ")
    }`,
  ];
  if (detail !== null) {
    lines.push("", `> ${detail.split(/\r?\n/).join("\n> ")}`);
  }
  lines.push("", `## Incoming paths (${report.incomingPaths.length})`, "");
  lines.push(`### ++-owned (${report.classification.fork.length})`, "");
  lines.push(
    ...(report.classification.fork.length === 0
      ? ["(none)"]
      : summaryList(report.classification.fork.map((entry) => `- ${JSON.stringify(entry.path)}`))),
  );
  lines.push("", `### Integration seams (${report.classification.seam.length})`, "");
  lines.push(
    ...(report.classification.seam.length === 0
      ? ["(none)"]
      : summaryList(
          report.classification.seam.map(
            (entry) =>
              `- ${JSON.stringify(entry.path)} (${entry.diverged ? "diverged" : "fork-only"})`,
          ),
        )),
  );
  lines.push("", `Other shared paths: ${report.classification.shared.length}`);
  if (report.conflicts.length > 0) {
    lines.push("", `## Conflicts (${report.conflicts.length})`, "");
    lines.push(
      ...summaryList(
        report.conflicts.map(
          (conflict) => `- ${JSON.stringify(conflict.path)} (stages ${conflict.stages.join(", ")})`,
        ),
      ),
    );
  }
  lines.push(
    "",
    "## Verification lanes",
    "",
    "Linux and Windows lane states are appended by the report job.",
  );
  if (
    report.status === "conflict" &&
    report.tag !== null &&
    parseUpstreamTagKind(report.tag) === "stable"
  ) {
    lines.push(
      "",
      "## Conflict recovery",
      "",
      "Resolve in the real sync flow:",
      "",
      "```sh",
      `node scripts/upstream-sync.ts prepare --tag ${report.tag}`,
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

export type DryRunLaneState = "passed" | "verification_failed" | "error" | "skipped";
export type DryRunOverallOutcome =
  | "passed"
  | "already_integrated"
  | "conflict"
  | "merge_verification_failed"
  | "verification_failed"
  | "error";

export interface LaneOutcomeInput {
  readonly result: string;
  readonly verification: string | null;
}

export interface DryRunOutcomeInput {
  readonly mergeStatus: string | null;
  readonly mergeResult: string;
  readonly reportPresent: boolean;
  readonly linux: LaneOutcomeInput;
  readonly windows: LaneOutcomeInput;
}

export interface DryRunOutcome {
  readonly outcome: DryRunOverallOutcome;
  readonly success: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly lanes: { readonly linux: DryRunLaneState; readonly windows: DryRunLaneState };
}

// Fail-closed reporting policy: missing outputs, missing diagnostics,
// cancellation, lanes in the wrong state, and surprises are infrastructure
// errors, and an infrastructure error outranks a verification failure.
export function resolveDryRunOutcome(input: DryRunOutcomeInput): DryRunOutcome {
  const problems: Array<string> = [];
  const laneState = (lane: string, { result, verification }: LaneOutcomeInput): DryRunLaneState => {
    switch (result) {
      case "success":
        return "passed";
      case "failure":
        if (verification === "verification_failed" || verification === "error") {
          return verification;
        }
        problems.push(
          `${lane}: failed without a usable verification_result (${JSON.stringify(verification)})`,
        );
        return "error";
      case "skipped":
        return "skipped";
      case "cancelled":
        problems.push(`${lane}: cancelled`);
        return "error";
      default:
        problems.push(`${lane}: unexpected job result ${JSON.stringify(result)}`);
        return "error";
    }
  };
  const lanes = {
    linux: laneState("linux", input.linux),
    windows: laneState("windows", input.windows),
  };

  const decideOutcome = (): DryRunOverallOutcome => {
    if (input.mergeResult === "cancelled") {
      problems.push("the merge job was cancelled");
      return "error";
    }
    if (input.mergeResult === "") {
      problems.push("the merge job reported no result");
      return "error";
    }
    const status = input.mergeStatus;
    if (status === null || status === "") {
      problems.push("the merge job produced no status output");
      return "error";
    }
    if (!input.reportPresent) {
      problems.push("the diagnostics report artifact is missing");
      return "error";
    }
    const requireSkippedLanes = (because: string) => {
      for (const [lane, entry] of [
        ["linux", input.linux],
        ["windows", input.windows],
      ] as const) {
        if (entry.result !== "skipped") {
          problems.push(`${lane} verification ran despite ${because}`);
        }
      }
    };
    switch (status) {
      case "already_integrated": {
        requireSkippedLanes("an already integrated tag");
        return "already_integrated";
      }
      case "conflict":
      case "merge_verification_failed": {
        if (input.mergeResult !== "failure") {
          problems.push(
            `the merge job result is ${JSON.stringify(input.mergeResult)} despite ${JSON.stringify(
              status,
            )}`,
          );
        }
        requireSkippedLanes(status === "conflict" ? "a conflict" : "a failed merge verification");
        return status;
      }
      case "error": {
        requireSkippedLanes("an infrastructure error");
        return "error";
      }
      case "clean": {
        if (input.mergeResult !== "success") {
          problems.push(
            `the merge job result is ${JSON.stringify(input.mergeResult)} despite a clean merge`,
          );
        }
        for (const [lane, state] of [
          ["linux", lanes.linux],
          ["windows", lanes.windows],
        ] as const) {
          if (state === "skipped") {
            problems.push(`${lane} verification skipped despite a clean merge`);
          }
        }
        if (lanes.linux === "error" || lanes.windows === "error") return "error";
        if (lanes.linux === "verification_failed" || lanes.windows === "verification_failed") {
          return "verification_failed";
        }
        return "passed";
      }
      default:
        problems.push(`unexpected merge status ${JSON.stringify(status)}`);
        return "error";
    }
  };

  const outcome = decideOutcome();
  return {
    outcome: problems.length > 0 ? "error" : outcome,
    success: problems.length === 0 && (outcome === "passed" || outcome === "already_integrated"),
    problems,
    lanes,
  };
}

export function renderDryRunOutcomeSummary(
  input: DryRunOutcomeInput,
  outcome: DryRunOutcome,
): string {
  const lane = (label: string, entry: LaneOutcomeInput, state: DryRunLaneState): string =>
    `- ${label}: ${state} (job result ${JSON.stringify(entry.result)}, verification ${JSON.stringify(
      entry.verification,
    )})`;
  const lines = [
    "## Final lane states",
    "",
    `- Merge: status ${JSON.stringify(input.mergeStatus)}, job result ${JSON.stringify(
      input.mergeResult,
    )}, diagnostics report ${input.reportPresent ? "present" : "missing"}`,
    lane("Linux verification", input.linux, outcome.lanes.linux),
    lane("Windows verification", input.windows, outcome.lanes.windows),
    `- Overall outcome: **${outcome.outcome}**`,
  ];
  if (outcome.problems.length > 0) {
    lines.push("", "Problems:", "");
    for (const problem of outcome.problems) lines.push(`- ${problem}`);
  }
  return `${lines.join("\n")}\n`;
}

const indentLines = (lines: ReadonlyArray<string>): string =>
  lines.map((line) => `  ${line}`).join("\n");

const upstreamReleaseRef = (tag: string): string => `${UPSTREAM_RELEASE_REF_PREFIX}${tag}`;

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = Effect.fn("upstream-sync.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make("git", args, {
    cwd,
    stdin: "ignore",
    env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    extendEnv: true,
  });
  const child = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message: `Failed to start git ${args.join(" ")}: ${String(cause)}`,
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
        new UpstreamSyncError({
          message: `Failed while reading git ${args.join(" ")}: ${String(cause)}`,
        }),
    ),
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const git = Effect.fn("upstream-sync.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const result = yield* runGit(cwd, args);
  if (result.exitCode !== 0) {
    return yield* new GitCommandError({ args: [...args], ...result });
  }
  return result.stdout;
});

const resolveRecordPath = Effect.fn("upstream-sync.resolveRecordPath")(function* (cwd: string) {
  const path = yield* Path.Path;
  const gitDir = (yield* git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  return path.join(gitDir, VERIFIED_MERGE_RECORD_NAME);
});

const clearVerifiedMergeRecord = Effect.fn("upstream-sync.clearVerifiedMergeRecord")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const recordPath = yield* resolveRecordPath(cwd);
  yield* fs.remove(recordPath, { force: true }).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message: `Failed to clear the verified merge record at ${recordPath}: ${cause.message}`,
        }),
    ),
  );
});

const writeVerifiedMergeRecord = Effect.fn("upstream-sync.writeVerifiedMergeRecord")(function* (
  cwd: string,
  record: VerifiedMergeRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const recordPath = yield* resolveRecordPath(cwd);
  const text = yield* encodeVerifiedMergeRecord(record).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message: `Failed to encode the verified merge record: ${cause.message}`,
        }),
    ),
  );
  yield* fs.writeFileString(recordPath, `${text}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message: `Failed to write the verified merge record at ${recordPath}: ${cause.message}`,
        }),
    ),
  );
});

const readVerifiedMergeRecord = Effect.fn("upstream-sync.readVerifiedMergeRecord")(function* (
  cwd: string,
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const recordPath = yield* resolveRecordPath(cwd);
  const rerunHint = `Run verify --tag ${tag} again before finish.`;
  const text = yield* fs.readFileString(recordPath).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message:
            cause.reason._tag === "NotFound"
              ? `No verified merge record was found at ${recordPath}. ${rerunHint}`
              : `Failed to read the verified merge record at ${recordPath}: ${cause.message}`,
        }),
    ),
  );
  return yield* decodeVerifiedMergeRecord(text).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message: `The verified merge record at ${recordPath} is invalid: ${cause.message}. ${rerunHint}`,
        }),
    ),
  );
});

const requireExpectedRemotes = Effect.fn("upstream-sync.requireExpectedRemotes")(function* (
  cwd: string,
) {
  for (const [remote, expected] of Object.entries(EXPECTED_REMOTES)) {
    const url = (yield* git(cwd, ["remote", "get-url", remote])).trim();
    if (parseGitHubRepository(url) !== expected.toLowerCase()) {
      return yield* new UpstreamSyncError({
        message: `Wrong ${remote} remote "${url}". Expected ${expected}.`,
      });
    }
  }
});

const resolveContext = Effect.fn("upstream-sync.resolveContext")(function* (
  options: UpstreamSyncOptions,
) {
  if (parseUpstreamTag(options.tag) === undefined) {
    return yield* new UpstreamSyncError({
      message: `Invalid upstream tag "${options.tag}". Expected vX.Y.Z (for example, v1.2.3).`,
    });
  }

  const path = yield* Path.Path;
  const cwd = path.resolve(options.cwd);
  yield* requireExpectedRemotes(cwd);
  return { cwd, tag: options.tag };
});

const requireNoLeftoverPaths = Effect.fn("upstream-sync.requireNoLeftoverPaths")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  message: string,
) {
  const paths = parseNullSeparated(yield* git(cwd, args));
  if (paths.length > 0) {
    return yield* new UpstreamSyncError({
      message: `${message}:\n${indentLines(paths)}`,
    });
  }
});

const verifyMergeState = Effect.fn("upstream-sync.verifyMergeState")(function* (
  cwd: string,
  tag: string,
) {
  // MERGE_HEAD can hold several entries (octopus merge) and rev-parse does not surface extras
  // reliably, so read the file directly.
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const noPendingMerge = new UpstreamSyncError({
    message: `No pending merge was found. Run prepare --tag ${tag} before verify or finish.`,
  });
  const gitPathResult = yield* runGit(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  if (gitPathResult.exitCode !== 0) {
    return yield* noPendingMerge;
  }
  const mergeHeadPathRaw = gitPathResult.stdout.trim();
  const mergeHeadPath = path.isAbsolute(mergeHeadPathRaw)
    ? mergeHeadPathRaw
    : path.resolve(cwd, mergeHeadPathRaw);
  const mergeHeadText = yield* fs.readFileString(mergeHeadPath).pipe(
    Effect.mapError((cause) =>
      cause.reason._tag === "NotFound"
        ? noPendingMerge
        : new UpstreamSyncError({
            message: `Failed to read MERGE_HEAD at ${mergeHeadPath}: ${cause.message}`,
          }),
    ),
  );

  const mergeHeadEntries = parseLines(mergeHeadText);
  const tagHead = (yield* git(cwd, [
    "rev-parse",
    "--verify",
    `${upstreamReleaseRef(tag)}^{commit}`,
  ])).trim();
  if (mergeHeadEntries.length !== 1 || mergeHeadEntries[0] !== tagHead) {
    return yield* new UpstreamSyncError({
      message: `MERGE_HEAD (${mergeHeadEntries.join(", ")}) must contain exactly ${tag} (${tagHead}) and no other entries.`,
    });
  }
  const mergeHead = tagHead;

  yield* requireNoLeftoverPaths(
    cwd,
    ["diff", "--name-only", "--diff-filter=U", "-z", "--"],
    "Unmerged paths remain. Resolve and stage them before continuing",
  );

  yield* requireNoLeftoverPaths(
    cwd,
    ["diff", "--name-only", "-z", "--"],
    "Tracked working-tree changes are not staged for the merge. Stage or revert these paths so the commit matches the verified tree",
  );

  yield* requireNoLeftoverPaths(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    "Untracked files would not be part of the merge commit. Remove, stage, or ignore these paths so the working tree matches the verified tree",
  );

  for (const target of [
    { label: "staged merge", diffArgs: ["--cached"] },
    { label: "working tree", diffArgs: [] },
  ] as const) {
    const patch = yield* git(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=0",
      ...target.diffArgs,
      "HEAD",
      "--",
    ]);
    const markers = findAddedConflictMarkers(patch);
    if (markers.length > 0) {
      return yield* new UpstreamSyncError({
        message: `Conflict markers remain in the ${target.label}. Remove them and stage the fixes:\n${indentLines(markers)}`,
      });
    }

    // Against the upstream side, so upstream's own vendored whitespace doesn't block every sync.
    const diffCheckArgs = ["diff", "--no-color", "--check", ...target.diffArgs, mergeHead, "--"];
    const diffCheck = yield* runGit(cwd, diffCheckArgs);
    if (diffCheck.exitCode !== 0) {
      return yield* new GitCommandError({
        args: diffCheckArgs,
        ...diffCheck,
      });
    }
  }

  const head = (yield* git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const tree = (yield* git(cwd, ["write-tree"])).trim();
  return { head, mergeHead, tree };
});

export const prepareUpstreamSync = Effect.fn("upstream-sync.prepare")(function* (
  options: UpstreamSyncOptions,
) {
  const { cwd, tag } = yield* resolveContext(options);
  yield* clearVerifiedMergeRecord(cwd);
  const status = yield* git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    return yield* new UpstreamSyncError({
      message: `The working tree must be clean before prepare:\n${status.trimEnd()}`,
    });
  }

  const releaseRef = upstreamReleaseRef(tag);
  // --no-tags everywhere: auto-followed tags, not just the explicit refspec, are what clobber a fork tag.
  yield* git(cwd, ["fetch", "--no-recurse-submodules", "--no-tags", "origin"]);
  yield* git(cwd, ["fetch", "--no-recurse-submodules", "--no-tags", "upstream"]);
  // Explicit refspec into our namespace: proves the tag exists upstream without touching refs/tags.
  yield* git(cwd, [
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "upstream",
    `+${TAG_REF_PREFIX}${tag}:${releaseRef}`,
  ]);
  yield* git(cwd, ["rev-parse", "--verify", `${releaseRef}^{commit}`]);

  const ancestryArgs = ["merge-base", "--is-ancestor", releaseRef, "origin/main"];
  const ancestry = yield* runGit(cwd, ancestryArgs);
  if (ancestry.exitCode === 0) {
    yield* Console.log(`${tag} is already integrated into origin/main; no merge is needed.`);
    return { branch: null };
  }
  if (ancestry.exitCode !== 1) {
    return yield* new GitCommandError({ args: ancestryArgs, ...ancestry });
  }

  const branch = `sync/upstream-${tag}`;
  yield* git(cwd, ["switch", "--no-track", "--create", branch, "origin/main"]);
  const forkOnly = yield* git(cwd, [
    "log",
    "--no-color",
    "--no-decorate",
    "--oneline",
    `${releaseRef}..HEAD`,
    "--",
  ]);
  yield* Console.log(`Fork-only commits relative to ${tag}:\n${forkOnly.trimEnd() || "(none)"}`);

  // -m keeps the fork's "Merge tag '<tag>'" history now that the tag ref is namespaced.
  const mergeArgs = [
    "merge",
    "--no-commit",
    "--no-ff",
    "--no-edit",
    "-m",
    `Merge tag '${tag}' into ${branch}`,
    releaseRef,
  ];
  const merge = yield* runGit(cwd, mergeArgs);
  if (merge.exitCode !== 0) {
    yield* requireNoLeftoverPaths(
      cwd,
      ["diff", "--name-only", "--diff-filter=U", "-z", "--"],
      `Merge conflicts were left unresolved. Resolve and stage them, then run verify --tag ${tag}`,
    );
    return yield* new GitCommandError({ args: mergeArgs, ...merge });
  }

  const mergeOutput = merge.stdout.trim();
  if (mergeOutput) yield* Console.log(mergeOutput);
  yield* Console.log(
    `Prepared ${branch}; the merge is not committed. Run verify --tag ${tag}, then finish --tag ${tag}.`,
  );
  return { branch };
});

export const verifyUpstreamSync = Effect.fn("upstream-sync.verify")(function* (
  options: UpstreamSyncOptions,
) {
  const { cwd, tag } = yield* resolveContext(options);
  const state = yield* verifyMergeState(cwd, tag);
  yield* writeVerifiedMergeRecord(cwd, state);
  yield* Console.log(`Verified pending merge of ${tag} at ${state.mergeHead}.`);
  return { mergeHead: state.mergeHead };
});

export const finishUpstreamSync = Effect.fn("upstream-sync.finish")(function* (
  options: UpstreamSyncOptions,
) {
  const { cwd, tag } = yield* resolveContext(options);
  const state = yield* verifyMergeState(cwd, tag);
  const record = yield* readVerifiedMergeRecord(cwd, tag);

  const drift: string[] = [];
  if (record.head !== state.head) drift.push(`HEAD moved from ${record.head} to ${state.head}`);
  if (record.mergeHead !== state.mergeHead)
    drift.push(`MERGE_HEAD changed from ${record.mergeHead} to ${state.mergeHead}`);
  if (record.tree !== state.tree)
    drift.push(`the staged tree changed from ${record.tree} to ${state.tree}`);
  if (drift.length > 0) {
    return yield* new UpstreamSyncError({
      message: `The pending merge no longer matches the verified resolution: ${drift.join("; ")}. Run verify --tag ${tag} again before finish.`,
    });
  }

  const commitOutput = yield* git(cwd, ["commit", "--no-edit"]);

  // On mismatch the record stays, so a later finish cannot hide the drift. rev-list lists every
  // parent, rejecting octopus merges that a HEAD^1/HEAD^2-only check would pass.
  const parentsLine = (yield* git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim();
  const [commitHead, ...commitParents] = parentsLine.split(/\s+/);
  const commitTree = (yield* git(cwd, ["rev-parse", "--verify", "HEAD^{tree}"])).trim();
  if (
    commitParents.length !== 2 ||
    commitParents[0] !== record.head ||
    commitParents[1] !== record.mergeHead ||
    commitTree !== record.tree
  ) {
    return yield* new UpstreamSyncError({
      message: `The commit ${commitHead} is not the verified merge of ${tag} (expected parents ${record.head} and ${record.mergeHead} with tree ${record.tree}). Inspect the repository before retrying.`,
    });
  }

  yield* clearVerifiedMergeRecord(cwd);
  yield* Console.log(commitOutput.trimEnd() || `Created merge commit for ${tag}.`);
});

// Additive real-merge validation for designated sync PRs (#50). Metadata is
// validated before any git work; the head must be the exact two-parent merge
// of the current PR base and the namespaced upstream tag commit.
const SYNC_BRANCH_PREFIX = "sync/upstream-";

export function parseSyncBranchTag(headRef: string): string | undefined {
  if (!headRef.startsWith(SYNC_BRANCH_PREFIX)) return undefined;
  const tag = headRef.slice(SYNC_BRANCH_PREFIX.length);
  return parseUpstreamTag(tag) === undefined ? undefined : tag;
}

export interface SyncPullRequestMetadata {
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRepo: string;
  readonly baseRef: string;
  readonly headRepo: string;
  readonly headRef: string;
}

export function validateSyncPullRequestMetadata(metadata: SyncPullRequestMetadata): {
  tag: string | undefined;
  problems: Array<string>;
} {
  const problems: Array<string> = [];
  if (!Number.isInteger(metadata.prNumber) || metadata.prNumber <= 0) {
    problems.push("the PR number must be a positive integer");
  }
  for (const [label, value] of [
    ["head SHA", metadata.headSha],
    ["base SHA", metadata.baseSha],
  ] as const) {
    if (!FULL_OBJECT_SHA_PATTERN.test(value)) {
      problems.push(`the ${label} ${jsonText(value)} must be a full lowercase hex object SHA`);
    }
  }
  if (metadata.baseRepo.toLowerCase() !== EXPECTED_REMOTES.origin.toLowerCase()) {
    problems.push(
      `the base repository must be ${EXPECTED_REMOTES.origin}, got ${jsonText(metadata.baseRepo)}`,
    );
  }
  if (metadata.baseRef !== "main") {
    problems.push(`the base branch must be main, got ${jsonText(metadata.baseRef)}`);
  }
  if (metadata.headRepo.toLowerCase() !== metadata.baseRepo.toLowerCase()) {
    problems.push(`a fork head (${jsonText(metadata.headRepo)}) can never be a designated sync PR`);
  }
  const tag = parseSyncBranchTag(metadata.headRef);
  if (tag === undefined) {
    problems.push(
      `the head branch ${jsonText(metadata.headRef)} is not exactly ${SYNC_BRANCH_PREFIX}vX.Y.Z`,
    );
  }
  return problems.length > 0 ? { tag: undefined, problems } : { tag, problems };
}

export interface ValidateMergeOptions extends SyncPullRequestMetadata {
  readonly cwd: string;
}

export const validateUpstreamSyncMerge = Effect.fn("upstream-sync.validateMerge")(function* (
  options: ValidateMergeOptions,
) {
  const path = yield* Path.Path;
  const cwd = path.resolve(options.cwd);
  const { tag, problems } = validateSyncPullRequestMetadata(options);
  if (problems.length > 0 || tag === undefined) {
    return yield* new UpstreamSyncError({
      message: `The sync PR metadata is invalid:\n${indentLines(problems)}`,
    });
  }
  yield* requireExpectedRemotes(cwd);

  const prRef = `${UPSTREAM_RELEASE_REF_PREFIX}pr/${options.prNumber}`;
  yield* git(cwd, [
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "origin",
    `+refs/pull/${options.prNumber}/head:${prRef}`,
  ]);
  const identity = yield* readCommitIdentity(cwd, prRef);
  if (identity.commit !== options.headSha) {
    return yield* new UpstreamSyncError({
      message: `The fetched PR head ${identity.commit} does not match the payload SHA ${options.headSha}.`,
    });
  }

  const upstreamSha = yield* fetchUpstreamTagNamespaced(cwd, tag);
  if (
    identity.parents.length !== 2 ||
    identity.parents[0] !== options.baseSha ||
    identity.parents[1] !== upstreamSha
  ) {
    return yield* new UpstreamSyncError({
      message: `The PR head ${identity.commit} has parents [${identity.parents.join(
        ", ",
      )}], expected exactly the current PR base ${options.baseSha} first and ${tag} (${upstreamSha}) second. Squash, single-parent, swapped, octopus, stale-base, and moved-tag merges are rejected.`,
    });
  }

  // The same integrity checks verify runs on the pending merge, applied to
  // both parents of the published head.
  for (const parent of identity.parents) {
    const patch = yield* git(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=0",
      parent,
      identity.commit,
      "--",
    ]);
    const markers = findAddedConflictMarkers(patch);
    if (markers.length > 0) {
      return yield* new UpstreamSyncError({
        message: `Conflict markers were added against parent ${parent}:\n${indentLines(markers)}`,
      });
    }
    const checkArgs = ["diff", "--no-color", "--check", parent, identity.commit, "--"];
    const check = yield* runGit(cwd, checkArgs);
    if (check.exitCode !== 0) {
      return yield* new GitCommandError({ args: checkArgs, ...check });
    }
  }

  yield* Console.log(
    `Validated the sync merge ${identity.commit} of ${tag} (${upstreamSha}) onto ${options.baseSha}.`,
  );
  return { headSha: identity.commit, tag, upstreamSha };
});

export const nextUpstreamForkTag = Effect.fn("upstream-sync.nextTag")(function* (
  options: UpstreamSyncOptions,
) {
  const { cwd, tag } = yield* resolveContext(options);
  const localTags = parseLines(yield* git(cwd, ["tag", "--list", `${tag}-fork.*`]));
  const originTags = parseLsRemoteTags(
    yield* git(cwd, ["ls-remote", "--tags", "--refs", "origin"]),
  );
  const next = nextForkTag(tag, [...localTags, ...originTags]);
  yield* Console.log(next);
  return next;
});

export interface DryRunOptions {
  readonly tag: string;
  readonly cwd: string;
  readonly baseRef?: string | undefined;
  readonly reportPath?: string | undefined;
  readonly summaryPath?: string | undefined;
  readonly githubOutput: boolean;
  // Test seam; production always computes the surface with the trusted detector.
  readonly windowsPackages?: ReadonlyArray<string> | undefined;
}

export interface ReplayDryRunOptions {
  readonly tag: string;
  readonly cwd: string;
  readonly baseSha: string;
  readonly upstreamSha: string;
  readonly expectedTree: string;
}

interface DryRunDraft {
  requestedTag: string;
  tag: string | null;
  baseSha: string | null;
  mergeBaseSha: string | null;
  upstreamSha: string | null;
  mergeCommit: string | null;
  tree: string | null;
  status: DryRunStatus;
  incomingPaths: Array<string>;
  classification: {
    fork: Array<ClassifiedPathEntry>;
    seam: Array<ClassifiedPathEntry>;
    shared: Array<ClassifiedPathEntry>;
  };
  conflicts: Array<DryRunConflictEntry>;
  windowsPackages: Array<string>;
}

const emptyDryRunDraft = (requestedTag: string): DryRunDraft => ({
  requestedTag,
  tag: null,
  baseSha: null,
  mergeBaseSha: null,
  upstreamSha: null,
  mergeCommit: null,
  tree: null,
  status: "error",
  incomingPaths: [],
  classification: { fork: [], seam: [], shared: [] },
  conflicts: [],
  windowsPackages: [],
});

const draftReport = (draft: DryRunDraft): DryRunReport => ({
  schemaVersion: DRY_RUN_REPORT_SCHEMA_VERSION,
  requestedTag: draft.requestedTag,
  tag: draft.tag,
  baseSha: draft.baseSha,
  mergeBaseSha: draft.mergeBaseSha,
  upstreamSha: draft.upstreamSha,
  mergeCommit: draft.mergeCommit,
  tree: draft.tree,
  status: draft.status,
  incomingPaths: [...draft.incomingPaths],
  classification: {
    fork: [...draft.classification.fork],
    seam: [...draft.classification.seam],
    shared: [...draft.classification.shared],
  },
  conflicts: draft.conflicts.map((conflict) => ({ ...conflict, stages: [...conflict.stages] })),
  windowsPackages: [...draft.windowsPackages],
});

const resolveDryRunContext = Effect.fn("upstream-sync.resolveDryRunContext")(function* (
  cwdOption: string,
) {
  const path = yield* Path.Path;
  const cwd = path.resolve(cwdOption);
  yield* requireExpectedRemotes(cwd);
  const status = yield* git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    return yield* new UpstreamSyncError({
      message: `The working tree must be clean before a dry run:\n${status.trimEnd()}`,
    });
  }
  return cwd;
});

const fetchUpstreamTagNamespaced = Effect.fn("upstream-sync.fetchUpstreamTagNamespaced")(function* (
  cwd: string,
  tag: string,
) {
  const releaseRef = upstreamReleaseRef(tag);
  // --no-tags and a namespaced refspec: a dry run must never write refs/tags/*.
  yield* git(cwd, [
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "upstream",
    `+${TAG_REF_PREFIX}${tag}:${releaseRef}`,
  ]);
  return (yield* git(cwd, ["rev-parse", "--verify", `${releaseRef}^{commit}`])).trim();
});

// Hooks off through an empty hooksPath; the merge target is always an immutable SHA.
const detachedMergeArgs = (message: string, upstreamSha: string): Array<string> => [
  "-c",
  "core.hooksPath=",
  "merge",
  "--no-commit",
  "--no-ff",
  "--no-edit",
  "-m",
  message,
  upstreamSha,
];

const unmergedPathsOf = Effect.fn("upstream-sync.unmergedPathsOf")(function* (cwd: string) {
  return parseNullSeparated(
    yield* git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z", "--"]),
  );
});

const commitDetachedMerge = Effect.fn("upstream-sync.commitDetachedMerge")(function* (cwd: string) {
  yield* git(cwd, ["-c", "core.hooksPath=", "commit", "--no-gpg-sign", "--no-edit"]);
});

const readCommitIdentity = Effect.fn("upstream-sync.readCommitIdentity")(function* (
  cwd: string,
  ref = "HEAD",
) {
  const parentsLine = (yield* git(cwd, ["rev-list", "--parents", "-n", "1", ref])).trim();
  const [commit, ...parents] = parentsLine.split(/\s+/);
  const tree = (yield* git(cwd, ["rev-parse", "--verify", `${ref}^{tree}`])).trim();
  return { commit: commit ?? "", parents, tree };
});

const validateWindowsPackageDirs = Effect.fn("upstream-sync.validateWindowsPackageDirs")(function* (
  cwd: string,
  dirs: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const dir of dirs) {
    const info = yield* fs.stat(path.join(cwd, dir)).pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({
            message: `Windows package directory ${dir} is missing from the merged tree: ${cause.message}`,
          }),
      ),
    );
    if (info.type !== "Directory") {
      return yield* new UpstreamSyncError({
        message: `Windows package path ${dir} is not a directory in the merged tree.`,
      });
    }
  }
  return [...dirs];
});

export const computeFullWindowsPackages = Effect.fn("upstream-sync.computeFullWindowsPackages")(
  function* (cwd: string) {
    // ci-changes resolves the workspace from its own repository root, so the
    // result is only trustworthy when cwd is that root; the directory check enforces it.
    const selected = yield* Effect.try({
      try: () => decide([], readWorkspace(), true).outputs.windows_packages,
      catch: (cause) =>
        new UpstreamSyncError({
          message: `Failed to compute the Windows package surface: ${String(cause)}`,
        }),
    });
    const dirs = selected.split(/\s+/).filter((dir) => dir.length > 0);
    if (dirs.length === 0) {
      return yield* new UpstreamSyncError({
        message: "The trusted change detector selected no Windows packages.",
      });
    }
    return yield* validateWindowsPackageDirs(cwd, dirs);
  },
);

const performDryRun = Effect.fn("upstream-sync.performDryRun")(function* (
  cwd: string,
  options: DryRunOptions,
  draft: DryRunDraft,
) {
  // Validate the requested form before touching the repository.
  const baseRef = options.baseRef ?? DEFAULT_BASE_REF;
  if (baseRef.startsWith("-")) {
    return yield* new UpstreamSyncError({ message: "The base ref must not start with '-'." });
  }
  if (options.tag !== LATEST_TAG_KEYWORD && parseUpstreamTagKind(options.tag) === undefined) {
    return yield* new UpstreamSyncError({
      message: `Invalid upstream tag ${jsonText(options.tag)}. Expected vX.Y.Z, vX.Y.Z-nightly.YYYYMMDD.N, or "${LATEST_TAG_KEYWORD}".`,
    });
  }

  // --no-tags everywhere: auto-followed tags are what clobber a same-named fork tag.
  yield* git(cwd, [
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const baseSha = (yield* git(cwd, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
  draft.baseSha = baseSha;
  yield* git(cwd, ["switch", "--detach", baseSha]);

  let tag = options.tag;
  if (tag === LATEST_TAG_KEYWORD) {
    const remoteTags = parseLsRemoteTags(
      yield* git(cwd, ["ls-remote", "--tags", "--refs", "upstream", "refs/tags/v*"]),
    );
    const latest = selectLatestUpstreamTag(remoteTags);
    if (latest === undefined) {
      return yield* new UpstreamSyncError({
        message: `No valid upstream stable tag (vX.Y.Z) among ${remoteTags.length} remote tags.`,
      });
    }
    tag = latest;
  }
  draft.tag = tag;
  const upstreamSha = yield* fetchUpstreamTagNamespaced(cwd, tag);
  draft.upstreamSha = upstreamSha;

  const ancestryArgs = ["merge-base", "--is-ancestor", upstreamSha, baseSha];
  const ancestry = yield* runGit(cwd, ancestryArgs);
  if (ancestry.exitCode === 0) {
    draft.status = "already_integrated";
    yield* Console.log(
      `${tag} (${upstreamSha}) is already integrated into ${baseSha}; nothing to verify.`,
    );
    return;
  }
  if (ancestry.exitCode !== 1) {
    return yield* new GitCommandError({ args: ancestryArgs, ...ancestry });
  }

  // merge-base...upstream so fork-only files are not reported as deletions, and
  // --no-renames so a rename surfaces as the two paths the merge actually touches.
  const mergeBaseSha = (yield* git(cwd, ["merge-base", baseSha, upstreamSha])).trim();
  draft.mergeBaseSha = mergeBaseSha;
  draft.incomingPaths = parseNullSeparated(
    yield* git(cwd, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${mergeBaseSha}...${upstreamSha}`,
      "--",
    ]),
  );
  const classification = classifyPaths(draft.incomingPaths);
  draft.classification = {
    fork: [...classification.fork],
    seam: [...classification.seam],
    shared: [...classification.shared],
  };

  const mergeArgs = detachedMergeArgs(`Dry-run merge tag '${tag}'`, upstreamSha);
  const merge = yield* runGit(cwd, mergeArgs);
  if (merge.exitCode !== 0) {
    const conflicts = yield* unmergedPathsOf(cwd);
    if (conflicts.length === 0) {
      return yield* new GitCommandError({ args: mergeArgs, ...merge });
    }
    draft.conflicts = parseConflictStages(
      conflicts,
      yield* git(cwd, ["ls-files", "-u", "-s", "-z", "--"]),
    );
    draft.status = "conflict";
    const recovery =
      parseUpstreamTagKind(tag) === "stable"
        ? `\nResolve through the real sync flow: node scripts/upstream-sync.ts prepare --tag ${tag}`
        : "";
    return yield* new UpstreamSyncError({
      message: `Merging ${tag} into the fork base conflicts:\n${indentLines(conflicts)}${recovery}`,
    });
  }

  const verification = yield* verifyMergeState(cwd, tag).pipe(
    Effect.map((state) => ({ state }) as const),
    Effect.catch((error) => Effect.succeed({ error } as const)),
  );
  if ("error" in verification) {
    draft.status = "merge_verification_failed";
    return yield* new UpstreamSyncError({
      message: `The clean merge of ${tag} failed integrity verification: ${verification.error.message}`,
    });
  }

  yield* commitDetachedMerge(cwd);
  const identity = yield* readCommitIdentity(cwd);
  if (
    identity.parents.length !== 2 ||
    identity.parents[0] !== baseSha ||
    identity.parents[1] !== upstreamSha
  ) {
    return yield* new UpstreamSyncError({
      message: `The dry-run merge commit ${identity.commit} has parents [${identity.parents.join(
        ", ",
      )}], expected exactly [${baseSha}, ${upstreamSha}].`,
    });
  }
  draft.mergeCommit = identity.commit;
  draft.tree = identity.tree;
  draft.status = "clean";

  draft.windowsPackages =
    options.windowsPackages === undefined
      ? yield* computeFullWindowsPackages(cwd)
      : yield* validateWindowsPackageDirs(cwd, options.windowsPackages);
});

const writeDryRunArtifacts = Effect.fn("upstream-sync.writeDryRunArtifacts")(function* (
  options: DryRunOptions,
  report: DryRunReport,
  detail: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const writeFile = (target: string, contents: string, label: string) =>
    fs.writeFileString(target, contents).pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({
            message: `Failed to write the ${label} at ${target}: ${cause.message}`,
          }),
      ),
    );

  if (options.reportPath !== undefined) {
    // Encoding through the versioned schema validates before anything consumes the file.
    const json = yield* encodeDryRunReport(report).pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({
            message: `Failed to encode the dry-run report: ${String(cause)}`,
          }),
      ),
    );
    yield* writeFile(options.reportPath, `${json}\n`, "JSON report");
  }
  if (options.summaryPath !== undefined) {
    yield* writeFile(options.summaryPath, renderDryRunSummary(report, detail), "Markdown summary");
  }
  if (options.githubOutput) {
    const outputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({ message: `Failed to resolve GITHUB_OUTPUT: ${String(cause)}` }),
      ),
    );
    const entries = [
      ["status", report.status],
      ["requested_tag", report.requestedTag],
      ["tag", report.tag ?? ""],
      ["base_sha", report.baseSha ?? ""],
      ["merge_base_sha", report.mergeBaseSha ?? ""],
      ["upstream_sha", report.upstreamSha ?? ""],
      ["merge_commit", report.mergeCommit ?? ""],
      ["merge_tree", report.tree ?? ""],
      ["windows_packages", report.windowsPackages.join(" ")],
    ] as const;
    for (const [key, value] of entries) {
      if (/[\r\n]/.test(value)) {
        return yield* new UpstreamSyncError({
          message: `Refusing to write a multiline ${key} value to GITHUB_OUTPUT.`,
        });
      }
    }
    yield* writeFile(
      outputPath,
      entries.map(([key, value]) => `${key}=${value}\n`).join(""),
      "GitHub outputs",
    );
  }
});

export const dryRunUpstreamSync = Effect.fn("upstream-sync.dryRun")(function* (
  options: DryRunOptions,
) {
  const draft = emptyDryRunDraft(options.tag);
  const failure: { error?: UpstreamSyncError | GitCommandError } = {};
  yield* resolveDryRunContext(options.cwd).pipe(
    Effect.flatMap((cwd) => performDryRun(cwd, options, draft)),
    Effect.catch((error) =>
      Effect.sync(() => {
        failure.error = error;
      }),
    ),
  );
  const report = draftReport(draft);
  yield* writeDryRunArtifacts(options, report, failure.error?.message ?? null);
  yield* Console.log(
    `Dry-run status: ${report.status}${report.tag === null ? "" : ` for ${report.tag}`}: ` +
      `${report.incomingPaths.length} incoming paths, ${report.conflicts.length} conflicts, ` +
      `${report.windowsPackages.length} Windows packages.`,
  );
  for (const conflict of report.conflicts.slice(0, 10)) {
    yield* Console.log(`  conflict: ${conflict.path} (stages ${conflict.stages.join(", ")})`);
  }
  if (failure.error !== undefined) return yield* failure.error;
  return report;
});

export const replayDryRun = Effect.fn("upstream-sync.replayDryRun")(function* (
  options: ReplayDryRunOptions,
) {
  if (parseUpstreamTagKind(options.tag) === undefined) {
    return yield* new UpstreamSyncError({
      message: `Invalid upstream tag ${jsonText(options.tag)}. Expected vX.Y.Z or vX.Y.Z-nightly.YYYYMMDD.N.`,
    });
  }
  for (const [label, value] of [
    ["base SHA", options.baseSha],
    ["upstream SHA", options.upstreamSha],
    ["expected tree", options.expectedTree],
  ] as const) {
    if (!FULL_OBJECT_SHA_PATTERN.test(value)) {
      return yield* new UpstreamSyncError({
        message: `The ${label} ${jsonText(value)} must be a full lowercase hex object SHA.`,
      });
    }
  }

  const cwd = yield* resolveDryRunContext(options.cwd);

  // Never replay on a branch: the commit must not be able to move a source ref.
  const symbolicRef = yield* runGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolicRef.exitCode === 0) {
    return yield* new UpstreamSyncError({
      message: `Replay requires a detached HEAD, but ${symbolicRef.stdout.trim()} is checked out. Refusing to move a branch.`,
    });
  }
  const head = (yield* git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (head !== options.baseSha) {
    return yield* new UpstreamSyncError({
      message: `The checked-out base ${head} does not match the dry-run base ${options.baseSha}.`,
    });
  }

  const upstreamSha = yield* fetchUpstreamTagNamespaced(cwd, options.tag);
  if (upstreamSha !== options.upstreamSha) {
    return yield* new UpstreamSyncError({
      message: `Tag ${options.tag} now resolves to ${upstreamSha}, not the merged ${options.upstreamSha}. The tag moved since the dry run.`,
    });
  }

  const mergeArgs = detachedMergeArgs(`Dry-run replay merge tag '${options.tag}'`, upstreamSha);
  const merge = yield* runGit(cwd, mergeArgs);
  if (merge.exitCode !== 0) {
    const conflicts = yield* unmergedPathsOf(cwd);
    if (conflicts.length > 0) {
      return yield* new UpstreamSyncError({
        message: `Replaying the merge of ${options.tag} onto ${options.baseSha} conflicted even though the dry run merged cleanly:\n${indentLines(
          conflicts,
        )}`,
      });
    }
    return yield* new GitCommandError({ args: mergeArgs, ...merge });
  }

  yield* verifyMergeState(cwd, options.tag);
  yield* commitDetachedMerge(cwd);
  const identity = yield* readCommitIdentity(cwd);
  if (
    identity.parents.length !== 2 ||
    identity.parents[0] !== options.baseSha ||
    identity.parents[1] !== options.upstreamSha
  ) {
    return yield* new UpstreamSyncError({
      message: `The replay merge commit ${identity.commit} has parents [${identity.parents.join(
        ", ",
      )}], expected exactly [${options.baseSha}, ${options.upstreamSha}].`,
    });
  }
  if (identity.tree !== options.expectedTree) {
    return yield* new UpstreamSyncError({
      message: `The replay produced tree ${identity.tree}, expected ${options.expectedTree}.`,
    });
  }

  yield* Console.log(
    `Replayed the clean merge of ${options.tag} at ${identity.commit} (tree ${identity.tree}).`,
  );
  return { mergeCommit: identity.commit, tree: identity.tree };
});

// Trusted ownership/conflict report for designated sync PRs (#50). The
// artifact is passive data: decoded through the versioned schema, then
// validated against the real merge and an independent recomputation before
// anything is rendered. The artifact's own Markdown is never republished.
export const HOTSPOT_COMMENT_MARKER = "<!-- upstream-sync-hotspot-report -->";
export const HOTSPOT_ARTIFACT_NAME = "upstream-sync-dry-run-report";

export interface HotspotRealMerge {
  readonly tag: string;
  readonly baseSha: string;
  readonly upstreamSha: string;
  readonly headSha: string;
  readonly headTree: string;
  readonly mergeBaseSha: string;
  readonly incomingPaths: ReadonlyArray<string>;
}

const HOTSPOT_SHA_FIELDS = [
  "baseSha",
  "mergeBaseSha",
  "upstreamSha",
  "mergeCommit",
  "tree",
] as const;
type HotspotShaField = (typeof HOTSPOT_SHA_FIELDS)[number] | "tag";

const STATUS_REQUIRED_NON_NULL: Readonly<Record<DryRunStatus, ReadonlyArray<HotspotShaField>>> = {
  clean: ["tag", "baseSha", "mergeBaseSha", "upstreamSha", "mergeCommit", "tree"],
  conflict: ["tag", "baseSha", "mergeBaseSha", "upstreamSha"],
  merge_verification_failed: ["tag", "baseSha", "mergeBaseSha", "upstreamSha"],
  already_integrated: ["tag", "baseSha", "upstreamSha"],
  error: [],
};
const STATUS_REQUIRED_NULL: Readonly<Record<DryRunStatus, ReadonlyArray<HotspotShaField>>> = {
  clean: [],
  conflict: ["mergeCommit", "tree"],
  merge_verification_failed: ["mergeCommit", "tree"],
  already_integrated: ["mergeBaseSha", "mergeCommit", "tree"],
  error: [],
};
const LEGAL_CONFLICT_STAGES = new Set([1, 2, 3]);

export function validateHotspotReport(report: DryRunReport, real: HotspotRealMerge): Array<string> {
  const problems: Array<string> = [];
  if (report.schemaVersion !== DRY_RUN_REPORT_SCHEMA_VERSION) {
    problems.push(`unsupported schemaVersion ${report.schemaVersion}`);
  }
  if (report.tag === null || parseUpstreamTag(report.tag) === undefined) {
    problems.push(`tag ${jsonText(report.tag)} is not a strict upstream release tag`);
  }
  for (const field of HOTSPOT_SHA_FIELDS) {
    const value = report[field];
    if (value !== null && !FULL_OBJECT_SHA_PATTERN.test(value)) {
      problems.push(`${field} ${jsonText(value)} is not a full object SHA`);
    }
  }
  for (const field of STATUS_REQUIRED_NON_NULL[report.status]) {
    if (report[field] === null) {
      problems.push(`${field} must be set for status ${jsonText(report.status)}`);
    }
  }
  for (const field of STATUS_REQUIRED_NULL[report.status]) {
    if (report[field] !== null) {
      problems.push(`${field} must be null for status ${jsonText(report.status)}`);
    }
  }
  if (report.status === "conflict" && report.conflicts.length === 0) {
    problems.push("a conflict status requires conflict entries");
  }
  if (report.status !== "conflict" && report.conflicts.length > 0) {
    problems.push(`status ${jsonText(report.status)} must not carry conflict entries`);
  }
  for (const conflict of report.conflicts) {
    if (
      conflict.stages.length === 0 ||
      conflict.stages.some((stage) => !LEGAL_CONFLICT_STAGES.has(stage))
    ) {
      problems.push(
        `conflict ${jsonText(conflict.path)} has illegal stages [${conflict.stages.join(", ")}]`,
      );
    }
  }
  if (
    (report.status === "clean" || report.status === "conflict") &&
    report.incomingPaths.length === 0
  ) {
    problems.push(`status ${jsonText(report.status)} requires incoming paths`);
  }
  if (report.tag !== real.tag) {
    problems.push(
      `report tag ${jsonText(report.tag)} does not match the real merge tag ${jsonText(real.tag)}`,
    );
  }
  if (report.baseSha !== real.baseSha) {
    problems.push(
      `report base ${jsonText(report.baseSha)} does not match the real merge base ${jsonText(
        real.baseSha,
      )}`,
    );
  }
  if (report.upstreamSha !== real.upstreamSha) {
    problems.push(
      `report upstream ${jsonText(report.upstreamSha)} does not match the real merged upstream ${jsonText(
        real.upstreamSha,
      )}`,
    );
  }
  if (report.mergeBaseSha !== real.mergeBaseSha) {
    problems.push(
      `report merge base ${jsonText(report.mergeBaseSha)} does not match the recomputed ${jsonText(
        real.mergeBaseSha,
      )}`,
    );
  }
  if (report.status === "clean" && report.tree !== real.headTree) {
    problems.push("the clean report tree does not equal the real merged tree");
  }
  const reportIncoming = [...report.incomingPaths].sort();
  const realIncoming = [...real.incomingPaths].sort();
  if (jsonText(reportIncoming) !== jsonText(realIncoming)) {
    problems.push(
      "the report incoming paths do not match the recomputed mergeBase...upstream diff",
    );
  }
  const recomputed = classifyPaths(realIncoming);
  const entryKey = (entry: { path: string; category: string; diverged: boolean }): string =>
    jsonText([entry.path, entry.category, entry.diverged]);
  for (const category of ["fork", "seam", "shared"] as const) {
    const fromReport = report.classification[category].map(entryKey).sort();
    const fromClassifier = recomputed[category].map(entryKey).sort();
    if (jsonText(fromReport) !== jsonText(fromClassifier)) {
      problems.push(
        `the report classification (${category}) does not match the recomputed registry classification`,
      );
    }
  }
  return problems;
}

// Unmapped ++-owned files: shared-classified PR paths that are neither
// incoming upstream work nor known to the validated upstream commit. These
// are fork-invented files the registry does not claim; maintainers must
// review them. Upstream-existing or upstream-deleted paths stay shared.
export function findUnmappedForkPaths(
  prDiffPaths: ReadonlyArray<string>,
  incomingPaths: ReadonlyArray<string>,
  upstreamTreePaths: ReadonlyArray<string>,
): Array<string> {
  const incoming = new Set(incomingPaths);
  const upstreamTree = new Set(upstreamTreePaths);
  return prDiffPaths.filter(
    (path) =>
      classifyPath(path).category === "shared" && !incoming.has(path) && !upstreamTree.has(path),
  );
}

export interface HotspotReportView {
  readonly report: DryRunReport;
  readonly real: HotspotRealMerge;
  readonly unmappedForkPaths: ReadonlyArray<string>;
  readonly sourceRun: string;
  readonly artifactName: string;
}

export function renderHotspotReport(view: HotspotReportView): string {
  const { report, real } = view;
  const value = (label: string, text: string | null): string =>
    `- ${label}: ${text === null ? "(unresolved)" : `\`${text}\``}`;
  const lines: Array<string> = [
    HOTSPOT_COMMENT_MARKER,
    "",
    "## Upstream sync hotspot report",
    "",
    "Generated by the trusted sync-PR automation from validated dry-run data; the artifact's own Markdown is never republished.",
    "",
    `- Source: ${view.sourceRun} (artifact \`${view.artifactName}\`)`,
    value("Upstream tag", report.tag),
    value("Fork base", real.baseSha),
    value("Upstream commit", real.upstreamSha),
    value("PR head (real merge)", real.headSha),
    `- Dry-run status: **${report.status}**`,
    "",
    "### Real merge validation",
    "",
    `- Head parents: exactly two, \`${real.baseSha}\` (current PR base) then \`${real.upstreamSha}\` (${report.tag}).`,
    "- Incoming paths and ++ classification were recomputed from the real merge and match the report.",
  ];
  if (report.status === "clean") {
    lines.push(`- Merged tree matches the dry-run tree (${report.tree}).`);
  } else {
    lines.push(
      `- The resolved tree may differ from the dry run (status: ${report.status}); only a clean dry run pins the tree.`,
    );
  }
  lines.push(
    "",
    `### Incoming ownership (${report.incomingPaths.length} paths)`,
    "",
    `#### ++-owned (${report.classification.fork.length})`,
    "",
    ...(report.classification.fork.length === 0
      ? ["(none)"]
      : summaryList(report.classification.fork.map((entry) => `- ${jsonText(entry.path)}`))),
    "",
    `#### Integration seams (${report.classification.seam.length})`,
    "",
    ...(report.classification.seam.length === 0
      ? ["(none)"]
      : summaryList(
          report.classification.seam.map(
            (entry) => `- ${jsonText(entry.path)} (${entry.diverged ? "diverged" : "fork-only"})`,
          ),
        )),
    "",
    `Other shared paths: ${report.classification.shared.length}`,
  );
  if (report.conflicts.length > 0) {
    lines.push("", `### Conflicts (${report.conflicts.length})`, "");
    lines.push(
      ...summaryList(
        report.conflicts.map(
          (conflict) => `- ${jsonText(conflict.path)} (stages ${conflict.stages.join(", ")})`,
        ),
      ),
    );
  }
  lines.push(
    "",
    "### Unmapped ++-owned files \u2014 maintainer review required",
    "",
    ...(view.unmappedForkPaths.length === 0
      ? ["(none)"]
      : summaryList(view.unmappedForkPaths.map((path) => `- ${jsonText(path)}`))),
    "",
    "Shared-classified PR paths that are neither incoming upstream work nor known to the validated upstream commit. Confirm each is intentional fork work; consider adding it to the ownership registry.",
  );
  return `${lines.join("\n")}\n`;
}

export interface HotspotReportOptions {
  readonly cwd: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly reportPath: string;
  readonly sourceRun: string;
  readonly outputPath: string;
  readonly artifactName?: string | undefined;
}

export const generateHotspotReport = Effect.fn("upstream-sync.hotspotReport")(function* (
  options: HotspotReportOptions,
) {
  if (!Number.isInteger(options.prNumber) || options.prNumber <= 0) {
    return yield* new UpstreamSyncError({ message: "The PR number must be a positive integer." });
  }
  if (!FULL_OBJECT_SHA_PATTERN.test(options.headSha)) {
    return yield* new UpstreamSyncError({
      message: `The head SHA ${jsonText(options.headSha)} must be a full lowercase hex object SHA.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = path.resolve(options.cwd);

  const text = yield* fs.readFileString(options.reportPath).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message:
            cause.reason._tag === "NotFound"
              ? `The dry-run report JSON is missing at ${options.reportPath}.`
              : `Failed to read the dry-run report at ${options.reportPath}: ${cause.message}`,
        }),
    ),
  );
  const report = yield* decodeDryRunReport(text).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({ message: `The dry-run report JSON is invalid: ${cause.message}` }),
    ),
  );
  if (report.tag === null || parseUpstreamTag(report.tag) === undefined) {
    return yield* new UpstreamSyncError({
      message: `The dry-run report does not name a strict upstream tag: ${jsonText(report.tag)}.`,
    });
  }

  yield* requireExpectedRemotes(cwd);
  const prRef = `${UPSTREAM_RELEASE_REF_PREFIX}pr/${options.prNumber}`;
  yield* git(cwd, [
    "fetch",
    "--no-recurse-submodules",
    "--no-tags",
    "origin",
    `+refs/pull/${options.prNumber}/head:${prRef}`,
  ]);
  const identity = yield* readCommitIdentity(cwd, prRef);
  if (identity.commit !== options.headSha) {
    return yield* new UpstreamSyncError({
      message: `The fetched PR head ${identity.commit} does not match the payload SHA ${options.headSha}; aborting the stale report.`,
    });
  }
  if (identity.parents.length !== 2) {
    return yield* new UpstreamSyncError({
      message: `The PR head has ${identity.parents.length} parents; a designated sync PR must be an exact two-parent merge.`,
    });
  }
  const baseSha = identity.parents[0]!;
  const upstreamSha = identity.parents[1]!;

  const upstreamTagSha = yield* fetchUpstreamTagNamespaced(cwd, report.tag);
  if (upstreamTagSha !== upstreamSha) {
    return yield* new UpstreamSyncError({
      message: `Tag ${report.tag} now resolves to ${upstreamTagSha}, not the merged ${upstreamSha}. The tag moved since the dry run.`,
    });
  }

  const mergeBaseSha = (yield* git(cwd, ["merge-base", baseSha, upstreamSha])).trim();
  const incomingPaths = parseNullSeparated(
    yield* git(cwd, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${mergeBaseSha}...${upstreamSha}`,
      "--",
    ]),
  );
  const real: HotspotRealMerge = {
    tag: report.tag,
    baseSha,
    upstreamSha,
    headSha: identity.commit,
    headTree: identity.tree,
    mergeBaseSha,
    incomingPaths,
  };

  // Validation completes before any rendering or output write.
  const problems = validateHotspotReport(report, real);
  if (problems.length > 0) {
    return yield* new UpstreamSyncError({
      message: `The dry-run report does not survive validation against the real merge:\n${indentLines(
        problems,
      )}`,
    });
  }

  const prDiffPaths = parseNullSeparated(
    yield* git(cwd, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${baseSha}...${identity.commit}`,
      "--",
    ]),
  );
  const upstreamTreePaths = parseNullSeparated(
    yield* git(cwd, ["ls-tree", "-r", "--name-only", "-z", upstreamSha]),
  );
  const unmappedForkPaths = findUnmappedForkPaths(prDiffPaths, incomingPaths, upstreamTreePaths);

  const markdown = renderHotspotReport({
    report,
    real,
    unmappedForkPaths,
    sourceRun: options.sourceRun,
    artifactName: options.artifactName ?? HOTSPOT_ARTIFACT_NAME,
  });
  yield* fs.writeFileString(options.outputPath, markdown).pipe(
    Effect.mapError(
      (cause) =>
        new UpstreamSyncError({
          message: `Failed to write the hotspot report at ${options.outputPath}: ${cause.message}`,
        }),
    ),
  );
  yield* Console.log(
    `Hotspot report for PR #${options.prNumber} (${report.tag}): ${incomingPaths.length} incoming paths, ${report.conflicts.length} conflicts, ${unmappedForkPaths.length} unmapped ++-owned files.`,
  );
  return { headSha: identity.commit, tag: report.tag, unmappedForkPaths };
});

const resolveDryRunOutcomeCommand = Effect.fn("upstream-sync.resolveOutcome")(function* (
  githubOutput: boolean,
  lanesPath: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const readEnv = (name: string) =>
    Config.String(name).pipe(
      Config.withDefault(""),
      Effect.mapError(
        (cause) => new UpstreamSyncError({ message: `Failed to read ${name}: ${String(cause)}` }),
      ),
    );
  const nullWhenEmpty = (value: string): string | null => (value === "" ? null : value);
  const input: DryRunOutcomeInput = {
    mergeStatus: nullWhenEmpty(yield* readEnv("DRY_RUN_MERGE_STATUS")),
    mergeResult: yield* readEnv("DRY_RUN_MERGE_RESULT"),
    reportPresent: (yield* readEnv("DRY_RUN_REPORT_PRESENT")) === "true",
    linux: {
      result: yield* readEnv("DRY_RUN_LINUX_RESULT"),
      verification: nullWhenEmpty(yield* readEnv("DRY_RUN_LINUX_VERIFICATION")),
    },
    windows: {
      result: yield* readEnv("DRY_RUN_WINDOWS_RESULT"),
      verification: nullWhenEmpty(yield* readEnv("DRY_RUN_WINDOWS_VERIFICATION")),
    },
  };
  const outcome = resolveDryRunOutcome(input);

  if (lanesPath !== undefined) {
    yield* fs.writeFileString(lanesPath, renderDryRunOutcomeSummary(input, outcome)).pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({
            message: `Failed to write the lane states at ${lanesPath}: ${cause.message}`,
          }),
      ),
    );
  }
  if (githubOutput) {
    const outputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({ message: `Failed to resolve GITHUB_OUTPUT: ${String(cause)}` }),
      ),
    );
    const serialized = `outcome=${outcome.outcome}\noutcome_json=${jsonText(outcome).replace(
      /[\r\n]/g,
      " ",
    )}\n`;
    yield* fs.writeFileString(outputPath, serialized, { flag: "a" }).pipe(
      Effect.mapError(
        (cause) =>
          new UpstreamSyncError({
            message: `Failed to append the outcome to ${outputPath}: ${cause.message}`,
          }),
      ),
    );
  }

  yield* Console.log(prettyJsonText(outcome));
  for (const problem of outcome.problems) {
    yield* Console.error(`::error::${problem}`);
  }
  if (!outcome.success) {
    return yield* new UpstreamSyncError({
      message: `Dry-run outcome: ${outcome.outcome}`,
    });
  }
});

const sharedFlags = {
  tag: Flag.String("tag").pipe(
    Flag.withDescription(
      'Upstream tag in vX.Y.Z form; dry-run also accepts vX.Y.Z-nightly.YYYYMMDD.N or "latest".',
    ),
    // Optional at the parser level so resolve-outcome needs no tag; every
    // tag-taking command rejects a missing value with the error below.
    Flag.optional,
  ),
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Repository directory."),
    Flag.withDefault("."),
  ),
};

const upstreamSyncRootCommand = Command.make("upstream-sync").pipe(
  Command.withSharedFlags(sharedFlags),
);

const missingTagError = () => new UpstreamSyncError({ message: "Missing required flag --tag." });

const runWithSharedOptions = Effect.fn("upstream-sync.runWithSharedOptions")(function* <A, E, R>(
  operation: (options: UpstreamSyncOptions) => Effect.Effect<A, E, R>,
) {
  const options = yield* upstreamSyncRootCommand;
  const tag = Option.getOrUndefined(options.tag);
  if (tag === undefined) return yield* missingTagError();
  yield* operation({ tag, cwd: options.cwd });
});

export const prepareCommand = Command.make("prepare").pipe(
  Command.withDescription("Create a branch and stage an upstream merge without committing it."),
  Command.withHandler(() => runWithSharedOptions(prepareUpstreamSync)),
);

export const verifyCommand = Command.make("verify").pipe(
  Command.withDescription("Check the pending upstream merge without committing it."),
  Command.withHandler(() => runWithSharedOptions(verifyUpstreamSync)),
);

export const finishCommand = Command.make("finish").pipe(
  Command.withDescription("Verify and explicitly commit the pending upstream merge."),
  Command.withHandler(() => runWithSharedOptions(finishUpstreamSync)),
);

export const nextTagCommand = Command.make("next-tag").pipe(
  Command.withDescription("Print the next fork release tag for an upstream release."),
  Command.withHandler(() => runWithSharedOptions(nextUpstreamForkTag)),
);

export const dryRunCommand = Command.make("dry-run", {
  report: Flag.String("report").pipe(
    Flag.withDescription("Write the versioned JSON report to this path."),
    Flag.optional,
  ),
  summary: Flag.String("summary").pipe(
    Flag.withDescription("Write the Markdown summary to this path."),
    Flag.optional,
  ),
  githubOutput: Flag.Boolean("github-output").pipe(
    Flag.withDescription("Append the dry-run values to GITHUB_OUTPUT."),
    Flag.withDefault(false),
  ),
  baseRef: Flag.String("base-ref").pipe(
    Flag.withDescription("Base ref the dry run stacks on."),
    Flag.withDefault(DEFAULT_BASE_REF),
  ),
}).pipe(
  Command.withDescription(
    "Merge an upstream tag into the fork base on a detached ref, read-only, and report the outcome.",
  ),
  Command.withHandler((config) =>
    Effect.gen(function* () {
      const shared = yield* upstreamSyncRootCommand;
      const tag = Option.getOrUndefined(shared.tag);
      if (tag === undefined) return yield* missingTagError();
      yield* dryRunUpstreamSync({
        tag,
        cwd: shared.cwd,
        baseRef: config.baseRef,
        reportPath: Option.getOrUndefined(config.report),
        summaryPath: Option.getOrUndefined(config.summary),
        githubOutput: config.githubOutput,
      });
    }),
  ),
);

export const replayDryRunCommand = Command.make("replay-dry-run", {
  baseSha: Flag.String("base-sha").pipe(
    Flag.withDescription("Full fork base SHA the dry run merged."),
  ),
  upstreamSha: Flag.String("upstream-sha").pipe(
    Flag.withDescription("Full upstream commit SHA the dry run merged."),
  ),
  expectedTree: Flag.String("expected-tree").pipe(
    Flag.withDescription("Full tree SHA the verified dry-run merge produced."),
  ),
}).pipe(
  Command.withDescription(
    "Reproduce a verified dry-run merge from scratch and fail on any identity mismatch.",
  ),
  Command.withHandler((config) =>
    Effect.gen(function* () {
      const shared = yield* upstreamSyncRootCommand;
      const tag = Option.getOrUndefined(shared.tag);
      if (tag === undefined) return yield* missingTagError();
      yield* replayDryRun({
        tag,
        cwd: shared.cwd,
        baseSha: config.baseSha,
        upstreamSha: config.upstreamSha,
        expectedTree: config.expectedTree,
      });
    }),
  ),
);

export const resolveOutcomeCommand = Command.make("resolve-outcome", {
  githubOutput: Flag.Boolean("github-output").pipe(
    Flag.withDescription("Append the overall outcome to GITHUB_OUTPUT."),
    Flag.withDefault(false),
  ),
  lanes: Flag.String("lanes").pipe(
    Flag.withDescription("Write the final lane states Markdown to this path."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Apply the fail-closed outcome matrix to the DRY_RUN_* lane environment values.",
  ),
  Command.withHandler((config) =>
    resolveDryRunOutcomeCommand(config.githubOutput, Option.getOrUndefined(config.lanes)),
  ),
);

export const validateMergeCommand = Command.make("validate-merge", {
  prNumber: Flag.Int("pr-number").pipe(Flag.withDescription("The designated sync PR number.")),
  headSha: Flag.String("head-sha").pipe(
    Flag.withDescription("Full PR head SHA from the trusted event payload."),
  ),
  baseSha: Flag.String("base-sha").pipe(
    Flag.withDescription("Full PR base SHA from the trusted event payload."),
  ),
  baseRepo: Flag.String("base-repo").pipe(
    Flag.withDescription("Base repository full name from the payload."),
  ),
  baseRef: Flag.String("base-ref").pipe(Flag.withDescription("Base branch from the payload.")),
  headRepo: Flag.String("head-repo").pipe(
    Flag.withDescription("Head repository full name from the payload."),
  ),
  headRef: Flag.String("head-ref").pipe(Flag.withDescription("Head branch from the payload.")),
}).pipe(
  Command.withDescription(
    "Validate a designated sync PR head as the exact two-parent merge of the current base and the upstream tag.",
  ),
  Command.withHandler((config) =>
    Effect.gen(function* () {
      const shared = yield* upstreamSyncRootCommand;
      yield* validateUpstreamSyncMerge({
        cwd: shared.cwd,
        prNumber: config.prNumber,
        headSha: config.headSha,
        baseSha: config.baseSha,
        baseRepo: config.baseRepo,
        baseRef: config.baseRef,
        headRepo: config.headRepo,
        headRef: config.headRef,
      });
    }),
  ),
);

export const hotspotReportCommand = Command.make("hotspot-report", {
  prNumber: Flag.Int("pr-number").pipe(Flag.withDescription("The designated sync PR number.")),
  headSha: Flag.String("head-sha").pipe(
    Flag.withDescription("Full PR head SHA from the trusted event payload."),
  ),
  report: Flag.String("report").pipe(
    Flag.withDescription("Path to the downloaded dry-run report JSON artifact."),
  ),
  sourceRun: Flag.String("source-run").pipe(
    Flag.withDescription("URL of the dry-run workflow run the artifact came from."),
  ),
  output: Flag.String("output").pipe(
    Flag.withDescription("Write the hotspot report Markdown to this path."),
  ),
  artifactName: Flag.String("artifact-name").pipe(
    Flag.withDescription("Artifact name cited in the report source line."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Validate a trusted dry-run artifact against the real merge and render the hotspot report.",
  ),
  Command.withHandler((config) =>
    Effect.gen(function* () {
      const shared = yield* upstreamSyncRootCommand;
      yield* generateHotspotReport({
        cwd: shared.cwd,
        prNumber: config.prNumber,
        headSha: config.headSha,
        reportPath: config.report,
        sourceRun: config.sourceRun,
        outputPath: config.output,
        artifactName: Option.getOrUndefined(config.artifactName),
      });
    }),
  ),
);

export const upstreamSyncCommand = upstreamSyncRootCommand.pipe(
  Command.withDescription("Synchronize an upstream release into the fork in explicit phases."),
  Command.withSubcommands([
    prepareCommand,
    verifyCommand,
    finishCommand,
    nextTagCommand,
    dryRunCommand,
    replayDryRunCommand,
    resolveOutcomeCommand,
    validateMergeCommand,
    hotspotReportCommand,
  ]),
);

if (import.meta.main) {
  Command.run(upstreamSyncCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
