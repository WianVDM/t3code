// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  checkForkBoundaries,
  classifyPath,
  collectChanges,
  designationFromEnv,
  isDesignatedSyncPr,
  isViolation,
  parseArguments,
  parseNameStatusZ,
  renderReport,
  seamAnchorProblems,
  summarizeRegistryChanges,
  touchedPaths,
  type BoundaryFinding,
  type BoundaryRun,
  type CheckOptions,
  type PathFacts,
} from "./check-fork-boundaries.ts";
import {
  SEAM_REGISTRY_PATH,
  fingerprintOf,
  locateRegion,
  serializeRegistry,
  type RegistryFile,
  type Seam,
  type SeamAnchor,
  type SeamRegistry,
  type Sibling,
} from "./seamRegistry.ts";

const WRONG_FINGERPRINT = "sha256:0000000000000000";
const UPSTREAM_REF = "a".repeat(40);

const UPSTREAM_APP = "export function App() {\n  const first = 1;\n  return first;\n}\n";
const FORK_APP = UPSTREAM_APP.replace("const first = 1;", "const first = 1;\n  const hook = true;");
const UPSTREAM_MAIN = "export const main = 1;\nconst shared = 1;\nconst shared2 = 2;\n";
const MAIN_ANCHOR: SeamAnchor = { text: "export const main" };

const fingerprintAt = (path: string, text: string, anchor: SeamAnchor): string => {
  const lookup = locateRegion(path, text, anchor);
  assert.strictEqual(lookup._tag, "Found");
  return fingerprintOf(lookup._tag === "Found" ? lookup.text : "");
};

const seam = (id: string, anchor: SeamAnchor, fingerprint: string): Seam => ({
  id: `demo.${id}`,
  feature: "demo",
  mechanism: "hook",
  anchor,
  fingerprint,
});

const registryOf = (
  files: Record<string, RegistryFile>,
  siblings: ReadonlyArray<Sibling> = [],
  upstreamRef = UPSTREAM_REF,
): SeamRegistry => ({
  version: 1,
  upstreamRef,
  features: { demo: { title: "Demo" } },
  files,
  siblings,
});

const legacy = (added: number, removed: number): RegistryFile => ({
  delta: [added, removed],
  legacy: true,
});

const appEntry: RegistryFile = {
  delta: [1, 0],
  seams: [
    seam("hook", { symbol: "App" }, fingerprintAt("App.tsx", UPSTREAM_APP, { symbol: "App" })),
  ],
};

const verdictsByPath = (findings: ReadonlyArray<BoundaryFinding>) => {
  const grouped: Record<string, Array<string>> = {};
  for (const finding of findings) (grouped[finding.path] ??= []).push(finding.verdict);
  return grouped;
};

const baseFacts: PathFacts = {
  path: "apps/server/src/main.ts",
  change: "M",
  upstreamOwned: true,
  entry: undefined,
  delta: undefined,
  anchorProblems: [],
};

describe("classifyPath", () => {
  const rows: ReadonlyArray<readonly [string, Partial<PathFacts>, ReadonlyArray<string>]> = [
    ["a ++-owned path is allowed", { upstreamOwned: false }, ["ALLOW_OWNED"]],
    ["a ++-owned deletion is allowed", { upstreamOwned: false, change: "D" }, ["ALLOW_OWNED"]],
    ["a delta with no entry is unregistered", { delta: [1, 1] }, ["UNREGISTERED"]],
    ["an entry with no delta is stale", { entry: legacy(1, 1) }, ["STALE_ENTRY"]],
    ["a ++-owned key is stale", { upstreamOwned: false, entry: legacy(1, 1) }, ["STALE_ENTRY"]],
    ["a restored file with no entry is upstream-equal", {}, ["ALLOW_UPSTREAM_EQUAL"]],
    ["added over the recorded budget", { entry: legacy(4, 1), delta: [5, 1] }, ["DELTA_EXCEEDED"]],
    [
      "removed over the recorded budget",
      { entry: legacy(4, 1), delta: [4, 2] },
      ["DELTA_EXCEEDED"],
    ],
    ["equal to the budget", { entry: legacy(4, 1), delta: [4, 1] }, ["ALLOW_REGISTERED"]],
    ["below the budget", { entry: legacy(4, 1), delta: [2, 0] }, ["ALLOW_REGISTERED"]],
    [
      "a deleted upstream path",
      { change: "D", entry: legacy(0, 3), delta: [0, 3] },
      ["UPSTREAM_DELETED"],
    ],
    [
      "a deleted, unregistered upstream path collects both failures",
      { change: "D", delta: [0, 3] },
      ["UPSTREAM_DELETED", "UNREGISTERED"],
    ],
    [
      "a broken anchor on a registered path",
      { entry: legacy(1, 1), delta: [1, 1], anchorProblems: ["demo.hook: anchor is missing"] },
      ["ANCHOR_BROKEN"],
    ],
    [
      "an exceeded delta and a broken anchor collect both",
      { entry: legacy(1, 1), delta: [2, 1], anchorProblems: ["demo.hook: anchor is missing"] },
      ["DELTA_EXCEEDED", "ANCHOR_BROKEN"],
    ],
  ];
  it.each(rows)("%s", (_name, facts, expected) => {
    const findings = classifyPath({ ...baseFacts, ...facts });
    assert.deepStrictEqual(
      findings.map((finding) => finding.verdict),
      expected,
    );
  });

  it("shows actual against recorded for an exceeded delta", () => {
    const [finding] = classifyPath({ ...baseFacts, entry: legacy(4, 1), delta: [5, 1] });
    assert.include(finding?.detail, "+5 -1");
    assert.include(finding?.detail, "+4 -1");
  });
});

describe("seamAnchorProblems", () => {
  const fingerprint = fingerprintAt("main.ts", UPSTREAM_MAIN, MAIN_ANCHOR);

  it("passes a resolved anchor with the upstream fingerprint", () => {
    assert.deepStrictEqual(
      seamAnchorProblems("main.ts", UPSTREAM_MAIN, [seam("ok", MAIN_ANCHOR, fingerprint)]),
      [],
    );
  });

  it("reports a wrong fingerprint, a missing anchor, an ambiguous anchor, and an absent file", () => {
    const seams = [
      seam("stale", MAIN_ANCHOR, WRONG_FINGERPRINT),
      seam("missing", { text: "nowhere" }, fingerprint),
      seam("ambiguous", { text: "const shared" }, fingerprint),
    ];
    const problems = seamAnchorProblems("main.ts", UPSTREAM_MAIN, seams);
    assert.strictEqual(problems.length, 3);
    assert.include(problems[0], "does not match upstream");
    assert.include(problems[1], "anchor is missing");
    assert.include(problems[2], "anchor is ambiguous");
    assert.deepStrictEqual(
      seamAnchorProblems("main.ts", undefined, seams).map((problem) =>
        problem.includes("absent at the upstream ref"),
      ),
      [true, true, true],
    );
  });
});

describe("summarizeRegistryChanges", () => {
  const sibling: Sibling = {
    feature: "demo",
    upstream: "docs/guide.md",
    plusplus: "docs/fork.md",
    fingerprint: WRONG_FINGERPRINT,
  };
  const twoSeams: RegistryFile = {
    delta: [2, 0],
    seams: [
      seam("one", MAIN_ANCHOR, WRONG_FINGERPRINT),
      seam("two", MAIN_ANCHOR, WRONG_FINGERPRINT),
    ],
  };
  const oneSeam: RegistryFile = {
    delta: [2, 0],
    seams: [seam("one", MAIN_ANCHOR, WRONG_FINGERPRINT)],
  };

  it("lists added entries, raises per component, new seam ids and new siblings", () => {
    const base = registryOf({
      "a.ts": legacy(1, 1),
      "b.ts": legacy(1, 1),
      "c.ts": legacy(1, 1),
      "d.ts": oneSeam,
    });
    const head = registryOf(
      {
        "a.ts": legacy(2, 1),
        "b.ts": legacy(1, 2),
        "c.ts": legacy(1, 1),
        "d.ts": twoSeams,
        "e.ts": legacy(3, 0),
      },
      [sibling],
    );
    assert.deepStrictEqual(
      summarizeRegistryChanges(base, head).map(({ path, kind, detail }) => [path, kind, detail]),
      [
        ["a.ts", "raised", "+1 -1 -> +2 -1"],
        ["b.ts", "raised", "+1 -1 -> +1 -2"],
        ["d.ts", "new seam", "demo.two (hook)"],
        ["docs/guide.md", "new sibling", "docs/fork.md (demo)"],
        ["e.ts", "added", "legacy, delta +3 -0"],
      ],
    );
  });

  it("lists every seam of an added entry and omits unchanged or lowered entries", () => {
    const base = registryOf({ "a.ts": legacy(5, 5), "b.ts": legacy(2, 2) });
    const head = registryOf({ "a.ts": legacy(1, 1), "b.ts": legacy(2, 2), "d.ts": twoSeams });
    assert.deepStrictEqual(
      summarizeRegistryChanges(base, head).map(({ path, kind }) => `${path} ${kind}`),
      ["d.ts added", "d.ts new seam", "d.ts new seam"],
    );
  });
});

describe("touchedPaths", () => {
  it("adds paths whose registry entry was added, removed or edited, but not untouched ones", () => {
    const base = registryOf({ "a.ts": legacy(1, 1), "b.ts": legacy(1, 1), "c.ts": legacy(1, 1) });
    const head = registryOf({ "a.ts": legacy(2, 1), "c.ts": legacy(1, 1), "d.ts": legacy(1, 1) });
    const touched = touchedPaths([{ status: "M", path: "docs/x.md" }], base, head);
    assert.deepStrictEqual(
      [...touched.entries()],
      [
        ["docs/x.md", "M"],
        ["a.ts", undefined],
        ["b.ts", undefined],
        ["d.ts", undefined],
      ],
    );
  });
});

describe("isDesignatedSyncPr", () => {
  const rows: ReadonlyArray<
    readonly [string, string | undefined, string | undefined, string | undefined, boolean]
  > = [
    ["verified designation with a passing merge validation", "true", "false", "success", true],
    ["an invalid designation", "true", "true", "success", false],
    ["a failed merge validation", "true", "false", "failure", false],
    ["a skipped merge validation", "true", "false", "skipped", false],
    ["a cancelled merge validation", "true", "false", "cancelled", false],
    ["no sync claim", "false", "false", "success", false],
    ["empty strings", "", "", "", false],
    ["unset variables", undefined, undefined, undefined, false],
  ];
  it.each(rows)("%s", (_name, upstreamSync, designationError, syncMerge, expected) => {
    assert.strictEqual(isDesignatedSyncPr({ upstreamSync, designationError, syncMerge }), expected);
  });

  it("reads only the three designation variables from the environment", () => {
    assert.deepStrictEqual(
      designationFromEnv({
        UPSTREAM_SYNC: "true",
        SYNC_DESIGNATION_ERROR: "false",
        SYNC_MERGE_RESULT: "success",
        GITHUB_EVENT_PATH: "/event.json",
      }),
      { upstreamSync: "true", designationError: "false", syncMerge: "success" },
    );
  });
});

describe("parseArguments", () => {
  it("defaults the base ref and reads --head and --summary", () => {
    assert.deepStrictEqual(parseArguments([]), {
      baseRef: "origin/main",
      headSha: undefined,
      summaryPath: undefined,
    });
    assert.deepStrictEqual(parseArguments(["abc", "--head", "def", "--summary", "out.md"]), {
      baseRef: "abc",
      headSha: "def",
      summaryPath: "out.md",
    });
  });

  it("rejects unknown flags, extra positionals and flags without a value", () => {
    assert.throws(() => parseArguments(["--bogus"]), /unexpected argument --bogus/);
    assert.throws(() => parseArguments(["a", "b"]), /unexpected argument b/);
    assert.throws(() => parseArguments(["--head"]), /--head needs a value/);
  });
});

const NAME_STATUS_FIXTURE = [
  "A\0docs/fork.md",
  "D\0scripts/old.ts",
  "M\0apps/web/src/main.tsx",
  "R057\0meta/app.xml\0meta/fork-app.xml",
].join("\0");

describe("parseNameStatusZ", () => {
  it("parses NUL-separated records including renames", () => {
    assert.deepStrictEqual(parseNameStatusZ(`${NAME_STATUS_FIXTURE}\0`), [
      { status: "A", path: "docs/fork.md" },
      { status: "D", path: "scripts/old.ts" },
      { status: "M", path: "apps/web/src/main.tsx" },
      { status: "R", path: "meta/fork-app.xml", upstreamPath: "meta/app.xml" },
    ]);
  });

  it("rejects typechange and copy statuses instead of skipping them", () => {
    assert.throws(
      () => parseNameStatusZ("T\0scripts/tool.sh\0"),
      /unsupported git name-status "T"/,
    );
    assert.throws(
      () => parseNameStatusZ("C075\0meta/app.xml\0meta/fork-app.xml\0"),
      /unsupported git name-status "C075"/,
    );
  });

  it("rejects an unknown status rather than misreading the tokens that follow it", () => {
    assert.throws(
      () => parseNameStatusZ("A\0docs/fork.md\0T\0Makefile\0A\0other.md\0"),
      /unsupported git name-status "T"/,
    );
  });
});

describe("collectChanges", () => {
  it("flattens renames and dedupes by path", () => {
    const changes = collectChanges(
      ["R090\0old/name.ts\0new/name.ts", "M\0docs/fork.md", "D\0gone.ts", "A\0docs/fork.md"].join(
        "\0",
      ),
    );
    assert.deepStrictEqual(changes, [
      { status: "D", path: "old/name.ts" },
      { status: "A", path: "new/name.ts" },
      { status: "M", path: "docs/fork.md" },
      { status: "D", path: "gone.ts" },
    ]);
  });
});

describe("renderReport", () => {
  const run: BoundaryRun = {
    base: "a".repeat(40),
    head: "working tree",
    forkPoint: "b".repeat(40),
    upstreamRef: "c".repeat(40),
    mode: "checked",
    registryChanges: [{ path: "x`y.ts", kind: "raised", detail: "+1 -0 -> +2 -0" }],
    findings: [
      { path: "evil`|\npath.ts", verdict: "UNREGISTERED", detail: "no entry | `x`" },
      { path: "docs/fork.md", verdict: "ALLOW_OWNED", detail: "owned" },
    ],
  };

  it("lists header, registry changes, violations and allowed paths", () => {
    const report = renderReport(run);
    assert.include(report, `base \`${"a".repeat(40)}\``);
    assert.include(report, "mode: checked");
    assert.include(report, "### Registry entries this PR adds or raises (1)");
    assert.include(report, "### Violations (1)");
    assert.include(report, "### Allowed (1)");
    assert.include(report, "<details>");
  });

  it("keeps backticks, pipes and newlines out of table cells", () => {
    const row = renderReport(run)
      .split("\n")
      .find((line) => line.startsWith("| UNREGISTERED"));
    assert.strictEqual(row, "| UNREGISTERED | `evil   path.ts` | `no entry    x ` |");
  });

  it("marks an exempt run and skips the registry summary", () => {
    const report = renderReport({ ...run, mode: "exempt", registryChanges: [], findings: [] });
    assert.include(report, "exempt (designated upstream-sync PR #50)");
    assert.include(report, "(skipped for a designated sync PR)");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files. Git on Windows cannot
// open os.devNull as a config path, so isolation uses a real empty file.
const emptyGitConfig = NodePath.join(
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-env-"))),
  "empty-git-config",
);
NodeFS.writeFileSync(emptyGitConfig, "");
const fixtureConfig = {
  "core.excludesFile": emptyGitConfig,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// An upstream commit, then a fork base on top of it that edits one upstream file
// (a registered seam), deletes another, adds a ++ file, and carries the registry
// that names the upstream commit.
function boundaryFixture(registryOverride?: string) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-boundaries-")),
  );
  const write = (file: string, content: string) => {
    const target = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  };
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
  const commitAll = (message: string) => {
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    write("apps/web/src/App.tsx", UPSTREAM_APP);
    write("apps/server/src/main.ts", UPSTREAM_MAIN);
    write("meta/app.xml", "<app/>\n");
    write("scripts/old.ts", "export const old = 1;\n");
    write("docs/guide.md", "# guide\n");
    git("init");
    const upstreamRef = commitAll("upstream");

    git("rm", "-f", "--quiet", "scripts/old.ts");
    write("apps/web/src/App.tsx", FORK_APP);
    write("docs/fork.md", "# fork\n");
    if (registryOverride !== "") {
      write(
        SEAM_REGISTRY_PATH,
        registryOverride ??
          serializeRegistry(
            registryOf(
              { "apps/web/src/App.tsx": appEntry, "scripts/old.ts": legacy(0, 1) },
              [],
              upstreamRef,
            ),
          ),
      );
    }
    commitAll("fork base");
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    write,
    git,
    base: git("rev-parse", "HEAD"),
    upstreamRef: git("rev-parse", "HEAD~1"),
    commit: commitAll,
    // Rewrites the working-tree registry: `files` entries replace or add keys,
    // a null drops one.
    writeRegistry(
      files: Record<string, RegistryFile | null>,
      options: { siblings?: ReadonlyArray<Sibling>; upstreamRef?: string } = {},
    ) {
      const current = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, SEAM_REGISTRY_PATH), "utf8"),
      ) as SeamRegistry;
      const merged = { ...current.files };
      for (const [path, entry] of Object.entries(files)) {
        if (entry === null) delete merged[path];
        else merged[path] = entry;
      }
      write(
        SEAM_REGISTRY_PATH,
        serializeRegistry({
          ...current,
          upstreamRef: options.upstreamRef ?? current.upstreamRef,
          files: merged,
          siblings: options.siblings ?? current.siblings,
        }),
      );
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const runCheck = (root: string, baseRef: string, overrides: Partial<CheckOptions> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* checkForkBoundaries(root, {
      baseRef,
      headSha: undefined,
      exempt: false,
      ...overrides,
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

// Wall-clock it.live: these run real git subprocesses. The fixture is an
// Effect resource so it disposes even when an assertion fails.
const withFixture = (registryOverride?: string) =>
  Effect.acquireDisposable(Effect.sync(() => boundaryFixture(registryOverride)));

const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    ),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const runOk = (root: string, baseRef: string, overrides: Partial<CheckOptions> = {}) =>
  Effect.gen(function* () {
    const result = yield* runCheck(root, baseRef, overrides);
    assert.isFalse(result.findings.some(isViolation), renderReport(result));
    return result;
  });

const runFail = (root: string, baseRef: string) => runCheck(root, baseRef).pipe(Effect.flip);

const EDITED_MAIN = UPSTREAM_MAIN.replace("main = 1", "main = 2");

describe("checkForkBoundaries", () => {
  it.live("allows owned CRUD, registered edits within budget and untracked owned files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("docs/fork.md", "# fork v2\n");
        project.write("packages/plusplus/new.ts", "export const n = 1;\n");
        const checked = yield* runOk(project.root, project.base);
        assert.strictEqual(checked.base, project.base);
        assert.strictEqual(checked.forkPoint, project.base);
        assert.strictEqual(checked.upstreamRef, project.upstreamRef);
        assert.deepStrictEqual(verdictsByPath(checked.findings), {
          "docs/fork.md": ["ALLOW_OWNED"],
          "packages/plusplus/new.ts": ["ALLOW_OWNED"],
        });
        project.git("rm", "-f", "--quiet", "docs/fork.md");
        const deleted = yield* runOk(project.root, project.base);
        assert.strictEqual(
          deleted.findings.find((finding) => finding.path === "docs/fork.md")?.verdict,
          "ALLOW_OWNED",
        );
      }),
    ),
  );

  it.live("check 1: an upstream edit needs a registry entry, read from the head registry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("apps/server/src/main.ts", EDITED_MAIN);
        const unregistered = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(unregistered.findings), {
          "apps/server/src/main.ts": ["UNREGISTERED"],
        });

        // The PR carries the entry in its own registry and the edit passes.
        project.writeRegistry({ "apps/server/src/main.ts": legacy(1, 1) });
        const registered = yield* runOk(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(registered.findings), {
          "apps/server/src/main.ts": ["ALLOW_REGISTERED"],
          [SEAM_REGISTRY_PATH]: ["ALLOW_OWNED"],
        });
        assert.deepStrictEqual(registered.registryChanges, [
          { path: "apps/server/src/main.ts", kind: "added", detail: "legacy, delta +1 -1" },
        ]);
      }),
    ),
  );

  it.live("check 1: a restored upstream file must lose its entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("apps/web/src/App.tsx", UPSTREAM_APP);
        const stale = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(stale.findings), {
          "apps/web/src/App.tsx": ["STALE_ENTRY"],
        });
        project.writeRegistry({ "apps/web/src/App.tsx": null });
        const removed = yield* runOk(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(removed.findings), {
          "apps/web/src/App.tsx": ["ALLOW_UPSTREAM_EQUAL"],
          [SEAM_REGISTRY_PATH]: ["ALLOW_OWNED"],
        });
      }),
    ),
  );

  it.live("check 2 and 5: growth beyond the recorded delta fails until the head raises it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write(
          "apps/web/src/App.tsx",
          FORK_APP.replace("return first;", "return first;\n  // x"),
        );
        const exceeded = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(exceeded.findings), {
          "apps/web/src/App.tsx": ["DELTA_EXCEEDED"],
        });
        assert.include(exceeded.findings[0]?.detail, "+2 -0");

        project.writeRegistry({ "apps/web/src/App.tsx": { ...appEntry, delta: [2, 0] } });
        const raised = yield* runOk(project.root, project.base);
        assert.deepStrictEqual(raised.registryChanges, [
          { path: "apps/web/src/App.tsx", kind: "raised", detail: "+1 -0 -> +2 -0" },
        ]);
      }),
    ),
  );

  it.live("check 3: deleting or renaming an upstream file fails, deleting a ++ file does not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.git("rm", "-f", "--quiet", "apps/server/src/main.ts", "docs/fork.md");
        const deleted = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(deleted.findings), {
          "apps/server/src/main.ts": ["UPSTREAM_DELETED", "UNREGISTERED"],
          "docs/fork.md": ["ALLOW_OWNED"],
        });

        project.git("reset", "--hard", "--quiet", "HEAD");
        project.git("mv", "apps/server/src/main.ts", "apps/server/src/moved.ts");
        const renamed = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(renamed.findings), {
          "apps/server/src/main.ts": ["UPSTREAM_DELETED", "UNREGISTERED"],
          "apps/server/src/moved.ts": ["ALLOW_OWNED"],
        });
      }),
    ),
  );

  it.live("check 4: touched entries must anchor at upstreamRef with the upstream fingerprint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("apps/server/src/main.ts", EDITED_MAIN);
        project.writeRegistry({
          "apps/server/src/main.ts": {
            delta: [1, 1],
            seams: [
              seam("stale", MAIN_ANCHOR, WRONG_FINGERPRINT),
              seam("missing", { text: "nowhere" }, WRONG_FINGERPRINT),
              seam("ambiguous", { text: "const shared" }, WRONG_FINGERPRINT),
            ],
          },
        });
        const broken = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(broken.findings)["apps/server/src/main.ts"], [
          "ANCHOR_BROKEN",
          "ANCHOR_BROKEN",
          "ANCHOR_BROKEN",
        ]);

        const fingerprint = fingerprintAt("main.ts", UPSTREAM_MAIN, MAIN_ANCHOR);
        project.writeRegistry({
          "apps/server/src/main.ts": {
            delta: [1, 1],
            seams: [seam("stale", MAIN_ANCHOR, fingerprint)],
          },
        });
        yield* runOk(project.root, project.base);

        // A head-authored fingerprint that does not match upstream never passes.
        const sibling: Sibling = {
          feature: "demo",
          upstream: "docs/guide.md",
          plusplus: "docs/fork.md",
          fingerprint: WRONG_FINGERPRINT,
        };
        project.writeRegistry({}, { siblings: [sibling] });
        const badSibling = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(badSibling.findings)["docs/guide.md"], [
          "ANCHOR_BROKEN",
        ]);
        project.writeRegistry(
          {},
          { siblings: [{ ...sibling, fingerprint: fingerprintOf("# guide\n") }] },
        );
        const goodSibling = yield* runOk(project.root, project.base);
        assert.isTrue(goodSibling.registryChanges.some(({ kind }) => kind === "new sibling"));
      }),
    ),
  );

  it.live("check 4: an untouched entry with a stale fingerprint is not evaluated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.writeRegistry({
          "apps/web/src/App.tsx": {
            ...appEntry,
            seams: [seam("hook", { symbol: "App" }, WRONG_FINGERPRINT)],
          },
        });
        const staleBase = project.commit("stale fingerprint in the base registry");
        project.write("docs/fork.md", "# fork v2\n");
        const checked = yield* runOk(project.root, staleBase);
        assert.deepStrictEqual(verdictsByPath(checked.findings), {
          "docs/fork.md": ["ALLOW_OWNED"],
        });
      }),
    ),
  );

  it.live("check 0: a head registry that moves upstreamRef is rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.writeRegistry({}, { upstreamRef: project.base });
        const moved = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(moved.findings), {
          [SEAM_REGISTRY_PATH]: ["UPSTREAM_REF_MOVED"],
        });
      }),
    ),
  );

  it.live("fails closed on a missing or invalid head registry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write(SEAM_REGISTRY_PATH, "{oops");
        const invalid = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(invalid.findings), {
          [SEAM_REGISTRY_PATH]: ["REGISTRY_INVALID"],
        });
        project.git("rm", "-f", "--quiet", SEAM_REGISTRY_PATH);
        const missing = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(missing.findings), {
          [SEAM_REGISTRY_PATH]: ["REGISTRY_INVALID"],
        });
      }),
    ),
  );

  it.live("exempts only a designated sync run, which keeps the whole-registry check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        // A consistent registry that deletes an upstream file: check 3 would fail it.
        project.git("rm", "-f", "--quiet", "apps/server/src/main.ts");
        project.writeRegistry({ "apps/server/src/main.ts": legacy(0, 3) });
        const checked = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(checked.findings)["apps/server/src/main.ts"], [
          "UPSTREAM_DELETED",
        ]);
        const exempt = yield* runCheck(project.root, project.base, { exempt: true });
        assert.strictEqual(exempt.mode, "exempt");
        assert.deepStrictEqual(exempt.findings, []);

        // An unregistered edit fails as an inconsistent registry, not as check 1.
        project.git("reset", "--hard", "--quiet", "HEAD");
        project.write("apps/server/src/main.ts", EDITED_MAIN);
        const inconsistent = yield* runCheck(project.root, project.base, { exempt: true });
        assert.deepStrictEqual(verdictsByPath(inconsistent.findings), {
          [SEAM_REGISTRY_PATH]: ["SYNC_REGISTRY_INCONSISTENT"],
        });
        assert.include(inconsistent.findings[0]?.detail, "apps/server/src/main.ts");
      }),
    ),
  );

  it.live("ignores an upstream-sync label, title and branch in the event payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        const payload = NodePath.join(
          project.root,
          "..",
          `event-${NodePath.basename(project.root)}.json`,
        );
        NodeFS.writeFileSync(
          payload,
          JSON.stringify({
            pull_request: {
              title: "upstream-sync",
              labels: [{ name: "upstream-sync" }],
              head: { ref: "sync/upstream-v9.9.9" },
            },
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(payload, { force: true })),
        );
        const designation = designationFromEnv({
          GITHUB_EVENT_PATH: payload,
          UPSTREAM_SYNC: "true",
          SYNC_DESIGNATION_ERROR: "true",
        });
        assert.isFalse(isDesignatedSyncPr(designation));
        project.write("apps/server/src/main.ts", EDITED_MAIN);
        const checked = yield* runCheck(project.root, project.base, {
          exempt: isDesignatedSyncPr(designation),
        });
        assert.deepStrictEqual(verdictsByPath(checked.findings), {
          "apps/server/src/main.ts": ["UNREGISTERED"],
        });
      }),
    ),
  );

  it.live("with --head, judges the commit and ignores a dirty working tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("docs/fork.md", "# fork v2\n");
        const headSha = project.commit("head: owned edit");
        project.write("apps/server/src/main.ts", EDITED_MAIN);
        const pinned = yield* runOk(project.root, project.base, { headSha });
        assert.strictEqual(pinned.head, headSha);
        assert.deepStrictEqual(verdictsByPath(pinned.findings), {
          "docs/fork.md": ["ALLOW_OWNED"],
        });
        const dirty = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(dirty.findings), {
          "apps/server/src/main.ts": ["UNREGISTERED"],
          "docs/fork.md": ["ALLOW_OWNED"],
        });
        const badHead = yield* runCheck(project.root, project.base, { headSha: "abc123" }).pipe(
          Effect.flip,
        );
        assert.include(badHead, "--head must be a full 40-hex commit sha");
      }),
    ),
  );

  it.live("diffs a stacked branch against its immediate parent only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("apps/server/src/main.ts", EDITED_MAIN);
        const middle = project.commit("middle: unregistered edit");
        project.write("docs/fork.md", "# fork v2\n");
        project.commit("head: owned edit");
        const againstMiddle = yield* runOk(project.root, middle);
        assert.strictEqual(againstMiddle.forkPoint, middle);
        assert.deepStrictEqual(verdictsByPath(againstMiddle.findings), {
          "docs/fork.md": ["ALLOW_OWNED"],
        });
        const againstBase = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdictsByPath(againstBase.findings), {
          "apps/server/src/main.ts": ["UNREGISTERED"],
          "docs/fork.md": ["ALLOW_OWNED"],
        });
      }),
    ),
  );

  it.live(
    "fails closed on a missing, malformed, or invalid base registry and unresolvable refs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const missing = yield* withFixture("");
          const missingError = yield* runFail(missing.root, missing.base);
          assert.isTrue(missingError.includes("cannot read the trusted policy"), missingError);

          const malformed = yield* withFixture("{oops");
          const malformedError = yield* runFail(malformed.root, malformed.base);
          assert.isTrue(malformedError.includes("is not valid"), malformedError);

          const unsorted = registryOf({
            "meta/app.xml": legacy(1, 1),
            "apps/web/src/App.tsx": legacy(3, 0),
          });
          const invalid = yield* withFixture(JSON.stringify(unsorted));
          const invalidError = yield* runFail(invalid.root, invalid.base);
          assert.isTrue(
            invalidError.includes("files keys must be unique and sorted"),
            invalidError,
          );

          const unknownUpstream = yield* withFixture(
            JSON.stringify(registryOf({}, [], "0".repeat(40))),
          );
          const upstreamError = yield* runFail(unknownUpstream.root, unknownUpstream.base);
          assert.isTrue(upstreamError.includes("cannot list the tree of"), upstreamError);

          const project = yield* withFixture();
          const refError = yield* runFail(project.root, "no-such-ref");
          assert.isTrue(refError.includes("cannot resolve base ref no-such-ref"), refError);

          const empty = yield* tempDir("t3-not-a-repo-");
          const repoError = yield* runFail(empty, "HEAD");
          assert.isTrue(repoError.includes("cannot resolve base ref HEAD"), repoError);
        }),
      ),
  );
});
