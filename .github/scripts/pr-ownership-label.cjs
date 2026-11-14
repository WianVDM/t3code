// Advisory ownership/hotspot labels for ++ PRs (#44), derived from changed paths.
// Runs from the trusted base branch inside pull_request_target; the PR head is only
// fetched as passive git objects. Never execute anything from the head tree here.
// Label definitions are owned by issue-labels.yml; this script only attaches them.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MANAGED_LABELS = ["plusplus-only", "upstream-candidate", "seam", "sync-conflict"];

// Ownership comes from git and the seam registry (plusplus/ARCHITECTURE.md):
// a path is upstream-owned when it exists at the registry's upstreamRef, and a
// registry entry means the fork already changes that upstream file. Both are
// read from the trusted base checkout, never from the PR head.
function buildOwnership(registry, upstreamPaths) {
  const featuresByPath = new Map();
  for (const [path, entry] of Object.entries(registry.files)) {
    const features = entry.legacy ? [] : entry.seams.map((seam) => seam.feature);
    featuresByPath.set(path, [...new Set(features)].sort());
  }
  return { upstreamPaths: new Set(upstreamPaths), featuresByPath };
}

function classifyPath(path, ownership) {
  const features = ownership.featuresByPath.get(path);
  if (features !== undefined) {
    return { path, category: "seam", features };
  }
  if (!ownership.upstreamPaths.has(path)) {
    return { path, category: "fork", features: [] };
  }
  return { path, category: "shared", features: [] };
}

function classifyPaths(paths, ownership) {
  const classified = paths.map((path) => classifyPath(path, ownership));
  return {
    classified,
    seam: classified.filter((entry) => entry.category === "seam"),
    fork: classified.filter((entry) => entry.category === "fork"),
    shared: classified.filter((entry) => entry.category === "shared"),
  };
}

function deriveAdvisoryLabels(classification) {
  const labels = new Set();
  const total = classification.classified.length;
  if (total === 0) {
    return labels;
  }
  // A registry entry is a fork delta inside an upstream file, so a sync is
  // likely to conflict there.
  if (classification.seam.length > 0) {
    labels.add("seam");
    labels.add("sync-conflict");
  }
  // plusplus-only means every path is ++-owned. Shared paths and registered
  // upstream files can be upstream work.
  if (classification.shared.length === 0 && classification.seam.length === 0) {
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

  return git(["diff", "--name-only", "--no-renames", "-z", `${baseSha}...${resolvedHeadSha}`])
    .split("\0")
    .filter((path) => path !== "");
}

// The checkout is the trusted base branch, so its registry is the policy.
function readOwnership() {
  const registryPath = path.resolve(__dirname, "../../plusplus/seams.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const upstreamPaths = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "-z", registry.upstreamRef],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((entry) => entry !== "");
  return buildOwnership(registry, upstreamPaths);
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
  const classification = classifyPaths(changedFiles, readOwnership());
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
    `features: ${[...new Set(classification.seam.flatMap((entry) => entry.features))].sort().join(", ") || "(none)"}`,
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
  MANAGED_LABELS,
  buildOwnership,
  classifyPath,
  classifyPaths,
  deriveAdvisoryLabels,
  planLabelChanges,
};
