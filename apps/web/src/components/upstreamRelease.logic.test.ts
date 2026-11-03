import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { DesktopUpdateState, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildUpstreamMergePrompt,
  isUpstreamCacheEntryFresh,
  pickForkProject,
  refreshUpstreamReleaseIfStale,
  refreshUpstreamReleaseNow,
  resetInFlightRefreshForTesting,
  shouldDeferUpstreamMerge,
  UPSTREAM_CHECK_STALE_AFTER_MS,
  type UpstreamReleaseOptions,
} from "./upstreamRelease.logic";

function createMockStorage(initialItems: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initialItems));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function createFakeFetch(handlers: {
  readonly latest?: () => Response | Promise<Response>;
  readonly compare?: (url: string) => Response | Promise<Response>;
}): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/releases/latest")) {
      if (handlers.latest) return Promise.resolve(handlers.latest());
      return Promise.resolve(Response.json({ tag_name: "v1.2.3" }));
    }
    if (url.includes("/compare/")) {
      if (handlers.compare) return Promise.resolve(handlers.compare(url));
      return Promise.resolve(Response.json({ status: "diverged" }));
    }
    return Promise.reject(new Error(`Unhandled URL: ${url}`));
  };
}

const mockProjectBase = {
  environmentId: "env-local" as EnvironmentId,
  id: "proj-1" as ProjectId,
  title: "Other Project",
  workspaceRoot: "C:\\projects\\other",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies EnvironmentProject;

const mockDesktopUpdateStateBase = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
} satisfies DesktopUpdateState;

describe("shouldDeferUpstreamMerge", () => {
  it("does not defer without update state or when the app is up to date", () => {
    expect(shouldDeferUpstreamMerge(null)).toBe(false);
    expect(
      shouldDeferUpstreamMerge({
        ...mockDesktopUpdateStateBase,
        status: "up-to-date",
      }),
    ).toBe(false);
  });

  it("does not defer while a check is in progress with no pending versions", () => {
    expect(
      shouldDeferUpstreamMerge({
        ...mockDesktopUpdateStateBase,
        status: "checking",
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "an in-progress check that already has an available version",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "checking",
        availableVersion: "1.1.0",
      },
    },
    {
      name: "an in-progress check that already has a downloaded version",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "checking",
        downloadedVersion: "1.1.0",
      },
    },
    {
      name: "a failed check retaining the available version",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "error",
        availableVersion: "1.1.0",
        message: "check failed",
        errorContext: "check",
        canRetry: true,
      },
    },
    {
      name: "an available update",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "available",
        availableVersion: "1.1.0",
      },
    },
    {
      name: "an update download in progress",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 42,
      },
    },
    {
      name: "a downloaded update",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        downloadPercent: 100,
      },
    },
    {
      name: "a retryable download error",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "error",
        availableVersion: "1.1.0",
        message: "network timeout",
        errorContext: "download",
        canRetry: true,
      },
    },
    {
      name: "a retryable install error",
      state: {
        ...mockDesktopUpdateStateBase,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "install failed",
        errorContext: "install",
        canRetry: true,
      },
    },
  ] satisfies ReadonlyArray<{ name: string; state: DesktopUpdateState }>)(
    "defers for $name",
    ({ state }) => {
      expect(shouldDeferUpstreamMerge(state)).toBe(true);
    },
  );
});

describe("upstreamRelease status mapping", () => {
  beforeEach(() => {
    resetInFlightRefreshForTesting();
  });

  it("maps 'ahead' to merged", async () => {
    const fetchFn = createFakeFetch({
      latest: () => Response.json({ tag_name: "v1.0.0" }),
      compare: () => Response.json({ status: "ahead" }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({ kind: "merged", tag: "v1.0.0" });
  });

  it("maps 'identical' to merged", async () => {
    const fetchFn = createFakeFetch({
      latest: () => Response.json({ tag_name: "v1.0.0" }),
      compare: () => Response.json({ status: "identical" }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({ kind: "merged", tag: "v1.0.0" });
  });

  it("maps 'diverged' to unmerged", async () => {
    const fetchFn = createFakeFetch({
      latest: () => Response.json({ tag_name: "v1.0.1" }),
      compare: () => Response.json({ status: "diverged" }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({ kind: "unmerged", tag: "v1.0.1" });
  });

  it("maps 'behind' to unmerged", async () => {
    const fetchFn = createFakeFetch({
      latest: () => Response.json({ tag_name: "v1.0.2" }),
      compare: () => Response.json({ status: "behind" }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({ kind: "unmerged", tag: "v1.0.2" });
  });

  it("maps other compare status to unknown", async () => {
    const fetchFn = createFakeFetch({
      compare: () => Response.json({ status: "unknown_status" }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("Unexpected compare status");
    }
  });

  it("maps latest release 404 to unknown", async () => {
    const fetchFn = createFakeFetch({
      latest: () => new Response("Not found", { status: 404 }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({
      kind: "unknown",
      reason: "GitHub request failed with status 404",
    });
  });

  it("maps compare 500 to unknown", async () => {
    const fetchFn = createFakeFetch({
      compare: () => new Response("Server error", { status: 500 }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({
      kind: "unknown",
      reason: "GitHub request failed with status 500",
    });
  });

  it("maps latest release network failure to unknown", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new Error("Connection refused"));

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({
      kind: "unknown",
      reason: "Connection refused",
    });
  });

  it("maps malformed latest release payload to unknown", async () => {
    const fetchFn = createFakeFetch({
      latest: () => Response.json({ something_else: 123 }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({
      kind: "unknown",
      reason: "Malformed release response",
    });
  });

  it("maps malformed compare payload to unknown", async () => {
    const fetchFn = createFakeFetch({
      compare: () => Response.json({ no_status_field: true }),
    });

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage: createMockStorage() });
    expect(result).toEqual({
      kind: "unknown",
      reason: "Malformed compare response",
    });
  });
});

describe("isUpstreamCacheEntryFresh", () => {
  it("treats merged as fresh at 59 min and stale at 61 min", () => {
    const baseTime = 1_000_000_000;
    const entry = {
      checkedAt: baseTime,
      result: { kind: "merged" as const, tag: "v1.0.0" },
    };

    expect(isUpstreamCacheEntryFresh(entry, baseTime + 59 * 60 * 1000)).toBe(true);
    expect(isUpstreamCacheEntryFresh(entry, baseTime + 61 * 60 * 1000)).toBe(false);
  });

  it("treats unknown as fresh at 4 min and stale at 6 min", () => {
    const baseTime = 1_000_000_000;
    const entry = {
      checkedAt: baseTime,
      result: { kind: "unknown" as const, reason: "network error" },
    };

    expect(isUpstreamCacheEntryFresh(entry, baseTime + 4 * 60 * 1000)).toBe(true);
    expect(isUpstreamCacheEntryFresh(entry, baseTime + 6 * 60 * 1000)).toBe(false);
  });
});

describe("upstreamRelease cache behavior", () => {
  beforeEach(() => {
    resetInFlightRefreshForTesting();
  });

  it("reuses fresh cache when refreshing if-stale", async () => {
    let fetchCount = 0;
    const fetchFn = createFakeFetch({
      latest: () => {
        fetchCount += 1;
        return Response.json({ tag_name: "v2.0.0" });
      },
    });
    const storage = createMockStorage();
    const now = vi.fn().mockReturnValue(1_000_000);

    const first = await refreshUpstreamReleaseNow({ fetchFn, storage, now });
    expect(first).toEqual({ kind: "unmerged", tag: "v2.0.0" });
    expect(fetchCount).toBe(1);

    now.mockReturnValue(1_000_000 + 30 * 60 * 1000);
    const second = await refreshUpstreamReleaseIfStale({ fetchFn, storage, now });
    expect(second).toEqual({ kind: "unmerged", tag: "v2.0.0" });
    expect(fetchCount).toBe(1);
  });

  it("refetches when cache is stale", async () => {
    let fetchCount = 0;
    const fetchFn = createFakeFetch({
      latest: () => {
        fetchCount += 1;
        return Response.json({ tag_name: `v2.0.${fetchCount}` });
      },
    });
    const storage = createMockStorage();
    const now = vi.fn().mockReturnValue(1_000_000);

    await refreshUpstreamReleaseNow({ fetchFn, storage, now });
    expect(fetchCount).toBe(1);

    now.mockReturnValue(1_000_000 + UPSTREAM_CHECK_STALE_AFTER_MS + 1);
    const result = await refreshUpstreamReleaseIfStale({ fetchFn, storage, now });
    expect(result).toEqual({ kind: "unmerged", tag: "v2.0.2" });
    expect(fetchCount).toBe(2);
  });

  it("refreshUpstreamReleaseNow bypasses fresh cache", async () => {
    let fetchCount = 0;
    const fetchFn = createFakeFetch({
      latest: () => {
        fetchCount += 1;
        return Response.json({ tag_name: `v3.0.${fetchCount}` });
      },
    });
    const storage = createMockStorage();
    const now = vi.fn().mockReturnValue(1_000_000);

    await refreshUpstreamReleaseNow({ fetchFn, storage, now });
    expect(fetchCount).toBe(1);

    const result = await refreshUpstreamReleaseNow({ fetchFn, storage, now });
    expect(result).toEqual({ kind: "unmerged", tag: "v3.0.2" });
    expect(fetchCount).toBe(2);
  });

  it("shares one in-flight promise across concurrent calls", async () => {
    let latestCallCount = 0;
    let resolveLatest: (response: Response) => void = () => {};
    const latestResponse = new Promise<Response>((resolve) => {
      resolveLatest = resolve;
    });
    const fetchFn = createFakeFetch({
      latest: () => {
        latestCallCount += 1;
        return latestResponse;
      },
    });
    const storage = createMockStorage();
    const options: UpstreamReleaseOptions = { fetchFn, storage };

    const promise1 = refreshUpstreamReleaseNow(options);
    const promise2 = refreshUpstreamReleaseNow(options);
    resolveLatest(Response.json({ tag_name: "v4.0.0" }));
    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toEqual({ kind: "unmerged", tag: "v4.0.0" });
    expect(result2).toEqual({ kind: "unmerged", tag: "v4.0.0" });
    expect(latestCallCount).toBe(1);
  });

  it("refetches an expired unknown while a fresh merged entry is reused", async () => {
    let fetchCount = 0;
    const fetchFn = createFakeFetch({
      latest: () => {
        fetchCount += 1;
        return Response.json({ tag_name: "v5.0.0" });
      },
      compare: () => Response.json({ status: "ahead" }),
    });
    const storage = createMockStorage();
    const now = vi.fn().mockReturnValue(1_000_000_000);

    storage.setItem(
      "t3code:upstream-release:v1",
      JSON.stringify({
        checkedAt: 1_000_000_000 - 6 * 60 * 1000,
        result: { kind: "unknown", reason: "temporary failure" },
      }),
    );

    const result1 = await refreshUpstreamReleaseIfStale({ fetchFn, storage, now });
    expect(result1).toEqual({ kind: "merged", tag: "v5.0.0" });
    expect(fetchCount).toBe(1);

    now.mockReturnValue(1_000_000_000 + 30 * 60 * 1000);
    const result2 = await refreshUpstreamReleaseIfStale({ fetchFn, storage, now });
    expect(result2).toEqual({ kind: "merged", tag: "v5.0.0" });
    expect(fetchCount).toBe(1);
  });
});

describe("pickForkProject ranking", () => {
  it("matches a fork checkout with both upstream and origin remotes as rank 1", () => {
    const forkProjectWithBothRemotes: EnvironmentProject = {
      ...mockProjectBase,
      id: "proj-fork" as ProjectId,
      title: "t3code fork",
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        origin: {
          canonicalKey: "github.com/wianvdm/t3code",
          displayName: "WianVDM/t3code",
        },
      },
    };

    expect(pickForkProject([forkProjectWithBothRemotes])).toEqual({
      environmentId: "env-local",
      projectId: "proj-fork",
    });
  });

  it("matches a fork clone with no upstream remote as rank 1", () => {
    const forkProjectDirect: EnvironmentProject = {
      ...mockProjectBase,
      id: "proj-fork-direct" as ProjectId,
      title: "custom-folder",
      repositoryIdentity: {
        canonicalKey: "github.com/wianvdm/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/WianVDM/t3code.git",
        },
      },
    };

    expect(pickForkProject([forkProjectDirect])).toEqual({
      environmentId: "env-local",
      projectId: "proj-fork-direct",
    });
  });

  it("treats a plain clone of upstream with t3code in path as rank 2, not rank 1", () => {
    const plainUpstreamClone: EnvironmentProject = {
      ...mockProjectBase,
      id: "proj-upstream" as ProjectId,
      title: "upstream clone",
      workspaceRoot: "C:\\code\\t3code-upstream",
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
      },
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    expect(pickForkProject([plainUpstreamClone])).toEqual({
      environmentId: "env-local",
      projectId: "proj-upstream",
    });

    const plainUpstreamCloneNoMatch: EnvironmentProject = {
      ...plainUpstreamClone,
      title: "unrelated-title",
      workspaceRoot: "C:\\code\\other",
    };

    expect(pickForkProject([plainUpstreamCloneNoMatch])).toBeNull();
  });

  it("prioritizes a rank 1 fork project over a more recently updated upstream clone (rank beats recency)", () => {
    const olderForkProject: EnvironmentProject = {
      ...mockProjectBase,
      id: "proj-fork-older" as ProjectId,
      title: "my-fork",
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        origin: {
          canonicalKey: "github.com/wianvdm/t3code",
          displayName: "WianVDM/t3code",
        },
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const newerUpstreamClone: EnvironmentProject = {
      ...mockProjectBase,
      id: "proj-upstream-newer" as ProjectId,
      title: "t3code upstream",
      workspaceRoot: "C:\\code\\t3code",
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
      },
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    expect(pickForkProject([newerUpstreamClone, olderForkProject])).toEqual({
      environmentId: "env-local",
      projectId: "proj-fork-older",
    });
  });

  it("matches mixed-case repository keys", () => {
    const mixedCaseForkProject: EnvironmentProject = {
      ...mockProjectBase,
      id: "proj-mixed" as ProjectId,
      title: "mixed-case",
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        origin: {
          canonicalKey: "GITHUB.COM/WianVDM/T3CODE",
          displayName: "WianVDM/t3code",
        },
      },
    };

    expect(pickForkProject([mixedCaseForkProject])).toEqual({
      environmentId: "env-local",
      projectId: "proj-mixed",
    });
  });

  it("breaks ties by most recent activity timestamp", () => {
    const projects: EnvironmentProject[] = [
      {
        ...mockProjectBase,
        id: "proj-older" as ProjectId,
        title: "t3code older",
        updatedAt: "2026-02-01T12:00:00.000Z",
      },
      {
        ...mockProjectBase,
        id: "proj-newer" as ProjectId,
        title: "t3code newer",
        updatedAt: "2026-05-15T10:00:00.000Z",
      },
    ];

    const picked = pickForkProject(projects);
    expect(picked).toEqual({
      environmentId: "env-local",
      projectId: "proj-newer",
    });
  });

  it("returns null when no projects match", () => {
    const projects: EnvironmentProject[] = [
      {
        ...mockProjectBase,
        id: "proj-1" as ProjectId,
        title: "awesome-tool",
        workspaceRoot: "C:\\tools\\awesome",
      },
    ];

    expect(pickForkProject(projects)).toBeNull();
  });
});

describe("buildUpstreamMergePrompt", () => {
  it("uses the script-driven merge flow with confirmation before finishing", () => {
    const prompt = buildUpstreamMergePrompt("v1.5.0");

    expect(prompt).toContain(
      "Merge upstream release v1.5.0 (https://github.com/pingdotgg/t3code/releases/tag/v1.5.0)",
    );
    expect(prompt).toContain("node scripts/upstream-sync.ts --tag v1.5.0 prepare");
    expect(prompt).toContain("sync/upstream-v1.5.0");
    expect(prompt).toContain("git merge v1.5.0");
    expect(prompt).toContain("fork-only commit list printed by the prepare step");
    expect(prompt).toContain("node scripts/upstream-sync.ts --tag v1.5.0 verify");
    expect(prompt).toContain(
      "Ask for explicit confirmation before running finish or creating any commit.",
    );
    expect(prompt).toContain("node scripts/upstream-sync.ts --tag v1.5.0 finish");
    expect(prompt).toContain("Do not push, tag, or open a pull request.");
  });
});
