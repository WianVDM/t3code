import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASE_CHANNELS,
  CLI_RELEASE_METADATA_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseMetadataUrl,
  newestCliReleaseVersion,
  parseChecksums,
  ReleaseMetadataSchema,
  decodeReleaseMetadata,
} from "./cliRelease.ts";

const decodeReleaseMetadataOption = Schema.decodeOption(ReleaseMetadataSchema);

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3-plusplus.4" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3-plusplus.4");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

describe("cli archive platforms", () => {
  it("supports darwin-arm64 alongside the published linux-x64 and win32-x64 archives", () => {
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("win32", "x64")).toBe("win32-x64");
  });

  it("names the darwin-arm64 archive as a gzip tarball", () => {
    expect(cliArchiveFileName("1.2.3", "darwin-arm64")).toBe("t3-1.2.3-darwin-arm64.tar.gz");
  });

  it("builds the darwin-arm64 download URL from the release base", () => {
    expect(
      `${cliReleaseDownloadBaseUrl("1.2.3")}/${cliArchiveFileName("1.2.3", "darwin-arm64")}`,
    ).toBe(
      "https://github.com/WianVDM/t3code/releases/download/v1.2.3/t3-1.2.3-darwin-arm64.tar.gz",
    );
  });

  it.each(["darwin-x64", "linux-arm64", "win32-arm64"])("rejects unsupported target %s", (key) => {
    const [platform, arch] = key.split("-") as [string, string];
    expect(cliArchivePlatformKey(platform as NodeJS.Platform, arch)).toBeUndefined();
  });
});

describe("release metadata", () => {
  it("serves the metadata asset from the release download URL", () => {
    expect(CLI_RELEASE_METADATA_FILE).toBe("release-metadata.json");
    expect(cliReleaseMetadataUrl("1.2.3")).toBe(
      "https://github.com/WianVDM/t3code/releases/download/v1.2.3/release-metadata.json",
    );
    expect(cliReleaseMetadataUrl("1.2.4-nightly.20260912.7")).toBe(
      "https://github.com/WianVDM/t3code/releases/download/v1.2.4-nightly.20260912.7/release-metadata.json",
    );
  });

  it("accepts every release channel in the schema", () => {
    for (const channel of CLI_RELEASE_CHANNELS) {
      expect(Option.isSome(decodeReleaseMetadataOption({ version: "1.2.3", channel }))).toBe(true);
    }
  });

  it("decodes stable metadata matching its tag", () => {
    for (const tag of ["v1.2.3", "v1.2.3-plusplus.4"]) {
      const version = tag.slice(1);
      const metadata = Option.getOrThrow(
        decodeReleaseMetadata(
          tag,
          JSON.stringify({ version, channel: "stable", databaseMigration: 7 }),
        ),
      );
      expect(metadata).toEqual({ version, channel: "stable", databaseMigration: 7 });
    }
  });

  it("decodes nightly metadata matching its tag", () => {
    const metadata = Option.getOrThrow(
      decodeReleaseMetadata(
        "v1.2.4-nightly.20260912.7",
        JSON.stringify({
          version: "1.2.4-nightly.20260912.7",
          channel: "nightly",
          databaseMigration: 12,
        }),
      ),
    );
    expect(metadata).toEqual({
      version: "1.2.4-nightly.20260912.7",
      channel: "nightly",
      databaseMigration: 12,
    });
  });

  it("decodes preview metadata matching its tag", () => {
    const metadata = Option.getOrThrow(
      decodeReleaseMetadata(
        "v1.2.4-preview.20260912.8",
        JSON.stringify({
          version: "1.2.4-preview.20260912.8",
          channel: "preview",
          databaseMigration: 12,
        }),
      ),
    );
    expect(metadata).toEqual({
      version: "1.2.4-preview.20260912.8",
      channel: "preview",
      databaseMigration: 12,
    });
  });

  it("tolerates an omitted databaseMigration", () => {
    const metadata = Option.getOrThrow(
      decodeReleaseMetadata("v1.2.3", JSON.stringify({ version: "1.2.3", channel: "stable" })),
    );
    expect(metadata.version).toBe("1.2.3");
    expect(metadata.channel).toBe("stable");
    expect(metadata.databaseMigration).toBeUndefined();
  });

  it("fails closed on malformed JSON", () => {
    expect(Option.isNone(decodeReleaseMetadata("v1.2.3", "{ not json"))).toBe(true);
    expect(Option.isNone(decodeReleaseMetadata("v1.2.3", ""))).toBe(true);
  });

  it.each([
    { version: 123, channel: "stable", databaseMigration: 7 },
    { version: "1.2.3", channel: "beta", databaseMigration: 7 },
    { version: "1.2.3", channel: "stable", databaseMigration: "7" },
    { version: "1.2.3", channel: "stable", databaseMigration: 1.5 },
    { version: "1.2.3", channel: "stable", databaseMigration: -1 },
    { version: "", channel: "stable", databaseMigration: 7 },
    { channel: "stable", databaseMigration: 7 },
    { version: "1.2.3", databaseMigration: 7 },
  ])("fails closed on wrong field types %j", (payload) => {
    expect(Option.isNone(decodeReleaseMetadata("v1.2.3", JSON.stringify(payload)))).toBe(true);
  });

  it("fails closed when the version does not match the tag", () => {
    expect(
      Option.isNone(
        decodeReleaseMetadata(
          "v1.2.3",
          JSON.stringify({ version: "1.2.4", channel: "stable", databaseMigration: 7 }),
        ),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        decodeReleaseMetadata(
          "v1.2.4-nightly.20260912.7",
          JSON.stringify({ version: "1.2.4-nightly.20260912.8", channel: "nightly" }),
        ),
      ),
    ).toBe(true);
  });

  it("fails closed when the channel does not match the version", () => {
    expect(
      Option.isNone(
        decodeReleaseMetadata(
          "v1.2.4-nightly.20260912.7",
          JSON.stringify({
            version: "1.2.4-nightly.20260912.7",
            channel: "stable",
            databaseMigration: 7,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        decodeReleaseMetadata(
          "v1.2.3",
          JSON.stringify({ version: "1.2.3", channel: "nightly", databaseMigration: 7 }),
        ),
      ),
    ).toBe(true);
  });
});
