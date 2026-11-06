import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import {
  InvalidReleaseVersionError,
  releasePackageFiles,
  updateReleasePackageVersions,
  updateReleasePackageVersionsCommand,
} from "./update-release-package-versions.ts";

const ScriptTestLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);
const runCli = Command.runWith(updateReleasePackageVersionsCommand, { version: "0.0.0" });
const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageJsonPrettyJson = fromJsonStringPretty(PackageJsonSchema);
const decodePackageJson = Schema.decodeEffect(PackageJsonPrettyJson);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const writePackageJsonFixtures = Effect.fn("writePackageJsonFixtures")(function* (
  rootDir: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(
      filePath,
      `${yield* encodePackageJson({
        name: relativePath,
        version,
        private: true,
      })}\n`,
    );
  }
});

const readReleaseVersions = Effect.fn("readReleaseVersions")(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions = new Map<string, string>();

  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    const packageJson = yield* fs.readFileString(filePath).pipe(Effect.flatMap(decodePackageJson));
    versions.set(relativePath, String(packageJson.version));
  }

  return versions;
});

it.layer(ScriptTestLayer)("update-release-package-versions", (it) => {
  it.effect("updates all release package versions under the provided root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-",
      });

      yield* writePackageJsonFixtures(baseDir, "0.0.1");

      const result = yield* updateReleasePackageVersions("1.2.3", { rootDir: baseDir });
      const versions = yield* readReleaseVersions(baseDir);

      assert.deepStrictEqual(result, { changed: true });
      assert.deepStrictEqual(
        Array.from(versions.entries()),
        releasePackageFiles.map((relativePath) => [relativePath, "1.2.3"]),
      );
    }),
  );

  it.effect("returns changed=false when all versions already match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-unchanged-",
      });

      yield* writePackageJsonFixtures(baseDir, "1.2.3");

      const result = yield* updateReleasePackageVersions("1.2.3", { rootDir: baseDir });

      assert.deepStrictEqual(result, { changed: false });
    }),
  );

  it.effect("accepts plusplus release versions and rejects malformed ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-validation-",
      });

      yield* writePackageJsonFixtures(baseDir, "0.1.5-plusplus.1");

      const result = yield* updateReleasePackageVersions("0.1.5-plusplus.2", { rootDir: baseDir });
      const versions = yield* readReleaseVersions(baseDir);

      assert.deepStrictEqual(result, { changed: true });
      assert.deepStrictEqual(
        Array.from(versions.entries()),
        releasePackageFiles.map((relativePath) => [relativePath, "0.1.5-plusplus.2"]),
      );

      for (const version of ["v0.1.5-plusplus.2", "0.1.5.1", "0.1.5-", "0.1.5_plusplus.1"]) {
        const error = yield* updateReleasePackageVersions(version, { rootDir: baseDir }).pipe(
          Effect.flip,
        );
        assert.instanceOf(error, InvalidReleaseVersionError);
      }

      // The PR preview suffix stacks on a release version and must keep working.
      const preview = yield* updateReleasePackageVersions("0.1.5-plusplus.2-pr.4.5", {
        rootDir: baseDir,
      });
      assert.deepStrictEqual(preview, { changed: true });
    }),
  );

  it.effect("accepts flags before the version positional and appends changed output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "update-release-package-versions-cli-",
      });
      const githubOutputPath = path.join(baseDir, "github-output.txt");

      yield* writePackageJsonFixtures(baseDir, "0.0.1");

      yield* runCli(["--github-output", "--root", baseDir, "2.0.0"]).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_OUTPUT: githubOutputPath,
              },
            }),
          ),
        ),
      );

      const githubOutput = yield* fs.readFileString(githubOutputPath);
      assert.equal(githubOutput, "changed=true\n");
    }),
  );
});
