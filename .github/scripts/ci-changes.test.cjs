const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  decide,
  desktopClosure,
  readWorkspace,
  boundaryInfrastructureOf,
  EXPECTED_JOBS,
  SEPARATELY_REQUIRED_JOBS,
} = require("./ci-changes.cjs");

// A miniature of the real workspace: apps and packages with the dependency
// edges gating cares about. t3 and @t3tools/web model the packages with their
// own test jobs, so they shape the test/test_packages outputs.
const packages = [
  { name: "t3", dir: "apps/server", hasTest: true, deps: ["@t3tools/web", "@t3tools/shared"] },
  {
    name: "@t3tools/web",
    dir: "apps/web",
    hasTest: true,
    deps: ["@t3tools/shared", "@t3tools/client-runtime"],
  },
  {
    name: "@t3tools/desktop",
    dir: "apps/desktop",
    hasTest: true,
    deps: ["@t3tools/shared", "@t3tools/client-runtime"],
  },
  {
    name: "@t3tools/mobile",
    dir: "apps/mobile",
    hasTest: true,
    deps: ["@t3tools/shared", "@t3tools/client-runtime"],
  },
  { name: "@t3tools/shared", dir: "packages/shared", hasTest: true, deps: [] },
  {
    name: "@t3tools/client-runtime",
    dir: "packages/client-runtime",
    hasTest: true,
    deps: ["@t3tools/shared"],
  },
  { name: "@t3tools/scripts", dir: "scripts", hasTest: true, deps: [] },
];

const GATES = [
  "build",
  "release_smoke",
  "rust",
  "sync_designation_error",
  "test",
  "test_packages",
  "test_server",
  "test_web",
  "typecheck",
  "upstream_sync",
  "windows",
  "windows_packages",
];

// The full scoped Windows set for this fixture: every affected package with
// tests in the desktop dependency closure, plus scripts, in workspace order.
const FULL_WINDOWS_PACKAGES = "apps/desktop packages/shared packages/client-runtime scripts";

// mobile_native gating was removed with the macOS static-analysis job: desktop
// CI no longer carries a mobile-native gate, so decide must not emit one.
test("outputs are exactly the remaining gates, with no mobile_native", () => {
  const { outputs } = decide(["apps/mobile/ios/AppDelegate.swift"], packages, false);
  assert.deepEqual(Object.keys(outputs).sort(), GATES);
  assert(!("mobile_native" in outputs));
});

// Everything-run indicators: an empty test_packages and the rust gate mean
// "unknown change, run every job".
function assertNotEverything(outputs) {
  assert.notEqual(outputs.test_packages, "");
  assert.equal(outputs.rust, false);
}

for (const file of [
  "apps/mobile/ios/AppDelegate.swift",
  "apps/mobile/android/app/src/MainActivity.kt",
  "apps/mobile/android/build.gradle.kts",
  "apps/mobile/.swiftlint.yml",
  "apps/mobile/detekt.yml",
  "apps/mobile/.editorconfig",
  "apps/mobile/Brewfile",
]) {
  test(`mobile-native change ${file} gates mobile, not everything`, () => {
    const result = decide([file], packages, false);
    assertNotEverything(result.outputs);
    // scripts tests read mobile sources, so they join the run; desktop gates stay off.
    assert.deepEqual(result.affected, ["@t3tools/mobile", "@t3tools/scripts"]);
    assert.equal(result.outputs.typecheck, true);
    assert.equal(result.outputs.test, true);
    assert.equal(result.outputs.test_packages, "@t3tools/mobile @t3tools/scripts");
    assert.equal(result.outputs.build, false);
    assert.equal(result.outputs.test_web, false);
    assert.equal(result.outputs.test_server, false);
    // release_smoke tracks direct scripts changes; the test-only pull-in does not set it.
    assert.equal(result.outputs.release_smoke, false);
    // scripts tests read mobile sources, but nothing desktop-owned changed.
    assert.equal(result.outputs.windows, false);
    assert.equal(result.outputs.windows_packages, "");
  });
}

// git diff --name-only reports deletions as bare paths, so a removed native
// file must fall through ownership like an edit, never the unknown gate.
test("a deleted mobile-native file is owned by mobile, not unknown", () => {
  const result = decide(["apps/mobile/ios/RemovedView.swift"], packages, false);
  assertNotEverything(result.outputs);
  assert.deepEqual(result.affected, ["@t3tools/mobile", "@t3tools/scripts"]);
});

test("the mobile-native static check script gates the scripts package", () => {
  const { affected, outputs } = decide(["scripts/mobile-native-static-check.ts"], packages, false);
  assertNotEverything(outputs);
  assert.deepEqual(affected, ["@t3tools/scripts"]);
  assert.equal(outputs.release_smoke, true);
  assert.equal(outputs.test_packages, "@t3tools/scripts");
});

test("a shared change runs the JS tests of every dependent", () => {
  const { affected, outputs } = decide(["packages/shared/src/env.ts"], packages, false);
  assert.deepEqual(affected, [
    "@t3tools/client-runtime",
    "@t3tools/desktop",
    "@t3tools/evals",
    "@t3tools/mobile",
    "@t3tools/provider-pi",
    "@t3tools/scripts",
    "@t3tools/shared",
    "@t3tools/web",
    "t3",
  ]);
  assert.equal(outputs.test, true);
  // t3 and @t3tools/web run in their own jobs, so only the rest test here.
  // TEST_ONLY_DEPS adds @t3tools/evals and @t3tools/provider-pi to affected,
  // but they are not in this fixture, so they stay out of test_packages.
  assert.equal(
    outputs.test_packages,
    "@t3tools/desktop @t3tools/mobile @t3tools/shared @t3tools/client-runtime @t3tools/scripts",
  );
  assert.equal(outputs.test_web, true);
  assert.equal(outputs.test_server, true);
  assert.equal(outputs.build, true);
  assert.equal(outputs.release_smoke, false);
  // desktop depends on shared, so the Windows lane covers the closure and scripts.
  assert.equal(outputs.windows, true);
  assert.equal(outputs.windows_packages, FULL_WINDOWS_PACKAGES);
});

test("a desktop-only change leaves unrelated gates false so jobs can skip", () => {
  const { affected, outputs } = decide(["apps/desktop/src/main.ts"], packages, false);
  assert.deepEqual(affected, ["@t3tools/desktop", "@t3tools/scripts"]);
  assert.equal(outputs.typecheck, true);
  assert.equal(outputs.build, true);
  assert.equal(outputs.test, true);
  assert.equal(outputs.test_packages, "@t3tools/desktop @t3tools/scripts");
  assert.equal(outputs.test_web, false);
  assert.equal(outputs.test_server, false);
  assert.equal(outputs.rust, false);
  assert.equal(outputs.release_smoke, false);
  assert.equal(outputs.windows, true);
  assert.equal(outputs.windows_packages, "apps/desktop scripts");
});

// Windows scope beyond the plain desktop case: scripts-owned inputs run the
// scripts tests, an affected desktop dependency joins the closure, and changes
// nothing desktop-owned depends on leave the lane off.
test("a scripts-owned change turns Windows on for the scripts package only", () => {
  for (const file of ["scripts/build-desktop-artifact.ts", "native/resource-monitor/src/main.rs"]) {
    const { outputs } = decide([file], packages, false);
    assert.equal(outputs.windows, true, file);
    assert.equal(outputs.windows_packages, "scripts", file);
  }
});

test("a desktop-distribution native input selects desktop and scripts", () => {
  const { outputs } = decide(["native/browser-secret/src/lib.rs"], packages, false);
  assert.equal(outputs.windows, true);
  assert.equal(outputs.windows_packages, "apps/desktop scripts");
});

test("an affected desktop dependency joins desktop and scripts in the scope", () => {
  const { outputs } = decide(["packages/client-runtime/src/state.ts"], packages, false);
  assert.equal(outputs.windows, true);
  assert.equal(outputs.windows_packages, "apps/desktop packages/client-runtime scripts");
  // scripts joins through TEST_ONLY_DEPS only, so the smoke gate stays off.
  assert.equal(outputs.release_smoke, false);
});

// client-runtime's provider and source-control registry dependencies are
// web/mobile surfaces the Electron shell never loads: a server-only registry
// change does not select Windows, and registry packages never join the scope
// even when affected alongside the closure.
const registryPackages = [
  ...packages.map((pkg) =>
    pkg.name === "@t3tools/client-runtime"
      ? { ...pkg, deps: [...pkg.deps, "@t3tools/provider-core", "@t3tools/source-control-core"] }
      : pkg,
  ),
  {
    name: "@t3tools/provider-core",
    dir: "packages/provider-core",
    hasTest: true,
    deps: ["@t3tools/shared"],
  },
  {
    name: "@t3tools/source-control-core",
    dir: "packages/source-control-core",
    hasTest: true,
    deps: ["@t3tools/shared"],
  },
];

test("a server-only provider change tests its dependents but leaves Windows off", () => {
  const { affected, outputs } = decide(
    ["packages/provider-core/src/server/driver.ts"],
    registryPackages,
    false,
  );
  // Linux still tests everything that depends on the registry.
  assert.ok(affected.includes("@t3tools/client-runtime"));
  assert.ok(affected.includes("@t3tools/desktop"));
  assert.equal(outputs.test, true);
  assert.equal(outputs.windows, false);
  assert.equal(outputs.windows_packages, "");
});

test("registry packages stay out of the Windows scope when the closure runs", () => {
  const { outputs } = decide(["packages/shared/src/env.ts"], registryPackages, false);
  assert.equal(outputs.windows, true);
  assert.equal(outputs.windows_packages, FULL_WINDOWS_PACKAGES);
});

// The same invariant against the real workspace: the Windows closure is
// exactly the Electron distribution surface, and full CI runs all eight
// selected packages (the closure plus scripts).
test("the real desktop closure is exactly the distribution surface", () => {
  assert.deepEqual([...desktopClosure(readWorkspace())].sort(), [
    "@t3tools/client-runtime",
    "@t3tools/contracts",
    "@t3tools/desktop",
    "@t3tools/plusplus",
    "@t3tools/shared",
    "@t3tools/ssh",
    "@t3tools/tailscale",
  ]);
});

test("a full run selects the eight-package Windows surface", () => {
  const { outputs } = decide([], readWorkspace(), true);
  assert.equal(outputs.windows, true);
  assert.equal(
    outputs.windows_packages,
    "apps/desktop packages/client-runtime packages/contracts packages/plusplus packages/shared packages/ssh packages/tailscale scripts",
  );
});

for (const file of ["apps/server/src/ws.ts", "apps/web/src/App.tsx", "apps/mobile/src/App.tsx"]) {
  test(`a non-desktop change ${file} leaves Windows off`, () => {
    const { outputs } = decide([file], packages, false);
    assert.equal(outputs.windows, false);
    assert.equal(outputs.windows_packages, "");
  });
}

// The protected upstream-sync designation (#50): a verified claim forces the
// full run plus the merge job; an invalid or unproven claim forces the same
// full run and additionally fails Check; no claim keeps ordinary filtering.
test("an ordinary change leaves the sync gates off", () => {
  const { outputs } = decide(["apps/web/src/App.tsx"], packages, false);
  assert.equal(outputs.upstream_sync, false);
  assert.equal(outputs.sync_designation_error, false);
});

test("a verified designation forces the full run, sync, and Windows", () => {
  const { affected, outputs } = decide(["docs/user/install.md"], packages, false, "designated");
  assert.deepEqual(affected, packages.map((pkg) => pkg.name).sort());
  assert.equal(outputs.upstream_sync, true);
  assert.equal(outputs.sync_designation_error, false);
  assert.equal(outputs.windows, true);
  assert.equal(outputs.windows_packages, FULL_WINDOWS_PACKAGES);
  for (const gate of [
    "typecheck",
    "build",
    "test",
    "test_web",
    "test_server",
    "rust",
    "release_smoke",
  ]) {
    assert.equal(outputs[gate], true, gate);
  }
});

// An unauthorized label, an unproven timeline, or a resolver/API failure can
// only add work or fail Check: full run, sync job on, designation error set.
for (const sync of ["invalid"]) {
  test(`a claimed-unverified or failed resolution (${sync}) forces full CI and errors`, () => {
    const { outputs } = decide(["apps/web/src/App.tsx"], packages, false, sync);
    assert.equal(outputs.upstream_sync, true);
    assert.equal(outputs.sync_designation_error, true);
    assert.equal(outputs.test_packages, "");
    assert.equal(outputs.windows, true);
    assert.equal(outputs.windows_packages, FULL_WINDOWS_PACKAGES);
  });
}

test("an unknown sync designation is rejected rather than guessed", () => {
  assert.throws(() => decide([], packages, false, "maybe"), /--sync/);
});

test("an inert docs change runs no gated job", () => {
  const { affected, outputs } = decide(["docs/user/install.md"], packages, false);
  assert.deepEqual(affected, []);
  for (const gate of GATES) {
    if (gate === "test_packages" || gate === "windows_packages") {
      assert.equal(outputs[gate], "", gate);
    } else {
      assert.equal(outputs[gate], false, gate);
    }
  }
});

// Fail-closed: a diff that cannot be resolved, a manifest, or an unrecognized
// path must run every job rather than guess.
for (const [name, files, full] of [
  ["an unresolvable diff", null, false],
  ["a full run", [], true],
  ["a manifest change", ["packages/shared/package.json"], false],
  ["an unrecognized release workflow", [".github/workflows/release.yml"], false],
]) {
  test(`${name} runs every job`, () => {
    const { affected, outputs } = decide(files, packages, full);
    assert.deepEqual(affected, packages.map((pkg) => pkg.name).sort());
    assert.equal(outputs.test_packages, "");
    for (const gate of [
      "typecheck",
      "build",
      "test",
      "test_web",
      "test_server",
      "rust",
      "release_smoke",
      "windows",
    ]) {
      assert.equal(outputs[gate], true, gate);
    }
    assert.equal(outputs.windows_packages, FULL_WINDOWS_PACKAGES);
  });
}

// The detector gates CI itself: an edit to any file that shapes job selection
// must run the whole pipeline it selects for, Windows included.
for (const file of [
  ".github/workflows/ci.yml",
  ".github/workflows/windows-tests.yml",
  ".github/actions/ci-changes/action.yml",
  ".github/scripts/ci-changes.cjs",
  ".github/scripts/ci-changes.d.cts",
  ".github/scripts/ci-changes.test.cjs",
]) {
  test(`a detector-owned path ${file} forces every gate and Windows`, () => {
    const { outputs } = decide([file], packages, false);
    assert.equal(outputs.test_packages, "");
    for (const gate of [
      "typecheck",
      "build",
      "test",
      "test_web",
      "test_server",
      "rust",
      "release_smoke",
      "windows",
    ]) {
      assert.equal(outputs[gate], true, gate);
    }
    assert.equal(outputs.windows_packages, FULL_WINDOWS_PACKAGES);
  });
}

// The Check job explains a skip only when the gate a job maps to exists and is
// "false"; a gate referenced by the workflow but never emitted by decide can
// never explain a skip, so the wiring must stay in sync with the outputs.
test("every gate the workflow references is a decide output", () => {
  const { outputs } = decide(["apps/web/src/App.tsx"], packages, false);
  const repoRoot = path.resolve(__dirname, "../..");
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const action = fs.readFileSync(
    path.join(repoRoot, ".github/actions/ci-changes/action.yml"),
    "utf8",
  );

  const referenced = new Set();
  for (const source of [workflow, action]) {
    for (const match of source.matchAll(/changes\.outputs\.(\w+)|steps\.detect\.outputs\.(\w+)/g)) {
      referenced.add(match[1] ?? match[2]);
    }
  }
  // fail_open marks an unhealthy detection fallback; the action emits it around
  // decide, so it deliberately is not a decide output.
  referenced.delete("fail_open");

  for (const gate of referenced) {
    assert.ok(gate in outputs, `workflow references gate "${gate}" that decide does not emit`);
  }
});

// ++ fork-boundary infrastructure gates the checker itself, so any of its
// paths must select full CI even when a package would otherwise own them.
function assertEverything(outputs, file) {
  assert.equal(outputs.test_packages, "", file);
  for (const gate of [
    "typecheck",
    "build",
    "test",
    "test_web",
    "test_server",
    "rust",
    "release_smoke",
  ]) {
    assert.equal(outputs[gate], true, `${file}: ${gate}`);
  }
}

test("boundaryInfrastructureOf parses only a well-formed policy list", () => {
  assert.deepEqual(
    boundaryInfrastructureOf('{"boundaryInfrastructure":["a.ts","b/c.ts"]}'),
    new Set(["a.ts", "b/c.ts"]),
  );
  assert.equal(boundaryInfrastructureOf("{oops"), null);
  assert.equal(boundaryInfrastructureOf("{}"), null);
  assert.equal(boundaryInfrastructureOf('{"boundaryInfrastructure":"a.ts"}'), null);
  assert.equal(boundaryInfrastructureOf('{"boundaryInfrastructure":[42]}'), null);
});

test("every recorded boundaryInfrastructure path runs every job", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const policy = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "config/fork-inventory.json"), "utf8"),
  );
  assert.ok(policy.boundaryInfrastructure.length > 0);
  for (const file of policy.boundaryInfrastructure) {
    const { outputs } = decide([file], packages, false);
    assertEverything(outputs, file);
  }
});

// The empty set stands in for a head policy stripped of every boundary entry.
test("a hostile inventory edit stripping boundary entries still runs every job", () => {
  const { outputs } = decide(
    ["config/fork-inventory.json", ".github/scripts/ci-changes.cjs"],
    packages,
    false,
    "none",
    new Set(),
  );
  assertEverything(outputs, "config/fork-inventory.json");
});

test("a scripts file outside the boundary list stays scoped", () => {
  const { outputs } = decide(["scripts/build-cli-archive.ts"], packages, false);
  assertNotEverything(outputs);
});

test("an unreadable boundary policy runs every job rather than guessing", () => {
  const { outputs } = decide(["docs/user/install.md"], packages, false, "none", null);
  assertEverything(outputs, "unreadable policy");
});

test("an inert docs diff still runs nothing when the policy is readable", () => {
  const { outputs } = decide(["docs/user/install.md"], packages, false, "none", new Set());
  assert.deepEqual(outputs.test_packages, "");
  assert.equal(outputs.rust, false);
});

// The fork-boundary job is advisory until B12: it must carry
// continue-on-error and stay out of Check's needs, so its result can never
// gate a PR. The shared expected-job map mirrors Check's needs and stays
// unaware of the job for the same reason.
test("fork_boundaries is advisory and outside the Check gate", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  const job = workflow.match(/^ {2}fork_boundaries:\n(?:.*\n)*?^ {4}continue-on-error: true$/m);
  assert.ok(job, "fork_boundaries job must set continue-on-error: true");
  assert.ok(
    !/fork_boundaries[\s\S]*?needs:/.test(job[0]),
    "fork_boundaries must not gate on needs",
  );

  const check = workflow.slice(workflow.indexOf("\n  check:"));
  const needs = check.match(/needs:\s*\[([\s\S]*?)\]/);
  assert.ok(needs, "check job must declare needs");
  assert.ok(!needs[1].includes("fork_boundaries"), "Check must not need fork_boundaries");

  assert.ok(!("fork_boundaries" in EXPECTED_JOBS), "EXPECTED_JOBS must not map fork_boundaries");
});

test("every gate the shared expected-job map names is a decide output", () => {
  const { outputs } = decide(["apps/web/src/App.tsx"], packages, false);
  for (const [job, { gates }] of Object.entries(EXPECTED_JOBS)) {
    for (const gate of gates ?? []) {
      assert.ok(gate in outputs, `${job} gate "${gate}" is not a decide output`);
    }
  }
});

test("the ci-changes action exposes fail_open", () => {
  const action = fs.readFileSync(
    path.join(path.resolve(__dirname, "../.."), ".github/actions/ci-changes/action.yml"),
    "utf8",
  );
  assert.match(action, /fail_open:\s*\n\s*value: \$\{\{ steps\.detect\.outputs\.fail_open \}\}/);
  const { outputs } = decide(["apps/web/src/App.tsx"], packages, false);
  assert.ok(!("fail_open" in outputs));
});

// The Check job fails closed on any drift between the workflow's jobs, its
// needs list, and the shared policy's expected-job map.
test("CI job IDs, check.needs, and the expected-job map stay synchronized", () => {
  const workflow = fs.readFileSync(
    path.join(path.resolve(__dirname, "../.."), ".github/workflows/ci.yml"),
    "utf8",
  );
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const jobIds = [...jobs.matchAll(/^ {2}([a-z_0-9]+):\n/gm)].map((match) => match[1]);
  const check = jobs.slice(jobs.indexOf("\n  check:\n"));
  const needs = check
    .match(/needs:\s*\[([^\]]*)\]/)[1]
    .split(",")
    .map((job) => job.trim())
    .filter(Boolean);
  const expected = Object.keys(EXPECTED_JOBS);

  assert.deepEqual(
    jobIds.filter((job) => job !== "check" && !SEPARATELY_REQUIRED_JOBS.includes(job)).sort(),
    [...expected].sort(),
  );
  assert.deepEqual(
    needs.filter((job) => !SEPARATELY_REQUIRED_JOBS.includes(job)).sort(),
    [...expected].sort(),
  );
});

// The Check job runs the shared policy through this CLI mode with toJSON(needs)
// in RESULTS, from a sparse checkout: it must not read the workspace.
test("--check-results passes a green run and fails unexplained results", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const script = path.join(__dirname, "ci-changes.cjs");
  const green = {
    changes: {
      result: "success",
      outputs: {
        fail_open: "false",
        sync_designation_error: "false",
        upstream_sync: "false",
        windows: "true",
      },
    },
    lint: { result: "success", outputs: {} },
    build: { result: "success", outputs: {} },
    test: { result: "success", outputs: {} },
    test_web: { result: "success", outputs: {} },
    test_server: { result: "success", outputs: {} },
    rust: { result: "success", outputs: {} },
    release_smoke: { result: "success", outputs: {} },
    shared_persistence_compat: { result: "success", outputs: {} },
    windows: { result: "success", outputs: {} },
    sync: { result: "success", outputs: {} },
  };
  const run = (needs) => {
    try {
      const stdout = execFileSync(process.execPath, [script, "--check-results"], {
        cwd: os.tmpdir(),
        env: { ...process.env, RESULTS: JSON.stringify(needs) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output: stdout };
    } catch (error) {
      return { status: error.status, output: `${error.stdout}${error.stderr}` };
    }
  };

  assert.equal(run(green).status, 0);
  const skipped = run({ ...green, windows: { result: "skipped", outputs: {} } });
  assert.equal(skipped.status, 1);
  assert.match(skipped.output, /windows/);
  const failOpen = run({
    ...green,
    changes: { result: "success", outputs: { fail_open: "true" } },
  });
  assert.equal(failOpen.status, 1);
  assert.match(failOpen.output, /fail_open/);

  // The sync job skips only when the detector turned the designation gate off.
  const syncSkippedOff = run({
    ...green,
    sync: { result: "skipped", outputs: {} },
  });
  assert.equal(syncSkippedOff.status, 0);
  const syncSkippedOn = run({
    ...green,
    changes: {
      result: "success",
      outputs: { fail_open: "false", sync_designation_error: "false", upstream_sync: "true" },
    },
    sync: { result: "skipped", outputs: {} },
  });
  assert.equal(syncSkippedOn.status, 1);
  assert.match(syncSkippedOn.output, /sync/);

  // A designation error fails Check even when every job, sync included, is green.
  const designationError = run({
    ...green,
    changes: {
      result: "success",
      outputs: { fail_open: "false", sync_designation_error: "true", upstream_sync: "true" },
    },
  });
  assert.equal(designationError.status, 1);
  assert.match(designationError.output, /sync_designation_error/);
  // A missing all-clear is as bad as an explicit true.
  const missingAllClear = run({
    ...green,
    changes: { result: "success", outputs: { fail_open: "false" } },
  });
  assert.equal(missingAllClear.status, 1);
  assert.match(missingAllClear.output, /sync_designation_error/);
});

// The sync PR gate wiring (#50): CI subscribes to label events, the sync job
// exists with the right name and gate, and Check aggregates it.
test("ci.yml wires the upstream-sync label gate and the sync merge job", () => {
  const workflow = fs.readFileSync(
    path.join(path.resolve(__dirname, "../.."), ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(workflow, /on:\n  pull_request:\n(    #[^\n]*\n)*    types:/);
  const typesLine = workflow.match(/pull_request:\n(?:    #[^\n]*\n)*    types: \[([^\]]*)\]/);
  assert.ok(typesLine, "ci.yml must list pull_request types");
  for (const type of ["opened", "reopened", "synchronize", "labeled", "unlabeled"]) {
    assert.ok(
      typesLine[1]
        .split(",")
        .map((entry) => entry.trim())
        .includes(type),
      `ci.yml pull_request types must include ${type}`,
    );
  }
  const syncJob =
    "  sync:\n    name: Upstream Sync Merge\n    needs: changes\n    if: ${{ !cancelled() && needs.changes.outputs.upstream_sync != 'false' }}";
  assert.ok(workflow.includes(syncJob), "ci.yml must gate the sync job on upstream_sync");
  assert.match(workflow, /needs\.changes\.outputs\.sync_designation_error == 'true'/);
  // The changes job and the self-gating shards can resolve the designation.
  assert.match(workflow, /issues: read/);
  assert.match(workflow, /pull-requests: read/);
  const shardGate = workflow.slice(workflow.indexOf("Require healthy change detection"));
  assert.match(shardGate, /sync_designation_error/);
});

// The upstream sync dry run (#49) is read-only automation: no write token,
// secret, or push, credential-less checkouts, two independent replay lanes,
// fail-closed reporting. These assertions pin that wiring so a refactor cannot
// silently drop a guard; they read raw YAML like the ci.yml tests above.
const repoRoot = path.resolve(__dirname, "../..");
const dryRunWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/upstream-sync-dry-run.yml"),
  "utf8",
);
const windowsWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/windows-tests.yml"),
  "utf8",
);

test("the dry-run workflow is read-only: no write token, secrets, or push", () => {
  assert.match(dryRunWorkflow, /^permissions:\n  contents: read\n  id-token: none$/m);
  // No secret is passed to any job, and no step pushes or writes a ref.
  assert.ok(!/secrets:/.test(dryRunWorkflow), "dry run must not reference secrets");
  assert.ok(!/\bcontents: write\b/.test(dryRunWorkflow));
  assert.ok(!/git push|update-ref|--tags\b/.test(dryRunWorkflow));
  // Every checkout disables credentials.
  const checkouts = (dryRunWorkflow.match(/uses: actions\/checkout@v6/g) ?? []).length;
  const noCreds = (dryRunWorkflow.match(/persist-credentials: false/g) ?? []).length;
  assert.equal(checkouts, noCreds, "every checkout must set persist-credentials: false");
  assert.ok(checkouts >= 3, "merge, verify_linux, and report each check out");
});

test("the dry-run workflow has strict triggers and a fail-closed topology", () => {
  // Manual dispatch requires a tag; the schedule resolves "latest" itself.
  assert.match(dryRunWorkflow, /workflow_dispatch:\n\s+inputs:\n\s+tag:/);
  assert.match(dryRunWorkflow, /required: true/);
  assert.match(dryRunWorkflow, /- cron: "17 6 \* \* \*"/);
  // One non-cancelling concurrency group on the default branch.
  assert.match(dryRunWorkflow, /group: upstream-sync-dry-run-main/);
  assert.match(dryRunWorkflow, /cancel-in-progress: false/);
  assert.match(dryRunWorkflow, /only runs on the default branch/);
});

test("the verification lanes gate independently on a clean merge", () => {
  // Linux and Windows both need merge only, so one cannot suppress the other.
  const linuxIf =
    "verify_linux:\n    name: Verify merge (Linux)\n    needs: merge\n    if: ${{ !cancelled() && needs.merge.outputs.status == 'clean' }}";
  assert.ok(dryRunWorkflow.includes(linuxIf), "verify_linux must gate on a clean merge alone");
  const windowsIf =
    "windows:\n    name: Verify merge (Windows)\n    needs: merge\n    if: ${{ !cancelled() && needs.merge.outputs.status == 'clean' }}";
  assert.ok(dryRunWorkflow.includes(windowsIf), "windows must gate on a clean merge alone");
  // Windows replays the full merge-provided distribution scope.
  assert.match(dryRunWorkflow, /package: \$\{\{ needs\.merge\.outputs\.windows_packages \}\}/);
  // Both lanes pass all four replay identities.
  for (const input of [
    "dry_run_tag: ${{ needs.merge.outputs.tag }}",
    "dry_run_base_sha: ${{ needs.merge.outputs.base_sha }}",
    "dry_run_upstream_sha: ${{ needs.merge.outputs.upstream_sha }}",
    "dry_run_merge_tree: ${{ needs.merge.outputs.merge_tree }}",
  ]) {
    assert.ok(dryRunWorkflow.includes(input), `windows lane must pass ${input}`);
  }
  // Each lane records one of the three verification results, fail-closed.
  assert.equal((dryRunWorkflow.match(/result=verification_failed ;;/g) ?? []).length, 1);
  assert.equal((dryRunWorkflow.match(/result=error\n/g) ?? []).length, 1);
});

test("the report job always runs and aggregates every lane", () => {
  const report = dryRunWorkflow.slice(dryRunWorkflow.indexOf("\n  report:\n"));
  assert.match(report, /if: always\(\)/);
  assert.match(report, /needs: \[merge, verify_linux, windows\]/);
  // It applies the outcome matrix through the script and reads all lane states.
  assert.match(report, /resolve-outcome/);
  for (const env of [
    "DRY_RUN_MERGE_STATUS: ${{ needs.merge.outputs.status }}",
    "DRY_RUN_MERGE_RESULT: ${{ needs.merge.result }}",
    "DRY_RUN_LINUX_RESULT: ${{ needs.verify_linux.result }}",
    "DRY_RUN_LINUX_VERIFICATION: ${{ needs.verify_linux.outputs.verification_result }}",
    "DRY_RUN_WINDOWS_RESULT: ${{ needs.windows.result }}",
    "DRY_RUN_WINDOWS_VERIFICATION: ${{ needs.windows.outputs.verification_result }}",
  ]) {
    assert.ok(report.includes(env), `report job must read ${env}`);
  }
});

test("windows-tests exposes replay inputs as all-or-none and a verification output", () => {
  for (const input of [
    "dry_run_tag",
    "dry_run_base_sha",
    "dry_run_upstream_sha",
    "dry_run_merge_tree",
  ]) {
    assert.ok(
      windowsWorkflow.includes(`${input}:`),
      `windows-tests must declare the ${input} input`,
    );
  }
  assert.match(windowsWorkflow, /all four dry_run inputs or none/);
  assert.match(windowsWorkflow, /a dry-run replay rejects a files scope/);
  assert.match(
    windowsWorkflow,
    /verification_result:\n\s+description:[^\n]*\n\s+value: \$\{\{ jobs\.test\.outputs\.verification_result \}\}/,
  );
  assert.match(windowsWorkflow, /id: verification_result\n\s+if: always\(\)/);
  // The replay checkout drops credentials; a normal run keeps its prior behavior.
  assert.match(windowsWorkflow, /persist-credentials: \$\{\{ inputs\.dry_run_base_sha == '' \}\}/);
  // Existing CI/manual behavior is preserved.
  assert.match(windowsWorkflow, /was called without a package/);
  assert.match(windowsWorkflow, /files is only supported by manual runs/);
});
