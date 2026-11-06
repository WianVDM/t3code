import { FORK_REPOSITORY_SLUG } from "./site";

const REPO = FORK_REPOSITORY_SLUG;

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

const CACHE_KEY = "t3code-stable-release";

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data: Release = await fetch(LATEST_API_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
