// @effect-diagnostics nodeBuiltinImport:off - pathToFileURL turns the fixture's temp repos into file:// remotes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeURL from "node:url";

import {
  computeFullWindowsPackages,
  decodeDryRunReport,
  dryRunUpstreamSync,
  DryRunReport,
  EXPECTED_REMOTES,
  findAddedConflictMarkers,
  finishUpstreamSync,
  GitCommandError,
  nextForkTag,
  parseConflictStages,
  parseGitHubRepository,
  prepareUpstreamSync,
  renderDryRunSummary,
  replayDryRun,
  resolveDryRunOutcome,
  selectLatestUpstreamTag,
  UpstreamSyncError,
  verifyUpstreamSync,
} from "./upstream-sync.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

import type { DryRunOutcomeInput } from "./upstream-sync.ts";

const TAG = "v1.2.3";
// Must stay in sync with the private VERIFIED_MERGE_RECORD_NAME in upstream-sync.ts.
const VERIFIED_MERGE_RECORD_NAME = "upstream-sync.verified.json";
const ORIGIN_REMOTE = `https://github.com/${EXPECTED_REMOTES.origin}.git`;
const UPSTREAM_REMOTE = `https://github.com/${EXPECTED_REMOTES.upstream}.git`;

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGit = Effect.fn("test.upstreamSyncGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("git", args, {
      cwd,
      stdin: "ignore",
      env,
      extendEnv: true,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  assert.equal(exitCode, 0, `git ${args.join(" ")} failed:\n${stderr}${stdout}`);
  return stdout;
}, Effect.scoped);

interface RepositoryFixture {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly git: (args: ReadonlyArray<string>) => ReturnType<typeof runGit>;
  readonly rewrites: ReadonlyArray<readonly [string, string]>;
  readonly forkHead: string;
  readonly upstreamHead: string;
  readonly originLocalUrl: string;
  readonly upstreamLocalUrl: string;
}

const makeRepositoryFixture = Effect.fn("test.makeUpstreamSyncFixture")(function* (options: {
  readonly variant: "clean" | "conflict";
  readonly extraUpstreamFiles?: Readonly<Record<string, string>>;
  readonly upstreamRenames?: ReadonlyArray<readonly [string, string]>;
}) {
  const conflict = options.variant === "conflict";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-sync-" });
  const globalConfig = path.join(root, "global.gitconfig");
  yield* fs.writeFileString(globalConfig, "");
  const env = {
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const git = (cwd: string, args: ReadonlyArray<string>) => runGit(cwd, args, env);

  const seed = path.join(root, "seed");
  yield* fs.makeDirectory(seed, { recursive: true });
  const commitSeed = (message: string) =>
    Effect.gen(function* () {
      yield* git(seed, ["add", "."]);
      yield* git(seed, ["commit", "-m", message]);
    });
  yield* git(seed, ["init", "--initial-branch=main"]);
  yield* git(seed, ["config", "user.name", "Upstream Sync Test"]);
  yield* git(seed, ["config", "user.email", "upstream-sync@example.invalid"]);
  yield* git(seed, ["config", "commit.gpgsign", "false"]);
  yield* fs.writeFileString(path.join(seed, "README.md"), "base\n");
  if (conflict) {
    yield* fs.writeFileString(path.join(seed, "conflict.txt"), "base\n");
  }
  yield* commitSeed("base");

  const originPath = path.join(root, "origin.git");
  const upstreamPath = path.join(root, "upstream.git");
  const originLocalUrl = NodeURL.pathToFileURL(originPath).href;
  const upstreamLocalUrl = NodeURL.pathToFileURL(upstreamPath).href;
  yield* git(root, ["init", "--bare", "--initial-branch=main", originPath]);
  yield* git(root, ["init", "--bare", "--initial-branch=main", upstreamPath]);

  yield* git(seed, ["switch", "-c", "fork"]);
  if (conflict) {
    yield* fs.writeFileString(path.join(seed, "conflict.txt"), "fork\n");
  } else {
    yield* fs.writeFileString(path.join(seed, "fork.txt"), "fork\n");
  }
  yield* commitSeed("fork change");
  const forkHead = (yield* git(seed, ["rev-parse", "HEAD"])).trim();
  yield* git(seed, ["push", originLocalUrl, "fork:main"]);

  yield* git(seed, ["switch", "main"]);
  if (conflict) {
    yield* fs.writeFileString(path.join(seed, "conflict.txt"), "upstream\n");
  } else {
    yield* fs.writeFileString(path.join(seed, "upstream.txt"), "upstream\n");
  }
  for (const [relative, content] of Object.entries(options.extraUpstreamFiles ?? {})) {
    const target = path.join(seed, ...relative.split("/"));
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
  }
  for (const [from, to] of options.upstreamRenames ?? []) {
    const target = path.join(seed, ...to.split("/"));
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* git(seed, ["mv", from, to]);
  }
  yield* commitSeed("upstream change");
  const upstreamHead = (yield* git(seed, ["rev-parse", "HEAD"])).trim();
  yield* git(seed, ["tag", TAG]);
  yield* git(seed, ["push", "--tags", upstreamLocalUrl, "main:main"]);

  const cwd = path.join(root, "work");
  yield* git(root, ["clone", "--branch", "main", originLocalUrl, cwd]);
  yield* git(cwd, ["remote", "set-url", "origin", ORIGIN_REMOTE]);
  yield* git(cwd, ["remote", "add", "upstream", UPSTREAM_REMOTE]);
  yield* git(cwd, ["config", "user.name", "Upstream Sync Test"]);
  yield* git(cwd, ["config", "user.email", "upstream-sync@example.invalid"]);
  yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  assert.equal((yield* git(cwd, ["remote", "get-url", "origin"])).trim(), ORIGIN_REMOTE);
  assert.equal((yield* git(cwd, ["remote", "get-url", "upstream"])).trim(), UPSTREAM_REMOTE);

  const rewrites: ReadonlyArray<readonly [string, string]> = [
    [originLocalUrl, ORIGIN_REMOTE],
    [upstreamLocalUrl, UPSTREAM_REMOTE],
  ];

  return {
    root,
    cwd,
    env,
    git: (args: ReadonlyArray<string>) => git(cwd, args),
    rewrites,
    forkHead,
    upstreamHead,
    originLocalUrl,
    upstreamLocalUrl,
  };
});

const localFetchSpawner = Effect.fn("test.localUpstreamSyncFetch")(function* (
  fixture: RepositoryFixture,
) {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rewriteArgs = fixture.rewrites.flatMap(([localUrl, gitHubUrl]) => [
    "-c",
    `url.${localUrl}.insteadOf=${gitHubUrl}`,
  ]);
  return ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return native.spawn(command);
    const talksToRemotes = command.args[0] === "fetch" || command.args[0] === "ls-remote";
    const args =
      command.command === "git" && talksToRemotes
        ? [...rewriteArgs, ...command.args]
        : command.args;
    return native.spawn(
      ChildProcess.make(command.command, args, {
        ...command.options,
        env: { ...fixture.env, ...command.options.env },
      }),
    );
  });
});

const withSpawner =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

const headParents = (git: RepositoryFixture["git"]) =>
  git(["rev-list", "--parents", "-n", "1", "HEAD"]).pipe(
    Effect.map((output) => output.trim().split(/\s+/)),
  );

// Turns the detached merge into a usage error so the failure carries no unmerged paths.
const mergeBreakingSpawner = Effect.fn("test.mergeBreakingSpawner")(function* (
  fixture: RepositoryFixture,
) {
  const fetchSpawner = yield* localFetchSpawner(fixture);
  return ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "git" &&
      command.args.includes("merge")
    ) {
      return fetchSpawner.spawn(
        ChildProcess.make(
          command.command,
          [...command.args, "--definitely-not-a-git-option"],
          command.options,
        ),
      );
    }
    return fetchSpawner.spawn(command);
  });
});

// Everything except the disposable refs/upstream-sync namespace, which dry runs own.
const localRefsSnapshot = (git: RepositoryFixture["git"]) =>
  git(["for-each-ref", "--format=%(refname) %(objectname)"]).pipe(
    Effect.map((output) =>
      output
        .split(/\r?\n/)
        .filter((line) => line.length > 0 && !line.startsWith("refs/upstream-sync/"))
        .sort(),
    ),
  );

const readReportFile = Effect.fn("test.readDryRunReport")(function* (reportPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(reportPath);
  return yield* decodeDryRunReport(text).pipe(Effect.orDie);
});

const dryRunPaths = (fixture: RepositoryFixture, path: Path.Path) => ({
  reportPath: path.join(fixture.root, "report.json"),
  summaryPath: path.join(fixture.root, "summary.md"),
});

// Simulates an octopus parent appearing only after verify recorded the two-parent state:
// injected during finish's `git commit` rather than weakening the production guard.
const commitParentInjectingSpawner = Effect.fn("test.commitParentInjectingSpawner")(function* (
  fixture: RepositoryFixture,
  extraParent: string,
) {
  const fetchSpawner = yield* localFetchSpawner(fixture);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (
        ChildProcess.isStandardCommand(command) &&
        command.command === "git" &&
        command.args.includes("commit")
      ) {
        const mergeHeadPath = path.join(fixture.cwd, ".git", "MERGE_HEAD");
        const existing = yield* fs.readFileString(mergeHeadPath);
        yield* fs.writeFileString(mergeHeadPath, `${existing.trimEnd()}\n${extraParent}\n`);
      }
      return yield* fetchSpawner.spawn(command);
    }),
  );
});

describe("upstream-sync helpers", () => {
  it("selects the next fork sequence without being limited to safe integers", () => {
    assert.equal(nextForkTag(TAG, []), `${TAG}-fork.1`);
    assert.equal(
      nextForkTag(TAG, [
        `${TAG}-fork.1`,
        `${TAG}-fork.10`,
        `${TAG}-fork.2`,
        `${TAG}-fork.02`,
        `${TAG}-fork.not-a-number`,
        "v1.2.30-fork.99",
      ]),
      `${TAG}-fork.11`,
    );
    assert.equal(
      nextForkTag(TAG, [`${TAG}-fork.9007199254740993`]),
      `${TAG}-fork.9007199254740994`,
    );
    assert.throws(() => nextForkTag("1.2.3", []), /Invalid upstream tag/);
  });

  it("parses supported GitHub remotes and rejects other repositories", () => {
    for (const remote of [
      "https://github.com/WianVDM/t3code.git",
      "http://github.com/WianVDM/t3code/",
      "git://github.com/WianVDM/t3code",
      "ssh://git@github.com/WianVDM/t3code.git",
      "git@github.com:WianVDM/t3code.git",
      "  https://github.com/WianVDM/t3code  ",
    ]) {
      assert.equal(parseGitHubRepository(remote), "wianvdm/t3code", remote);
    }
    for (const remote of [
      "https://gitlab.com/WianVDM/t3code",
      "https://github.com/WianVDM/t3code/issues",
      "https://github.com/Wian_VDM/t3code",
      "https://github.com/WianVDM/",
      "file:///tmp/WianVDM/t3code",
    ]) {
      assert.isUndefined(parseGitHubRepository(remote), remote);
    }
  });

  it("finds only conflict markers added by a patch", () => {
    const patch = [
      "diff --cc conflict.txt",
      "--- a/conflict.txt",
      "+++ b/conflict.txt",
      " <<<<<<< context",
      "-<<<<<<< removed",
      "+<<<<<<< HEAD",
      "+fork",
      "+=======",
      "+upstream",
      "+>>>>>>> v1.2.3",
      "+||||||| base",
      "+not a marker: <<<<<<<",
    ].join("\n");
    assert.deepStrictEqual(findAddedConflictMarkers(patch), [
      "<<<<<<< HEAD",
      "=======",
      ">>>>>>> v1.2.3",
      "||||||| base",
    ]);
  });
});

it.live("prepare, verify, and finish create a real two-parent merge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const options = { tag: TAG, cwd: fixture.cwd };

      yield* Effect.gen(function* () {
        const prepared = yield* prepareUpstreamSync(options);
        assert.deepStrictEqual(prepared, { branch: `sync/upstream-${TAG}` });
        assert.equal((yield* fixture.git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
        assert.equal(
          (yield* fixture.git(["rev-parse", "MERGE_HEAD"])).trim(),
          fixture.upstreamHead,
        );

        const verified = yield* verifyUpstreamSync(options);
        assert.equal(verified.mergeHead, fixture.upstreamHead);
        assert.equal((yield* fixture.git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);

        yield* finishUpstreamSync(options);
      }).pipe(withSpawner(spawner));

      const parents = yield* headParents(fixture.git);
      assert.equal(parents.length, 3);
      assert.equal(parents[1], fixture.forkHead);
      assert.equal(parents[2], fixture.upstreamHead);
      assert.equal((yield* fixture.git(["status", "--porcelain"])).trim(), "");
      assert.equal((yield* fixture.git(["show", "HEAD:fork.txt"])).trim(), "fork");
      assert.equal((yield* fixture.git(["show", "HEAD:upstream.txt"])).trim(), "upstream");
      assert.equal((yield* fixture.git(["remote", "get-url", "origin"])).trim(), ORIGIN_REMOTE);
      assert.equal((yield* fixture.git(["remote", "get-url", "upstream"])).trim(), UPSTREAM_REMOTE);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("prepare, verify, and finish sync a release the fork already tagged locally", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const git = fixture.git;
      const options = { tag: TAG, cwd: fixture.cwd };
      const tagsSnapshot = () =>
        git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/tags"]);

      // The fork owns its own tag on a fork-only commit, colliding with the upstream release name.
      yield* git(["tag", TAG, fixture.forkHead]);
      const tagsBefore = yield* tagsSnapshot();
      assert.equal(
        (yield* git(["rev-parse", `refs/tags/${TAG}^{commit}`])).trim(),
        fixture.forkHead,
      );

      yield* Effect.gen(function* () {
        const prepared = yield* prepareUpstreamSync(options);
        assert.deepStrictEqual(prepared, { branch: `sync/upstream-${TAG}` });
        assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
        assert.equal((yield* git(["rev-parse", "MERGE_HEAD"])).trim(), fixture.upstreamHead);

        const verified = yield* verifyUpstreamSync(options);
        assert.equal(verified.mergeHead, fixture.upstreamHead);

        yield* finishUpstreamSync(options);
      }).pipe(withSpawner(spawner));

      const parents = yield* headParents(git);
      assert.equal(parents.length, 3);
      assert.equal(parents[1], fixture.forkHead);
      assert.equal(parents[2], fixture.upstreamHead);
      assert.equal((yield* git(["status", "--porcelain"])).trim(), "");
      assert.equal(
        (yield* git(["rev-parse", `refs/upstream-sync/${TAG}^{commit}`])).trim(),
        fixture.upstreamHead,
      );
      assert.deepStrictEqual(yield* tagsSnapshot(), tagsBefore);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("verify and finish reject unstaged tracked edits until they are staged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = fixture.git;
      const options = { tag: TAG, cwd: fixture.cwd };

      yield* withSpawner(spawner)(prepareUpstreamSync(options));

      yield* fs.writeFileString(path.join(fixture.cwd, "fork.txt"), "fork\nunstaged edit\n");
      assert.equal((yield* git(["diff", "--name-only"])).trim(), "fork.txt");

      for (const operation of [verifyUpstreamSync, finishUpstreamSync]) {
        const error = yield* Effect.flip(withSpawner(spawner)(operation(options)));
        assert.instanceOf(error, UpstreamSyncError);
        assert.match(error.message, /Tracked working-tree changes are not staged[\s\S]*fork\.txt/);
        assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
        assert.equal((yield* git(["rev-parse", "MERGE_HEAD"])).trim(), fixture.upstreamHead);
      }

      yield* git(["add", "fork.txt"]);
      const verified = yield* withSpawner(spawner)(verifyUpstreamSync(options));
      assert.equal(verified.mergeHead, fixture.upstreamHead);

      yield* withSpawner(spawner)(finishUpstreamSync(options));
      assert.equal((yield* git(["show", "HEAD:fork.txt"])).trim(), "fork\nunstaged edit");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("finish rejects staged drift after verify until the new resolution is re-verified", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = fixture.git;
      const options = { tag: TAG, cwd: fixture.cwd };
      const gitDir = (yield* git(["rev-parse", "--absolute-git-dir"])).trim();
      const recordPath = path.join(gitDir, VERIFIED_MERGE_RECORD_NAME);

      yield* withSpawner(spawner)(prepareUpstreamSync(options));
      const verified = yield* withSpawner(spawner)(verifyUpstreamSync(options));
      assert.equal(verified.mergeHead, fixture.upstreamHead);
      assert.isTrue(yield* fs.exists(recordPath));

      yield* fs.writeFileString(path.join(fixture.cwd, "fork.txt"), "fork\nrevised resolution\n");
      yield* git(["add", "fork.txt"]);
      assert.include(
        (yield* git(["diff", "--cached", "--name-only"])).trim().split(/\r?\n/),
        "fork.txt",
      );

      const driftError = yield* Effect.flip(withSpawner(spawner)(finishUpstreamSync(options)));
      assert.instanceOf(driftError, UpstreamSyncError);
      assert.match(driftError.message, /no longer matches the verified resolution/);
      assert.match(driftError.message, /staged tree changed/);
      assert.match(driftError.message, /verify --tag v1\.2\.3/);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
      assert.equal((yield* git(["rev-parse", "MERGE_HEAD"])).trim(), fixture.upstreamHead);
      assert.isTrue(yield* fs.exists(recordPath));

      // Re-verifying the new resolution rewrites the record, so finish commits it.
      yield* withSpawner(spawner)(verifyUpstreamSync(options));
      yield* withSpawner(spawner)(finishUpstreamSync(options));
      assert.isFalse(yield* fs.exists(recordPath));

      const parents = yield* headParents(git);
      assert.deepStrictEqual(parents.slice(1), [fixture.forkHead, fixture.upstreamHead]);
      assert.equal((yield* git(["show", "HEAD:fork.txt"])).trim(), "fork\nrevised resolution");
      assert.equal((yield* git(["status", "--porcelain"])).trim(), "");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a non-ignored untracked file blocks verify and finish until it is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = fixture.git;
      const options = { tag: TAG, cwd: fixture.cwd };

      yield* withSpawner(spawner)(prepareUpstreamSync(options));
      yield* fs.writeFileString(path.join(fixture.cwd, "scratch.txt"), "scratch\n");

      for (const operation of [verifyUpstreamSync, finishUpstreamSync]) {
        const error = yield* Effect.flip(withSpawner(spawner)(operation(options)));
        assert.instanceOf(error, UpstreamSyncError);
        assert.match(
          error.message,
          /Untracked files would not be part of the merge commit[\s\S]*scratch\.txt/,
        );
        assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
        assert.equal((yield* git(["rev-parse", "MERGE_HEAD"])).trim(), fixture.upstreamHead);
      }

      yield* fs.remove(path.join(fixture.cwd, "scratch.txt"));
      yield* withSpawner(spawner)(verifyUpstreamSync(options));
      yield* withSpawner(spawner)(finishUpstreamSync(options));

      const parents = yield* headParents(git);
      assert.deepStrictEqual(parents.slice(1), [fixture.forkHead, fixture.upstreamHead]);
      assert.equal((yield* git(["status", "--porcelain"])).trim(), "");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("prepare rejects a stale local tag missing upstream without creating a branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const git = fixture.git;

      yield* git(["fetch", fixture.upstreamLocalUrl, `refs/tags/${TAG}:refs/tags/${TAG}`]);
      yield* git(["push", fixture.upstreamLocalUrl, `:refs/tags/${TAG}`]);
      assert.equal(
        (yield* git(["rev-parse", `refs/tags/${TAG}^{commit}`])).trim(),
        fixture.upstreamHead,
      );
      assert.equal(
        (yield* git(["ls-remote", fixture.upstreamLocalUrl, `refs/tags/${TAG}`])).trim(),
        "",
      );

      const error = yield* Effect.flip(
        withSpawner(spawner)(prepareUpstreamSync({ tag: TAG, cwd: fixture.cwd })),
      );
      assert.instanceOf(error, GitCommandError);
      assert.match(error.message, /couldn't find remote ref refs\/tags\/v1\.2\.3/);
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "main");
      assert.equal((yield* git(["branch", "--list", `sync/upstream-${TAG}`])).trim(), "");
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("prepare skips a merge when the tag is already integrated into origin main", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = fixture.git;
      const integratedTag = "v1.2.2";

      yield* git(["tag", integratedTag, `${fixture.forkHead}^`]);
      yield* git([
        "push",
        fixture.upstreamLocalUrl,
        `refs/tags/${integratedTag}:refs/tags/${integratedTag}`,
      ]);

      const prepared = yield* withSpawner(spawner)(
        prepareUpstreamSync({ tag: integratedTag, cwd: fixture.cwd }),
      );
      assert.deepStrictEqual(prepared, { branch: null });
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "main");
      assert.equal((yield* git(["branch", "--list", `sync/upstream-${integratedTag}`])).trim(), "");
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
      assert.isFalse(yield* fs.exists(path.join(fixture.cwd, ".git", "MERGE_HEAD")));
      assert.equal((yield* git(["status", "--porcelain"])).trim(), "");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("prepare reports a real conflict and leaves it unresolved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "conflict" });
      const spawner = yield* localFetchSpawner(fixture);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = fixture.git;

      const error = yield* Effect.flip(
        withSpawner(spawner)(prepareUpstreamSync({ tag: TAG, cwd: fixture.cwd })),
      );
      assert.instanceOf(error, UpstreamSyncError);
      assert.match(error.message, /Merge conflicts were left unresolved[\s\S]*conflict\.txt/);
      assert.equal((yield* git(["branch", "--show-current"])).trim(), `sync/upstream-${TAG}`);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
      assert.equal((yield* git(["rev-parse", "MERGE_HEAD"])).trim(), fixture.upstreamHead);
      assert.equal((yield* git(["diff", "--name-only", "--diff-filter=U"])).trim(), "conflict.txt");

      const conflictText = yield* fs.readFileString(path.join(fixture.cwd, "conflict.txt"));
      assert.isTrue(conflictText.includes("<<<<<<< HEAD\n"));
      assert.isTrue(conflictText.includes("\nfork\n=======\nupstream\n"));
      assert.isTrue(conflictText.includes(`>>>>>>> refs/upstream-sync/${TAG}`));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "verify and finish reject an extra MERGE_HEAD parent in either order without committing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        for (const order of ["tag-first", "extra-first"] as const) {
          const fixture = yield* makeRepositoryFixture({ variant: "clean" });
          const spawner = yield* localFetchSpawner(fixture);
          const git = fixture.git;
          const options = { tag: TAG, cwd: fixture.cwd };
          const gitDir = (yield* git(["rev-parse", "--absolute-git-dir"])).trim();
          const mergeHeadPath = path.join(gitDir, "MERGE_HEAD");
          const recordPath = path.join(gitDir, VERIFIED_MERGE_RECORD_NAME);

          yield* withSpawner(spawner)(prepareUpstreamSync(options));

          const extraParent = (yield* git(["rev-parse", `${fixture.forkHead}^`])).trim();
          const entries =
            order === "tag-first"
              ? [fixture.upstreamHead, extraParent]
              : [extraParent, fixture.upstreamHead];
          yield* fs.writeFileString(mergeHeadPath, `${entries.join("\n")}\n`);

          for (const operation of [verifyUpstreamSync, finishUpstreamSync]) {
            const error = yield* Effect.flip(withSpawner(spawner)(operation(options)));
            assert.instanceOf(error, UpstreamSyncError, order);
            assert.match(
              error.message,
              /MERGE_HEAD \([0-9a-f]+, [0-9a-f]+\) must contain exactly v1\.2\.3 \([0-9a-f]+\) and no other entries\./,
              order,
            );
            assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead, order);
            assert.isFalse(yield* fs.exists(recordPath), order);
          }

          const parents = yield* headParents(git);
          assert.equal(parents.length, 2, `${order}: HEAD must not become a merge commit`);
          const mergeHeadText = yield* fs.readFileString(mergeHeadPath);
          assert.deepStrictEqual(mergeHeadText.trim().split(/\r?\n/), entries, order);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "finish rejects a commit that gains an extra parent after verify and keeps the record",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRepositoryFixture({ variant: "clean" });
        const git = fixture.git;
        const options = { tag: TAG, cwd: fixture.cwd };
        const extraParent = (yield* git(["rev-parse", `${fixture.forkHead}^`])).trim();
        const spawner = yield* commitParentInjectingSpawner(fixture, extraParent);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const gitDir = (yield* git(["rev-parse", "--absolute-git-dir"])).trim();
        const recordPath = path.join(gitDir, VERIFIED_MERGE_RECORD_NAME);

        yield* withSpawner(spawner)(prepareUpstreamSync(options));
        const verified = yield* withSpawner(spawner)(verifyUpstreamSync(options));
        assert.equal(verified.mergeHead, fixture.upstreamHead);
        assert.isTrue(yield* fs.exists(recordPath));

        // The extra parent makes the commit an octopus merge the verified record never approved.
        const error = yield* Effect.flip(withSpawner(spawner)(finishUpstreamSync(options)));
        assert.instanceOf(error, UpstreamSyncError);
        assert.match(error.message, /is not the verified merge of v1\.2\.3/);
        assert.isTrue(yield* fs.exists(recordPath));

        const parents = yield* headParents(git);
        assert.deepStrictEqual(parents.slice(1), [
          fixture.forkHead,
          fixture.upstreamHead,
          extraParent,
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

describe("upstream-sync dry-run helpers", () => {
  it("selects the greatest strict stable tag and rejects everything else", () => {
    assert.isUndefined(selectLatestUpstreamTag([]));
    assert.isUndefined(
      selectLatestUpstreamTag(["main", "v1.2", "v1.2.3-rc.1", "refs/tags/v1.0.0"]),
    );
    assert.equal(selectLatestUpstreamTag(["v1.2.3", "v1.2.10", "v1.10.0", "v0.9.9"]), "v1.10.0");
    assert.equal(selectLatestUpstreamTag(["v2.0.0", "v10.0.0", "v9.9.9"]), "v10.0.0");
    // Prereleases, fork tags, malformed names, option-like values, and embedded
    // newlines never win; only strict vX.Y.Z survives.
    assert.equal(
      selectLatestUpstreamTag([
        "v1.0.0",
        "v2.0.0-rc.1",
        "v2.0.0-fork.1",
        "v02.0.0",
        "-v3.0.0",
        "v3.0.0\nv9.9.9",
        "latest",
      ]),
      "v1.0.0",
    );
    // BigInt components: beyond safe integers the numerically greatest still wins.
    assert.equal(
      selectLatestUpstreamTag(["v9007199254740993.0.0", "v1.0.0"]),
      "v9007199254740993.0.0",
    );
  });

  it("groups conflict stages by path from ls-files -u -s -z output", () => {
    const output = [
      "100644 1111111111111111111111111111111111111111 1\tconflict.txt",
      "100644 2222222222222222222222222222222222222222 2\tconflict.txt",
      "100644 3333333333333333333333333333333333333333 3\tconflict.txt",
      "100644 1111111111111111111111111111111111111111 1\tother.txt",
      "100644 3333333333333333333333333333333333333333 3\tother.txt",
      "",
    ].join("\0");
    assert.deepStrictEqual(parseConflictStages(["conflict.txt", "other.txt"], output), [
      { path: "conflict.txt", stages: [1, 2, 3] },
      { path: "other.txt", stages: [1, 3] },
    ]);
    assert.deepStrictEqual(parseConflictStages(["absent.txt"], output), [
      { path: "absent.txt", stages: [] },
    ]);
  });

  it("escapes unusual paths and caps long sections in the summary", () => {
    const paths = Array.from({ length: 205 }, (_, index) => `pkg/${index}.ts`);
    const report: DryRunReport = {
      schemaVersion: 1,
      requestedTag: "latest",
      tag: "v1.2.3",
      baseSha: "b".repeat(40),
      mergeBaseSha: "m".repeat(40),
      upstreamSha: "u".repeat(40),
      mergeCommit: null,
      tree: null,
      status: "conflict",
      incomingPaths: ['weird "path"\t.ts', ...paths],
      classification: {
        fork: paths.map((path) => ({ path, category: "fork" as const, diverged: false })),
        seam: [{ path: 'seam "x".ts', category: "seam" as const, diverged: true }],
        shared: [],
      },
      conflicts: [{ path: 'weird "path"\t.ts', stages: [1, 2, 3] }],
      windowsPackages: [],
    };
    const summary = renderDryRunSummary(report, null);
    // The unusual path only appears JSON-escaped, never raw.
    assert.include(summary, JSON.stringify('weird "path"\t.ts'));
    assert.isFalse(summary.includes('weird "path"\t.ts\n'));
    // A 205-entry section shows 200 and names the remainder.
    assert.include(summary, "and 5 more");
    assert.include(summary, "++-owned (205)");
    assert.include(summary, "(diverged)");
    assert.include(summary, "prepare --tag v1.2.3");
  });
});

describe("resolveDryRunOutcome", () => {
  const lane = (result: string, verification: string | null = null) => ({ result, verification });
  const input = (overrides: Partial<DryRunOutcomeInput> = {}): DryRunOutcomeInput => ({
    mergeStatus: "clean",
    mergeResult: "success",
    reportPresent: true,
    linux: lane("success", "passed"),
    windows: lane("success", "passed"),
    ...overrides,
  });

  it("passes a clean merge that verifies on both lanes", () => {
    const outcome = resolveDryRunOutcome(input());
    assert.equal(outcome.outcome, "passed");
    assert.isTrue(outcome.success);
    assert.deepEqual(outcome.lanes, { linux: "passed", windows: "passed" });
    assert.deepEqual(outcome.problems, []);
  });

  it("succeeds on already integrated with both lanes skipped", () => {
    const outcome = resolveDryRunOutcome(
      input({
        mergeStatus: "already_integrated",
        linux: lane("skipped"),
        windows: lane("skipped"),
      }),
    );
    assert.equal(outcome.outcome, "already_integrated");
    assert.isTrue(outcome.success);
    assert.deepEqual(outcome.problems, []);
  });

  it("reports a conflict as failure without running lanes", () => {
    const outcome = resolveDryRunOutcome(
      input({
        mergeStatus: "conflict",
        mergeResult: "failure",
        linux: lane("skipped"),
        windows: lane("skipped"),
      }),
    );
    assert.equal(outcome.outcome, "conflict");
    assert.isFalse(outcome.success);
    assert.deepEqual(outcome.problems, []);
  });

  it("reports a merge integrity failure distinctly from a conflict", () => {
    const outcome = resolveDryRunOutcome(
      input({
        mergeStatus: "merge_verification_failed",
        mergeResult: "failure",
        linux: lane("skipped"),
        windows: lane("skipped"),
      }),
    );
    assert.equal(outcome.outcome, "merge_verification_failed");
    assert.isFalse(outcome.success);
  });

  it("maps a started lane verification failure to verification_failed", () => {
    const outcome = resolveDryRunOutcome(
      input({ windows: lane("failure", "verification_failed") }),
    );
    assert.equal(outcome.outcome, "verification_failed");
    assert.isFalse(outcome.success);
    assert.deepEqual(outcome.lanes, { linux: "passed", windows: "verification_failed" });
  });

  it("outranks a lane verification failure with an infrastructure error on the other lane", () => {
    const outcome = resolveDryRunOutcome(
      input({
        linux: lane("failure", "verification_failed"),
        windows: lane("failure", "error"),
      }),
    );
    assert.equal(outcome.outcome, "error");
    assert.isFalse(outcome.success);
    // Both lane states are preserved even though the overall outcome is error.
    assert.deepEqual(outcome.lanes, { linux: "verification_failed", windows: "error" });
  });

  it("fails closed on cancellation", () => {
    for (const mergeResult of ["cancelled", ""]) {
      const outcome = resolveDryRunOutcome(input({ mergeResult }));
      assert.equal(outcome.outcome, "error", mergeResult);
      assert.isFalse(outcome.success, mergeResult);
    }
    const cancelledLane = resolveDryRunOutcome(input({ linux: lane("cancelled") }));
    assert.equal(cancelledLane.outcome, "error");
    assert.equal(cancelledLane.lanes.linux, "error");
  });

  it("fails closed on missing or unexpected merge outputs", () => {
    for (const mergeStatus of [null, "", "surprise"]) {
      const outcome = resolveDryRunOutcome(input({ mergeStatus }));
      assert.equal(outcome.outcome, "error", JSON.stringify(mergeStatus));
      assert.isFalse(outcome.success, JSON.stringify(mergeStatus));
    }
  });

  it("fails closed when the diagnostics report is missing", () => {
    const outcome = resolveDryRunOutcome(input({ reportPresent: false }));
    assert.equal(outcome.outcome, "error");
    assert.isFalse(outcome.success);
  });

  it("fails closed when a clean merge skips a lane or a lane fails without a result", () => {
    const skipped = resolveDryRunOutcome(input({ linux: lane("skipped") }));
    assert.equal(skipped.outcome, "error");
    const noVerification = resolveDryRunOutcome(input({ windows: lane("failure", null) }));
    assert.equal(noVerification.outcome, "error");
    assert.equal(noVerification.lanes.windows, "error");
  });

  it("fails closed when a lane runs despite an already integrated tag", () => {
    const outcome = resolveDryRunOutcome(
      input({ mergeStatus: "already_integrated", linux: lane("success", "passed") }),
    );
    assert.equal(outcome.outcome, "error");
    assert.isFalse(outcome.success);
  });
});

it.live("dry-run merges on a detached ref and mutates no branch, tag, or remote", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({
        variant: "clean",
        extraUpstreamFiles: {
          "AGENTS.md": "fork governance\n",
          ".agents/we ird's path.txt": "odd name\n",
          "packages/shared/src/promptLinks.ts": "export const promptLinks = [];\n",
          "scripts/dry-run-tool.txt": "tool\n",
        },
        upstreamRenames: [["README.md", "docs/README.md"]],
      });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      // A same-named fork tag must survive the upstream fetch into the namespace.
      yield* git(["tag", TAG, fixture.forkHead]);
      const refsBefore = yield* localRefsSnapshot(git);
      const originRefsBefore = (yield* git(["ls-remote", fixture.originLocalUrl])).trim();
      const mergeBase = (yield* git(["rev-parse", `${fixture.forkHead}^`])).trim();
      const githubOutputPath = path.join(fixture.root, "github-output.txt");

      process.env.GITHUB_OUTPUT = githubOutputPath;
      let report: DryRunReport;
      try {
        report = yield* withSpawner(spawner)(
          dryRunUpstreamSync({
            tag: TAG,
            cwd: fixture.cwd,
            ...paths,
            githubOutput: true,
            windowsPackages: ["scripts"],
          }),
        );
      } finally {
        delete process.env.GITHUB_OUTPUT;
      }

      assert.equal(report.schemaVersion, 1);
      assert.equal(report.status, "clean");
      assert.equal(report.requestedTag, TAG);
      assert.equal(report.tag, TAG);
      assert.equal(report.baseSha, fixture.forkHead);
      assert.equal(report.mergeBaseSha, mergeBase);
      assert.equal(report.upstreamSha, fixture.upstreamHead);
      assert.isNotNull(report.mergeCommit);
      assert.isNotNull(report.tree);

      // Exactly two parents, base then upstream, and the recorded tree matches HEAD.
      const parents = yield* headParents(git);
      assert.deepEqual(parents.slice(1), [fixture.forkHead, fixture.upstreamHead]);
      assert.equal(parents[0], report.mergeCommit);
      assert.equal((yield* git(["rev-parse", "--verify", "HEAD^{tree}"])).trim(), report.tree);

      // Detached: no branch checked out, no sync branch, no ref or remote mutation.
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "");
      assert.equal((yield* git(["branch", "--list", `sync/upstream-${TAG}`])).trim(), "");
      assert.deepEqual(yield* localRefsSnapshot(git), refsBefore);
      // The same-named fork tag still points at the fork commit, not upstream.
      assert.equal(
        (yield* git(["rev-parse", `refs/tags/${TAG}^{commit}`])).trim(),
        fixture.forkHead,
      );
      assert.equal((yield* git(["ls-remote", fixture.originLocalUrl])).trim(), originRefsBefore);
      assert.equal((yield* git(["remote", "get-url", "origin"])).trim(), ORIGIN_REMOTE);
      assert.equal((yield* git(["remote", "get-url", "upstream"])).trim(), UPSTREAM_REMOTE);
      assert.equal((yield* git(["status", "--porcelain"])).trim(), "");
      assert.equal((yield* git(["show", "HEAD:upstream.txt"])).trim(), "upstream");
      assert.equal((yield* git(["show", "HEAD:fork.txt"])).trim(), "fork");

      // A no-rename diff lists both sides of the rename, and the fork-only file
      // is not reported as deleted. Real classifier: fork, seam, and shared.
      assert.deepEqual([...report.incomingPaths].sort(), [
        ".agents/we ird's path.txt",
        "AGENTS.md",
        "README.md",
        "docs/README.md",
        "packages/shared/src/promptLinks.ts",
        "scripts/dry-run-tool.txt",
        "upstream.txt",
      ]);
      const sortedFork = [...report.classification.fork].sort((a, b) => (a.path < b.path ? -1 : 1));
      assert.deepEqual(sortedFork, [
        { path: ".agents/we ird's path.txt", category: "fork", diverged: false },
        { path: "AGENTS.md", category: "fork", diverged: false },
      ]);
      assert.deepEqual(report.classification.seam, [
        { path: "packages/shared/src/promptLinks.ts", category: "seam", diverged: true },
      ]);
      assert.deepEqual(report.classification.shared.map((entry) => entry.path).sort(), [
        "README.md",
        "docs/README.md",
        "scripts/dry-run-tool.txt",
        "upstream.txt",
      ]);
      assert.deepEqual(report.conflicts, []);
      assert.deepEqual(report.windowsPackages, ["scripts"]);

      // The JSON report round-trips through the versioned schema, the summary
      // escapes unusual paths, and GITHUB_OUTPUT carries the lane inputs.
      const persisted = yield* readReportFile(paths.reportPath);
      assert.deepEqual(persisted, report);
      const summary = yield* fs.readFileString(paths.summaryPath);
      assert.include(summary, JSON.stringify(".agents/we ird's path.txt"));
      assert.include(summary, "(diverged)");
      assert.include(summary, "**clean**");
      const output = yield* fs.readFileString(githubOutputPath);
      assert.include(output, "status=clean\n");
      assert.include(output, `tag=${TAG}\n`);
      assert.include(output, `base_sha=${fixture.forkHead}\n`);
      assert.include(output, "windows_packages=scripts\n");
      assert.include(output, `merge_tree=${report.tree}\n`);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run reports a real conflict with stages and commits nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "conflict" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      const refsBefore = yield* localRefsSnapshot(git);

      const error = yield* Effect.flip(
        withSpawner(spawner)(
          dryRunUpstreamSync({ tag: TAG, cwd: fixture.cwd, ...paths, githubOutput: false }),
        ),
      );
      assert.instanceOf(error, UpstreamSyncError);
      assert.match(error.message, /prepare --tag v1\.2\.3/);

      const report = yield* readReportFile(paths.reportPath);
      assert.equal(report.status, "conflict");
      assert.deepEqual(report.conflicts, [{ path: "conflict.txt", stages: [1, 2, 3] }]);
      assert.deepEqual(report.incomingPaths, ["conflict.txt"]);
      assert.deepEqual(
        report.classification.shared.map((entry) => entry.path),
        ["conflict.txt"],
      );
      assert.isNull(report.mergeCommit);
      assert.isNull(report.tree);
      // No merge commit was created and no ref moved.
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
      assert.equal((yield* headParents(git)).length, 2);
      assert.deepEqual(yield* localRefsSnapshot(git), refsBefore);
      const summary = yield* fs.readFileString(paths.summaryPath);
      assert.include(summary, `node scripts/upstream-sync.ts prepare --tag ${TAG}`);
      assert.include(summary, '"conflict.txt" (stages 1, 2, 3)');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run distinguishes a conflict-marker clean merge from a real conflict", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Upstream adds a file that already contains conflict markers, so the merge
      // is clean but integrity verification must reject it.
      const fixture = yield* makeRepositoryFixture({
        variant: "clean",
        extraUpstreamFiles: {
          "docs/marker.md": "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> v1.2.3\nafter\n",
        },
      });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);

      const error = yield* Effect.flip(
        withSpawner(spawner)(
          dryRunUpstreamSync({ tag: TAG, cwd: fixture.cwd, ...paths, githubOutput: false }),
        ),
      );
      assert.instanceOf(error, UpstreamSyncError);
      assert.match(error.message, /integrity verification/);

      const report = yield* readReportFile(paths.reportPath);
      assert.equal(report.status, "merge_verification_failed");
      // Distinct from a conflict: no unmerged paths and no downstream verification.
      assert.deepEqual(report.conflicts, []);
      assert.isNull(report.mergeCommit);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run maps a non-conflict merge failure to an infrastructure error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* mergeBreakingSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);

      const error = yield* Effect.flip(
        withSpawner(spawner)(
          dryRunUpstreamSync({ tag: TAG, cwd: fixture.cwd, ...paths, githubOutput: false }),
        ),
      );
      assert.instanceOf(error, GitCommandError);

      const report = yield* readReportFile(paths.reportPath);
      assert.equal(report.status, "error");
      assert.deepEqual(report.conflicts, []);
      assert.isNull(report.mergeCommit);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run reports an already integrated tag without merging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const integratedTag = "v1.2.2";
      yield* git(["tag", integratedTag, `${fixture.forkHead}^`]);
      yield* git([
        "push",
        fixture.upstreamLocalUrl,
        `refs/tags/${integratedTag}:refs/tags/${integratedTag}`,
      ]);
      const refsBefore = yield* localRefsSnapshot(git);
      const paths = dryRunPaths(fixture, path);

      const report = yield* withSpawner(spawner)(
        dryRunUpstreamSync({ tag: integratedTag, cwd: fixture.cwd, ...paths, githubOutput: false }),
      );

      assert.equal(report.status, "already_integrated");
      assert.equal(report.tag, integratedTag);
      assert.equal(report.upstreamSha, (yield* git(["rev-parse", `${fixture.forkHead}^`])).trim());
      assert.isNull(report.mergeCommit);
      assert.isNull(report.tree);
      assert.deepEqual(report.incomingPaths, []);
      assert.deepEqual(report.windowsPackages, []);
      // HEAD is the detached base; nothing merged and no ref moved.
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
      assert.equal((yield* headParents(git)).length, 2);
      assert.deepEqual(yield* localRefsSnapshot(git), refsBefore);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run rejects an invalid tag and a manual run never falls back to latest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;

      for (const tag of [
        "1.2.3",
        "v1.2",
        "v1.2.3-rc.1",
        "refs/tags/v1.2.3",
        "-v1.2.3",
        "v1.2.3\nv9.9.9",
        "main",
      ]) {
        const paths = dryRunPaths(fixture, path);
        const error = yield* Effect.flip(
          withSpawner(spawner)(
            dryRunUpstreamSync({ tag, cwd: fixture.cwd, ...paths, githubOutput: false }),
          ),
        );
        assert.instanceOf(error, UpstreamSyncError, tag);
        assert.match(error.message, /Invalid upstream tag/, tag);
        const report = yield* readReportFile(paths.reportPath);
        assert.equal(report.status, "error", tag);
        assert.equal(report.requestedTag, tag, tag);
        assert.isNull(report.baseSha, tag);
      }

      // Validation precedes repository mutation, so the branch was never detached.
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "main");

      // A missing upstream tag is an error; a manual tag never falls back to latest.
      const paths = dryRunPaths(fixture, path);
      const missing = yield* Effect.flip(
        withSpawner(spawner)(
          dryRunUpstreamSync({ tag: "v9.9.9", cwd: fixture.cwd, ...paths, githubOutput: false }),
        ),
      );
      assert.instanceOf(missing, GitCommandError);
      assert.match(missing.message, /couldn't find remote ref/);
      const missingReport = yield* readReportFile(paths.reportPath);
      assert.equal(missingReport.status, "error");
      assert.equal(missingReport.tag, "v9.9.9");
      assert.isNull(missingReport.upstreamSha);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("scheduled dry-run selects the latest annotated stable tag", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      // v1.10.0 is annotated and numerically greater than v1.2.3 and v1.9.0. The
      // seed repository owns the upstream objects, so publish the tags from there.
      const seed = path.join(fixture.root, "seed");
      yield* runGit(
        seed,
        ["tag", "-a", "v1.10.0", "-m", "annotated", fixture.upstreamHead],
        fixture.env,
      );
      yield* runGit(
        seed,
        ["push", fixture.upstreamLocalUrl, "refs/tags/v1.10.0:refs/tags/v1.10.0"],
        fixture.env,
      );
      yield* runGit(seed, ["tag", "v1.9.0", fixture.upstreamHead], fixture.env);
      yield* runGit(
        seed,
        ["push", fixture.upstreamLocalUrl, "refs/tags/v1.9.0:refs/tags/v1.9.0"],
        fixture.env,
      );
      const paths = dryRunPaths(fixture, path);

      const report = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: "latest",
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );

      assert.equal(report.requestedTag, "latest");
      assert.equal(report.tag, "v1.10.0");
      assert.equal(report.upstreamSha, fixture.upstreamHead);
      assert.equal(report.status, "clean");
      // The namespaced fetch never writes refs/tags in the working repository.
      assert.equal((yield* git(["tag", "--list", "v1.10.0"])).trim(), "");
      assert.equal(
        (yield* git(["rev-parse", `refs/upstream-sync/v1.10.0^{commit}`])).trim(),
        fixture.upstreamHead,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replay-dry-run reproduces the verified merge identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      const first = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: TAG,
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );
      assert.equal(first.status, "clean");
      const baseSha = first.baseSha ?? "";
      const upstreamSha = first.upstreamSha ?? "";
      const expectedTree = first.tree ?? "";

      // Reset to the base and replay from scratch; parents and tree must match.
      yield* git(["checkout", "--detach", baseSha]);
      const replayed = yield* withSpawner(spawner)(
        replayDryRun({ tag: TAG, cwd: fixture.cwd, baseSha, upstreamSha, expectedTree }),
      );
      assert.equal(replayed.tree, expectedTree);
      const parents = yield* headParents(git);
      assert.deepEqual(parents.slice(1), [baseSha, upstreamSha]);
      assert.equal((yield* git(["rev-parse", "--verify", "HEAD^{tree}"])).trim(), expectedTree);
      // The commit SHA and timestamp need not match the original merge commit.
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replay-dry-run fails on a moved tag before any verification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      const first = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: TAG,
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );
      const baseSha = first.baseSha ?? "";
      yield* git(["checkout", "--detach", baseSha]);

      // Move the upstream tag to a different commit after the dry run recorded it.
      const moved = (yield* git([
        "commit-tree",
        (yield* git(["rev-parse", `${fixture.upstreamHead}^{tree}`])).trim(),
        "-p",
        fixture.upstreamHead,
        "-m",
        "moved",
      ])).trim();
      yield* git(["push", "--force", fixture.upstreamLocalUrl, `${moved}:refs/tags/${TAG}`]);

      const error = yield* Effect.flip(
        withSpawner(spawner)(
          replayDryRun({
            tag: TAG,
            cwd: fixture.cwd,
            baseSha,
            upstreamSha: first.upstreamSha ?? "",
            expectedTree: first.tree ?? "",
          }),
        ),
      );
      assert.instanceOf(error, UpstreamSyncError);
      assert.match(error.message, /tag moved/i);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), baseSha);
      assert.equal((yield* headParents(git)).length, 2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replay-dry-run fails on a wrong expected tree and a wrong checked-out base", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      const first = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: TAG,
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );
      const baseSha = first.baseSha ?? "";
      const upstreamSha = first.upstreamSha ?? "";

      // A wrong expected tree fails after the commit, on the identity check.
      yield* git(["checkout", "--detach", baseSha]);
      const treeError = yield* Effect.flip(
        withSpawner(spawner)(
          replayDryRun({
            tag: TAG,
            cwd: fixture.cwd,
            baseSha,
            upstreamSha,
            expectedTree: "0".repeat(40),
          }),
        ),
      );
      assert.instanceOf(treeError, UpstreamSyncError);
      assert.match(treeError.message, /expected 0{40}/);

      // A wrong checked-out base fails before any merge.
      yield* git(["checkout", "--detach", `${baseSha}^`]);
      const baseError = yield* Effect.flip(
        withSpawner(spawner)(
          replayDryRun({
            tag: TAG,
            cwd: fixture.cwd,
            baseSha,
            upstreamSha,
            expectedTree: first.tree ?? "",
          }),
        ),
      );
      assert.instanceOf(baseError, UpstreamSyncError);
      assert.match(baseError.message, /does not match the dry-run base/);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replay-dry-run refuses a branch checkout and rejects a replay conflict", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "conflict" });
      const spawner = yield* localFetchSpawner(fixture);
      const git = fixture.git;
      const baseSha = (yield* git(["rev-parse", "HEAD"])).trim();

      // On a branch: refuses before any merge, protecting the source ref.
      const branchError = yield* Effect.flip(
        withSpawner(spawner)(
          replayDryRun({
            tag: TAG,
            cwd: fixture.cwd,
            baseSha,
            upstreamSha: fixture.upstreamHead,
            expectedTree: "0".repeat(40),
          }),
        ),
      );
      assert.instanceOf(branchError, UpstreamSyncError);
      assert.match(branchError.message, /detached HEAD/);
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "main");

      // Detached: the conflicting replay is rejected and commits nothing.
      yield* git(["checkout", "--detach", baseSha]);
      const conflictError = yield* Effect.flip(
        withSpawner(spawner)(
          replayDryRun({
            tag: TAG,
            cwd: fixture.cwd,
            baseSha,
            upstreamSha: fixture.upstreamHead,
            expectedTree: "0".repeat(40),
          }),
        ),
      );
      assert.instanceOf(conflictError, UpstreamSyncError);
      assert.match(conflictError.message, /conflicted/);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), baseSha);
      assert.equal((yield* headParents(git)).length, 2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replay-dry-run fails on an injected extra parent and malformed inputs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      const fetchSpawner = yield* localFetchSpawner(fixture);
      const first = yield* withSpawner(fetchSpawner)(
        dryRunUpstreamSync({
          tag: TAG,
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );
      const baseSha = first.baseSha ?? "";

      // An octopus parent injected at commit time breaks the exact-parents check.
      const extraParent = (yield* git(["rev-parse", `${baseSha}^`])).trim();
      const injecting = yield* commitParentInjectingSpawner(fixture, extraParent);
      yield* git(["checkout", "--detach", baseSha]);
      const parentError = yield* Effect.flip(
        withSpawner(injecting)(
          replayDryRun({
            tag: TAG,
            cwd: fixture.cwd,
            baseSha,
            upstreamSha: first.upstreamSha ?? "",
            expectedTree: first.tree ?? "",
          }),
        ),
      );
      assert.instanceOf(parentError, UpstreamSyncError);
      assert.match(parentError.message, /expected exactly/);

      // Malformed identities are rejected before any git work.
      const sha = "a".repeat(40);
      for (const overrides of [
        { baseSha: "nope", upstreamSha: sha, expectedTree: sha },
        { baseSha: sha, upstreamSha: "SHORT", expectedTree: sha },
        { baseSha: sha, upstreamSha: sha, expectedTree: "Z".repeat(40) },
      ]) {
        const error = yield* Effect.flip(
          withSpawner(fetchSpawner)(replayDryRun({ tag: TAG, cwd: fixture.cwd, ...overrides })),
        );
        assert.instanceOf(error, UpstreamSyncError);
        assert.match(error.message, /full lowercase hex object SHA/);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("the trusted detector provides the full Windows package surface", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
      const surface = yield* computeFullWindowsPackages(repoRoot);
      assert.deepEqual(
        surface,
        decide([], readWorkspace(), true).outputs.windows_packages.split(" ").filter(Boolean),
      );
      assert.isTrue(surface.length >= 7);

      // A cwd that is not the detector's repository root fails closed.
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "windows-packages-" });
      const error = yield* Effect.flip(computeFullWindowsPackages(empty));
      assert.instanceOf(error, UpstreamSyncError);
      assert.match(error.message, /missing from the merged tree/);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
