// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { InvalidReleaseVersionError } from "./update-release-package-versions.ts";
import {
  ForbiddenReleaseAssetError,
  MissingReleaseAssetError,
  ReleaseChecksumError,
  ReleaseMetadataError,
  verifyReleaseAssets,
  type ReleaseSmokeChannel,
} from "./release-smoke.ts";

const ScriptTestLayer = NodeServices.layer;

const STABLE_VERSION = "9.9.9-plusplus.1";

const sha256Hex = (content: string) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex");

const cliArchiveNames = (version: string) =>
  [
    `t3-${version}-linux-x64.tar.gz`,
    `t3-${version}-win32-x64.zip`,
    `t3-${version}-darwin-arm64.tar.gz`,
  ] as const;

// The full supported asset set: manual Windows/Linux x64 and macOS arm64
// desktop artifacts and CLI archives on GitHub Releases. macOS x64, other ARM
// platforms, mobile, and npm/AUR/Vercel/relay artifacts must never appear.
// macOS has no updater feed, so no mac manifests or blockmaps ship.
const makeFixtureFiles = (version: string, channel: ReleaseSmokeChannel) => {
  const files = new Map<string, string>();
  files.set(`T3-Code-${version}-x64.exe`, "nsis installer");
  files.set(`T3-Code-${version}-x64.AppImage`, "appimage");
  files.set(`T3-Code-${version}-arm64.dmg`, "dmg installer");
  for (const name of cliArchiveNames(version)) {
    files.set(name, `archive ${name}`);
  }
  if (channel !== "preview") {
    const manifest = channel === "nightly" ? "nightly" : "latest";
    files.set(`${manifest}.yml`, "windows updater manifest");
    files.set(`${manifest}-linux.yml`, "linux updater manifest");
    files.set(`T3-Code-${version}-x64.exe.blockmap`, "exe blockmap");
    files.set(`T3-Code-${version}-x64.AppImage.blockmap`, "appimage blockmap");
  }
  files.set("release-metadata.json", `${JSON.stringify({ version, channel })}\n`);
  return files;
};

const writeFixtures = Effect.fn("writeFixtures")(function* (
  assetsDir: string,
  files: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(assetsDir, { recursive: true });

  for (const [name, content] of files) {
    yield* fs.writeFileString(`${assetsDir}/${name}`, content);
  }

  // Mirrors the release workflow: SHA256SUMS covers the CLI archives only.
  const sums = [...files.entries()]
    .filter(([name]) => /^t3-.*\.(tar\.gz|zip)$/.test(name))
    .map(([name, content]) => `${sha256Hex(content)}  ${name}\n`)
    .join("");
  yield* fs.writeFileString(`${assetsDir}/SHA256SUMS`, sums);
});

it.layer(ScriptTestLayer)("release-smoke", (it) => {
  it.effect("passes for the supported Windows/Linux x64 and macOS arm64 ++ asset set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const assetsDir = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "release-smoke-valid-" }),
        "release-assets",
      );

      yield* writeFixtures(assetsDir, makeFixtureFiles(STABLE_VERSION, "stable"));

      yield* verifyReleaseAssets({
        assetsDir,
        version: STABLE_VERSION,
        channel: "stable",
      });
    }),
  );

  it.effect("accepts nightly and preview channels with their own updater rules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "release-smoke-channels-",
      });

      const nightlyVersion = "9.9.10-nightly.20260413.321";
      const nightlyDir = path.join(baseDir, "nightly");
      yield* writeFixtures(nightlyDir, makeFixtureFiles(nightlyVersion, "nightly"));
      yield* verifyReleaseAssets({
        assetsDir: nightlyDir,
        version: nightlyVersion,
        channel: "nightly",
      });

      const previewVersion = "9.9.10-preview.20260413.321";
      const previewDir = path.join(baseDir, "preview");
      yield* writeFixtures(previewDir, makeFixtureFiles(previewVersion, "preview"));
      yield* verifyReleaseAssets({
        assetsDir: previewDir,
        version: previewVersion,
        channel: "preview",
      });
    }),
  );

  it.effect("fails when a supported asset is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      for (const missing of [
        `T3-Code-${STABLE_VERSION}-x64.exe`,
        `T3-Code-${STABLE_VERSION}-x64.AppImage`,
        `T3-Code-${STABLE_VERSION}-arm64.dmg`,
        `t3-${STABLE_VERSION}-win32-x64.zip`,
        `t3-${STABLE_VERSION}-darwin-arm64.tar.gz`,
        "SHA256SUMS",
        "latest.yml",
        "release-metadata.json",
      ]) {
        const assetsDir = path.join(
          yield* fs.makeTempDirectoryScoped({
            prefix: "release-smoke-missing-",
          }),
          "release-assets",
        );
        const files = makeFixtureFiles(STABLE_VERSION, "stable");
        // writeFixtures always writes SHA256SUMS and release-metadata.json, so
        // the missing asset is removed from disk after writing; the rest are
        // dropped from the fixture map.
        const alwaysWritten = missing === "SHA256SUMS" || missing === "release-metadata.json";
        if (!alwaysWritten) {
          files.delete(missing);
        }
        yield* writeFixtures(assetsDir, files);
        if (alwaysWritten) {
          yield* fs.remove(`${assetsDir}/${missing}`);
        }

        const error = yield* verifyReleaseAssets({
          assetsDir,
          version: STABLE_VERSION,
          channel: "stable",
        }).pipe(Effect.flip);
        assert.instanceOf(error, MissingReleaseAssetError);
        assert.equal(error.asset, missing);
      }
    }),
  );

  it.effect("fails when a shipped artifact does not match SHA256SUMS", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const assetsDir = path.join(
        yield* fs.makeTempDirectoryScoped({
          prefix: "release-smoke-mismatch-",
        }),
        "release-assets",
      );

      yield* writeFixtures(assetsDir, makeFixtureFiles(STABLE_VERSION, "stable"));
      const archive = `t3-${STABLE_VERSION}-linux-x64.tar.gz`;
      yield* fs.writeFileString(`${assetsDir}/${archive}`, "tampered after checksum");

      const error = yield* verifyReleaseAssets({
        assetsDir,
        version: STABLE_VERSION,
        channel: "stable",
      }).pipe(Effect.flip);
      assert.instanceOf(error, ReleaseChecksumError);
      assert.equal(error.asset, archive);
    }),
  );

  it.effect("fails when SHA256SUMS omits a CLI archive or lists an absent file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "release-smoke-index-",
      });

      const omittedDir = path.join(baseDir, "omitted");
      yield* writeFixtures(omittedDir, makeFixtureFiles(STABLE_VERSION, "stable"));
      const sumsPath = `${omittedDir}/SHA256SUMS`;
      const sums = yield* fs.readFileString(sumsPath);
      yield* fs.writeFileString(
        sumsPath,
        sums
          .split("\n")
          .filter((line) => !line.includes("win32"))
          .join("\n"),
      );

      const omittedError = yield* verifyReleaseAssets({
        assetsDir: omittedDir,
        version: STABLE_VERSION,
        channel: "stable",
      }).pipe(Effect.flip);
      assert.instanceOf(omittedError, ReleaseChecksumError);
      assert.equal(omittedError.asset, `t3-${STABLE_VERSION}-win32-x64.zip`);

      const absentDir = path.join(baseDir, "absent");
      yield* writeFixtures(absentDir, makeFixtureFiles(STABLE_VERSION, "stable"));
      yield* fs.remove(`${absentDir}/t3-${STABLE_VERSION}-linux-x64.tar.gz`);

      const absentError = yield* verifyReleaseAssets({
        assetsDir: absentDir,
        version: STABLE_VERSION,
        channel: "stable",
      }).pipe(Effect.flip);
      assert.instanceOf(absentError, ReleaseChecksumError);
      assert.equal(absentError.asset, `t3-${STABLE_VERSION}-linux-x64.tar.gz`);
    }),
  );

  it.effect("rejects metadata that does not describe the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      for (const metadata of [
        `${JSON.stringify({ version: STABLE_VERSION, channel: "nightly" })}\n`,
        `${JSON.stringify({ version: "9.9.8-plusplus.1", channel: "stable" })}\n`,
        "not json",
      ]) {
        const assetsDir = path.join(
          yield* fs.makeTempDirectoryScoped({
            prefix: "release-smoke-metadata-",
          }),
          "release-assets",
        );
        yield* writeFixtures(assetsDir, makeFixtureFiles(STABLE_VERSION, "stable"));
        yield* fs.writeFileString(`${assetsDir}/release-metadata.json`, metadata);

        const error = yield* verifyReleaseAssets({
          assetsDir,
          version: STABLE_VERSION,
          channel: "stable",
        }).pipe(Effect.flip);
        assert.instanceOf(error, ReleaseMetadataError);
        assert.equal(error.asset, "release-metadata.json");
      }
    }),
  );

  it.effect("rejects forbidden platform and registry artifacts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // macOS updater feeds are forbidden on every channel, including stable
      // and nightly where the Windows/Linux manifests ship.
      const channels = [
        { channel: "stable" as const, version: STABLE_VERSION },
        { channel: "nightly" as const, version: "9.9.10-nightly.20260413.321" },
      ];
      const forbiddenAssets = (version: string) => [
        `T3-Code-${version}-arm64.exe`,
        `T3-Code-${version}-x64.dmg`,
        `t3-${version}-darwin-x64.tar.gz`,
        `t3-${version}-linux-arm64.tar.gz`,
        `t3-${version}-win32-arm64.zip`,
        "latest-mac.yml",
        "nightly-mac.yml",
        `t3code-${version}.apk`,
        `t3-${version}.tgz`,
        "PKGBUILD",
        "vercel.json",
        "relay-client-tracing-config.json",
      ];

      for (const { channel, version } of channels) {
        for (const forbidden of forbiddenAssets(version)) {
          const assetsDir = path.join(
            yield* fs.makeTempDirectoryScoped({
              prefix: "release-smoke-forbidden-",
            }),
            "release-assets",
          );
          const files = makeFixtureFiles(version, channel);
          files.set(forbidden, "must not ship");
          yield* writeFixtures(assetsDir, files);

          const error = yield* verifyReleaseAssets({
            assetsDir,
            version,
            channel,
          }).pipe(Effect.flip);
          assert.instanceOf(error, ForbiddenReleaseAssetError);
          assert.equal(error.asset, forbidden);
        }
      }
    }),
  );

  it.effect("forbids updater metadata on preview releases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const assetsDir = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "release-smoke-preview-" }),
        "release-assets",
      );

      const version = "9.9.10-preview.20260413.321";
      const files = makeFixtureFiles(version, "preview");
      files.set("latest.yml", "updater metadata must not be offered");
      yield* writeFixtures(assetsDir, files);

      const error = yield* verifyReleaseAssets({
        assetsDir,
        version,
        channel: "preview",
      }).pipe(Effect.flip);
      assert.instanceOf(error, ForbiddenReleaseAssetError);
      assert.equal(error.asset, "latest.yml");
    }),
  );

  it.effect("requires a ++ stable version and rejects malformed ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      for (const version of ["v9.9.9-plusplus.1", "9.9.9", "9.9.9-alpha.1", "9.9.9.1"]) {
        const assetsDir = path.join(
          yield* fs.makeTempDirectoryScoped({
            prefix: "release-smoke-version-",
          }),
          "release-assets",
        );
        yield* writeFixtures(assetsDir, makeFixtureFiles(STABLE_VERSION, "stable"));

        const error = yield* verifyReleaseAssets({
          assetsDir,
          version,
          channel: "stable",
        }).pipe(Effect.flip);
        assert.instanceOf(error, InvalidReleaseVersionError);
      }
    }),
  );
});
