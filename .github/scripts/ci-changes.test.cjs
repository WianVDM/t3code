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
  "test",
  "test_packages",
  "test_server",
  "test_web",
  "typecheck",
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
    new Set(),
  );
  assertEverything(outputs, "config/fork-inventory.json");
});

test("a scripts file outside the boundary list stays scoped", () => {
  const { outputs } = decide(["scripts/build-cli-archive.ts"], packages, false);
  assertNotEverything(outputs);
});

test("an unreadable boundary policy runs every job rather than guessing", () => {
  const { outputs } = decide(["docs/user/install.md"], packages, false, null);
  assertEverything(outputs, "unreadable policy");
});

test("an inert docs diff still runs nothing when the policy is readable", () => {
  const { outputs } = decide(["docs/user/install.md"], packages, false, new Set());
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
    changes: { result: "success", outputs: { fail_open: "false", windows: "true" } },
    lint: { result: "success", outputs: {} },
    build: { result: "success", outputs: {} },
    test: { result: "success", outputs: {} },
    test_web: { result: "success", outputs: {} },
    test_server: { result: "success", outputs: {} },
    rust: { result: "success", outputs: {} },
    release_smoke: { result: "success", outputs: {} },
    shared_persistence_compat: { result: "success", outputs: {} },
    windows: { result: "success", outputs: {} },
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
});
