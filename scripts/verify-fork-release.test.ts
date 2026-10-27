import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { verifyForkRelease } from "./verify-fork-release.ts";

const version = "1.2.3";
const installerName = `T3-Code-Fork-${version}-x64.exe`;
const installerBytes = Uint8Array.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]);
const blockmapBytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x42]);

const makeReleaseFixture = Effect.fn("test.makeReleaseFixture")(function* (options: {
  readonly manifestVersion?: string;
  readonly includeX64Entry?: boolean;
  readonly reportedSize?: number;
  readonly reportedSha512?: string;
  readonly includeBlockmap?: boolean;
}) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const releaseDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "verify-fork-release-",
  });
  const manifestVersion = options.manifestVersion ?? version;
  const arm64Bytes = Uint8Array.from([0x4d, 0x5a, 0x61, 0x72, 0x6d]);
  const arm64Sha512 = Base64.encode(yield* crypto.digest("SHA-512", arm64Bytes));
  const installerSha512 = Base64.encode(yield* crypto.digest("SHA-512", installerBytes));
  const entries = [
    `  - url: T3-Code-Fork-${manifestVersion}-arm64.exe`,
    `    sha512: ${arm64Sha512}`,
    `    size: ${arm64Bytes.byteLength}`,
  ];
  if (options.includeX64Entry !== false) {
    entries.push(
      `  - url: T3-Code-Fork-${manifestVersion}-x64.exe`,
      `    sha512: ${options.reportedSha512 ?? installerSha512}`,
      `    size: ${options.reportedSize ?? installerBytes.byteLength}`,
    );
  }

  yield* fs.writeFileString(
    path.join(releaseDirectory, "latest.yml"),
    [
      `version: ${manifestVersion}`,
      "files:",
      ...entries,
      "releaseDate: '2026-03-07T10:36:07.540Z'",
      "",
    ].join("\n"),
  );
  yield* fs.writeFile(path.join(releaseDirectory, installerName), installerBytes);
  if (options.includeBlockmap !== false) {
    yield* fs.writeFile(path.join(releaseDirectory, `${installerName}.blockmap`), blockmapBytes);
  }

  return releaseDirectory;
});

const assertVerificationFails = Effect.fn("test.assertVerificationFails")(function* (
  releaseDirectory: string,
  expectedMessage: RegExp,
) {
  const result = yield* Effect.exit(verifyForkRelease(version, "x64", releaseDirectory));
  assert.isTrue(Exit.isFailure(result));
  if (Exit.isFailure(result)) {
    assert.match(Cause.pretty(result.cause), expectedMessage);
  }
});

it.layer(NodeServices.layer)("verify-fork-release", (it) => {
  it.effect("accepts a valid x64 release with an extra arm64 manifest entry", () =>
    Effect.gen(function* () {
      const releaseDirectory = yield* makeReleaseFixture({});

      yield* verifyForkRelease(version, "x64", releaseDirectory);
    }),
  );

  it.effect("rejects a manifest with the wrong version", () =>
    Effect.gen(function* () {
      const releaseDirectory = yield* makeReleaseFixture({ manifestVersion: "1.2.4" });

      yield* assertVerificationFails(releaseDirectory, /has version '1\.2\.4', expected '1\.2\.3'/);
    }),
  );

  it.effect("rejects a manifest without the exact x64 installer entry", () =>
    Effect.gen(function* () {
      const releaseDirectory = yield* makeReleaseFixture({ includeX64Entry: false });

      yield* assertVerificationFails(
        releaseDirectory,
        /missing file\.url 'T3-Code-Fork-1\.2\.3-x64\.exe'/,
      );
    }),
  );

  it.effect("rejects an installer with a different size than the manifest", () =>
    Effect.gen(function* () {
      const releaseDirectory = yield* makeReleaseFixture({
        reportedSize: installerBytes.byteLength + 1,
      });

      yield* assertVerificationFails(releaseDirectory, /has byte size 8, expected 9/);
    }),
  );

  it.effect("rejects an installer with a different SHA-512 than the manifest", () =>
    Effect.gen(function* () {
      const releaseDirectory = yield* makeReleaseFixture({
        reportedSha512: Base64.encode(new Uint8Array(64)),
      });

      yield* assertVerificationFails(releaseDirectory, /has SHA-512/);
    }),
  );

  it.effect("rejects a release without the installer blockmap", () =>
    Effect.gen(function* () {
      const releaseDirectory = yield* makeReleaseFixture({ includeBlockmap: false });

      yield* assertVerificationFails(releaseDirectory, /Fork release blockmap .* is missing at/);
    }),
  );
});
