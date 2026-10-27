#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import {
  parseUpdateManifest,
  type UpdateManifest,
  type UpdateManifestFile,
} from "./lib/update-manifest.ts";

const ForkReleaseArch = Schema.Literals(["x64", "arm64"]);
export type ForkReleaseArch = typeof ForkReleaseArch.Type;

export function selectForkReleaseInstaller(
  manifest: UpdateManifest,
  options: {
    readonly expectedVersion: string;
    readonly arch: ForkReleaseArch;
    readonly manifestPath: string;
  },
): UpdateManifestFile {
  if (manifest.version !== options.expectedVersion) {
    throw new Error(
      `Fork release manifest at ${options.manifestPath} has version '${manifest.version}', expected '${options.expectedVersion}'.`,
    );
  }

  const expectedUrl = `T3-Code-Fork-${options.expectedVersion}-${options.arch}.exe`;
  const installer = manifest.files.find((file) => file.url === expectedUrl);
  if (!installer) {
    throw new Error(
      `Fork release manifest at ${options.manifestPath} (version '${options.expectedVersion}') is missing file.url '${expectedUrl}'.`,
    );
  }
  return installer;
}

export const verifyForkRelease = Effect.fn("verifyForkRelease")(function* (
  expectedVersion: string,
  arch: ForkReleaseArch,
  releaseDirectoryArg: string,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const releaseDirectory = path.resolve(releaseDirectoryArg);
  const manifestPath = path.join(releaseDirectory, "latest.yml");
  const manifest = parseUpdateManifest(
    yield* fs.readFileString(manifestPath),
    manifestPath,
    "Windows fork release",
  );
  const installerEntry = selectForkReleaseInstaller(manifest, {
    expectedVersion,
    arch,
    manifestPath,
  });
  const installerPath = path.join(releaseDirectory, installerEntry.url);
  const blockmapPath = `${installerPath}.blockmap`;

  if (!(yield* fs.exists(installerPath))) {
    throw new Error(
      `Fork release installer for version '${expectedVersion}' is missing at ${installerPath}.`,
    );
  }
  const installerBytes = yield* fs.readFile(installerPath);
  if (installerBytes.byteLength !== installerEntry.size) {
    throw new Error(
      `Fork release installer at ${installerPath} (version '${expectedVersion}') has byte size ${installerBytes.byteLength}, expected ${installerEntry.size}.`,
    );
  }

  const actualSha512 = Base64.encode(yield* crypto.digest("SHA-512", installerBytes));
  if (actualSha512 !== installerEntry.sha512) {
    throw new Error(
      `Fork release installer at ${installerPath} (version '${expectedVersion}') has SHA-512 '${actualSha512}', expected '${installerEntry.sha512}'.`,
    );
  }

  if (!(yield* fs.exists(blockmapPath))) {
    throw new Error(
      `Fork release blockmap for installer at ${installerPath} (version '${expectedVersion}') is missing at ${blockmapPath}.`,
    );
  }
  yield* fs.readFile(blockmapPath);
});

export const verifyForkReleaseCommand = Command.make(
  "verify-fork-release",
  {
    version: Flag.String("version").pipe(Flag.withDescription("Expected fork release version.")),
    arch: Flag.Literals("arch", ForkReleaseArch.literals).pipe(
      Flag.withDescription("Windows installer architecture."),
    ),
    releaseDirectory: Argument.String("release-directory").pipe(
      Argument.withDescription("Directory containing latest.yml and the fork release artifacts."),
    ),
  },
  ({ version, arch, releaseDirectory }) => verifyForkRelease(version, arch, releaseDirectory),
).pipe(Command.withDescription("Verify a Windows fork release installer and blockmap."));

if (import.meta.main) {
  Command.run(verifyForkReleaseCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
