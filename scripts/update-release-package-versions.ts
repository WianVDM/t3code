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
import { Argument, Command, Flag } from "effect/cli";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

export class ReleasePackageManifestError extends Schema.TaggedError<ReleasePackageManifestError>()(
  "ReleasePackageManifestError",
  {
    operation: Schema.Literals(["read", "decode", "encode", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} release package manifest '${this.filePath}'.`;
  }
}

export class ReleaseGitHubOutputConfigurationError extends Schema.TaggedError<ReleaseGitHubOutputConfigurationError>()(
  "ReleaseGitHubOutputConfigurationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to resolve GITHUB_OUTPUT for release package version output.";
  }
}

export class ReleaseGitHubOutputWriteError extends Schema.TaggedError<ReleaseGitHubOutputWriteError>()(
  "ReleaseGitHubOutputWriteError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to append release package version output to '${this.filePath}'.`;
  }
}

export class InvalidReleaseVersionError extends Schema.TaggedError<InvalidReleaseVersionError>()(
  "InvalidReleaseVersionError",
  { version: Schema.String },
) {
  override get message(): string {
    return `Invalid release version '${this.version}'; expected X.Y.Z with an optional channel suffix such as -plusplus.N.`;
  }
}

// `X.Y.Z` plus one optional channel suffix (`-plusplus.N`, `-nightly.*`,
// `-preview.*`, `-pr.*`). The suffix must start with `-`: `0.1.5.1`-style
// versions are not semver, and npm and Electron tooling reject them.
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export const assertReleaseVersion = Effect.fn("assertReleaseVersion")(function* (version: string) {
  if (!RELEASE_VERSION.test(version)) {
    return yield* new InvalidReleaseVersionError({ version });
  }
  return version;
});

export const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

interface UpdateReleasePackageVersionsOptions {
  readonly rootDir?: string | undefined;
}

const PackageJsonSchema = Schema.Record(Schema.String, Schema.Unknown);
const PackageJsonPrettyJson = fromJsonStringPretty(PackageJsonSchema);
const decodePackageJson = Schema.decodeUnknownEffect(PackageJsonPrettyJson);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

export const updateReleasePackageVersions = Effect.fn("updateReleasePackageVersions")(function* (
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
) {
  yield* assertReleaseVersion(version);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  let changed = false;

  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(rootDir, relativePath);
    const packageJsonText = yield* fs.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "read",
            filePath,
            cause,
          }),
      ),
    );
    const packageJson = yield* decodePackageJson(packageJsonText).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "decode",
            filePath,
            cause,
          }),
      ),
    );
    if (packageJson.version === version) {
      continue;
    }

    const packageJsonString = yield* encodePackageJson({ ...packageJson, version }).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "encode",
            filePath,
            cause,
          }),
      ),
    );
    yield* fs.writeFileString(filePath, `${packageJsonString}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new ReleasePackageManifestError({
            operation: "write",
            filePath,
            cause,
          }),
      ),
    );
    changed = true;
  }

  return { changed };
});

const writeGithubOutput = Effect.fn("writeGithubOutput")(function* (changed: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const githubOutputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseGitHubOutputConfigurationError({
          cause,
        }),
    ),
  );
  yield* fs.writeFileString(githubOutputPath, `changed=${changed}\n`, { flag: "a" }).pipe(
    Effect.mapError(
      (cause) =>
        new ReleaseGitHubOutputWriteError({
          filePath: githubOutputPath,
          cause,
        }),
    ),
  );
});

export const updateReleasePackageVersionsCommand = Command.make(
  "update-release-package-versions",
  {
    version: Argument.String("version").pipe(
      Argument.withDescription("Release version to write into each releasable package.json."),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription("Workspace root used to resolve the release package manifests."),
      Flag.optional,
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Append changed=<boolean> to GITHUB_OUTPUT."),
      Flag.withDefault(false),
    ),
  },
  ({ version, root, githubOutput }) =>
    updateReleasePackageVersions(version, {
      rootDir: Option.getOrUndefined(root),
    }).pipe(
      Effect.tap(({ changed }) =>
        changed
          ? Effect.void
          : Console.log("All package.json versions already match release version."),
      ),
      Effect.tap(({ changed }) => (githubOutput ? writeGithubOutput(changed) : Effect.void)),
    ),
).pipe(Command.withDescription("Update release package versions across the workspace."));

if (import.meta.main) {
  Command.run(updateReleasePackageVersionsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
