// Advisory ownership/hotspot labels for ++ PRs (#44), derived from changed paths.
// Runs from the trusted base branch inside pull_request_target; the PR head is only
// fetched as passive git objects. Never execute anything from the head tree here.
// Label definitions are owned by issue-labels.yml; this script only attaches them.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const MANAGED_LABELS = ["plusplus-only", "upstream-candidate", "seam", "sync-conflict"];

// Integration seams: files where fork behavior meets upstream code. `diverged`
// marks files that also exist upstream with fork modifications; syncs are likely
// to conflict there. Fork-only seam modules cannot conflict themselves. Curated
// seed registry; the B10 sync hotspot report (#50) extends coverage.
const SEAM_ENTRIES = [
  { path: ".github/scripts/check-shared-persistence-compat.cjs", diverged: false },
  { path: ".github/scripts/check-shared-persistence-compat.test.cjs", diverged: false },
  { path: "apps/desktop/src/app/DesktopStatePaths.ts", diverged: true },
  { path: "apps/desktop/src/app/DesktopEnvironment.ts", diverged: true },
  { path: "apps/desktop/src/app/DesktopEnvironment.test.ts", diverged: true },
  { path: "apps/desktop/src/app/DesktopUserData.ts", diverged: true },
  { path: "apps/desktop/src/app/DesktopUserData.test.ts", diverged: true },
  { path: "apps/desktop/src/app/DesktopVariant.ts", diverged: false },
  { path: "apps/desktop/src/app/DesktopVariant.test.ts", diverged: false },
  { path: "apps/desktop/src/main.ts", diverged: true },
  { path: "apps/web/src/components/settings/UpstreamReleaseRow.tsx", diverged: false },
  { path: "apps/web/src/components/settings/UpstreamReleaseRow.browser.test.tsx", diverged: false },
  { path: "apps/web/src/components/sidebar/SidebarUpstreamReleasePill.tsx", diverged: false },
  {
    path: "apps/web/src/components/sidebar/SidebarUpstreamReleasePill.browser.test.tsx",
    diverged: false,
  },
  { path: "apps/web/src/components/upstreamRelease.logic.ts", diverged: false },
  { path: "apps/web/src/components/upstreamRelease.logic.test.ts", diverged: false },
  { path: "apps/web/src/state/upstreamRelease.ts", diverged: false },
  { path: "apps/web/src/state/upstreamRelease.test.ts", diverged: false },
  { path: "packages/provider-pi/src/server/driver.ts", diverged: true },
  { path: "packages/provider-pi/src/server/driver.test.ts", diverged: true },
  { path: "packages/provider-pi/src/server/mcpExtensionSource.ts", diverged: true },
  { path: "packages/provider-pi/src/server/mcpExtensionSource.test.ts", diverged: true },
  { path: "packages/provider-pi/src/server/mcpInjection.ts", diverged: true },
  { path: "packages/provider-pi/src/server/mcpInjection.test.ts", diverged: true },
  { path: "packages/shared/src/promptLinks.ts", diverged: true },
  { path: "packages/shared/src/promptLinks.test.ts", diverged: true },
  { path: "scripts/build-desktop-artifact.ts", diverged: true },
  { path: "scripts/build-desktop-artifact.test.ts", diverged: true },
  { path: "scripts/lib/desktop-variant.ts", diverged: false },
];

const SEAM_BY_PATH = new Map(SEAM_ENTRIES.map((entry) => [entry.path, entry]));

// Fork-only surfaces: governance, privileged automation, ++ distribution, and
// upstream sync tooling. A rule ending in "/**" matches everything below it;
// any other rule matches one exact path.
const FORK_RULES = [
  ".agents/**",
  ".github/**",
  ".repos/**",
  ".coderabbit.config.ts",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "apps/desktop/resources/linux/com.t3tools.t3code.plusplus.metainfo.xml",
  "scripts/lib/reference-repos.ts",
  "scripts/sync-reference-repos.ts",
  "scripts/upstream-sync.test.ts",
  "scripts/upstream-sync.ts",
];

function matchesRule(rule, path) {
  if (rule.endsWith("/**")) {
    return path.startsWith(rule.slice(0, -2));
  }
  return rule === path;
}

// Seam entries win over fork prefixes so a seam inside .github/ stays a seam;
// anything unregistered outside fork surfaces is shared upstream code.
function classifyPath(path) {
  const seam = SEAM_BY_PATH.get(path);
  if (seam !== undefined) {
    return { path, category: "seam", diverged: seam.diverged };
  }
  if (FORK_RULES.some((rule) => matchesRule(rule, path))) {
    return { path, category: "fork", diverged: false };
  }
  return { path, category: "shared", diverged: false };
}

function classifyPaths(paths) {
  const classified = paths.map(classifyPath);
  return {
    classified,
    seam: classified.filter((entry) => entry.category === "seam"),
    fork: classified.filter((entry) => entry.category === "fork"),
    shared: classified.filter((entry) => entry.category === "shared"),
    hasDivergedSeam: classified.some((entry) => entry.category === "seam" && entry.diverged),
  };
}

function deriveAdvisoryLabels(classification) {
  const labels = new Set();
  const total = classification.classified.length;
  if (total === 0) {
    return labels;
  }
  if (classification.seam.length > 0) {
    labels.add("seam");
  }
  if (classification.hasDivergedSeam) {
    labels.add("sync-conflict");
  }
  // plusplus-only means every path is fork-owned: fork surfaces and fork-added
  // seam modules. Shared paths and diverged upstream files can be upstream work.
  if (classification.shared.length === 0 && !classification.hasDivergedSeam) {
    labels.add("plusplus-only");
  }
  if (classification.fork.length === 0 && classification.seam.length === 0) {
    labels.add("upstream-candidate");
  }
  return labels;
}

// Only managed labels are ever touched; size, taxonomy, and human labels stay put.
function planLabelChanges(currentLabels, desiredLabels) {
  const desired = new Set(desiredLabels);
  const current = new Set(currentLabels);
  return {
    add: [...desired].filter((label) => !current.has(label)).sort(),
    remove: [...current]
      .filter((label) => MANAGED_LABELS.includes(label) && !desired.has(label))
      .sort(),
  };
}

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

function readEnv() {
  const prNumber = Number.parseInt(process.env.PR_NUMBER ?? "", 10);
  const baseSha = process.env.PR_BASE_SHA ?? "";
  const headSha = process.env.PR_HEAD_SHA ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha)) {
    throw new Error("PR_BASE_SHA and PR_HEAD_SHA must be full commit SHAs.");
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repo slug.");
  }
  if (token === "") {
    throw new Error("GITHUB_TOKEN is required.");
  }
  return { prNumber, baseSha, headSha, repository, token };
}

function listChangedFiles(prNumber, baseSha, headSha) {
  const git = (args) =>
    execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const headTrackingRef = `refs/remotes/pr-ownership-label/${prNumber}`;

  git(["fetch", "--no-tags", "origin", baseSha]);
  git(["fetch", "--no-tags", "origin", `+refs/pull/${prNumber}/head:${headTrackingRef}`]);

  const resolvedHeadSha = git(["rev-parse", headTrackingRef]).trim();
  if (resolvedHeadSha !== headSha) {
    console.warn(
      `Fetched head SHA ${resolvedHeadSha} does not match payload head SHA ${headSha}; using the fetched ref.`,
    );
  }
  git(["cat-file", "-e", `${baseSha}^{commit}`]);

  return git(["diff", "--name-only", "-z", `${baseSha}...${resolvedHeadSha}`])
    .split("\0")
    .filter((path) => path !== "");
}

async function githubFetch(env, path, init = {}) {
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pr-ownership-label",
      ...init.headers,
    },
  });
  return response;
}

async function applyLabels(env, issueNumber, plan) {
  const issuesPath = `/repos/${env.repository}/issues/${issueNumber}`;

  for (const label of plan.remove) {
    const response = await githubFetch(env, `${issuesPath}/labels/${encodeURIComponent(label)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Removing label ${label} failed: ${response.status}`);
    }
  }

  if (plan.add.length > 0) {
    const response = await githubFetch(env, `${issuesPath}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: plan.add }),
    });
    if (!response.ok) {
      throw new Error(`Adding labels ${plan.add.join(", ")} failed: ${response.status}`);
    }
  }
}

async function main() {
  const env = readEnv();
  const changedFiles = listChangedFiles(env.prNumber, env.baseSha, env.headSha);
  const classification = classifyPaths(changedFiles);
  const desiredLabels = deriveAdvisoryLabels(classification);

  const issuesPath = `/repos/${env.repository}/issues/${env.prNumber}`;
  const listResponse = await githubFetch(env, `${issuesPath}/labels?per_page=100`);
  if (!listResponse.ok) {
    throw new Error(`Listing labels failed: ${listResponse.status}`);
  }
  const currentLabels = (await listResponse.json()).map((label) => label.name);

  const plan = planLabelChanges(currentLabels, desiredLabels);
  await applyLabels(env, env.prNumber, plan);

  const summary = [
    `PR #${env.prNumber}: ${changedFiles.length} changed paths -> ` +
      `${classification.seam.length} seam, ${classification.fork.length} fork, ` +
      `${classification.shared.length} shared`,
    `desired labels: ${[...desiredLabels].sort().join(", ") || "(none)"}`,
    `added: ${plan.add.join(", ") || "(none)"}`,
    `removed: ${plan.remove.join(", ") || "(none)"}`,
  ].join("\n");
  console.log(summary);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `\`\`\`\n${summary}\n\`\`\`\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  FORK_RULES,
  MANAGED_LABELS,
  SEAM_ENTRIES,
  classifyPath,
  classifyPaths,
  deriveAdvisoryLabels,
  planLabelChanges,
};
