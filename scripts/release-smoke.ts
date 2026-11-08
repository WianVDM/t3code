// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASE_METADATA_FILE,
  cliArchiveFileName,
  type CliReleaseChannel,
  decodeReleaseMetadata,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { cliArchiveFileName as buildCliArchiveFileName } from "./build-cli-archive.ts";
import {
  InvalidReleaseVersionError,
  releasePackageFiles,
} from "./update-release-package-versions.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const releaseVersion = "9.9.9-plusplus.1";
const nightlyDate = "20260413";
const nightlyRunNumber = "321";
const nightlySha = "abcdef1234567890";

// The workspace the release graph builds from: server (CLI + web client),
// desktop, and their packages. Mobile, marketing, and the relay are not part
// of a release, so the fixture never depends on their trees existing.
const workspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "oxlint-plugin-t3code/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/plusplus/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/provider-core/package.json",
  "packages/provider-testing/package.json",
  "packages/provider-pi/package.json",
  "packages/provider-acp/package.json",
  "packages/provider-acp-registry/package.json",
  "packages/provider-cursor/package.json",
  "packages/provider-fx/package.json",
  "packages/provider-grok/package.json",
  "packages/provider-kiro/package.json",
  "packages/provider-muse/package.json",
  "packages/provider-opencode/package.json",
  "packages/secret-provider-core/package.json",
  "packages/secret-provider-definitions/package.json",
  "packages/secret-provider-onepassword/package.json",
  "packages/source-control-azure-devops/package.json",
  "packages/source-control-bitbucket/package.json",
  "packages/source-control-core/package.json",
  "packages/source-control-definitions/package.json",
  "packages/source-control-forgejo/package.json",
  "packages/source-control-gitcafe/package.json",
  "packages/source-control-github/package.json",
  "packages/source-control-gitlab/package.json",
  "packages/source-control-testing/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

// Windows x64, Linux x64, and the macOS arm64 manual download are the shipped
// targets; see the cli_archive rows in release.yml.
const cliTargets = [
  { platform: "linux", arch: "x64", platformKey: "linux-x64" },
  { platform: "win", arch: "x64", platformKey: "win32-x64" },
  { platform: "mac", arch: "arm64", platformKey: "darwin-arm64" },
] as const;

export type ReleaseSmokeChannel = CliReleaseChannel;

export class MissingReleaseAssetError extends Schema.TaggedError<MissingReleaseAssetError>()(
  "MissingReleaseAssetError",
  { asset: Schema.String },
) {
  override get message(): string {
    return `Release is missing required asset '${this.asset}'.`;
  }
}

export class ForbiddenReleaseAssetError extends Schema.TaggedError<ForbiddenReleaseAssetError>()(
  "ForbiddenReleaseAssetError",
  { asset: Schema.String },
) {
  override get message(): string {
    return `Release must not ship '${this.asset}'.`;
  }
}

export class ReleaseChecksumError extends Schema.TaggedError<ReleaseChecksumError>()(
  "ReleaseChecksumError",
  { asset: Schema.String },
) {
  override get message(): string {
    return `Release asset '${this.asset}' does not match ${CLI_RELEASE_CHECKSUMS_FILE}.`;
  }
}

export class ReleaseMetadataError extends Schema.TaggedError<ReleaseMetadataError>()(
  "ReleaseMetadataError",
  { asset: Schema.String },
) {
  override get message(): string {
    return `Release asset '${this.asset}' does not describe the release version and channel.`;
  }
}

// Stable releases carry the ++ pre-release suffix; nightly and preview are
// derived from the next base version with their own suffixes.
const releaseSmokeVersionPatterns: Record<ReleaseSmokeChannel, RegExp> = {
  stable: /^[0-9]+\.[0-9]+\.[0-9]+-plusplus\.[0-9]+$/,
  nightly: /^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+(?:\.[0-9]+)*$/,
  preview: /^[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]+(?:\.[0-9]+)*$/,
};

// macOS ships a manual arm64 DMG and CLI archive only: no updater feed, no x64
// build. Windows and Linux ship x64 only, so their ARM builds stay out too.
// The T3-Code prefix separates desktop artifacts from CLI archives, whose
// win32-x64 zip ends with the same suffix an ARM desktop zip would.
const forbiddenReleaseAssetPatterns: ReadonlyArray<RegExp> = [
  /-mac[^/]*\.ya?ml$/,
  /^T3-Code-.*-(?:universal|x64)\.dmg$/,
  /^T3-Code-.*-(?:universal|arm64|x64)\.zip(?:\.blockmap)?$/,
  /^T3-Code-.*-arm64\.dmg\.blockmap$/,
  /^T3-Code-.*-arm64\.(?:exe|AppImage)(?:\.blockmap)?$/,
  /(?:linux|win32)-arm64/,
  /-darwin-(?:x64|universal)/,
  /\.apk$/,
  /^t3-.*\.tgz$/,
  /^PKGBUILD$/,
  /^vercel\.json$/,
  /^relay-client-tracing-config\.json$/,
];

// Preview releases offer no updater metadata.
const previewForbiddenReleaseAssetPatterns: ReadonlyArray<RegExp> = [
  /\.blockmap$/,
  /^(?:latest|nightly)(?:-linux)?\.yml$/,
];

export interface VerifyReleaseAssetsOptions {
  readonly assetsDir: string;
  readonly version: string;
  readonly channel: ReleaseSmokeChannel;
}

/**
 * The contract a published release directory must satisfy: only the supported
 * Windows/Linux x64 manual artifacts, the macOS arm64 DMG and CLI archive,
 * updater manifests per channel, and SHA256SUMS digests that match every
 * shipped CLI archive. macOS has no updater feed, so it needs no manifest.
 */
export const verifyReleaseAssets = Effect.fn("verifyReleaseAssets")(function* ({
  assetsDir,
  version,
  channel,
}: VerifyReleaseAssetsOptions) {
  if (!releaseSmokeVersionPatterns[channel].test(version)) {
    return yield* new InvalidReleaseVersionError({ version });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assetsPath = path.resolve(assetsDir);
  const shipped = yield* fs.readDirectory(assetsPath);

  for (const asset of shipped) {
    if (
      forbiddenReleaseAssetPatterns.some((pattern) => pattern.test(asset)) ||
      (channel === "preview" &&
        previewForbiddenReleaseAssetPatterns.some((pattern) => pattern.test(asset)))
    ) {
      return yield* new ForbiddenReleaseAssetError({ asset });
    }
  }

  const cliArchives = cliTargets.map((target) => cliArchiveFileName(version, target.platformKey));
  const updaterManifest = channel === "nightly" ? "nightly" : "latest";
  const requiredAssets = [
    `T3-Code-${version}-x64.exe`,
    `T3-Code-${version}-x64.AppImage`,
    `T3-Code-${version}-arm64.dmg`,
    ...cliArchives,
    CLI_RELEASE_CHECKSUMS_FILE,
    CLI_RELEASE_METADATA_FILE,
    ...(channel === "preview"
      ? []
      : [
          `${updaterManifest}.yml`,
          `${updaterManifest}-linux.yml`,
          `T3-Code-${version}-x64.exe.blockmap`,
          `T3-Code-${version}-x64.AppImage.blockmap`,
        ]),
  ];

  const sumsPath = path.join(assetsPath, CLI_RELEASE_CHECKSUMS_FILE);
  if (!(yield* fs.exists(sumsPath))) {
    return yield* new MissingReleaseAssetError({ asset: CLI_RELEASE_CHECKSUMS_FILE });
  }
  const sums = parseChecksums(yield* fs.readFileString(sumsPath));

  for (const asset of requiredAssets) {
    const onDisk = shipped.includes(asset);
    const expectedDigest = sums.get(asset);
    if (!cliArchives.includes(asset)) {
      if (!onDisk) {
        return yield* new MissingReleaseAssetError({ asset });
      }
      continue;
    }
    if (!onDisk && expectedDigest === undefined) {
      return yield* new MissingReleaseAssetError({ asset });
    }
    if (expectedDigest === undefined) {
      return yield* new ReleaseChecksumError({ asset });
    }
    if (!onDisk) {
      return yield* new ReleaseChecksumError({ asset });
    }
    const bytes = yield* fs.readFile(path.join(assetsPath, asset));
    const actualDigest = yield* Effect.sync(() =>
      NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    );
    if (actualDigest !== expectedDigest) {
      return yield* new ReleaseChecksumError({ asset });
    }
  }

  // release.yml publishes the metadata on every channel; it is release
  // information, not updater metadata, so preview ships it too.
  const metadataText = yield* fs.readFileString(path.join(assetsPath, CLI_RELEASE_METADATA_FILE));
  if (Option.isNone(decodeReleaseMetadata(`v${version}`, metadataText))) {
    return yield* new ReleaseMetadataError({ asset: CLI_RELEASE_METADATA_FILE });
  }
});

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = NodePath.resolve(repoRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  const patchesDirectory = NodePath.resolve(repoRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertPackageVersion(path: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    readonly version?: unknown;
  };

  if (packageJson.version !== version) {
    throw new Error(`Expected ${path} to have version ${version}.`);
  }
}

/**
 * The release build names CLI archives with scripts/build-cli-archive.ts while
 * the desktop clients request them with packages/shared's cliRelease helper,
 * and install.sh/install.ps1 read them out of SHA256SUMS. A published release
 * only works when all three agree on the same file names and digests.
 */
function writeCliArchiveFixtures(targetRoot: string): string {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const digests = new Map<string, string>();
  for (const target of cliTargets) {
    const archiveName = buildCliArchiveFileName(releaseVersion, target.platform, target.arch);
    const clientArchiveName = cliArchiveFileName(releaseVersion, target.platformKey);
    if (archiveName !== clientArchiveName) {
      throw new Error(
        `CLI archive name mismatch for ${target.platformKey}: the release build writes ${archiveName} but clients request ${clientArchiveName}.`,
      );
    }

    // Contents only need to differ per archive; the contract under test is the
    // file names and their digests, not what is inside.
    const bytes = Buffer.from(`${archiveName}\n`);
    NodeFS.writeFileSync(NodePath.resolve(assetDirectory, archiveName), bytes);
    digests.set(archiveName, NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
  }

  // Same layout `sha256sum "${archives[@]}"` writes in release.yml.
  const sumsPath = NodePath.resolve(assetDirectory, CLI_RELEASE_CHECKSUMS_FILE);
  NodeFS.writeFileSync(
    sumsPath,
    `${[...digests].map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`,
  );

  const publishedSums = parseChecksums(NodeFS.readFileSync(sumsPath, "utf8"));
  if (publishedSums.size !== digests.size) {
    throw new Error(
      `Expected ${CLI_RELEASE_CHECKSUMS_FILE} to list ${digests.size} archives, listed ${publishedSums.size}.`,
    );
  }
  for (const [name, digest] of digests) {
    if (publishedSums.get(name) !== digest) {
      throw new Error(`${CLI_RELEASE_CHECKSUMS_FILE} is missing a matching digest for ${name}.`);
    }
  }

  // The manual install artifacts and updater metadata a release also ships, so
  // verifyReleaseAssets can check the whole directory against the contract.
  const manualAssets = [
    `T3-Code-${releaseVersion}-x64.exe`,
    `T3-Code-${releaseVersion}-x64.AppImage`,
    `T3-Code-${releaseVersion}-arm64.dmg`,
    `T3-Code-${releaseVersion}-x64.exe.blockmap`,
    `T3-Code-${releaseVersion}-x64.AppImage.blockmap`,
    "latest.yml",
    "latest-linux.yml",
  ];
  for (const name of manualAssets) {
    NodeFS.writeFileSync(NodePath.resolve(assetDirectory, name), `${name}\n`);
  }
  NodeFS.writeFileSync(
    NodePath.resolve(assetDirectory, CLI_RELEASE_METADATA_FILE),
    `${JSON.stringify({ version: releaseVersion, channel: "stable" })}\n`,
  );

  return assetDirectory;
}

function readNightlyMetadata(targetRoot: string, channel: "nightly" | "preview"): string {
  return NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      nightlyDate,
      "--run-number",
      nightlyRunNumber,
      "--sha",
      nightlySha,
      "--channel",
      channel,
      "--root",
      targetRoot,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

/**
 * The release job's launch check boots the packaged Linux app against
 * scripts/fixtures/desktop-launch/statev2.sqlite and waits for the thread
 * smoke-desktop-app.ts names. A regenerated fixture that lost that thread fails
 * there, after a full desktop build, instead of here.
 */
function assertLaunchCheckFixture(): void {
  const launchCheckSource = NodeFS.readFileSync(
    NodePath.resolve(repoRoot, "scripts/smoke-desktop-app.ts"),
    "utf8",
  );
  const declaration = (name: string) =>
    new RegExp(`^const ${name} = "(.+)";$`, "m").exec(launchCheckSource)?.[1];
  const threadTitle = declaration("THREAD_TITLE");
  const threadMessage = declaration("THREAD_MESSAGE");
  if (threadTitle === undefined || threadMessage === undefined) {
    throw new Error("smoke-desktop-app.ts no longer declares THREAD_TITLE and THREAD_MESSAGE.");
  }

  const fixture = NodeFS.readFileSync(
    NodePath.resolve(repoRoot, "scripts/fixtures/desktop-launch/statev2.sqlite"),
    "utf8",
  );
  assertContains(fixture, threadTitle, "Desktop launch fixture is missing the expected thread.");
  assertContains(
    fixture,
    threadMessage,
    "Desktop launch fixture is missing the message the launch check waits for.",
  );
}

const runReleaseSmoke = async (): Promise<void> => {
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));

  try {
    copyWorkspaceManifestFixture(tempRoot);

    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
        releaseVersion,
        "--root",
        tempRoot,
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );

    // A malformed release version must fail before any manifest mutates.
    const rejectedVersion = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
        `v${releaseVersion}`,
        "--root",
        tempRoot,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (rejectedVersion.status === 0) {
      throw new Error("update-release-package-versions accepted a v-prefixed release version.");
    }

    NodeFS.rmSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), { force: true });

    // The fixture only holds the trees a release builds, so patches for mobile
    // packages stay unused here; the real workspace still applies them.
    NodeChildProcess.execFileSync(
      "vp",
      ["install", "--lockfile-only", "--ignore-scripts", "--", "--config.allowUnusedPatches=true"],
      {
        cwd: tempRoot,
        stdio: "inherit",
      },
    );

    const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
    assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

    for (const relativePath of releasePackageFiles) {
      assertPackageVersion(NodePath.resolve(tempRoot, relativePath), releaseVersion);
    }

    const nightlyMetadata = readNightlyMetadata(tempRoot, "nightly");
    assertContains(
      nightlyMetadata,
      "base_version=9.9.10",
      "Expected the nightly base version to drop the ++ suffix.",
    );
    assertContains(
      nightlyMetadata,
      "version=9.9.10-nightly.20260413.321",
      "Expected nightly metadata to contain the derived nightly version.",
    );
    assertContains(
      nightlyMetadata,
      "tag=v9.9.10-nightly.20260413.321",
      "Expected nightly metadata to contain the derived nightly tag.",
    );
    assertContains(
      nightlyMetadata,
      "name=T3 Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      "Expected nightly metadata to include the short commit SHA in the release name.",
    );

    const previewMetadata = readNightlyMetadata(tempRoot, "preview");
    assertContains(
      previewMetadata,
      "version=9.9.10-preview.20260413.321",
      "Expected preview metadata to contain the derived preview version.",
    );
    assertContains(
      previewMetadata,
      "tag=v9.9.10-preview.20260413.321",
      "Expected preview metadata to contain the derived preview tag.",
    );

    const assetDirectory = writeCliArchiveFixtures(tempRoot);
    assertLaunchCheckFixture();

    await Effect.runPromise(
      verifyReleaseAssets({
        assetsDir: assetDirectory,
        version: releaseVersion,
        channel: "stable",
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    Effect.runSync(Console.log("Release smoke checks passed."));
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  NodeRuntime.runMain(Effect.promise(runReleaseSmoke));
}
