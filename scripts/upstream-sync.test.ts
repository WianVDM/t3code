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
  buildImpactReport,
  computeFullWindowsPackages,
  decodeDryRunReport,
  dryRunUpstreamSync,
  DryRunReport,
  EXPECTED_REMOTES,
  findAddedConflictMarkers,
  finishUpstreamSync,
  generateHotspotReport,
  GitCommandError,
  nextForkTag,
  parseConflictStages,
  parseGitHubRepository,
  parseUpstreamTagKind,
  parseSyncBranchTag,
  prepareUpstreamSync,
  renderDryRunSummary,
  renderHotspotReport,
  renderImpactReport,
  replayDryRun,
  resolveDryRunOutcome,
  selectLatestUpstreamTag,
  UpstreamSyncError,
  validateHotspotReport,
  validateSyncPullRequestMetadata,
  validateUpstreamSyncMerge,
  verifyUpstreamSync,
} from "./upstream-sync.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  SEAM_REGISTRY_PATH,
  SYNC_HISTORY_PATH,
  parseSeamRegistry,
  parseSyncHistory,
  serializeRegistry,
  serializeSyncHistory,
  type SeamAnchor,
  type SeamRegistry,
} from "./seamRegistry.ts";

import type { DryRunOutcomeInput, ImpactReport } from "./upstream-sync.ts";

const TAG = "v1.2.3";
const NIGHTLY_TAG = "v0.1.8-nightly.20261108.4380";
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

// The fork's hook sits inside hooked(); other() is upstream-only territory.
const APP_BASE = [
  "export function hooked() {",
  "  const a = 1;",
  "  const b = 2;",
  "  const c = 3;",
  "  return a + b + c;",
  "}",
  "",
  "export function other() {",
  "  return 2;",
  "}",
  "",
].join("\n");
const APP_FORK = APP_BASE.replace("return a + b + c;", "return a + b + c + hook();");
const PLACEHOLDER_FINGERPRINT = "sha256:0000000000000000";

const demoRegistry = (upstreamRef: string, variant: "clean" | "conflict"): SeamRegistry => ({
  version: 1,
  upstreamRef,
  features: { demo: { title: "Demo", issue: 1 } },
  files: {
    "app.ts": {
      delta: [1, 1],
      seams: [
        {
          id: "demo.hook",
          feature: "demo",
          mechanism: "hook",
          anchor: { symbol: "hooked" },
          fingerprint: PLACEHOLDER_FINGERPRINT,
        },
      ],
    },
    ...(variant === "conflict" ? { "conflict.txt": { delta: [1, 1], legacy: true as const } } : {}),
  },
  siblings: [],
});

interface RepositoryFixture {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly git: (args: ReadonlyArray<string>) => ReturnType<typeof runGit>;
  readonly rewrites: ReadonlyArray<readonly [string, string]>;
  readonly forkHead: string;
  readonly baseHead: string;
  readonly registry: SeamRegistry;
  readonly upstreamHead: string;
  readonly originLocalUrl: string;
  readonly upstreamLocalUrl: string;
}

const makeRepositoryFixture = Effect.fn("test.makeUpstreamSyncFixture")(function* (options: {
  readonly variant: "clean" | "conflict";
  readonly extraUpstreamFiles?: Readonly<Record<string, string>>;
  readonly upstreamRenames?: ReadonlyArray<readonly [string, string]>;
  readonly upstreamDeletions?: ReadonlyArray<string>;
  readonly forkSyncHistoryText?: string;
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
  yield* fs.writeFileString(path.join(seed, "app.ts"), APP_BASE);
  if (conflict) {
    yield* fs.writeFileString(path.join(seed, "conflict.txt"), "base\n");
  }
  yield* commitSeed("base");
  const baseHead = (yield* git(seed, ["rev-parse", "HEAD"])).trim();
  const registry = demoRegistry(baseHead, options.variant);

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
  yield* fs.writeFileString(path.join(seed, "app.ts"), APP_FORK);
  yield* fs.makeDirectory(path.join(seed, "plusplus"), { recursive: true });
  yield* fs.writeFileString(path.join(seed, SEAM_REGISTRY_PATH), serializeRegistry(registry));
  yield* fs.writeFileString(
    path.join(seed, SYNC_HISTORY_PATH),
    options.forkSyncHistoryText ?? serializeSyncHistory({ version: 1, syncs: [] }),
  );
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
  for (const deleted of options.upstreamDeletions ?? []) {
    yield* git(seed, ["rm", "--quiet", deleted]);
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
    baseHead,
    registry,
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

  it("classifies stable and nightly tag grammar with valid calendar dates", () => {
    assert.equal(parseUpstreamTagKind("v1.2.3"), "stable");
    assert.equal(parseUpstreamTagKind(NIGHTLY_TAG), "nightly");
    assert.equal(parseUpstreamTagKind("v10.20.30-nightly.20260101.0"), "nightly");
    assert.equal(parseUpstreamTagKind("v1.2.3-nightly.20280229.1"), "nightly");
    assert.equal(parseUpstreamTagKind("v1.2.3-nightly.20000229.1"), "nightly");
    for (const tag of [
      "1.2.3",
      "v1.2",
      "v1.2.3.4",
      "v01.2.3",
      "v1.2.3-rc.1",
      "v1.2.3-nightly",
      "v1.2.3-nightly.20261108",
      "v1.2.3-nightly.2026113.1",
      "v1.2.3-nightly.20261301.1",
      "v1.2.3-nightly.20260229.1",
      "v1.2.3-nightly.19000229.1",
      "v1.2.3-nightly.20261108.04380",
      "v1.2.3-nightly.20261108.x",
    ]) {
      assert.isUndefined(parseUpstreamTagKind(tag), tag);
    }
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

        // Verify staged the refresh: the registry now sits on the tag commit and
        // the history holds one entry for it.
        const staged = yield* parseSeamRegistry(
          yield* fixture.git(["show", `:${SEAM_REGISTRY_PATH}`]),
        );
        assert.equal(staged.upstreamRef, fixture.upstreamHead);
        const history = yield* parseSyncHistory(
          yield* fixture.git(["show", `:${SYNC_HISTORY_PATH}`]),
        );
        assert.deepStrictEqual(
          history.syncs.map((sync) => [sync.tag, sync.upstreamRef, sync.previousUpstreamRef]),
          [[TAG, fixture.upstreamHead, fixture.baseHead]],
        );
        // Verifying again stages the identical tree and adds no duplicate entry.
        const treeBefore = (yield* fixture.git(["write-tree"])).trim();
        yield* verifyUpstreamSync(options);
        assert.equal((yield* fixture.git(["write-tree"])).trim(), treeBefore);

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

it.live("verify refuses to refresh the registry past a lost anchor or an unregistered delta", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({
        variant: "clean",
        extraUpstreamFiles: {
          "app.ts": APP_BASE.replace("function hooked", "function hookedRenamed"),
        },
      });
      const spawner = yield* localFetchSpawner(fixture);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const options = { tag: TAG, cwd: fixture.cwd };

      yield* withSpawner(spawner)(prepareUpstreamSync(options));
      const lost = yield* Effect.flip(withSpawner(spawner)(verifyUpstreamSync(options)));
      assert.instanceOf(lost, UpstreamSyncError);
      assert.match(lost.message, /demo\.hook \(app\.ts\)[\s\S]*anchor is missing/);

      // With the anchor repaired, a fork delta that has no registry entry is refused too.
      yield* fs.writeFileString(
        path.join(fixture.cwd, "app.ts"),
        APP_FORK.replace("function hooked", "function hookedRenamed"),
      );
      yield* fs.writeFileString(
        path.join(fixture.cwd, SEAM_REGISTRY_PATH),
        serializeRegistry({
          ...fixture.registry,
          files: {
            "app.ts": {
              delta: [1, 1],
              seams: [
                {
                  id: "demo.hook",
                  feature: "demo",
                  mechanism: "hook",
                  anchor: { symbol: "hookedRenamed" },
                  fingerprint: PLACEHOLDER_FINGERPRINT,
                },
              ],
            },
          },
        }),
      );
      yield* fs.writeFileString(path.join(fixture.cwd, "README.md"), "base\nresolution edit\n");
      yield* fixture.git(["add", "-A"]);
      const unregistered = yield* Effect.flip(withSpawner(spawner)(verifyUpstreamSync(options)));
      assert.match(unregistered.message, /unregistered fork delta: README\.md/);

      yield* fixture.git(["checkout", fixture.upstreamHead, "--", "README.md"]);
      const verified = yield* withSpawner(spawner)(verifyUpstreamSync(options));
      assert.equal(verified.mergeHead, fixture.upstreamHead);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("verify refuses a seam whose file upstream deleted instead of dropping it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({
        variant: "clean",
        upstreamDeletions: ["app.ts"],
      });
      const spawner = yield* localFetchSpawner(fixture);
      const options = { tag: TAG, cwd: fixture.cwd };

      // The fork modified app.ts, so the delete is a modify/delete conflict; keeping the file resolves it.
      yield* Effect.flip(withSpawner(spawner)(prepareUpstreamSync(options)));
      yield* fixture.git(["add", "app.ts"]);
      const refused = yield* Effect.flip(withSpawner(spawner)(verifyUpstreamSync(options)));
      assert.instanceOf(refused, UpstreamSyncError);
      assert.match(
        refused.message,
        /demo\.hook \(app\.ts\)[\s\S]*file is absent at the upstream ref/,
      );
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

  it("renders the impact per feature and escapes unusual paths in the summary", () => {
    const paths = Array.from({ length: 205 }, (_, index) => `pkg/${index}.ts`);
    const impact: ImpactReport = {
      upstreamRef: "a".repeat(40),
      targetRef: "u".repeat(40),
      features: [
        {
          feature: "demo",
          title: "Demo",
          issue: 1,
          seams: [
            {
              id: "demo.hook",
              path: "app.ts",
              mechanism: "hook",
              state: "changed",
              conflict: true,
              diff: "@@ -1 +1 @@\n-old\n+new ```\n",
            },
            {
              id: "demo.other",
              path: "other|odd`.ts",
              mechanism: "mount",
              state: "same",
              conflict: false,
              diff: null,
            },
          ],
          siblings: [],
        },
      ],
      legacyTouched: paths.map((path) => ({ path, conflict: false })),
      unregisteredConflicts: [{ path: 'weird "path"\t.ts', hunks: 2 }],
      unregisteredDeltas: [],
    };
    const report: DryRunReport = {
      schemaVersion: 2,
      requestedTag: "latest",
      tag: "v1.2.3",
      baseSha: "b".repeat(40),
      mergeBaseSha: "m".repeat(40),
      upstreamSha: "u".repeat(40),
      mergeCommit: null,
      tree: null,
      status: "conflict",
      incomingPaths: ['weird "path"\t.ts', ...paths],
      impact,
      conflicts: [{ path: 'weird "path"\t.ts', stages: [1, 2, 3] }],
      seamRefreshProblems: [],
      windowsPackages: [],
    };
    const summary = renderDryRunSummary(report, null);
    assert.include(summary, "## ++ impact");
    assert.include(summary, "### demo: Demo (#1)");
    assert.include(summary, "| `demo.hook` | `app.ts` | hook | changed | conflict |");
    assert.include(summary, "| `demo.other` | `other odd .ts` | mount | same | - |");
    assert.include(summary, "Adapt the ++ change, or drop it if upstream now does the same.");
    // The diff fence outgrows backticks inside the diff, so it cannot be closed early.
    assert.include(summary, "````diff\n@@ -1 +1 @@");
    // The unusual path only appears JSON-escaped, never raw.
    assert.include(summary, JSON.stringify('weird "path"\t.ts'));
    assert.isFalse(summary.includes('weird "path"\t.ts\n'));
    // A 205-entry list shows 200 and names the remainder.
    assert.include(summary, "and 5 more");
    assert.include(summary, "Legacy files upstream touches (205)");
    assert.include(summary, "Unregistered conflicts (1)");
    assert.include(summary, "prepare --tag v1.2.3");
    assert.include(renderDryRunSummary({ ...report, impact: null }, null), "(not computed)");
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

  it("reports a conflict as a finding without running lanes", () => {
    const outcome = resolveDryRunOutcome(
      input({
        mergeStatus: "conflict",
        mergeResult: "success",
        linux: lane("skipped"),
        windows: lane("skipped"),
      }),
    );
    assert.equal(outcome.outcome, "conflict");
    assert.isTrue(outcome.success);
    assert.deepEqual(outcome.problems, []);
    // The merge job only fails when the report cannot be computed.
    const failedMerge = resolveDryRunOutcome(
      input({
        mergeStatus: "conflict",
        mergeResult: "failure",
        linux: lane("skipped"),
        windows: lane("skipped"),
      }),
    );
    assert.equal(failedMerge.outcome, "error");
    assert.isFalse(failedMerge.success);
  });

  it("reports a merge integrity failure distinctly from a conflict", () => {
    const outcome = resolveDryRunOutcome(
      input({
        mergeStatus: "merge_verification_failed",
        mergeResult: "success",
        linux: lane("skipped"),
        windows: lane("skipped"),
      }),
    );
    assert.equal(outcome.outcome, "merge_verification_failed");
    assert.isTrue(outcome.success);
  });

  it("reads a lane verification failure from a continue-on-error success", () => {
    const outcome = resolveDryRunOutcome(
      input({ windows: lane("success", "verification_failed") }),
    );
    assert.equal(outcome.outcome, "verification_failed");
    assert.isTrue(outcome.success);
    assert.deepEqual(outcome.lanes, { linux: "passed", windows: "verification_failed" });
    const failedJob = resolveDryRunOutcome(
      input({ windows: lane("failure", "verification_failed") }),
    );
    assert.equal(failedJob.outcome, "verification_failed");
    assert.isTrue(failedJob.success);
  });

  it("fails closed when a successful lane has no usable verification result", () => {
    for (const verification of [null, "error", "surprise"]) {
      const outcome = resolveDryRunOutcome(input({ linux: lane("success", verification) }));
      assert.equal(outcome.outcome, "error", String(verification));
      assert.isFalse(outcome.success, String(verification));
    }
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

      assert.equal(report.schemaVersion, 2);
      assert.equal(report.status, "clean");
      assert.deepEqual(report.seamRefreshProblems, []);
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
      // is not reported as deleted.
      assert.deepEqual([...report.incomingPaths].sort(), [
        ".agents/we ird's path.txt",
        "AGENTS.md",
        "README.md",
        "docs/README.md",
        "packages/shared/src/promptLinks.ts",
        "scripts/dry-run-tool.txt",
        "upstream.txt",
      ]);
      assert.deepEqual(report.impact, {
        upstreamRef: fixture.baseHead,
        targetRef: fixture.upstreamHead,
        features: [
          {
            feature: "demo",
            title: "Demo",
            issue: 1,
            seams: [
              {
                id: "demo.hook",
                path: "app.ts",
                mechanism: "hook",
                state: "same",
                conflict: false,
                diff: null,
              },
            ],
            siblings: [],
          },
        ],
        legacyTouched: [],
        unregisteredConflicts: [],
        unregisteredDeltas: [],
      });
      assert.deepEqual(report.conflicts, []);
      assert.deepEqual(report.windowsPackages, ["scripts"]);

      // The JSON report round-trips through the versioned schema, the summary
      // escapes unusual paths, and GITHUB_OUTPUT carries the lane inputs.
      const persisted = yield* readReportFile(paths.reportPath);
      assert.deepEqual(persisted, report);
      const summary = yield* fs.readFileString(paths.summaryPath);
      assert.include(summary, "## ++ impact");
      assert.include(summary, "### demo: Demo (#1)");
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

it.live("dry-run verifies a nightly merge on the default base without touching the caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);
      const seed = path.join(fixture.root, "seed");
      yield* runGit(seed, ["tag", NIGHTLY_TAG, fixture.upstreamHead], fixture.env);
      yield* runGit(
        seed,
        ["push", fixture.upstreamLocalUrl, `refs/tags/${NIGHTLY_TAG}`],
        fixture.env,
      );

      const refsBefore = yield* localRefsSnapshot(git);
      const originRefsBefore = yield* git(["ls-remote", fixture.originLocalUrl]);
      const upstreamRefsBefore = yield* git(["ls-remote", fixture.upstreamLocalUrl]);
      const report = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: NIGHTLY_TAG,
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );

      assert.equal(report.status, "clean");
      assert.equal(report.requestedTag, NIGHTLY_TAG);
      assert.equal(report.tag, NIGHTLY_TAG);
      assert.equal(report.baseSha, fixture.forkHead);
      assert.equal(report.upstreamSha, fixture.upstreamHead);
      assert.isNotNull(report.mergeCommit);
      assert.isNotNull(report.tree);
      assert.deepEqual(yield* localRefsSnapshot(git), refsBefore);
      assert.equal(yield* git(["ls-remote", fixture.originLocalUrl]), originRefsBefore);
      assert.equal(yield* git(["ls-remote", fixture.upstreamLocalUrl]), upstreamRefsBefore);
      assert.equal((yield* git(["tag", "--list", NIGHTLY_TAG])).trim(), "");
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "");
      assert.deepEqual(yield* readReportFile(paths.reportPath), report);

      yield* git(["checkout", "--detach", fixture.forkHead]);
      const replayed = yield* withSpawner(spawner)(
        replayDryRun({
          tag: NIGHTLY_TAG,
          cwd: fixture.cwd,
          baseSha: fixture.forkHead,
          upstreamSha: fixture.upstreamHead,
          expectedTree: report.tree ?? "",
        }),
      );
      assert.equal(replayed.tree, report.tree);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run stacks the merge onto a custom base ref", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({ variant: "clean" });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const git = fixture.git;
      const paths = dryRunPaths(fixture, path);

      const optionLikeBaseError = yield* Effect.flip(
        withSpawner(spawner)(
          dryRunUpstreamSync({
            tag: TAG,
            cwd: fixture.cwd,
            baseRef: "--upload-pack=unexpected",
            ...paths,
            githubOutput: false,
            windowsPackages: [],
          }),
        ),
      );
      assert.instanceOf(optionLikeBaseError, UpstreamSyncError);
      assert.match(optionLikeBaseError.message, /base ref must not start/);
      assert.equal((yield* git(["branch", "--show-current"])).trim(), "main");
      assert.isNull((yield* readReportFile(paths.reportPath)).baseSha);

      yield* git(["switch", "-c", "stack"]);
      yield* fs.writeFileString(path.join(fixture.cwd, "stack.txt"), "stack\n");
      yield* git(["add", "stack.txt"]);
      yield* git(["commit", "-m", "stack change"]);
      const stackHead = (yield* git(["rev-parse", "HEAD"])).trim();
      yield* git(["switch", "main"]);
      const refsBefore = yield* localRefsSnapshot(git);

      const report = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: TAG,
          cwd: fixture.cwd,
          baseRef: "stack",
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );
      assert.equal(report.status, "clean");
      assert.equal(report.baseSha, stackHead);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), report.mergeCommit);
      assert.equal((yield* git(["show", "HEAD:stack.txt"])).trim(), "stack");
      assert.deepEqual(yield* localRefsSnapshot(git), refsBefore);
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

      // Report-only: a conflict is a finding, so the run itself succeeds.
      const returned = yield* withSpawner(spawner)(
        dryRunUpstreamSync({ tag: TAG, cwd: fixture.cwd, ...paths, githubOutput: false }),
      );

      const report = yield* readReportFile(paths.reportPath);
      assert.deepEqual(returned, report);
      assert.equal(report.schemaVersion, 2);
      assert.equal(report.status, "conflict");
      assert.deepEqual(report.conflicts, [{ path: "conflict.txt", stages: [1, 2, 3] }]);
      assert.deepEqual(report.incomingPaths, ["conflict.txt"]);
      assert.deepEqual(report.impact?.legacyTouched, [{ path: "conflict.txt", conflict: true }]);
      assert.deepEqual(report.impact?.unregisteredConflicts, []);
      assert.deepEqual(report.impact?.features[0]?.seams[0], {
        id: "demo.hook",
        path: "app.ts",
        mechanism: "hook",
        state: "same",
        conflict: false,
        diff: null,
      });
      assert.isNull(report.mergeCommit);
      assert.isNull(report.tree);
      // No merge commit was created and no ref moved.
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
      assert.equal((yield* headParents(git)).length, 2);
      assert.deepEqual(yield* localRefsSnapshot(git), refsBefore);
      const summary = yield* fs.readFileString(paths.summaryPath);
      assert.include(summary, `node scripts/upstream-sync.ts prepare --tag ${TAG}`);
      assert.include(summary, '"conflict.txt" (stages 1, 2, 3)');
      assert.include(summary, "Legacy files upstream touches (1)");
      assert.include(summary, '- "conflict.txt" (conflict)');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run records a registry refresh failure and still commits the clean merge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({
        variant: "clean",
        extraUpstreamFiles: {
          "app.ts": APP_BASE.replace("function hooked", "function hookedRenamed"),
        },
      });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const paths = dryRunPaths(fixture, path);

      const returned = yield* withSpawner(spawner)(
        dryRunUpstreamSync({
          tag: TAG,
          cwd: fixture.cwd,
          ...paths,
          githubOutput: false,
          windowsPackages: [],
        }),
      );

      // Not merge_verification_failed: the Linux and Windows lanes still need to run.
      assert.equal(returned.status, "clean");
      assert.isNotNull(returned.mergeCommit);
      // The real sync stages the refresh this merge lacks, so the tree is not pinned.
      assert.isNull(returned.tree);
      assert.lengthOf(returned.seamRefreshProblems, 1);
      assert.match(returned.seamRefreshProblems[0] ?? "", /demo\.hook \(app\.ts\)[\s\S]*missing/);
      assert.deepEqual(yield* readReportFile(paths.reportPath), returned);
      const summary = yield* fs.readFileString(paths.summaryPath);
      assert.include(summary, "## Seam registry refresh (1)");
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

      const returned = yield* withSpawner(spawner)(
        dryRunUpstreamSync({ tag: TAG, cwd: fixture.cwd, ...paths, githubOutput: false }),
      );
      assert.equal(returned.status, "merge_verification_failed");
      const fs = yield* FileSystem.FileSystem;
      assert.match(yield* fs.readFileString(paths.summaryPath), /failed integrity verification/);

      const report = yield* readReportFile(paths.reportPath);
      assert.equal(report.status, "merge_verification_failed");
      // Distinct from a conflict: no unmerged paths and no downstream verification.
      assert.deepEqual(report.conflicts, []);
      assert.isNull(report.mergeCommit);
      assert.equal((yield* git(["rev-parse", "HEAD"])).trim(), fixture.forkHead);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dry-run reports a seam refresh failure inside merge verification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({
        variant: "clean",
        forkSyncHistoryText: "not json\n",
      });
      const spawner = yield* localFetchSpawner(fixture);
      const path = yield* Path.Path;
      const paths = dryRunPaths(fixture, path);

      const returned = yield* withSpawner(spawner)(
        dryRunUpstreamSync({ tag: TAG, cwd: fixture.cwd, ...paths, githubOutput: false }),
      );
      assert.equal(returned.status, "merge_verification_failed");
      assert.isNull(returned.mergeCommit);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("buildImpactReport reports every state, conflicts with hunks, and the registry gaps", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeRepositoryFixture({
        variant: "conflict",
        extraUpstreamFiles: {
          "extra-upstream.txt": "x\n",
          "app.ts": APP_BASE.replace("return a + b + c;", "return a * b * c;").replace(
            "return 2;",
            "return 3;",
          ),
        },
        upstreamRenames: [["README.md", "docs/README.md"]],
      });
      yield* fixture.git([
        "fetch",
        fixture.upstreamLocalUrl,
        `refs/tags/${TAG}:refs/upstream-sync/${TAG}`,
      ]);
      const seam = (id: string, mechanism: "hook" | "generated", anchor: SeamAnchor) => ({
        id,
        feature: id.split(".")[0] ?? "",
        mechanism,
        anchor,
        fingerprint: PLACEHOLDER_FINGERPRINT,
      });
      const registry: SeamRegistry = {
        version: 1,
        upstreamRef: fixture.baseHead,
        features: { demo: { title: "Demo", issue: 1 }, extra: { title: "Extra" } },
        files: {
          "README.md": {
            delta: [0, 1],
            seams: [seam("extra.readme", "generated", { file: true })],
          },
          "app.ts": {
            delta: [1, 1],
            seams: [
              seam("demo.hook", "hook", { symbol: "hooked" }),
              seam("demo.other", "hook", { symbol: "other" }),
              seam("extra.gone", "hook", { symbol: "nonexistent" }),
              seam("extra.vague", "hook", { text: "return" }),
            ],
          },
          "extra-upstream.txt": { delta: [1, 0], legacy: true },
        },
        siblings: [
          {
            feature: "extra",
            upstream: "conflict.txt",
            plusplus: "plusplus/docs/conflict.md",
            fingerprint: PLACEHOLDER_FINGERPRINT,
          },
        ],
      };

      const report = yield* buildImpactReport({
        cwd: fixture.cwd,
        registry,
        forkSha: fixture.forkHead,
        targetSha: fixture.upstreamHead,
      });

      assert.equal(report.upstreamRef, fixture.baseHead);
      assert.equal(report.targetRef, fixture.upstreamHead);
      assert.deepEqual(
        report.features.map((feature) => [feature.feature, feature.title, feature.issue]),
        [
          ["demo", "Demo", 1],
          ["extra", "Extra", null],
        ],
      );
      const states = Object.fromEntries(
        report.features.flatMap((feature) =>
          feature.seams.map((entry) => [entry.id, [entry.state, entry.conflict]] as const),
        ),
      );
      // The conflict flag is per path: every seam in a conflicted file carries it.
      assert.deepEqual(states, {
        "demo.hook": ["changed", true],
        "demo.other": ["changed", true],
        "extra.readme": ["file-deleted", false],
        "extra.gone": ["missing", true],
        "extra.vague": ["ambiguous", true],
      });
      // Upstream's diff of the region, with the change shown and capped.
      const hook = report.features[0]?.seams[0];
      assert.include(hook?.diff ?? "", "-  return a + b + c;");
      assert.include(hook?.diff ?? "", "+  return a * b * c;");
      assert.isNull(report.features[1]?.seams[0]?.diff);
      const sibling = report.features[1]?.siblings[0];
      assert.deepEqual(sibling && [sibling.state, sibling.conflict], ["changed", true]);

      assert.deepEqual(report.legacyTouched, [{ path: "extra-upstream.txt", conflict: false }]);
      assert.deepEqual(report.unregisteredConflicts, [{ path: "conflict.txt", hunks: 1 }]);
      assert.deepEqual(report.unregisteredDeltas, ["conflict.txt"]);

      const rendered = renderImpactReport(report).join("\n");
      assert.include(rendered, "### demo: Demo (#1)");
      assert.include(rendered, "### extra: Extra");
      assert.include(rendered, "| `demo.hook` | `app.ts` | hook | changed | conflict |");
      assert.include(rendered, "| `extra.readme` | `README.md` | generated | file-deleted | - |");
      assert.include(
        rendered,
        "<details><summary>demo.hook: upstream changed this region</summary>",
      );
      assert.include(rendered, "Adapt the ++ change, or drop it if upstream now does the same.");
      assert.include(rendered, "Unregistered conflicts (1)");
      assert.include(rendered, '- "conflict.txt" (1 hunks)');
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
        "v1.2.3-nightly.20260229.1",
        "v1.2.3-nightly.20261108.04380",
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

const jsonText = (value: unknown): string => JSON.stringify(value);

const sha = (char: string): string => char.repeat(40);

const SYNC_METADATA = {
  prNumber: 7,
  headSha: sha("c"),
  baseSha: sha("b"),
  baseRepo: "WianVDM/t3code",
  baseRef: "main",
  headRepo: "WianVDM/t3code",
  headRef: `sync/upstream-${TAG}`,
};

describe("sync PR metadata", () => {
  it("parses only exact sync/upstream-vX.Y.Z head branches", () => {
    assert.equal(parseSyncBranchTag(`sync/upstream-${TAG}`), TAG);
    assert.isUndefined(parseSyncBranchTag("sync/upstream-v1.2"));
    assert.isUndefined(parseSyncBranchTag("sync/upstream-v1.2.3-rc.1"));
    assert.isUndefined(parseSyncBranchTag("sync/upstream-latest"));
    assert.isUndefined(parseSyncBranchTag("sync/downstream-v1.2.3"));
    assert.isUndefined(parseSyncBranchTag("main"));
    assert.isUndefined(parseSyncBranchTag("sync/upstream-v01.2.3"));
  });

  it("accepts the exact sync PR shape and rejects every deviation", () => {
    assert.deepEqual(validateSyncPullRequestMetadata(SYNC_METADATA), {
      tag: TAG,
      problems: [],
    });
    const problemCases: ReadonlyArray<readonly [string, Partial<typeof SYNC_METADATA>]> = [
      ["a fork head", { headRepo: "someone/t3code" }],
      ["a wrong base repo", { baseRepo: "pingdotgg/t3code" }],
      ["a wrong base branch", { baseRef: "release" }],
      ["an ordinary branch", { headRef: "fix/thing" }],
      ["a malformed head SHA", { headSha: "abc123" }],
      ["a malformed base SHA", { baseSha: sha("Z") }],
      ["a non-positive PR number", { prNumber: 0 }],
    ];
    for (const [name, overrides] of problemCases) {
      const result = validateSyncPullRequestMetadata({ ...SYNC_METADATA, ...overrides });
      assert.isUndefined(result.tag, name);
      assert.isTrue(result.problems.length > 0, name);
    }
  });
});

const emptyImpact = (targetRef: string): ImpactReport => ({
  upstreamRef: sha("a"),
  targetRef,
  features: [],
  legacyTouched: [],
  unregisteredConflicts: [],
  unregisteredDeltas: [],
});

describe("hotspot report validation", () => {
  const real = {
    tag: TAG,
    baseSha: sha("b"),
    upstreamSha: sha("c"),
    headSha: sha("e"),
    headTree: sha("f"),
    mergeBaseSha: sha("d"),
    incomingPaths: ["upstream.txt"],
    impact: emptyImpact(sha("c")),
  };
  const report = (overrides: Partial<DryRunReport> = {}): DryRunReport => ({
    schemaVersion: 2,
    requestedTag: TAG,
    tag: TAG,
    baseSha: real.baseSha,
    mergeBaseSha: real.mergeBaseSha,
    upstreamSha: real.upstreamSha,
    mergeCommit: sha("a"),
    tree: real.headTree,
    status: "clean",
    incomingPaths: ["upstream.txt"],
    impact: real.impact,
    conflicts: [],
    seamRefreshProblems: [],
    windowsPackages: ["apps/desktop"],
    ...overrides,
  });

  it("accepts a report that matches the recomputed real merge", () => {
    assert.deepEqual(validateHotspotReport(report(), real), []);
  });

  it("rejects an identity mismatch against the real merge", () => {
    for (const overrides of [
      { tag: "v9.9.9" },
      { baseSha: sha("0") },
      { upstreamSha: sha("1") },
      { mergeBaseSha: sha("2") },
    ]) {
      assert.isNotEmpty(validateHotspotReport(report(overrides), real), jsonText(overrides));
    }
  });

  it("rejects an old schema version, incoming-path mismatches, and a tampered impact", () => {
    assert.isNotEmpty(validateHotspotReport({ ...report(), schemaVersion: 1 as 2 }, real));
    assert.isNotEmpty(validateHotspotReport(report({ incomingPaths: ["bogus.txt"] }), real));
    assert.isNotEmpty(validateHotspotReport(report({ incomingPaths: [] }), real));
    assert.isNotEmpty(validateHotspotReport(report({ impact: null }), real));
    assert.isNotEmpty(
      validateHotspotReport(
        report({ impact: { ...real.impact, unregisteredDeltas: ["secret.ts"] } }),
        real,
      ),
    );
    assert.isNotEmpty(
      validateHotspotReport(
        report({ impact: { ...real.impact, legacyTouched: [{ path: "a.ts", conflict: true }] } }),
        real,
      ),
    );
    // Key order is not content.
    const reordered: ImpactReport = JSON.parse(
      JSON.stringify({
        unregisteredDeltas: [],
        unregisteredConflicts: [],
        legacyTouched: [],
        features: [],
        targetRef: real.impact.targetRef,
        upstreamRef: real.impact.upstreamRef,
      }),
    );
    assert.deepEqual(validateHotspotReport(report({ impact: reordered }), real), []);
  });

  it("requires the clean report tree to equal the real merged tree", () => {
    assert.deepEqual(validateHotspotReport(report({ tree: real.headTree }), real), []);
    assert.isNotEmpty(validateHotspotReport(report({ tree: sha("0") }), real));
  });

  it("accepts an unpinned tree only when the registry refresh failed", () => {
    const problems = ["demo.hook (app.ts) is missing"];
    assert.deepEqual(
      validateHotspotReport(report({ tree: null, seamRefreshProblems: problems }), real),
      [],
    );
    assert.isNotEmpty(
      validateHotspotReport(report({ tree: real.headTree, seamRefreshProblems: problems }), real),
    );
    assert.isNotEmpty(validateHotspotReport(report({ tree: null }), real));
  });

  it("enforces status-specific nullable fields", () => {
    assert.isNotEmpty(validateHotspotReport(report({ tree: null }), real));
    assert.isNotEmpty(validateHotspotReport(report({ mergeCommit: null }), real));
    // A conflict report must not claim a merged tree, and must list conflicts.
    const conflictReal = { ...real, headTree: sha("9") };
    const conflict = report({
      status: "conflict",
      mergeCommit: null,
      tree: null,
      conflicts: [{ path: "conflict.txt", stages: [1, 2, 3] }],
    });
    assert.deepEqual(validateHotspotReport(conflict, conflictReal), []);
    assert.isNotEmpty(validateHotspotReport(report({ status: "conflict" }), real));
    assert.isNotEmpty(
      validateHotspotReport(
        report({
          status: "conflict",
          mergeCommit: null,
          tree: sha("f"),
          conflicts: [{ path: "x", stages: [1] }],
        }),
        real,
      ),
    );
    assert.isNotEmpty(
      validateHotspotReport(
        report({ status: "already_integrated", mergeCommit: sha("a"), tree: sha("f") }),
        real,
      ),
    );
  });

  it("rejects malformed SHAs, non-strict tags, and illegal conflict stages", () => {
    assert.isNotEmpty(validateHotspotReport(report({ baseSha: "short" }), real));
    assert.isNotEmpty(validateHotspotReport(report({ tag: "v1.2" }), real));
    assert.isNotEmpty(
      validateHotspotReport(
        report({
          status: "conflict",
          mergeCommit: null,
          tree: null,
          conflicts: [{ path: "conflict.txt", stages: [4] }],
        }),
        real,
      ),
    );
    assert.isNotEmpty(
      validateHotspotReport(
        report({
          status: "conflict",
          mergeCommit: null,
          tree: null,
          conflicts: [{ path: "conflict.txt", stages: [] }],
        }),
        real,
      ),
    );
  });
});

describe("hotspot report rendering", () => {
  const impact: ImpactReport = {
    ...emptyImpact(sha("c")),
    features: [
      {
        feature: "demo",
        title: "Demo",
        issue: 1,
        seams: [
          {
            id: "demo.hook",
            path: "apps/desktop/src/main.ts",
            mechanism: "hook",
            state: "changed",
            conflict: true,
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
        siblings: [],
      },
    ],
    unregisteredConflicts: [{ path: 'weird "path".ts', hunks: 3 }],
  };
  const view = {
    report: {
      schemaVersion: 2 as const,
      requestedTag: TAG,
      tag: TAG,
      baseSha: sha("b"),
      mergeBaseSha: sha("d"),
      upstreamSha: sha("c"),
      mergeCommit: sha("a"),
      tree: sha("f"),
      status: "clean" as const,
      incomingPaths: ["apps/desktop/src/main.ts", "upstream.txt"],
      impact,
      conflicts: [],
      seamRefreshProblems: [],
      windowsPackages: ["apps/desktop"],
    },
    real: {
      tag: TAG,
      baseSha: sha("b"),
      upstreamSha: sha("c"),
      headSha: sha("e"),
      headTree: sha("f"),
      mergeBaseSha: sha("d"),
      incomingPaths: ["apps/desktop/src/main.ts", "upstream.txt"],
      impact,
    },
    sourceRun: "https://github.com/WianVDM/t3code/actions/runs/42",
    artifactName: "upstream-sync-dry-run-report",
  };

  it("renders every required section from the recomputed impact", () => {
    const markdown = renderHotspotReport(view);
    assert.isTrue(markdown.startsWith("<!-- upstream-sync-hotspot-report -->"));
    assert.include(markdown, view.sourceRun);
    assert.include(markdown, "upstream-sync-dry-run-report");
    assert.include(markdown, `\`${TAG}\``);
    assert.include(markdown, `\`${sha("e")}\``);
    assert.include(markdown, "## ++ impact");
    assert.include(markdown, "### demo: Demo (#1)");
    assert.include(
      markdown,
      "| `demo.hook` | `apps/desktop/src/main.ts` | hook | changed | conflict |",
    );
    assert.include(markdown, "Unregistered conflicts (1)");
    assert.isFalse(markdown.includes("Unmapped"));
    // Paths only ever appear JSON-escaped in lists.
    assert.include(markdown, JSON.stringify('weird "path".ts'));
  });

  it("renders the seam registry refresh problems", () => {
    const markdown = renderHotspotReport({
      ...view,
      report: {
        ...view.report,
        tree: null,
        seamRefreshProblems: ["demo.hook (app.ts) is missing"],
      },
    });
    assert.include(markdown, "## Seam registry refresh (1)");
    assert.include(markdown, JSON.stringify("demo.hook (app.ts) is missing"));
    assert.isFalse(markdown.includes("Merged tree matches"));
    assert.isFalse(renderHotspotReport(view).includes("Seam registry refresh"));
  });

  it("caps long impact lists", () => {
    const paths = Array.from({ length: 205 }, (_, index) => `pkg/${index}.ts`);
    const capped = renderHotspotReport({
      ...view,
      real: {
        ...view.real,
        impact: { ...impact, legacyTouched: paths.map((path) => ({ path, conflict: false })) },
      },
    });
    assert.include(capped, "and 5 more");
    assert.include(capped, "Legacy files upstream touches (205)");
    assert.include(capped, "(none)");
  });
});

// Live flows: validate-merge over real repositories, and the hotspot report
// over a real two-parent merge with a hand-built trusted artifact.
const syncPrFixture = Effect.fn("test.syncPrFixture")(function* (
  options: {
    readonly extraMergeFiles?: Readonly<Record<string, string>>;
    readonly extraUpstreamFiles?: Readonly<Record<string, string>>;
  } = {},
) {
  const fixture = yield* makeRepositoryFixture({
    variant: "clean",
    ...(options.extraUpstreamFiles === undefined
      ? {}
      : { extraUpstreamFiles: options.extraUpstreamFiles }),
  });
  const spawner = yield* localFetchSpawner(fixture);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const syncOptions = { tag: TAG, cwd: fixture.cwd };

  yield* Effect.gen(function* () {
    yield* prepareUpstreamSync(syncOptions);
    for (const [relative, content] of Object.entries(options.extraMergeFiles ?? {})) {
      const target = path.join(fixture.cwd, ...relative.split("/"));
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    }
    if (Object.keys(options.extraMergeFiles ?? {}).length > 0) {
      yield* fixture.git(["add", "-A"]);
    }
    yield* verifyUpstreamSync(syncOptions);
    yield* finishUpstreamSync(syncOptions);
  }).pipe(withSpawner(spawner));

  const headSha = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
  const headTree = (yield* fixture.git(["rev-parse", "HEAD^{tree}"])).trim();
  const mergeBaseSha = (yield* fixture.git([
    "merge-base",
    fixture.forkHead,
    fixture.upstreamHead,
  ])).trim();
  yield* fixture.git(["push", fixture.originLocalUrl, "HEAD:refs/pull/7/head"]);

  return { fixture, spawner, fs, path, headSha, headTree, mergeBaseSha };
});

// The artifact's impact is what the dry run computed on the base registry; the
// hotspot recomputes it from the real merge parents.
const impactOf = (fixture: RepositoryFixture) =>
  buildImpactReport({
    cwd: fixture.cwd,
    registry: fixture.registry,
    forkSha: fixture.forkHead,
    targetSha: fixture.upstreamHead,
  });

const trustedReport = (overrides: Record<string, unknown>): string =>
  jsonText({
    schemaVersion: 2,
    requestedTag: TAG,
    tag: TAG,
    baseSha: null,
    mergeBaseSha: null,
    upstreamSha: null,
    mergeCommit: null,
    tree: null,
    status: "clean",
    incomingPaths: ["upstream.txt"],
    impact: null,
    conflicts: [],
    seamRefreshProblems: [],
    windowsPackages: [],
    ...overrides,
  });

const hotspotOptions = (fixtureRoot: string, cwd: string, prNumber: number, headSha: string) => ({
  cwd,
  prNumber,
  headSha,
  reportPath: `${fixtureRoot}/artifact-report.json`,
  sourceRun: "https://github.com/WianVDM/t3code/actions/runs/42",
  outputPath: `${fixtureRoot}/hotspot.md`,
});

it.live("validate-merge accepts the real two-parent sync merge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fixture, spawner, headSha } = yield* syncPrFixture();
      const result = yield* withSpawner(spawner)(
        validateUpstreamSyncMerge({
          cwd: fixture.cwd,
          prNumber: 7,
          headSha,
          baseSha: fixture.forkHead,
          baseRepo: "WianVDM/t3code",
          baseRef: "main",
          headRepo: "WianVDM/t3code",
          headRef: `sync/upstream-${TAG}`,
        }),
      );
      assert.equal(result.tag, TAG);
      assert.equal(result.headSha, headSha);
      assert.equal(result.upstreamSha, fixture.upstreamHead);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "validate-merge rejects squashed, swapped, octopus, stale, mismatched, and moved-tag merges",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fixture, spawner, headSha, mergeBaseSha } = yield* syncPrFixture();
        const git = fixture.git;
        const metadata = {
          cwd: fixture.cwd,
          baseSha: fixture.forkHead,
          baseRepo: "WianVDM/t3code",
          baseRef: "main",
          headRepo: "WianVDM/t3code",
          headRef: `sync/upstream-${TAG}`,
        };
        const fails = (options: typeof metadata & { prNumber: number; headSha: string }) =>
          Effect.flip(withSpawner(spawner)(validateUpstreamSyncMerge(options)));
        const tree = (yield* git(["rev-parse", "HEAD^{tree}"])).trim();

        // A malformed head SHA never reaches git.
        assert.match(
          (yield* fails({ ...metadata, prNumber: 7, headSha: "nope" })).message,
          /full lowercase hex/,
        );
        // A head SHA that is not the fetched PR head.
        assert.match(
          (yield* fails({ ...metadata, prNumber: 7, headSha: fixture.forkHead })).message,
          /does not match the payload SHA/,
        );

        // A squashed single-parent commit of the same tree.
        const squashed = (yield* git([
          "commit-tree",
          tree,
          "-p",
          fixture.forkHead,
          "-m",
          "squash",
        ])).trim();
        yield* git(["push", fixture.originLocalUrl, `${squashed}:refs/pull/8/head`]);
        const squashError = yield* fails({ ...metadata, prNumber: 8, headSha: squashed });
        assert.instanceOf(squashError, UpstreamSyncError);
        assert.match(squashError.message, /expected exactly/);

        // Swapped parents.
        const swapped = (yield* git([
          "commit-tree",
          tree,
          "-p",
          fixture.upstreamHead,
          "-p",
          fixture.forkHead,
          "-m",
          "swapped",
        ])).trim();
        yield* git(["push", fixture.originLocalUrl, `${swapped}:refs/pull/9/head`]);
        assert.match(
          (yield* fails({ ...metadata, prNumber: 9, headSha: swapped })).message,
          /expected exactly/,
        );

        // An octopus merge.
        const octopus = (yield* git([
          "commit-tree",
          tree,
          "-p",
          fixture.forkHead,
          "-p",
          fixture.upstreamHead,
          "-p",
          mergeBaseSha,
          "-m",
          "octopus",
        ])).trim();
        yield* git(["push", fixture.originLocalUrl, `${octopus}:refs/pull/10/head`]);
        assert.match(
          (yield* fails({ ...metadata, prNumber: 10, headSha: octopus })).message,
          /expected exactly/,
        );

        // A stale base SHA: the merge is right, the claimed base is not.
        assert.match(
          (yield* fails({ ...metadata, baseSha: mergeBaseSha, prNumber: 7, headSha })).message,
          /expected exactly/,
        );

        // A moved upstream tag: the second parent no longer matches the tag.
        yield* git([
          "push",
          "--force",
          fixture.upstreamLocalUrl,
          `${fixture.forkHead}:refs/tags/${TAG}`,
        ]);
        const movedError = yield* fails({ ...metadata, prNumber: 7, headSha });
        assert.instanceOf(movedError, UpstreamSyncError);
        assert.match(movedError.message, /expected exactly/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("hotspot-report validates the artifact against the real merge and renders it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prepared = yield* syncPrFixture({
        extraUpstreamFiles: { "app.ts": APP_BASE.replace("return 2;", "return 3;") },
      });
      const { fixture, spawner, fs, path, headSha, headTree, mergeBaseSha } = prepared;
      const impact = yield* withSpawner(spawner)(impactOf(fixture));
      // Upstream edited other(), outside the anchored region: same, no conflict.
      assert.equal(impact.features[0]?.seams[0]?.state, "same");
      yield* fs.writeFileString(
        path.join(fixture.root, "artifact-report.json"),
        trustedReport({
          baseSha: fixture.forkHead,
          mergeBaseSha,
          upstreamSha: fixture.upstreamHead,
          mergeCommit: headSha,
          tree: headTree,
          incomingPaths: ["app.ts", "upstream.txt"],
          impact,
        }),
      );

      const result = yield* withSpawner(spawner)(
        generateHotspotReport(hotspotOptions(fixture.root, fixture.cwd, 7, headSha)),
      );
      assert.deepStrictEqual(result, { headSha, tag: TAG });

      const markdown = yield* fs.readFileString(path.join(fixture.root, "hotspot.md"));
      assert.isTrue(markdown.startsWith("<!-- upstream-sync-hotspot-report -->"));
      assert.include(markdown, "https://github.com/WianVDM/t3code/actions/runs/42");
      assert.include(markdown, "## ++ impact");
      assert.include(markdown, "| `demo.hook` | `app.ts` | hook | same | - |");
      assert.include(markdown, headSha);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("hotspot-report fails closed before rendering on any mismatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fixture, spawner, fs, path, headSha, headTree, mergeBaseSha } =
        yield* syncPrFixture();
      const reportPath = path.join(fixture.root, "artifact-report.json");
      const options = hotspotOptions(fixture.root, fixture.cwd, 7, headSha);
      const impact = yield* withSpawner(spawner)(impactOf(fixture));
      const goodFields = {
        baseSha: fixture.forkHead,
        mergeBaseSha,
        upstreamSha: fixture.upstreamHead,
        mergeCommit: headSha,
        tree: headTree,
        impact,
      };
      const generate = () =>
        Effect.flip(withSpawner(spawner)(generateHotspotReport({ ...options, reportPath })));

      // A missing JSON file is an error.
      const missing = yield* generate();
      assert.instanceOf(missing, UpstreamSyncError);
      assert.match(missing.message, /missing/i);

      // A malformed JSON payload fails the schema before any git work.
      yield* fs.writeFileString(reportPath, "{not json");
      assert.match((yield* generate()).message, /invalid/i);

      // An identity mismatch fails before rendering; no output file appears.
      yield* fs.writeFileString(
        reportPath,
        trustedReport({ ...goodFields, upstreamSha: sha("0") }),
      );
      assert.match((yield* generate()).message, /does not survive validation/);
      assert.isFalse(yield* fs.exists(options.outputPath));

      // A stale head (the payload SHA moved) fails before anything else.
      yield* fs.writeFileString(reportPath, trustedReport(goodFields));
      const stale = yield* Effect.flip(
        withSpawner(spawner)(generateHotspotReport({ ...options, headSha: sha("0"), reportPath })),
      );
      assert.match(stale.message, /payload SHA/);

      // An incoming-path mismatch fails before rendering.
      yield* fs.writeFileString(
        reportPath,
        trustedReport({ ...goodFields, incomingPaths: ["bogus.txt"] }),
      );
      assert.match((yield* generate()).message, /does not survive validation/);
      assert.isFalse(yield* fs.exists(options.outputPath));

      // A tampered impact fails before rendering, even with every identity right.
      yield* fs.writeFileString(
        reportPath,
        trustedReport({
          ...goodFields,
          impact: { ...impact, unregisteredDeltas: ["hidden.ts"] },
        }),
      );
      const tampered = yield* generate();
      assert.match(tampered.message, /impact does not match/);
      assert.isFalse(yield* fs.exists(options.outputPath));

      // So does a report without any impact.
      yield* fs.writeFileString(reportPath, trustedReport({ ...goodFields, impact: null }));
      assert.match((yield* generate()).message, /carries no impact/);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
