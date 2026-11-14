const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANAGED_LABELS,
  SEAM_ENTRIES,
  classifyPath,
  classifyPaths,
  deriveAdvisoryLabels,
  planLabelChanges,
} = require("./pr-ownership-label.cjs");

const labelsOf = (paths) => [...deriveAdvisoryLabels(classifyPaths(paths))].sort();

test("classifies fork governance, sync tooling, and shared product paths", () => {
  assert.equal(classifyPath(".github/workflows/ci.yml").category, "fork");
  assert.equal(classifyPath(".agents/skills/test-t3-app/SKILL.md").category, "fork");
  assert.equal(classifyPath(".repos/effect/LLMS.md").category, "fork");
  assert.equal(classifyPath("scripts/upstream-sync.ts").category, "fork");
  assert.equal(classifyPath("scripts/sync-reference-repos.ts").category, "fork");
  assert.equal(classifyPath("CONTRIBUTING.md").category, "fork");
  assert.equal(classifyPath("apps/server/src/orchestration-v2/Orchestrator.ts").category, "shared");
  assert.equal(classifyPath("scripts/dev-runner.ts").category, "shared");
});

test("fork prefix rules do not swallow sibling paths", () => {
  assert.equal(classifyPath(".githubx/workflows/ci.yml").category, "shared");
  assert.equal(classifyPath("scripts/upstream-syncer.ts").category, "shared");
});

test("classifies upstream-owned diverged files as diverged seams", () => {
  const entry = classifyPath("apps/desktop/src/main.ts");
  assert.deepEqual(entry, { path: "apps/desktop/src/main.ts", category: "seam", diverged: true });
  assert.equal(classifyPath("packages/provider-pi/src/server/mcpInjection.ts").diverged, true);
  assert.equal(classifyPath("packages/shared/src/promptLinks.test.ts").diverged, true);
});

test("classifies fork-only integration modules as non-diverged seams", () => {
  const entry = classifyPath("apps/desktop/src/app/DesktopVariant.ts");
  assert.deepEqual(entry, {
    path: "apps/desktop/src/app/DesktopVariant.ts",
    category: "seam",
    diverged: false,
  });
  assert.equal(classifyPath("apps/web/src/state/upstreamRelease.ts").diverged, false);
  assert.equal(classifyPath("scripts/lib/desktop-variant.ts").diverged, false);
});

test("seam entries win over overlapping fork prefix rules", () => {
  // .github/scripts/check-shared-persistence-compat.cjs matches both the seam
  // registry and the .github/** fork prefix; seam precedence must be stable.
  const entry = classifyPath(".github/scripts/check-shared-persistence-compat.cjs");
  assert.equal(entry.category, "seam");
  assert.equal(entry.diverged, false);
});

test("seam registry marks diverged files consistently", () => {
  const paths = SEAM_ENTRIES.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, "seam registry paths must be unique");
  for (const entry of SEAM_ENTRIES) {
    assert.equal(classifyPath(entry.path).category, "seam");
    assert.equal(typeof entry.diverged, "boolean");
  }
});

test("labels a fork-only PR as plusplus-only", () => {
  assert.deepEqual(labelsOf([".github/workflows/ci.yml", "scripts/upstream-sync.ts"]), [
    "plusplus-only",
  ]);
});

test("labels a shared-only PR as upstream-candidate", () => {
  assert.deepEqual(labelsOf(["apps/server/src/ws.ts", "apps/web/src/App2.tsx"]), [
    "upstream-candidate",
  ]);
});

test("labels a fork-added seam module PR as seam and plusplus-only", () => {
  assert.deepEqual(labelsOf(["apps/desktop/src/app/DesktopVariant.ts"]), ["plusplus-only", "seam"]);
});

test("labels a diverged seam PR touching shared code as seam and sync-conflict", () => {
  assert.deepEqual(labelsOf(["apps/desktop/src/main.ts", "apps/desktop/src/app/DesktopApp.ts"]), [
    "seam",
    "sync-conflict",
  ]);
});

test("mixed fork and shared changes get no exclusivity label", () => {
  assert.deepEqual(labelsOf([".github/workflows/ci.yml", "apps/server/src/ws.ts"]), []);
});

test("an empty diff gets no labels", () => {
  assert.deepEqual(labelsOf([]), []);
});

test("plans label adds and removes over managed labels only", () => {
  assert.deepEqual(planLabelChanges(["bug", "size:M"], new Set(["seam"])), {
    add: ["seam"],
    remove: [],
  });
  assert.deepEqual(planLabelChanges(["seam", "sync-conflict"], new Set(["seam"])), {
    add: [],
    remove: ["sync-conflict"],
  });
});

test("leaves unmanaged labels untouched and is idempotent", () => {
  const desired = new Set(["plusplus-only", "seam"]);
  assert.deepEqual(planLabelChanges(["plusplus-only", "seam", "accepted"], desired), {
    add: [],
    remove: [],
  });
  assert.deepEqual(planLabelChanges(["accepted", "size:S"], desired), {
    add: ["plusplus-only", "seam"],
    remove: [],
  });
});

test("every managed label is a derivable advisory label", () => {
  assert.deepEqual(MANAGED_LABELS, [
    "plusplus-only",
    "upstream-candidate",
    "seam",
    "sync-conflict",
  ]);
  assert.deepEqual(
    labelsOf(["apps/desktop/src/main.ts"]).filter((l) => MANAGED_LABELS.includes(l)),
    ["seam", "sync-conflict"],
  );
});
