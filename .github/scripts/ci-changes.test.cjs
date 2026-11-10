const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { decide, boundaryInfrastructureOf } = require("./ci-changes.cjs");

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
  { name: "@t3tools/desktop", dir: "apps/desktop", hasTest: true, deps: ["@t3tools/shared"] },
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
];

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
});

test("an inert docs change runs no gated job", () => {
  const { affected, outputs } = decide(["docs/user/install.md"], packages, false);
  assert.deepEqual(affected, []);
  for (const gate of GATES) {
    if (gate === "test_packages") {
      assert.equal(outputs.test_packages, "");
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
  ["an unrecognized path", [".github/workflows/ci.yml"], false],
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
    ]) {
      assert.equal(outputs[gate], true, gate);
    }
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
  // Gates named by the Check job's renamed-gates map (job name -> gate list).
  for (const match of workflow.matchAll(/\[("(?:\w+)"(?:, "(?:\w+)")*)\]/g)) {
    for (const gate of match[1].matchAll(/"(\w+)"/g)) referenced.add(gate[1]);
  }

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
// gate a PR. check-changed.ts's JOB_GATES mirrors Check's needs and stays
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

  const changed = fs.readFileSync(path.join(repoRoot, "scripts/check-changed.ts"), "utf8");
  const gates = changed.match(/const JOB_GATES[^=]*=\s*{([\s\S]*?)};/);
  assert.ok(gates, "JOB_GATES must exist");
  assert.ok(!gates[1].includes("fork_boundaries"), "JOB_GATES must not map fork_boundaries");
});
