import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Fork identity, release discovery, and channel classification live in
// @t3tools/plusplus/forkIdentity; this facade keeps the cliRelease import surface stable for
// consumers that can only reach @t3tools/shared.
import {
  FORK_BROWSER_SETUP_COMMAND,
  FORK_CLI_RELEASE_CHANNELS as CLI_RELEASE_CHANNELS,
  FORK_RELEASE_DOWNLOAD_BASE_URL as CLI_RELEASE_DEFAULT_BASE_URL,
  FORK_RELEASES_URL as CLI_RELEASES_PAGE_URL,
  forkCliReleaseChannelOf as cliReleaseChannelOf,
  forkCliReleaseIndexPageUrl as cliReleaseIndexPageUrl,
  newestForkCliReleaseVersion as newestCliReleaseVersion,
  resolveForkGitHubPublishConfig,
  type ForkCliReleaseChannel as CliReleaseChannel,
} from "@t3tools/plusplus/forkIdentity";
import { compareSemverVersions } from "./semver.ts";

export {
  CLI_RELEASE_CHANNELS,
  CLI_RELEASES_PAGE_URL,
  FORK_BROWSER_SETUP_COMMAND,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  resolveForkGitHubPublishConfig,
};
export type { CliReleaseChannel };

export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_METADATA_FILE = "release-metadata.json";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

// Keep archive keys aligned with the cli_archive rows in release.yml, plus the darwin-arm64 archive
// offered as a manual macOS download. Node single-executables do not support darwin-x64 and segfault
// at startup, and the ARM64 Linux and Windows builds publish no CLI archive.
const CLI_ARCHIVE_PLATFORM_KEYS = ["linux-x64", "win32-x64", "darwin-arm64"] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/** Use System32 bsdtar on Windows; Git-for-Windows GNU tar cannot open zip archives. */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

export function cliReleaseMetadataUrl(version: string): string {
  return `${cliReleaseDownloadBaseUrl(version)}/${CLI_RELEASE_METADATA_FILE}`;
}

/** `segments` added to `baseUrl`'s path, keeping its query, such as a signed mirror URL's token. */
export function releaseAssetUrl(baseUrl: string, ...segments: ReadonlyArray<string>): string {
  const url = new URL(baseUrl);
  url.pathname = [url.pathname.replace(/\/+$/, ""), ...segments.map(encodeURIComponent)].join("/");
  return url.toString();
}

/** A file of release `version`, from `baseUrl` laid out as GitHub's release downloads. */
export function cliReleaseAssetUrl(
  version: string,
  fileName: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return releaseAssetUrl(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL, `v${version}`, fileName);
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

/** Whether updating between these versions crosses Stable and Nightly. Preview builds cross nothing.
 * Hosts refuse a crossing outside a track switch, which checks the database first. */
export function crossesReleaseTrack(fromVersion: string, toVersion: string): boolean {
  const from = cliReleaseChannelOf(fromVersion);
  const to = cliReleaseChannelOf(toVersion);
  return from !== to && from !== "preview" && to !== "preview";
}

/** The desktop update track a build belongs to. Preview builds have no feed and read as Stable. */
export function desktopUpdateChannelOf(version: string): "latest" | "nightly" {
  return cliReleaseChannelOf(version) === "nightly" ? "nightly" : "latest";
}

/**
 * The update feed file a desktop app on this platform reads, which an update mirror publishes at
 * its root beside the release's CLI archives.
 */
export function updateFeedFileName(
  channel: "latest" | "nightly",
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (platform === "darwin") return `${channel}-mac.yml`;
  if (platform === "linux")
    return arch === "arm64" ? `${channel}-linux-arm64.yml` : `${channel}-linux.yml`;
  return `${channel}.yml`;
}

/** Whether a track switch may install `found` after its database check cleared `checked`: any build
 * on the switch's track at least as new, since later releases only add migrations. */
export function acceptsTrackSwitchRelease(
  found: string,
  channel: "latest" | "nightly",
  checked: string,
): boolean {
  return (
    cliReleaseChannelOf(found) === (channel === "nightly" ? "nightly" : "stable") &&
    compareSemverVersions(found, checked) >= 0
  );
}

export const ReleaseMetadataSchema = Schema.Struct({
  version: Schema.NonEmptyString,
  channel: Schema.Literals(CLI_RELEASE_CHANNELS),
  /** Omitted by metadata written before the field existed. */
  databaseMigration: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ReleaseMetadata = typeof ReleaseMetadataSchema.Type;

const decodeReleaseMetadataJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReleaseMetadataSchema),
);

/** Decodes the `release-metadata.json` body served by `tag`. Unparseable or inconsistent
 * metadata yields nothing, so callers fail closed instead of assuming a version or channel. */
export function decodeReleaseMetadata(tag: string, json: string): Option.Option<ReleaseMetadata> {
  return Option.filter(
    decodeReleaseMetadataJson(json),
    (metadata) =>
      metadata.version === tag.replace(/^v/, "") &&
      metadata.channel === cliReleaseChannelOf(metadata.version),
  );
}

const NpmReleaseMigrationManifest = Schema.Struct({
  t3code: Schema.Struct({ databaseMigration: Schema.Int }),
});
const decodeNpmReleaseMigrationManifest = Schema.decodeUnknownOption(NpmReleaseMigrationManifest);

/** Highest database migration a release's server knows, from its npm `t3` manifest. */
export function npmReleaseDatabaseMigration(manifest: unknown): number | undefined {
  return Option.getOrUndefined(decodeNpmReleaseMigrationManifest(manifest))?.t3code
    .databaseMigration;
}
