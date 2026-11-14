import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { cliReleaseIndexPageUrl, cliReleaseMetadataUrl } from "@t3tools/shared/cliRelease";
import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { releaseMetadataAtom } from "./releaseMetadata";

interface Release {
  readonly tag_name: string;
  readonly draft?: boolean;
}

interface GithubReleases {
  /** Index pages in order; a page past the end reads as an empty list. */
  readonly pages: ReadonlyArray<ReadonlyArray<Release>>;
  /** version → `release-metadata.json` body, or a status code for an unavailable asset. */
  readonly metadata?: Readonly<Record<string, string | number>>;
}

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function requestedUrls(): ReadonlyArray<string> {
  return fetchMock.mock.calls.map(([input]) => requestUrl(input));
}

function metadataAsset(version: string, channel: string, databaseMigration?: number): string {
  return JSON.stringify({
    version,
    channel,
    ...(databaseMigration === undefined ? {} : { databaseMigration }),
  });
}

function mockGithub({ pages, metadata = {} }: GithubReleases): void {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(requestUrl(input));
    if (url.hostname === "api.github.com") {
      const page = Number(url.searchParams.get("page"));
      return Response.json(pages[page - 1] ?? []);
    }
    const version = /\/download\/v([^/]+)\/release-metadata\.json$/.exec(url.pathname)?.[1];
    const asset = version === undefined ? undefined : metadata[version];
    if (typeof asset === "number") return new Response("unavailable", { status: asset });
    if (asset === undefined) return new Response("not found", { status: 404 });
    return new Response(asset);
  });
}

async function settle(channel: DesktopUpdateChannel) {
  const atom = releaseMetadataAtom(channel);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

function selected(result: Awaited<ReturnType<typeof settle>>): unknown {
  return AsyncResult.getOrElse(result, () => "failed");
}

describe("releaseMetadataAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("reads the newest stable GitHub release and its exact metadata asset", async () => {
    mockGithub({
      pages: [
        [
          { tag_name: "v1.5.0-preview.20261012.9" },
          { tag_name: "v1.5.0-nightly.20261012.8" },
          { tag_name: "v1.4.0-plusplus.3", draft: true },
          { tag_name: "v1.3.0-plusplus.2" },
          { tag_name: "v1.2.0-plusplus.1" },
        ],
      ],
      metadata: { "1.3.0-plusplus.2": metadataAsset("1.3.0-plusplus.2", "stable", 12) },
    });

    const result = await settle("latest");

    expect(selected(result)).toEqual({
      version: "1.3.0-plusplus.2",
      channel: "stable",
      databaseMigration: 12,
    });
    expect(requestedUrls()).toEqual([
      cliReleaseIndexPageUrl(1),
      cliReleaseMetadataUrl("1.3.0-plusplus.2"),
    ]);
    expect(requestedUrls().map((url) => new URL(url).hostname)).toEqual([
      "api.github.com",
      "github.com",
    ]);
  });

  it("takes the newest nightly for the nightly channel", async () => {
    mockGithub({
      pages: [
        [
          { tag_name: "v1.5.0-preview.20261012.9" },
          { tag_name: "v1.4.0-nightly.20261012.7" },
          { tag_name: "v1.4.0-nightly.20261011.6" },
          { tag_name: "v1.3.0" },
        ],
      ],
      metadata: {
        "1.4.0-nightly.20261012.7": metadataAsset("1.4.0-nightly.20261012.7", "nightly", 9),
      },
    });

    const result = await settle("nightly");

    expect(selected(result)).toEqual({
      version: "1.4.0-nightly.20261012.7",
      channel: "nightly",
      databaseMigration: 9,
    });
    expect(requestedUrls()).not.toContain(cliReleaseMetadataUrl("1.4.0-nightly.20261011.6"));
  });

  it("pages until it finds a release on the channel", async () => {
    mockGithub({
      pages: [
        [{ tag_name: "v1.5.0-nightly.20261012.8" }, { tag_name: "v1.5.0-preview.20261012.9" }],
        [{ tag_name: "v1.3.0-plusplus.2" }],
      ],
      metadata: { "1.3.0-plusplus.2": metadataAsset("1.3.0-plusplus.2", "stable") },
    });

    const result = await settle("latest");

    expect(selected(result)).toEqual({ version: "1.3.0-plusplus.2", channel: "stable" });
    expect(requestedUrls()).toEqual([
      cliReleaseIndexPageUrl(1),
      cliReleaseIndexPageUrl(2),
      cliReleaseMetadataUrl("1.3.0-plusplus.2"),
    ]);
  });

  it("gives up after ten index pages", async () => {
    mockGithub({
      pages: Array.from({ length: 10 }, () => [{ tag_name: "v1.5.0-nightly.20261012.8" }]),
    });

    const result = await settle("latest");

    expect(selected(result)).toBeNull();
    expect(requestedUrls()).toEqual(
      Array.from({ length: 10 }, (_, index) => cliReleaseIndexPageUrl(index + 1)),
    );
  });

  it("has no result when every release is on another track", async () => {
    mockGithub({ pages: [[{ tag_name: "v2.0.0-preview.20261012.4" }]] });

    expect(selected(await settle("latest"))).toBeNull();
  });

  it("never selects a draft release", async () => {
    mockGithub({
      pages: [[{ tag_name: "v9.9.9-plusplus.9", draft: true }, { tag_name: "v1.3.0-plusplus.2" }]],
      metadata: { "1.3.0-plusplus.2": metadataAsset("1.3.0-plusplus.2", "stable") },
    });

    expect(selected(await settle("latest"))).toEqual({
      version: "1.3.0-plusplus.2",
      channel: "stable",
    });
    expect(requestedUrls()).not.toContain(cliReleaseMetadataUrl("9.9.9-plusplus.9"));
  });

  it("skips malformed tags and bare upstream versions for stable", async () => {
    mockGithub({
      pages: [
        [
          { tag_name: "latest" },
          { tag_name: "v1.2" },
          { tag_name: "release-1.2.3" },
          { tag_name: "1.2.3" },
          { tag_name: "v1.2.4" },
          { tag_name: "v1.2.3-rc.1" },
          { tag_name: "v1.2.3-plusplus.4" },
        ],
      ],
      metadata: { "1.2.3-plusplus.4": metadataAsset("1.2.3-plusplus.4", "stable", 4) },
    });

    expect(selected(await settle("latest"))).toEqual({
      version: "1.2.3-plusplus.4",
      channel: "stable",
      databaseMigration: 4,
    });
    expect(requestedUrls()).not.toContain(cliReleaseMetadataUrl("1.2.4"));
  });

  it("fails closed when the selected release has no metadata asset", async () => {
    mockGithub({
      pages: [[{ tag_name: "v1.3.0-plusplus.2" }, { tag_name: "v1.2.0-plusplus.1" }]],
      metadata: { "1.3.0-plusplus.2": 404 },
    });

    const result = await settle("latest");

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(requestedUrls()).toEqual([
      cliReleaseIndexPageUrl(1),
      cliReleaseMetadataUrl("1.3.0-plusplus.2"),
    ]);
  });

  it("fails closed when the selected metadata is malformed", async () => {
    mockGithub({
      pages: [[{ tag_name: "v1.3.0-plusplus.2" }, { tag_name: "v1.2.0-plusplus.1" }]],
      metadata: { "1.3.0-plusplus.2": "{ not json" },
    });

    const result = await settle("latest");

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(requestedUrls()).not.toContain(cliReleaseMetadataUrl("1.2.0-plusplus.1"));
  });

  it("fails closed when the asset describes a different version", async () => {
    mockGithub({
      pages: [[{ tag_name: "v1.3.0-plusplus.2" }]],
      metadata: { "1.3.0-plusplus.2": metadataAsset("1.2.4-plusplus.1", "stable", 12) },
    });

    expect(AsyncResult.isFailure(await settle("latest"))).toBe(true);
  });

  it("fails closed when the asset claims another channel", async () => {
    mockGithub({
      pages: [[{ tag_name: "v1.3.0-plusplus.2" }]],
      metadata: { "1.3.0-plusplus.2": metadataAsset("1.3.0-plusplus.2", "nightly", 12) },
    });

    expect(AsyncResult.isFailure(await settle("latest"))).toBe(true);
  });

  it("keeps a release whose metadata predates databaseMigration", async () => {
    mockGithub({
      pages: [[{ tag_name: "v1.3.0-plusplus.2" }]],
      metadata: { "1.3.0-plusplus.2": metadataAsset("1.3.0-plusplus.2", "stable") },
    });

    const result = await settle("latest");

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(selected(result)).toEqual({ version: "1.3.0-plusplus.2", channel: "stable" });
    expect(AsyncResult.getOrElse(result, () => null)?.databaseMigration).toBeUndefined();
  });

  it("fails when the index response is not a list", async () => {
    fetchMock.mockResolvedValue(Response.json({ message: "rate limited" }));

    expect(AsyncResult.isFailure(await settle("latest"))).toBe(true);
    expect(requestedUrls()).toEqual([cliReleaseIndexPageUrl(1)]);
  });

  it("fails when GitHub rejects the index request", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    expect(AsyncResult.isFailure(await settle("latest"))).toBe(true);
  });
});
