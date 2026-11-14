const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANAGED_LABELS,
  buildOwnership,
  classifyPath,
  classifyPaths,
  deriveAdvisoryLabels,
  planLabelChanges,
} = require("./pr-ownership-label.cjs");

// Injected ownership: three upstream paths, two of them registered.
const registry = {
  files: {
    "apps/server/src/provider/ClaudeProvider.ts": {
      delta: [10, 2],
      seams: [
        { id: "context-bridge.a", feature: "context-bridge" },
        { id: "context-bridge.b", feature: "context-bridge" },
        { id: "usage-vendor-icons.a", feature: "usage-vendor-icons" },
      ],
    },
    "apps/server/src/terminal/Manager.test.ts": { delta: [155, 1], legacy: true },
    "scripts/removed-upstream.ts": { delta: [0, 20], legacy: true },
  },
};
const upstreamPaths = [
  "apps/server/src/provider/ClaudeProvider.ts",
  "apps/server/src/terminal/Manager.test.ts",
  "apps/server/src/ws.ts",
  "apps/web/src/App.tsx",
  "scripts/removed-upstream.ts",
];
const ownership = buildOwnership(registry, upstreamPaths);

const labelsOf = (paths) => [...deriveAdvisoryLabels(classifyPaths(paths, ownership))].sort();

test("a path absent at upstreamRef is ++-owned", () => {
  assert.deepEqual(classifyPath("plusplus/ARCHITECTURE.md", ownership), {
    path: "plusplus/ARCHITECTURE.md",
    category: "fork",
    features: [],
  });
  assert.equal(classifyPath(".github/workflows/plusplus-ci.yml", ownership).category, "fork");
});

test("a registry entry is a seam, with the features of its anchored seams", () => {
  assert.deepEqual(classifyPath("apps/server/src/provider/ClaudeProvider.ts", ownership), {
    path: "apps/server/src/provider/ClaudeProvider.ts",
    category: "seam",
    features: ["context-bridge", "usage-vendor-icons"],
  });
  assert.deepEqual(
    classifyPath("apps/server/src/terminal/Manager.test.ts", ownership).features,
    [],
  );
});

test("an upstream path deleted by the fork stays a seam", () => {
  assert.equal(classifyPath("scripts/removed-upstream.ts", ownership).category, "seam");
});

test("an unregistered upstream path is shared", () => {
  assert.equal(classifyPath("apps/server/src/ws.ts", ownership).category, "shared");
});

test("++-only paths get plusplus-only", () => {
  assert.deepEqual(labelsOf(["plusplus/seams.json", "packages/plusplus/src/index.ts"]), [
    "plusplus-only",
  ]);
});

test("a registry-entry path gets seam and sync-conflict", () => {
  assert.deepEqual(labelsOf(["apps/server/src/provider/ClaudeProvider.ts"]), [
    "seam",
    "sync-conflict",
  ]);
  assert.deepEqual(labelsOf(["apps/server/src/terminal/Manager.test.ts", "plusplus/seams.json"]), [
    "seam",
    "sync-conflict",
  ]);
});

test("unregistered upstream paths get upstream-candidate", () => {
  assert.deepEqual(labelsOf(["apps/server/src/ws.ts", "apps/web/src/App.tsx"]), [
    "upstream-candidate",
  ]);
});

test("mixed ++-owned and shared changes get no exclusivity label", () => {
  assert.deepEqual(labelsOf(["plusplus/seams.json", "apps/server/src/ws.ts"]), []);
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
  const derivable = new Set([
    ...labelsOf(["plusplus/seams.json"]),
    ...labelsOf(["apps/server/src/ws.ts"]),
    ...labelsOf(["apps/server/src/provider/ClaudeProvider.ts"]),
  ]);
  assert.deepEqual([...derivable].sort(), [...MANAGED_LABELS].sort());
});
