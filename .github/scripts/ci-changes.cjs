// Unknown paths run every job; recognized packages pull in their dependents.
// scripts/check-changed.ts shares these decisions so local checks match CI.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

const INERT = [
  /^docs\//,
  /^\.(agents|cursor|vscode|devcontainer|repos)\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
];

// Shared test setup and vendored mobile dependencies affect every package.
// CI's own detection files join explicitly: an edit to the detector must
// exercise the full pipeline it selects for, not the filtering it changes.
const RUNS_EVERYTHING = [
  /^packages\/shared\/src\/(HostProcess|testing\/(longTempDir|providerEnv))\.ts$/,
  /^apps\/mobile\/deps\//,
  // The policy is read from the head checkout, so editing it runs every job: a PR
  // cannot strip boundaryInfrastructure entries to narrow its own run.
  /^config\/fork-inventory\.json$/,
  /^\.github\/workflows\/(ci|windows-tests)\.yml$/,
  /^\.github\/actions\/ci-changes\//,
  /^\.github\/scripts\/(ci-changes|upstream-sync-pr)/,
];

// The ++ fork-boundary infrastructure named by the trusted policy shapes how
// every other change is gated, so a change to any of its files runs full CI.
// A missing or unreadable policy is fail-closed (null) and also runs full CI;
// the boundary checker itself only trusts the policy at the base commit.
const BOUNDARY_INVENTORY_PATH = path.join(root, "config", "fork-inventory.json");

function boundaryInfrastructureOf(policyText) {
  try {
    const policy = JSON.parse(policyText);
    const paths = policy?.boundaryInfrastructure;
    return Array.isArray(paths) && paths.every((entry) => typeof entry === "string")
      ? new Set(paths)
      : null;
  } catch {
    return null;
  }
}

function readBoundaryInfrastructure() {
  try {
    return boundaryInfrastructureOf(fs.readFileSync(BOUNDARY_INVENTORY_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Includes cross-package reads absent from package.json dependencies.
const EXTRA_OWNERS = [
  // Vite configs and tsconfigs of these apps import scripts/lib directly.
  [/^scripts\/lib\//, ["@t3tools/desktop", "@t3tools/mobile", "@t3tools/web", "t3"]],
  // scripts/build-desktop-artifact.ts reads the GNOME extension manifest.
  [/^apps\/desktop\/gnome-extension\//, ["@t3tools/scripts"]],
  [/^native\/browser-secret\//, ["@t3tools/desktop"]],
  [/^native\/kde-snap-shot\//, ["@t3tools/desktop"]],
  [/^native\/libghostty-vt\//, ["@t3tools/web"]],
  // apps/server/src/cloud/ConnectReachability.test.ts checks the guide's headings.
  [/^docs\/user\/t3-connect-troubleshooting\.md$/, ["t3"]],
];
const RUST = /^native\/(resource-monitor|kde-snap-shot|hyprland-snap-shot)\//;

// These tests read other packages without declaring dependencies.
const TEST_ONLY_DEPS = {
  // Evals import the server's source to test its real model-facing text.
  "@t3tools/evals": ["t3"],
  "@t3tools/provider-pi": ["@t3tools/client-runtime"],
  "@t3tools/scripts": [
    "@t3tools/desktop",
    "@t3tools/mobile",
    "@t3tools/web",
    "t3",
    "@t3tools/provider-cursor",
  ],
};
// The server bundles the web build without importing it.
const BUILD_ONLY_DEPS = { t3: ["@t3tools/web"] };

const OWN_TEST_JOB = new Set(["t3", "@t3tools/web", "@t3tools/monorepo"]);

function readWorkspace() {
  const patterns = [];
  let inPackages = false;
  for (const line of fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    const entry = inPackages && line.match(/^\s+-\s+["']?([^"'\s]+)/);
    if (entry) patterns.push(entry[1]);
  }

  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return fs.readdirSync(path.join(root, parent)).map((name) => `${parent}/${name}`);
  });

  const packages = [];
  for (const dir of dirs) {
    const manifestPath = path.join(root, dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    packages.push({
      name: manifest.name,
      dir,
      hasTest: Boolean(manifest.scripts?.test),
      deps: Object.keys(deps).filter(
        (dep) =>
          String(deps[dep]).startsWith("workspace:") &&
          !BUILD_ONLY_DEPS[manifest.name]?.includes(dep),
      ),
    });
  }
  return packages;
}

// [] means inert; null means unknown and requires every job.
function ownersOf(file, packages) {
  const extra = EXTRA_OWNERS.flatMap(([pattern, names]) => (pattern.test(file) ? names : []));
  if (INERT.some((pattern) => pattern.test(file))) return extra;
  // A manifest can change dependencies or versions other packages read.
  if (path.posix.basename(file) === "package.json") return null;
  if (RUNS_EVERYTHING.some((pattern) => pattern.test(file))) return null;
  // scripts/build-desktop-artifact.test.ts reads the crates' sources.
  if (RUST.test(file)) return ["@t3tools/scripts", ...extra];

  const owner = packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (owner) return [owner.name, ...extra];
  return extra.length > 0 ? extra : null;
}

// Advisory and deliberately outside Check; issue #39 will make it a separately required status.
const SEPARATELY_REQUIRED_JOBS = ["fork_boundaries"];

// The Check job's contract: every required CI job except `check` itself, and the
// `changes` gates that explain its skip. gates: null means the job always
// runs and can never skip. Kept in sync with ci.yml by ci-changes.test.cjs.
const EXPECTED_JOBS = {
  changes: { gates: null },
  lint: { gates: null },
  build: { gates: ["build", "typecheck"] },
  test: { gates: ["test"] },
  test_web: { gates: ["test_web"] },
  test_server: { gates: ["test_server"] },
  rust: { gates: ["rust"] },
  release_smoke: { gates: ["release_smoke"] },
  shared_persistence_compat: { gates: null },
  windows: { gates: ["windows"] },
  sync: { gates: ["upstream_sync"] },
};

// Fail-closed result policy shared by CI's Check job (--check-results) and
// scripts/check-changed.ts. `needs` is GitHub's toJSON(needs); returns one
// problem per violation. A success is valid whatever its gates said: a server
// shard detects before skipping its test steps, so it succeeds with gates off.
function checkJobResults(needs) {
  const jobs = Object.entries(needs ?? {});
  if (jobs.length === 0) return ["needs is empty: no job results to check"];
  const problems = [];
  for (const job of Object.keys(EXPECTED_JOBS)) {
    if (!(job in needs)) problems.push(`${job}: missing from needs`);
  }
  for (const [job] of jobs) {
    if (!(job in EXPECTED_JOBS)) problems.push(`${job}: not an expected CI job`);
  }
  const gates = needs.changes?.outputs ?? {};
  for (const [job, entry] of jobs) {
    const expected = EXPECTED_JOBS[job];
    if (!expected) continue;
    const result = entry?.result;
    if (result === "success") {
      // changes may succeed after a fetch/diff fallback, but a fail-open
      // detection is never a healthy run: Check requires the explicit all-clear.
      if (job === "changes" && gates.fail_open !== "false") {
        problems.push(`changes: fail_open is ${JSON.stringify(gates.fail_open)}, expected "false"`);
      }
      // An invalid or unproven upstream-sync claim (#50) forces full CI and can
      // never merge green: Check requires this explicit all-clear too.
      if (job === "changes" && gates.sync_designation_error !== "false") {
        problems.push(
          `changes: sync_designation_error is ${JSON.stringify(
            gates.sync_designation_error,
          )}, expected "false"`,
        );
      }
      continue;
    }
    if (result === "skipped") {
      if (expected.gates === null) problems.push(`${job}: skipped, but it always runs`);
      else if (!expected.gates.every((gate) => gates[gate] === "false")) {
        problems.push(
          `${job}: skipped, but not every gate it represents (${expected.gates.join(", ")}) is "false"`,
        );
      }
      continue;
    }
    problems.push(`${job}: result ${JSON.stringify(result ?? null)} never merges`);
  }
  return problems;
}

// Windows lane invariant: the Electron shell imports only client-runtime's
// authorization/connection/environment/platform/rpc entry points, which never
// load its provider or source-control registries. Both Windows traversals drop
// those edges; Linux CI keeps the full graph.
const CLIENT_RUNTIME_REGISTRY_DEP = /^@t3tools\/(provider|source-control)-/;

function windowsDeps(pkg) {
  return pkg.name === "@t3tools/client-runtime"
    ? pkg.deps.filter((dep) => !CLIENT_RUNTIME_REGISTRY_DEP.test(dep))
    : pkg.deps;
}

// Names in the Windows dependency closure of @t3tools/desktop, including
// desktop itself. deps already excludes build-only edges.
function desktopClosure(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const closure = new Set(["@t3tools/desktop"]);
  const queue = ["@t3tools/desktop"];
  while (queue.length > 0) {
    const pkg = byName.get(queue.pop());
    if (!pkg) continue;
    for (const dep of windowsDeps(pkg)) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }
  return closure;
}

function propagateDependents(packages, seed, depsOf) {
  const result = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (!result.has(pkg.name) && depsOf(pkg).some((dep) => result.has(dep))) {
        result.add(pkg.name);
        grew = true;
      }
    }
  }
  return result;
}

// Sync designation states from the ci-changes action: "none" (no claim),
// "designated" (verified upstream-sync), "invalid" (claimed but unproven or a
// resolver/API failure). Anything but "none" forces the full run.
const SYNC_DESIGNATIONS = new Set(["none", "designated", "invalid"]);

function decide(
  files,
  packages,
  full,
  sync = "none",
  boundaryInfra = readBoundaryInfrastructure(),
) {
  if (!SYNC_DESIGNATIONS.has(sync)) {
    throw new Error(
      `Invalid --sync designation ${JSON.stringify(sync)}. Expected none, designated, or invalid.`,
    );
  }
  const all = new Set(packages.map((pkg) => pkg.name));
  let affected = new Set();
  let everything = full || files === null || sync !== "none" || boundaryInfra === null;
  let rust = false;

  for (const file of files ?? []) {
    if (RUST.test(file)) rust = true;
    if (boundaryInfra?.has(file)) {
      everything = true;
      console.error(`Boundary infrastructure runs everything: ${file}`);
      continue;
    }
    const owners = ownersOf(file, packages);
    if (owners === null) {
      everything = true;
      console.error(`Runs everything: ${file}`);
    } else {
      for (const owner of owners) affected.add(owner);
    }
  }

  // Release smoke reads scripts/ itself, not what the scripts tests read.
  let scriptsChanged = everything;
  let windowsAffected = all;
  if (everything) {
    affected = all;
  } else {
    // The Windows gate propagates over the pruned graph; see windowsDeps.
    windowsAffected = propagateDependents(packages, affected, windowsDeps);
    affected = propagateDependents(packages, affected, (pkg) => pkg.deps);
    scriptsChanged = affected.has("@t3tools/scripts");
    for (const [name, deps] of Object.entries(TEST_ONLY_DEPS)) {
      if (deps.some((dep) => affected.has(dep))) affected.add(name);
    }
  }

  const tested = packages.filter(
    (pkg) => pkg.hasTest && !OWN_TEST_JOB.has(pkg.name) && affected.has(pkg.name),
  );
  const has = (name) => affected.has(name);

  // Scoped Windows verification: the desktop distribution and the release
  // scripts that package it. scriptsChanged was captured before TEST_ONLY_DEPS
  // added scripts as a test-only dependent, so unrelated web/mobile changes do
  // not start Windows merely because scripts tests read those sources.
  const windows = everything || windowsAffected.has("@t3tools/desktop") || scriptsChanged;
  const closure = windows ? desktopClosure(packages) : null;
  const windowsPackages = windows
    ? packages
        .filter(
          (pkg) =>
            pkg.hasTest &&
            affected.has(pkg.name) &&
            (pkg.name === "@t3tools/scripts" || closure.has(pkg.name)),
        )
        .map((pkg) => pkg.dir)
    : [];

  return {
    affected: [...affected].sort(),
    outputs: {
      typecheck: affected.size > 0,
      build: has("@t3tools/desktop") || has("t3") || has("@t3tools/web"),
      test: tested.length > 0,
      // Empty means every package the Test job covers.
      test_packages: everything ? "" : tested.map((pkg) => pkg.name).join(" "),
      test_web: has("@t3tools/web"),
      test_server: has("t3"),
      rust: everything || rust,
      release_smoke: scriptsChanged,
      windows,
      windows_packages: windowsPackages.join(" "),
      upstream_sync: sync !== "none",
      sync_designation_error: sync === "invalid",
    },
  };
}

// The Check job's entry point: applies the shared policy to toJSON(needs) in
// RESULTS. Runs from a sparse checkout, so it must not read the workspace.
function checkResults() {
  const raw = process.env.RESULTS;
  if (typeof raw !== "string" || raw.trim() === "") {
    console.error("check-results: RESULTS is empty or unset");
    process.exit(1);
  }
  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (error) {
    console.error(`check-results: RESULTS is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  for (const [job, entry] of Object.entries(needs)) console.log(`${job}: ${entry?.result}`);
  const problems = checkJobResults(needs);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check-results")) return checkResults();
  const pathsIndex = args.indexOf("--paths");
  const syncIndex = args.indexOf("--sync");
  const sync = syncIndex === -1 ? "none" : args[syncIndex + 1];
  const files =
    pathsIndex === -1
      ? null
      : fs
          .readFileSync(args[pathsIndex + 1], "utf8")
          .split("\n")
          .filter(Boolean);
  const { affected, outputs } = decide(files, readWorkspace(), args.includes("--full"), sync);

  console.error(`Affected packages: ${affected.join(", ") || "none"}`);
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
}

module.exports = {
  readWorkspace,
  decide,
  desktopClosure,
  boundaryInfrastructureOf,
  checkJobResults,
  EXPECTED_JOBS,
  SEPARATELY_REQUIRED_JOBS,
};

if (require.main === module) main();
