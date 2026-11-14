import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const FORK_REPOSITORY_OWNER = "WianVDM";
const FORK_REPOSITORY_NAME = "t3code";

export const FORK_REPOSITORY = `${FORK_REPOSITORY_OWNER}/${FORK_REPOSITORY_NAME}`;
export const FORK_RELEASES_URL = `https://github.com/${FORK_REPOSITORY}/releases`;
export const FORK_RELEASE_DOWNLOAD_BASE_URL = `${FORK_RELEASES_URL}/download`;

// The browser sandbox setup needs the installed fork CLI; npx would fetch upstream's `t3`.
export const FORK_BROWSER_SETUP_COMMAND = "sudo t3 browser setup";

export type ForkCliReleaseChannel = "stable" | "nightly" | "preview";
export const FORK_CLI_RELEASE_CHANNELS: ReadonlyArray<ForkCliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

export function forkCliReleaseChannelOf(version: string): ForkCliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

// Fork stable releases are always cut as vX.Y.Z-plusplus.N, so a bare or otherwise suffixed
// tag can never win stable discovery; an explicitly requested bare version still reads as
// stable through forkCliReleaseChannelOf.
const FORK_STABLE_RELEASE_TAG = /^v(\d+\.\d+\.\d+-plusplus\.\d+)$/;

export function isForkStableReleaseTag(tagName: string): boolean {
  return FORK_STABLE_RELEASE_TAG.test(tagName);
}

export interface ForkRelease {
  readonly tag_name: string;
  readonly draft?: boolean | undefined;
}

/** Page until the channel matches; nightlies can push preview/stable releases past the first page. */
export function forkCliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${FORK_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/** Draft assets are not downloadable. Stable discovery accepts only fork plusplus tags. */
export function newestForkCliReleaseVersion(
  releases: ReadonlyArray<ForkRelease>,
  channel: ForkCliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    if (channel === "stable") {
      const stable = FORK_STABLE_RELEASE_TAG.exec(release.tag_name)?.[1];
      if (stable !== undefined) return stable;
      continue;
    }
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (forkCliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}

export class InvalidDesktopUpdateRepositoryError extends Schema.TaggedError<InvalidDesktopUpdateRepositoryError>()(
  "InvalidDesktopUpdateRepositoryError",
  { value: Schema.String },
) {
  override get message(): string {
    return `T3CODE_DESKTOP_UPDATE_REPOSITORY must be exactly owner/repo, got '${this.value}'.`;
  }
}

function parseDesktopUpdateRepository(
  value: string,
): { readonly owner: string; readonly repo: string } | undefined {
  const [owner, repo, ...rest] = value.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;
  return { owner, repo };
}

function forkGitHubPublishConfig(
  repository: { readonly owner: string; readonly repo: string },
  updateChannel: "latest" | "nightly",
) {
  return {
    provider: "github",
    owner: repository.owner,
    repo: repository.repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
}

export const resolveForkGitHubPublishConfig = Effect.fn("resolveForkGitHubPublishConfig")(
  function* (
    updateChannel: "latest" | "nightly",
    variant: "official" | "fork" | "plusplus" = "official",
  ) {
    const env = yield* Config.all({
      updateRepository: Config.String("T3CODE_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
      githubRepository: Config.String("GITHUB_REPOSITORY").pipe(Config.option),
    });
    const explicit = Option.getOrUndefined(env.updateRepository)?.trim();
    if (explicit) {
      const repository = parseDesktopUpdateRepository(explicit);
      if (repository === undefined) {
        return yield* new InvalidDesktopUpdateRepositoryError({ value: explicit });
      }
      return forkGitHubPublishConfig(repository, updateChannel);
    }
    // GITHUB_REPOSITORY is CI plumbing an official upstream build may inherit; fork and ++
    // builds must never read it, or a workflow run in another repository would silently
    // point their updater at that repository.
    if (variant !== "official") {
      return forkGitHubPublishConfig(
        { owner: FORK_REPOSITORY_OWNER, repo: FORK_REPOSITORY_NAME },
        updateChannel,
      );
    }
    // An official build with no usable repository ships no feed; electron-builder must not infer one.
    const inherited = Option.getOrUndefined(env.githubRepository)?.trim() ?? "";
    const repository = inherited === "" ? undefined : parseDesktopUpdateRepository(inherited);
    return repository === undefined
      ? undefined
      : forkGitHubPublishConfig(repository, updateChannel);
  },
);
