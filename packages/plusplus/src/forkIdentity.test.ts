import { assert, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  FORK_BROWSER_SETUP_COMMAND,
  FORK_CLI_RELEASE_CHANNELS,
  FORK_RELEASE_DOWNLOAD_BASE_URL,
  FORK_RELEASES_URL,
  FORK_REPOSITORY,
  forkCliReleaseChannelOf,
  forkCliReleaseIndexPageUrl,
  InvalidDesktopUpdateRepositoryError,
  isForkStableReleaseTag,
  newestForkCliReleaseVersion,
  resolveForkGitHubPublishConfig,
} from "./forkIdentity.ts";

const envLayer = (env: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

describe("fork identity", () => {
  it("points every release surface at the fork repository", () => {
    expect(FORK_REPOSITORY).toBe("WianVDM/t3code");
    expect(FORK_RELEASES_URL).toBe("https://github.com/WianVDM/t3code/releases");
    expect(FORK_RELEASE_DOWNLOAD_BASE_URL).toBe(
      "https://github.com/WianVDM/t3code/releases/download",
    );
    expect(forkCliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/WianVDM/t3code/releases?per_page=100&page=2",
    );
  });

  it("sets up the browser sandbox with the installed fork CLI, never npx", () => {
    expect(FORK_BROWSER_SETUP_COMMAND).toBe("sudo t3 browser setup");
    expect(FORK_BROWSER_SETUP_COMMAND).not.toContain("npx");
  });
});

describe("fork release channels", () => {
  it("lists stable, nightly, and preview", () => {
    expect(FORK_CLI_RELEASE_CHANNELS).toEqual(["stable", "nightly", "preview"]);
  });

  it("keeps reading explicitly requested bare versions as stable", () => {
    expect(forkCliReleaseChannelOf("1.2.3")).toBe("stable");
    expect(forkCliReleaseChannelOf("1.2.3-plusplus.4")).toBe("stable");
    expect(forkCliReleaseChannelOf("1.2.4-nightly.20260912.7")).toBe("nightly");
    expect(forkCliReleaseChannelOf("1.2.4-preview.20260912.8")).toBe("preview");
  });

  it("accepts only fork plusplus tags as stable release tags", () => {
    expect(isForkStableReleaseTag("v1.2.3-plusplus.4")).toBe(true);
    for (const tag of [
      "v1.2.3",
      "v1.2.3-rc.1",
      "v1.2.4-nightly.20260912.7",
      "v1.2.4-preview.20260912.8",
      "v1.2.3-plusplus",
      "v1.2.3-plusplus.4.5",
      "release-1.2.3-plusplus.4",
      "1.2.3-plusplus.4",
    ]) {
      expect(isForkStableReleaseTag(tag), tag).toBe(false);
    }
  });
});

describe("fork release discovery", () => {
  it("accepts only fork plusplus tags for stable discovery", () => {
    const releases = [
      { tag_name: "v1.3.0" },
      { tag_name: "v1.3.0-rc.1" },
      { tag_name: "v1.2.9-plusplus.11" },
    ];
    expect(newestForkCliReleaseVersion(releases, "stable")).toBe("1.2.9-plusplus.11");
    expect(newestForkCliReleaseVersion([{ tag_name: "v1.3.0" }], "stable")).toBeUndefined();
    expect(
      newestForkCliReleaseVersion([{ tag_name: "v1.3.0-plusplus.2", draft: true }], "stable"),
    ).toBeUndefined();
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
    expect(newestForkCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestForkCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestForkCliReleaseVersion(releases, "stable")).toBe("1.2.3-plusplus.4");
    expect(newestForkCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

describe("resolveForkGitHubPublishConfig", () => {
  it.effect("defaults fork and plusplus feeds to the fork repository", () =>
    Effect.gen(function* () {
      for (const variant of ["fork", "plusplus"] as const) {
        const config = yield* resolveForkGitHubPublishConfig("latest", variant).pipe(
          Effect.provide(envLayer({})),
        );
        assert.deepStrictEqual(config, {
          provider: "github",
          owner: "WianVDM",
          repo: "t3code",
          releaseType: "release",
        });
      }
      const nightly = yield* resolveForkGitHubPublishConfig("nightly", "plusplus").pipe(
        Effect.provide(envLayer({})),
      );
      assert.deepStrictEqual(nightly, {
        provider: "github",
        owner: "WianVDM",
        repo: "t3code",
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  it.effect("never lets GITHUB_REPOSITORY redirect a fork or plusplus update feed", () =>
    Effect.gen(function* () {
      const ciEnv = envLayer({ GITHUB_REPOSITORY: "pingdotgg/t3code" });
      for (const variant of ["fork", "plusplus"] as const) {
        const config = yield* resolveForkGitHubPublishConfig("latest", variant).pipe(
          Effect.provide(ciEnv),
        );
        assert.deepStrictEqual(config, {
          provider: "github",
          owner: "WianVDM",
          repo: "t3code",
          releaseType: "release",
        });
      }
      // An official build inherits the repository CI checked out.
      const official = yield* resolveForkGitHubPublishConfig("latest").pipe(Effect.provide(ciEnv));
      assert.deepStrictEqual(official, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      });
    }),
  );

  it.effect("ships no official feed for a missing or malformed GITHUB_REPOSITORY", () =>
    Effect.gen(function* () {
      for (const env of [
        {},
        { GITHUB_REPOSITORY: "" },
        { GITHUB_REPOSITORY: "   " },
        { GITHUB_REPOSITORY: "pingdotgg" },
        { GITHUB_REPOSITORY: "pingdotgg/t3code/extra" },
      ]) {
        const config = yield* resolveForkGitHubPublishConfig("latest").pipe(
          Effect.provide(envLayer(env)),
        );
        assert.equal(config, undefined, JSON.stringify(env));
      }
    }),
  );

  it.effect("fails on a malformed explicit update repository instead of falling back", () =>
    Effect.gen(function* () {
      for (const value of ["pingdotgg", "a/b/c", "/t3code", "WianVDM/"]) {
        const error = yield* Effect.flip(
          resolveForkGitHubPublishConfig("latest", "fork").pipe(
            Effect.provide(envLayer({ T3CODE_DESKTOP_UPDATE_REPOSITORY: value })),
          ),
        );
        assert.instanceOf(error, InvalidDesktopUpdateRepositoryError);
        assert.include(error.message, value);
      }
      // A valid explicit repository wins over an inherited one.
      const config = yield* resolveForkGitHubPublishConfig("latest").pipe(
        Effect.provide(
          envLayer({
            T3CODE_DESKTOP_UPDATE_REPOSITORY: " someone/elsewhere ",
            GITHUB_REPOSITORY: "pingdotgg/t3code",
          }),
        ),
      );
      assert.deepStrictEqual(config, {
        provider: "github",
        owner: "someone",
        repo: "elsewhere",
        releaseType: "release",
      });
    }),
  );
});
