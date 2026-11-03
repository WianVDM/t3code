import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { DesktopUpdateState, ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
export const FORK_REPOSITORY = "WianVDM/t3code";
export const UPSTREAM_CHECK_STALE_AFTER_MS = 60 * 60 * 1000;
export const UPSTREAM_UNKNOWN_RETRY_AFTER_MS = 5 * 60 * 1000;
export const UPSTREAM_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPSTREAM_REQUEST_TIMEOUT_MS = 10_000;
export const UPSTREAM_RELEASE_CACHE_STORAGE_KEY = "t3code:upstream-release:v1";

const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
const [forkOwner] = FORK_REPOSITORY.split("/");
const FORK_COMPARE_HEAD = `${forkOwner}:main`;
const FORK_CANONICAL_KEY = `github.com/${FORK_REPOSITORY.toLowerCase()}`;
const T3CODE_KEYWORD = "t3code";

const RANK_PRIMARY_REPOSITORY_MATCH = 1;
const RANK_NAME_OR_PATH_MATCH = 2;

export type UpstreamReleaseResult =
  | { readonly kind: "merged"; readonly tag: string }
  | { readonly kind: "unmerged"; readonly tag: string }
  | { readonly kind: "unknown"; readonly reason: string };

export interface UpstreamReleaseCacheEntry {
  readonly checkedAt: number;
  readonly result: UpstreamReleaseResult;
}

export interface UpstreamReleaseOptions {
  readonly fetchFn?: typeof fetch;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly now?: () => number;
}

export const isForkDesktopBuild = import.meta.env.T3CODE_DESKTOP_VARIANT === "fork";

export function shouldDeferUpstreamMerge(state: DesktopUpdateState | null): boolean {
  if (!state) {
    return false;
  }
  return (
    state.status === "downloading" ||
    state.availableVersion !== null ||
    state.downloadedVersion !== null
  );
}

export function isUpstreamCacheEntryFresh(entry: UpstreamReleaseCacheEntry, now: number): boolean {
  const age = now - entry.checkedAt;
  if (age < 0) {
    return false;
  }
  if (entry.result.kind === "unknown") {
    return age < UPSTREAM_UNKNOWN_RETRY_AFTER_MS;
  }
  return age < UPSTREAM_CHECK_STALE_AFTER_MS;
}

export function buildUpstreamMergePrompt(tag: string): string {
  return `Merge upstream release ${tag} (https://github.com/pingdotgg/t3code/releases/tag/${tag}) into this fork.

1. Run \`node scripts/upstream-sync.ts --tag ${tag} prepare\`. Let the script create \`sync/upstream-${tag}\` and handle the \`git merge ${tag}\` mechanics; the final commit must be a real merge commit (no squash, no rebase).
2. Resolve any semantic conflicts yourself so the fork's own behavior survives. Review the fork-only commit list printed by the prepare step and check each fork change still works after the merge. Use your judgment to run only targeted tests for files touched while resolving conflicts; no repo-wide checks.
3. Run \`node scripts/upstream-sync.ts --tag ${tag} verify\` and address any failures.
4. Ask for explicit confirmation before running finish or creating any commit. After confirmation, run \`node scripts/upstream-sync.ts --tag ${tag} finish\` to create the real merge commit.

Do not push, tag, or open a pull request. Finish with a report: conflicts and how you resolved them, tests run and their results, and anything you are unsure about.`;
}

interface ScoredProject {
  readonly project: EnvironmentProject;
  readonly rank: number;
  readonly index: number;
  readonly timestamp: number;
}

function matchesForkRepository(identity: EnvironmentProject["repositoryIdentity"]): boolean {
  if (!identity) {
    return false;
  }
  const primaryCanonicalKey = identity.canonicalKey.trim().toLowerCase();
  if (primaryCanonicalKey === FORK_CANONICAL_KEY) {
    return true;
  }
  // Fork checkouts report the fork remote under origin because the resolver prefers upstream.
  const originCanonicalKey = identity.origin?.canonicalKey.trim().toLowerCase();
  return originCanonicalKey === FORK_CANONICAL_KEY;
}

function resolveProjectMatchRank(project: EnvironmentProject): number | null {
  if (matchesForkRepository(project.repositoryIdentity)) {
    return RANK_PRIMARY_REPOSITORY_MATCH;
  }
  const titleMatches = project.title.toLowerCase().includes(T3CODE_KEYWORD);
  const rootMatches = project.workspaceRoot.toLowerCase().includes(T3CODE_KEYWORD);
  if (titleMatches || rootMatches) {
    return RANK_NAME_OR_PATH_MATCH;
  }
  return null;
}

function scoreProject(project: EnvironmentProject, index: number): ScoredProject | null {
  const rank = resolveProjectMatchRank(project);
  if (rank === null) {
    return null;
  }
  return {
    project,
    rank,
    index,
    timestamp: Date.parse(project.updatedAt) || 0,
  };
}

function compareScoredProjects(first: ScoredProject, second: ScoredProject): number {
  if (first.rank !== second.rank) {
    return first.rank - second.rank;
  }
  if (first.timestamp !== second.timestamp) {
    return second.timestamp - first.timestamp;
  }
  return first.index - second.index;
}

export function pickForkProject(
  projects: ReadonlyArray<EnvironmentProject>,
): ScopedProjectRef | null {
  const scoredCandidates: ScoredProject[] = [];
  for (const [index, project] of projects.entries()) {
    const candidate = scoreProject(project, index);
    if (candidate !== null) {
      scoredCandidates.push(candidate);
    }
  }

  scoredCandidates.sort(compareScoredProjects);
  const bestCandidate = scoredCandidates[0];
  if (!bestCandidate) {
    return null;
  }

  return {
    environmentId: bestCandidate.project.environmentId,
    projectId: bestCandidate.project.id,
  };
}

const UpstreamReleaseResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("merged"),
    tag: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unmerged"),
    tag: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    reason: Schema.String,
  }),
]);

const UpstreamReleaseCacheEntrySchema = Schema.Struct({
  checkedAt: Schema.Number,
  result: UpstreamReleaseResultSchema,
});

const decodeCacheEntry = Schema.decodeUnknownOption(UpstreamReleaseCacheEntrySchema);

function resolveStorage(
  options?: UpstreamReleaseOptions,
): Pick<Storage, "getItem" | "setItem"> | null {
  if (options?.storage) {
    return options.storage;
  }
  return typeof localStorage !== "undefined" ? localStorage : null;
}

export function readCachedUpstreamRelease(
  options?: UpstreamReleaseOptions,
): UpstreamReleaseCacheEntry | null {
  try {
    const storage = resolveStorage(options);
    if (!storage) {
      return null;
    }
    const rawValue = storage.getItem(UPSTREAM_RELEASE_CACHE_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }
    const parsedValue: unknown = JSON.parse(rawValue);
    const decoded = decodeCacheEntry(parsedValue);
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

export function writeCachedUpstreamRelease(
  entry: UpstreamReleaseCacheEntry,
  options?: UpstreamReleaseOptions,
): void {
  try {
    const storage = resolveStorage(options);
    if (!storage) {
      return;
    }
    storage.setItem(UPSTREAM_RELEASE_CACHE_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Storage writes are best-effort: sandboxed contexts or exceeded quotas can throw.
  }
}

const ReleaseResponseSchema = Schema.Struct({
  tag_name: Schema.String.check(Schema.isNonEmpty()),
});
const decodeReleaseResponse = Schema.decodeUnknownOption(ReleaseResponseSchema);

const CompareResponseSchema = Schema.Struct({
  status: Schema.String,
});
const decodeCompareResponse = Schema.decodeUnknownOption(CompareResponseSchema);

function mapCompareStatus(status: string, tag: string): UpstreamReleaseResult {
  if (status === "ahead" || status === "identical") {
    return { kind: "merged", tag };
  }
  if (status === "diverged" || status === "behind") {
    return { kind: "unmerged", tag };
  }
  return { kind: "unknown", reason: `Unexpected compare status: ${status}` };
}

type HttpJsonResponse =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly failure: string };

async function fetchGithubJson(url: string, fetchFn: typeof fetch): Promise<HttpJsonResponse> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      headers: { Accept: GITHUB_ACCEPT_HEADER },
      signal: abortController.signal,
    });
    if (!response.ok) {
      return { success: false, failure: `GitHub request failed with status ${response.status}` };
    }
    const data: unknown = await response.json();
    return { success: true, data };
  } catch (error) {
    if (abortController.signal.aborted) {
      return { success: false, failure: "Request timed out" };
    }
    return {
      success: false,
      failure: error instanceof Error ? error.message : "Network error",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function queryUpstreamRelease(fetchFn: typeof fetch): Promise<UpstreamReleaseResult> {
  const latestReleaseUrl = `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/latest`;
  const latestResponse = await fetchGithubJson(latestReleaseUrl, fetchFn);
  if (!latestResponse.success) {
    return { kind: "unknown", reason: latestResponse.failure };
  }

  const decodedLatest = decodeReleaseResponse(latestResponse.data);
  if (decodedLatest._tag !== "Some") {
    return { kind: "unknown", reason: "Malformed release response" };
  }

  const tag = decodedLatest.value.tag_name;
  const compareUrl = `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/compare/${encodeURIComponent(tag)}...${FORK_COMPARE_HEAD}`;
  const compareResponse = await fetchGithubJson(compareUrl, fetchFn);
  if (!compareResponse.success) {
    return { kind: "unknown", reason: compareResponse.failure };
  }

  const decodedCompare = decodeCompareResponse(compareResponse.data);
  if (decodedCompare._tag !== "Some") {
    return { kind: "unknown", reason: "Malformed compare response" };
  }

  return mapCompareStatus(decodedCompare.value.status, tag);
}

let sharedInFlightRefresh: Promise<UpstreamReleaseResult> | null = null;

export function resetInFlightRefreshForTesting(): void {
  sharedInFlightRefresh = null;
}

function readFreshCachedResult(
  currentTime: number,
  options?: UpstreamReleaseOptions,
): UpstreamReleaseResult | null {
  const cachedEntry = readCachedUpstreamRelease(options);
  if (!cachedEntry || !isUpstreamCacheEntryFresh(cachedEntry, currentTime)) {
    return null;
  }
  return cachedEntry.result;
}

function fetchAndCacheUpstreamRelease(
  options?: UpstreamReleaseOptions,
): Promise<UpstreamReleaseResult> {
  if (sharedInFlightRefresh !== null) {
    return sharedInFlightRefresh;
  }

  const getCurrentTime = options?.now ?? (() => Date.now());
  const effectiveFetch = options?.fetchFn ?? fetch;
  const inFlightPromise = queryUpstreamRelease(effectiveFetch)
    .then((result) => {
      writeCachedUpstreamRelease({ checkedAt: getCurrentTime(), result }, options);
      return result;
    })
    .finally(() => {
      sharedInFlightRefresh = null;
    });

  sharedInFlightRefresh = inFlightPromise;
  return inFlightPromise;
}

export function refreshUpstreamReleaseIfStale(
  options?: UpstreamReleaseOptions,
): Promise<UpstreamReleaseResult> {
  const currentTime = options?.now ? options.now() : Date.now();
  const freshCached = readFreshCachedResult(currentTime, options);
  if (freshCached !== null) {
    return Promise.resolve(freshCached);
  }
  return fetchAndCacheUpstreamRelease(options);
}

export function refreshUpstreamReleaseNow(
  options?: UpstreamReleaseOptions,
): Promise<UpstreamReleaseResult> {
  return fetchAndCacheUpstreamRelease(options);
}
