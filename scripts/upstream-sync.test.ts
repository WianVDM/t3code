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
  EXPECTED_REMOTES,
  findAddedConflictMarkers,
  finishUpstreamSync,
  GitCommandError,
  nextForkTag,
  parseGitHubRepository,
  prepareUpstreamSync,
  UpstreamSyncError,
  verifyUpstreamSync,
} from "./upstream-sync.ts";

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
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly git: (args: ReadonlyArray<string>) => ReturnType<typeof runGit>;
  readonly rewrites: ReadonlyArray<readonly [string, string]>;
  readonly forkHead: string;
  readonly upstreamHead: string;
  readonly upstreamLocalUrl: string;
}

const makeRepositoryFixture = Effect.fn("test.makeUpstreamSyncFixture")(function* (options: {
  readonly variant: "clean" | "conflict";
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
    cwd,
    env,
    git: (args: ReadonlyArray<string>) => git(cwd, args),
    rewrites,
    forkHead,
    upstreamHead,
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
    const args =
      command.command === "git" && command.args[0] === "fetch"
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
        command.args[0] === "commit"
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
      assert.isTrue(conflictText.includes(`>>>>>>> ${TAG}`));
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
