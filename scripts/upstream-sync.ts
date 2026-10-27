#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const EXPECTED_REMOTES = {
  origin: "WianVDM/t3code",
  upstream: "pingdotgg/t3code",
} as const;

const TAG_REF_PREFIX = "refs/tags/";
const UPSTREAM_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FORK_SEQUENCE_PATTERN = /^(0|[1-9]\d*)$/;
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

const indentLines = (lines: ReadonlyArray<string>): string =>
  lines.map((line) => `  ${line}`).join("\n");

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
  for (const [remote, expected] of Object.entries(EXPECTED_REMOTES)) {
    const url = (yield* git(cwd, ["remote", "get-url", remote])).trim();
    if (parseGitHubRepository(url) !== expected.toLowerCase()) {
      return yield* new UpstreamSyncError({
        message: `Wrong ${remote} remote "${url}". Expected ${expected}.`,
      });
    }
  }
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
    `${TAG_REF_PREFIX}${tag}^{commit}`,
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

    const diffCheckArgs = ["diff", "--no-color", "--check", ...target.diffArgs, "HEAD", "--"];
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

  yield* git(cwd, ["fetch", "--no-recurse-submodules", "--tags", "origin"]);
  yield* git(cwd, ["fetch", "--no-recurse-submodules", "--tags", "upstream"]);
  // Explicit refspec: fetching the requested ref proves the tag exists upstream instead of trusting a local tag.
  yield* git(cwd, [
    "fetch",
    "--no-recurse-submodules",
    "upstream",
    `${TAG_REF_PREFIX}${tag}:${TAG_REF_PREFIX}${tag}`,
  ]);
  yield* git(cwd, ["rev-parse", "--verify", `${TAG_REF_PREFIX}${tag}^{commit}`]);

  const ancestryArgs = ["merge-base", "--is-ancestor", `${TAG_REF_PREFIX}${tag}`, "origin/main"];
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
    `${TAG_REF_PREFIX}${tag}..HEAD`,
    "--",
  ]);
  yield* Console.log(`Fork-only commits relative to ${tag}:\n${forkOnly.trimEnd() || "(none)"}`);

  const merge = yield* runGit(cwd, ["merge", "--no-commit", "--no-ff", "--no-edit", tag]);
  if (merge.exitCode !== 0) {
    yield* requireNoLeftoverPaths(
      cwd,
      ["diff", "--name-only", "--diff-filter=U", "-z", "--"],
      `Merge conflicts were left unresolved. Resolve and stage them, then run verify --tag ${tag}`,
    );
    return yield* new GitCommandError({
      args: ["merge", "--no-commit", "--no-ff", "--no-edit", tag],
      ...merge,
    });
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

const sharedFlags = {
  tag: Flag.String("tag").pipe(Flag.withDescription("Upstream release tag in vX.Y.Z form.")),
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Repository directory."),
    Flag.withDefault("."),
  ),
};

const upstreamSyncRootCommand = Command.make("upstream-sync").pipe(
  Command.withSharedFlags(sharedFlags),
);

const runWithSharedOptions = Effect.fn("upstream-sync.runWithSharedOptions")(function* <A, E, R>(
  operation: (options: UpstreamSyncOptions) => Effect.Effect<A, E, R>,
) {
  const options = yield* upstreamSyncRootCommand;
  yield* operation(options);
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

export const upstreamSyncCommand = upstreamSyncRootCommand.pipe(
  Command.withDescription("Synchronize an upstream release into the fork in explicit phases."),
  Command.withSubcommands([prepareCommand, verifyCommand, finishCommand, nextTagCommand]),
);

if (import.meta.main) {
  Command.run(upstreamSyncCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
