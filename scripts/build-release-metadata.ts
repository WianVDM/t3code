#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import {
  CLI_RELEASE_CHANNELS,
  CLI_RELEASE_METADATA_FILE,
  ReleaseMetadataSchema,
  cliReleaseChannelOf,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import { assertReleaseVersion } from "./update-release-package-versions.ts";

export class InvalidReleaseChannelError extends Schema.TaggedError<InvalidReleaseChannelError>()(
  "InvalidReleaseChannelError",
  { version: Schema.String, channel: Schema.String },
) {
  override get message(): string {
    return `Invalid release channel '${this.channel}' for version '${this.version}'.`;
  }
}

export class ReleaseMetadataWriteError extends Schema.TaggedError<ReleaseMetadataWriteError>()(
  "ReleaseMetadataWriteError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to write release metadata '${this.filePath}'.`;
  }
}

export interface BuildReleaseMetadataOptions {
  readonly version: string;
  readonly channel: CliReleaseChannel;
  readonly outputDir: string;
  readonly rootDir?: string | undefined;
}

const MIGRATIONS_RELATIVE_PATH = "apps/server/src/persistence/Migrations";

const encodeMetadataJson = Schema.encodeEffect(fromJsonStringPretty(ReleaseMetadataSchema));

/** Highest `NNN_` migration prefix in the workspace, or 0 when there are none. */
const migrationHeadOf = Effect.fn("migrationHeadOf")(function* (migrationsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(migrationsDir))) return 0;
  let head = 0;
  for (const entry of yield* fs.readDirectory(migrationsDir)) {
    const id = /^(\d+)_/.exec(entry)?.[1];
    if (id !== undefined) head = Math.max(head, Number(id));
  }
  return head;
});

export const buildReleaseMetadata = Effect.fn("buildReleaseMetadata")(function* ({
  version,
  channel,
  outputDir,
  rootDir,
}: BuildReleaseMetadataOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* assertReleaseVersion(version);
  // Readers drop metadata whose channel contradicts the version, so refuse to write it.
  if (!CLI_RELEASE_CHANNELS.includes(channel) || cliReleaseChannelOf(version) !== channel) {
    return yield* new InvalidReleaseChannelError({ version, channel });
  }

  const resolvedRootDir = rootDir ?? (yield* path.fromFileUrl(new URL("..", import.meta.url)));
  const databaseMigration = yield* migrationHeadOf(
    path.join(resolvedRootDir, MIGRATIONS_RELATIVE_PATH),
  );
  const filePath = path.join(outputDir, CLI_RELEASE_METADATA_FILE);
  const json = yield* encodeMetadataJson({ version, channel, databaseMigration });
  yield* fs
    .writeFileString(filePath, `${json}\n`)
    .pipe(Effect.mapError((cause) => new ReleaseMetadataWriteError({ filePath, cause })));
  return { filePath };
});

export const buildReleaseMetadataCommand = Command.make(
  "build-release-metadata",
  {
    version: Flag.String("version").pipe(
      Flag.withDescription("Release version to stamp, e.g. 1.2.3 or 1.2.3-nightly.20260101.1."),
    ),
    channel: Flag.String("channel").pipe(
      Flag.withDescription("Release channel: stable, nightly, or preview."),
    ),
    outputDir: Flag.String("output-dir").pipe(
      Flag.withDescription("Existing directory that receives release-metadata.json."),
    ),
    rootDir: Flag.String("root").pipe(
      Flag.withDescription("Workspace root used to resolve the migrations directory."),
      Flag.optional,
    ),
  },
  ({ version, channel, outputDir, rootDir }) =>
    buildReleaseMetadata({
      version,
      channel: channel as CliReleaseChannel,
      outputDir,
      rootDir: Option.getOrUndefined(rootDir),
    }),
).pipe(Command.withDescription("Write release-metadata.json for a CLI release."));

if (import.meta.main) {
  Command.run(buildReleaseMetadataCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
