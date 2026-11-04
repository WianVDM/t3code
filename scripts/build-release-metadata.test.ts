import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CLI_RELEASE_METADATA_FILE,
  decodeReleaseMetadata,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { buildReleaseMetadata } from "./build-release-metadata.ts";
import { InvalidReleaseVersionError } from "./update-release-package-versions.ts";

const ScriptTestLayer = NodeServices.layer;
const MIGRATIONS_RELATIVE_PATH = "apps/server/src/persistence/Migrations";

const STABLE_VERSION = "9.9.9-plusplus.1";

const CHANNEL_FIXTURES: ReadonlyArray<{
  readonly channel: CliReleaseChannel;
  readonly version: string;
}> = [
  { channel: "stable", version: STABLE_VERSION },
  { channel: "nightly", version: "9.9.10-nightly.20260713.4" },
  { channel: "preview", version: "9.9.10-preview.20260713.4" },
];

const makeFixtureRoot = Effect.fn("makeFixtureRoot")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = yield* fs.makeTempDirectoryScoped({ prefix });
  const outputDir = path.join(rootDir, "release-assets");
  yield* fs.makeDirectory(outputDir, { recursive: true });
  return { rootDir, outputDir };
});

const writeMigrationFixtures = Effect.fn("writeMigrationFixtures")(function* (
  rootDir: string,
  entries: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const migrationsDir = path.join(rootDir, MIGRATIONS_RELATIVE_PATH);
  yield* fs.makeDirectory(migrationsDir, { recursive: true });
  for (const entry of entries) {
    yield* fs.writeFileString(path.join(migrationsDir, entry), "");
  }
});

/** The filename rule the generator follows: the numeric `NNN_` prefix decides, not the newest
 * mtime, so a helper or fixture file in the directory cannot move the head. */
const migrationHeadOf = Effect.fn("migrationHeadOf")(function* (migrationsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  let head = 0;
  for (const entry of yield* fs.readDirectory(migrationsDir)) {
    const id = /^(\d+)_/.exec(entry)?.[1];
    if (id !== undefined) head = Math.max(head, Number(id));
  }
  return head;
});

const readWrittenMetadata = Effect.fn("readWrittenMetadata")(function* (
  filePath: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(filePath);
  return Option.getOrThrow(decodeReleaseMetadata(`v${version}`, text));
});

it.layer(ScriptTestLayer)("build-release-metadata", (it) => {
  it.effect("writes one metadata file per channel at the highest migration id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      for (const { channel, version } of CHANNEL_FIXTURES) {
        const { rootDir, outputDir } = yield* makeFixtureRoot(`release-metadata-${channel}-`);
        yield* writeMigrationFixtures(rootDir, [
          "007_Seventh.ts",
          "042_FortyTwo.ts",
          "042_FortyTwo.test.ts",
          "073_ActiveTurnItemIndexes.ts",
          "legacyThreadPullRequestKey.ts",
          "README.md",
        ]);

        const { filePath } = yield* buildReleaseMetadata({
          version,
          channel,
          outputDir,
          rootDir,
        });

        assert.equal(filePath, path.join(outputDir, CLI_RELEASE_METADATA_FILE));
        assert.deepStrictEqual(yield* fs.readDirectory(outputDir), [CLI_RELEASE_METADATA_FILE]);

        const metadata = yield* readWrittenMetadata(filePath, version);
        assert.deepStrictEqual(metadata, {
          version,
          channel,
          databaseMigration: 73,
        });
      }
    }),
  );

  it.effect("stamps the migration head this checkout actually ships", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { outputDir } = yield* makeFixtureRoot("release-metadata-head-");
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const expectedHead = yield* migrationHeadOf(path.join(repoRoot, MIGRATIONS_RELATIVE_PATH));

      const { filePath } = yield* buildReleaseMetadata({
        version: STABLE_VERSION,
        channel: "stable",
        outputDir,
      });

      const metadata = yield* readWrittenMetadata(filePath, STABLE_VERSION);
      assert.equal(metadata.databaseMigration, expectedHead);
    }),
  );

  it.effect("stamps 0 when the workspace has no migrations", () =>
    Effect.gen(function* () {
      const { rootDir, outputDir } = yield* makeFixtureRoot("release-metadata-empty-");

      const { filePath } = yield* buildReleaseMetadata({
        version: STABLE_VERSION,
        channel: "stable",
        outputDir,
        rootDir,
      });

      const metadata = yield* readWrittenMetadata(filePath, STABLE_VERSION);
      assert.equal(metadata.databaseMigration, 0);
    }),
  );

  it.effect("rejects an unknown channel and a channel that contradicts the version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { rootDir, outputDir } = yield* makeFixtureRoot("release-metadata-bad-channel-");
      yield* writeMigrationFixtures(rootDir, ["001_OrchestrationEvents.ts"]);

      for (const request of [
        { version: STABLE_VERSION, channel: "latest" as unknown as CliReleaseChannel },
        // Metadata readers drop a channel the version does not carry, so the
        // generator must refuse to write it.
        { version: "9.9.10-nightly.20260713.4", channel: "stable" as CliReleaseChannel },
      ]) {
        const exit = yield* Effect.exit(buildReleaseMetadata({ ...request, outputDir, rootDir }));

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) assert.isTrue(Cause.hasFails(exit.cause));
        assert.deepStrictEqual(yield* fs.readDirectory(outputDir), []);
      }
    }),
  );

  it.effect("rejects malformed release versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { rootDir, outputDir } = yield* makeFixtureRoot("release-metadata-bad-version-");

      for (const version of ["9.9.9.1", "v9.9.9-plusplus.1", "latest"]) {
        const error = yield* buildReleaseMetadata({
          version,
          channel: "stable",
          outputDir,
          rootDir,
        }).pipe(Effect.flip);

        assert.instanceOf(error, InvalidReleaseVersionError);
        assert.equal(error.version, version);
      }

      assert.deepStrictEqual(yield* fs.readDirectory(outputDir), []);
    }),
  );
});
