// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  checkForkBoundaries,
  classifyChanges,
  collectChanges,
  isViolation,
  renderReport,
  seamAnalysisPaths,
  thinSeamViolation,
  type BoundaryChange,
  type BoundaryFinding,
} from "./check-fork-boundaries.ts";
import { FORK_INVENTORY_PATH, ForkInventory, validateForkInventory } from "./forkInventory.ts";

const decodeInventory = Schema.decodeUnknownSync(ForkInventory, { onExcessProperty: "error" });

const TEST_POLICY = {
  version: 1,
  issue: "https://github.com/WianVDM/t3code/issues/39",
  baseline: {
    forkRef: "f".repeat(40),
    upstreamRef: "a".repeat(40),
    mergeBase: "b".repeat(40),
    counts: {
      total: 4,
      plusplusOwned: 1,
      upstreamOwned: 1,
      integrationSeam: 2,
      sharedModified: 1,
      renamed: 1,
    },
  },
  plusplusOwnedRoots: ["packages/plusplus"],
  boundaryInfrastructure: ["scripts/check-changed.ts"],
  conflictHistory: [],
  exceptions: [],
  entries: [
    { id: "OWN-001", category: "plusplus-owned", change: "added", path: "docs/fork.md" },
    { id: "DEL-001", category: "upstream-owned", change: "deleted", path: "scripts/old.ts" },
    {
      id: "SEAM-001",
      category: "integration-seam",
      change: "modified",
      path: "apps/web/src/App.tsx",
    },
    {
      id: "SEAM-002",
      category: "integration-seam",
      change: "renamed",
      path: "meta/fork-app.xml",
      upstreamPath: "meta/app.xml",
    },
  ],
} as const;

const inventory = decodeInventory(TEST_POLICY);

// A seam edit is thin when everything but imports and typed mounts matches;
// the stub keeps classify tests independent of the AST analysis below.
const analyze = () => undefined;

const classify = (changes: ReadonlyArray<BoundaryChange>) =>
  classifyChanges(inventory, changes, analyze);

const verdicts = (findings: ReadonlyArray<BoundaryFinding>) =>
  Object.fromEntries(findings.map((finding) => [finding.path, finding.verdict]));

describe("classifyChanges", () => {
  it("accepts a valid fixture policy", () => {
    assert.deepStrictEqual(validateForkInventory(inventory), []);
  });

  it("allows CRUD on own entries and owned roots, including deletions", () => {
    const findings = classify([
      { status: "M", path: "docs/fork.md" },
      { status: "D", path: "docs/fork.md" },
      { status: "A", path: "packages/plusplus/new/file.ts" },
    ]);
    assert.deepStrictEqual(verdicts(findings), {
      "docs/fork.md": "ALLOW_OWNED",
      "packages/plusplus/new/file.ts": "ALLOW_OWNED",
    });
    assert.isFalse(findings.some(isViolation));
    assert.strictEqual(
      findings.find((finding) => finding.path === "docs/fork.md")?.entry,
      "OWN-001",
    );
  });

  it("flags the policy file itself as POLICY_CHANGED whatever the status", () => {
    const findings = classify([{ status: "M", path: FORK_INVENTORY_PATH }]);
    assert.strictEqual(findings[0]?.verdict, "POLICY_CHANGED");
    assert.isTrue(findings.every(isViolation));
  });

  it("allows boundaryInfrastructure paths with any change kind", () => {
    const findings = classify([
      { status: "M", path: "scripts/check-changed.ts" },
      { status: "A", path: "scripts/check-changed.ts" },
    ]);
    assert.deepStrictEqual(
      findings.map((finding) => finding.verdict),
      ["ALLOW_INFRASTRUCTURE", "ALLOW_INFRASTRUCTURE"],
    );
  });

  it("routes seam TS files through the thin analysis and fails every other seam edit", () => {
    const findings = classify([
      { status: "M", path: "apps/web/src/App.tsx" },
      { status: "M", path: "meta/fork-app.xml" },
    ]);
    assert.deepStrictEqual(verdicts(findings), {
      "apps/web/src/App.tsx": "ALLOW_THIN_SEAM",
      "meta/fork-app.xml": "SEAM_NON_TS",
    });
    assert.strictEqual(
      findings.find((finding) => finding.path === "apps/web/src/App.tsx")?.entry,
      "SEAM-001",
    );
    const deleted = classify([{ status: "D", path: "apps/web/src/App.tsx" }]);
    assert.strictEqual(deleted[0]?.verdict, "SEAM_DELETED");
  });

  it("reports a non-thin seam edit with the analyzer's reason", () => {
    const thick = classifyChanges(
      inventory,
      [{ status: "M", path: "apps/web/src/App.tsx" }],
      () => "statement 2 (FunctionDeclaration) changes code",
    );
    assert.strictEqual(thick[0]?.verdict, "SEAM_NOT_THIN");
    assert.strictEqual(thick[0]?.reason, "statement 2 (FunctionDeclaration) changes code");
  });

  it("fails stale upstream paths, deleted-upstream resurrections, and unclassified paths", () => {
    const findings = classify([
      { status: "A", path: "meta/app.xml" },
      { status: "A", path: "scripts/old.ts" },
      { status: "M", path: "apps/server/src/main.ts" },
    ]);
    assert.deepStrictEqual(verdicts(findings), {
      "meta/app.xml": "STALE_UPSTREAM_PATH",
      "scripts/old.ts": "UPSTREAM_DELETION_TOUCHED",
      "apps/server/src/main.ts": "UNCLASSIFIED",
    });
    assert.strictEqual(
      findings.find((finding) => finding.path === "meta/app.xml")?.entry,
      "SEAM-002",
    );
    assert.strictEqual(
      findings.find((finding) => finding.path === "scripts/old.ts")?.entry,
      "DEL-001",
    );
    assert.isTrue(findings.every(isViolation));
  });

  it("sorts findings by path for a deterministic report", () => {
    const findings = classify([
      { status: "M", path: "z/last.ts" },
      { status: "M", path: "a/first.ts" },
      { status: "M", path: "m/middle.ts" },
    ]);
    assert.deepStrictEqual(
      findings.map((finding) => finding.path),
      ["a/first.ts", "m/middle.ts", "z/last.ts"],
    );
  });

  it("only sends non-deleted TS seam files to the AST analysis", () => {
    assert.deepStrictEqual(
      seamAnalysisPaths(inventory, [
        { status: "M", path: "apps/web/src/App.tsx" },
        { status: "D", path: "apps/web/src/App.tsx" },
        { status: "M", path: "meta/fork-app.xml" },
        { status: "M", path: "docs/fork.md" },
      ]),
      ["apps/web/src/App.tsx"],
    );
  });
});

describe("collectChanges", () => {
  it("flattens renames, adds untracked files, and dedupes by path", () => {
    const changes = collectChanges(
      ["R090\0old/name.ts\0new/name.ts", "M\0docs/fork.md", "D\0gone.ts"].join("\0"),
      "docs/fork.md\nuntracked/dir/file.ts\n",
    );
    assert.deepStrictEqual(changes, [
      { status: "D", path: "old/name.ts" },
      { status: "A", path: "new/name.ts" },
      { status: "M", path: "docs/fork.md" },
      { status: "D", path: "gone.ts" },
      { status: "A", path: "untracked/dir/file.ts" },
    ]);
  });
});

const BASE_APP_TSX = `import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount(count + 1)}>{count}</button>
    </div>
  );
}
`;

const withMount = (mount: string) =>
  `import { useState } from "react";
import { PlusPlusPanel } from "~/plusplus/PlusPlusPanel";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount(count + 1)}>{count}</button>
      ${mount}
    </div>
  );
}
`;

describe("thinSeamViolation", () => {
  it("accepts added imports and mounts with literal, identifier, member, and nested-mount props", () => {
    assert.isUndefined(thinSeamViolation("App.tsx", BASE_APP_TSX, BASE_APP_TSX));
    assert.isUndefined(
      thinSeamViolation(
        "App.tsx",
        BASE_APP_TSX,
        withMount(
          `<PlusPlusPanel title="Usage" count={count} vendor={cfg.vendor.name} icon={<VendorIcon name="x" />} disabled />`,
        ),
      ),
    );
    // Imports alone, including removed and side-effect-free clause imports.
    assert.isUndefined(
      thinSeamViolation("App.tsx", BASE_APP_TSX, `import "./setup";\n${BASE_APP_TSX}`),
    );
  });

  it("rejects mounts whose props or placement carry logic", () => {
    const cases: Record<string, string> = {
      "arrow prop": withMount(`<PlusPlusPanel onClose={() => setCount(0)} />`),
      "call prop": withMount(`<PlusPlusPanel value={compute(count)} />`),
      "spread props": withMount(`<PlusPlusPanel {...props} />`),
      "conditional mount": withMount(`{count > 0 && <PlusPlusPanel />}`),
      "text child": withMount(`<PlusPlusPanel>hello</PlusPlusPanel>`),
      "intrinsic element": withMount(`<span>hi</span>`),
      "lowercase tag": withMount(`<plusplusPanel />`),
    };
    for (const [name, head] of Object.entries(cases)) {
      assert.isDefined(
        thinSeamViolation("App.tsx", BASE_APP_TSX, head),
        `expected a violation for ${name}`,
      );
    }
  });

  it("rejects implementation changes and new statements, naming the statement", () => {
    const logic = thinSeamViolation(
      "App.tsx",
      BASE_APP_TSX,
      BASE_APP_TSX.replace("useState(0)", "useState(1)"),
    );
    assert.isDefined(logic);
    assert.isTrue(logic!.includes("FunctionDeclaration"), logic);
    const added = thinSeamViolation(
      "App.tsx",
      BASE_APP_TSX,
      `${BASE_APP_TSX}\nexport const extra = 1;\n`,
    );
    assert.isDefined(added);
    // A .ts seam: imports are inert, new statements are not.
    const baseTs = `export const a = 1;\n`;
    assert.isUndefined(thinSeamViolation("x.ts", baseTs, `import { b } from "y";\n${baseTs}`));
    assert.isDefined(thinSeamViolation("x.ts", baseTs, `${baseTs}export const c = 2;\n`));
  });

  it("ignores formatting, comments, and CRLF line endings", () => {
    const reflowed = BASE_APP_TSX.replace(/ {2}/g, "    ").replace(
      "export function App()",
      "// a note\nexport function App()",
    );
    assert.isUndefined(thinSeamViolation("App.tsx", BASE_APP_TSX, reflowed));
    assert.isUndefined(
      thinSeamViolation("App.tsx", BASE_APP_TSX, BASE_APP_TSX.replace(/\n/g, "\r\n")),
    );
  });

  it("allows prop retunes on an existing mount", () => {
    const before = withMount(`<PlusPlusPanel title="one" />`);
    const after = withMount(`<PlusPlusPanel title="two" />`);
    assert.isUndefined(thinSeamViolation("App.tsx", before, after));
  });
});

describe("renderReport", () => {
  it("names the base and fork point and counts violations", () => {
    const findings = classify([{ status: "M", path: "apps/server/src/main.ts" }]);
    const report = renderReport("a".repeat(40), "origin/main", "b".repeat(40), findings);
    assert.isTrue(report.startsWith(`fork-boundaries: base ${"a".repeat(40)} (origin/main)`));
    assert.isTrue(report.includes(`fork point ${"b".repeat(40)}`));
    assert.isTrue(report.includes("UNCLASSIFIED"));
    assert.isTrue(report.includes("apps/server/src/main.ts"));
    assert.isTrue(report.includes("1 violation(s) across 1 changed path(s)"));
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

function boundaryFixture(policyText?: string) {
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
  try {
    if (policyText !== "") {
      write(FORK_INVENTORY_PATH, policyText ?? JSON.stringify(TEST_POLICY, null, 2));
    }
    write("docs/fork.md", "# fork\n");
    write("apps/web/src/App.tsx", BASE_APP_TSX);
    write("apps/server/src/main.ts", "export const main = 1;\n");
    write("meta/fork-app.xml", "<app/>\n");
    write("scripts/check-changed.ts", "export const a = 1;\n");
    git("init");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    write,
    git,
    base: git("rev-parse", "HEAD"),
    commit(message: string) {
      git("add", "-A");
      git("-c", "commit.gpgsign=false", "commit", "-m", message);
      return git("rev-parse", "HEAD");
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const runCheck = (root: string, ref: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* checkForkBoundaries(root, ref).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const renderReportLines = (run: {
  base: string;
  forkPoint: string;
  findings: ReadonlyArray<BoundaryFinding>;
}) => renderReport(run.base, "ref", run.forkPoint, run.findings);

// Wall-clock it.live: these run real git subprocesses. The fixture is an
// Effect resource so it disposes even when an assertion fails.
const withFixture = (policyText?: string) =>
  Effect.acquireDisposable(Effect.sync(() => boundaryFixture(policyText)));

const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    ),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const runOk = (root: string, ref: string) =>
  Effect.gen(function* () {
    const result = yield* runCheck(root, ref);
    assert.isFalse(result.findings.some(isViolation), renderReportLines(result));
    return result;
  });

const runFail = (root: string, ref: string) => runCheck(root, ref).pipe(Effect.flip);

describe("checkForkBoundaries", () => {
  it.live("allows owned CRUD, infra edits, thin seams, and untracked owned files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("docs/fork.md", "# fork v2\n");
        project.write("scripts/check-changed.ts", "export const a = 2;\n");
        project.write("packages/plusplus/new.ts", "export const n = 1;\n");
        project.write("apps/web/src/App.tsx", withMount(`<PlusPlusPanel title="x" />`));
        const checked = yield* runOk(project.root, project.base);
        assert.strictEqual(checked.base, project.base);
        assert.strictEqual(checked.forkPoint, project.base);
        assert.deepStrictEqual(verdicts(checked.findings), {
          "apps/web/src/App.tsx": "ALLOW_THIN_SEAM",
          "docs/fork.md": "ALLOW_OWNED",
          "packages/plusplus/new.ts": "ALLOW_OWNED",
          "scripts/check-changed.ts": "ALLOW_INFRASTRUCTURE",
        });
        // Deleting an owned file stays allowed.
        project.git("rm", "-f", "--quiet", "docs/fork.md");
        const deleted = yield* runOk(project.root, project.base);
        assert.strictEqual(
          deleted.findings.find((finding) => finding.path === "docs/fork.md")?.verdict,
          "ALLOW_OWNED",
        );
      }),
    ),
  );

  it.live(
    "fails unclassified edits, seam deletions, non-TS seams, stale upstream paths, and resurrections",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const project = yield* withFixture();
          project.write("apps/server/src/main.ts", "export const main = 2;\n");
          project.write("meta/fork-app.xml", "<app fork/>\n");
          project.write("meta/app.xml", "<app/>\n");
          project.write("scripts/old.ts", "export const old = 1;\n");
          project.git("rm", "-f", "--quiet", "apps/web/src/App.tsx");
          const checked = yield* runCheck(project.root, project.base);
          assert.deepStrictEqual(verdicts(checked.findings), {
            "apps/server/src/main.ts": "UNCLASSIFIED",
            "apps/web/src/App.tsx": "SEAM_DELETED",
            "meta/app.xml": "STALE_UPSTREAM_PATH",
            "meta/fork-app.xml": "SEAM_NON_TS",
            "scripts/old.ts": "UPSTREAM_DELETION_TOUCHED",
          });
          // A rename of an unclassified upstream file fails on both halves.
          project.git("checkout", "HEAD", "--", "apps/web/src/App.tsx");
          project.git("mv", "apps/server/src/main.ts", "apps/server/src/moved.ts");
          const renamed = yield* runCheck(project.root, project.base);
          assert.deepStrictEqual(verdicts(renamed.findings), {
            "apps/server/src/main.ts": "UNCLASSIFIED",
            "apps/server/src/moved.ts": "UNCLASSIFIED",
            "meta/app.xml": "STALE_UPSTREAM_PATH",
            "meta/fork-app.xml": "SEAM_NON_TS",
            "scripts/old.ts": "UPSTREAM_DELETION_TOUCHED",
          });
        }),
      ),
  );

  it.live("fails a seam edit that smuggles logic past the mount rules", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("apps/web/src/App.tsx", BASE_APP_TSX.replace("useState(0)", "useState(1)"));
        const checked = yield* runCheck(project.root, project.base);
        const seam = checked.findings.find((finding) => finding.path === "apps/web/src/App.tsx");
        assert.strictEqual(seam?.verdict, "SEAM_NOT_THIN");
      }),
    ),
  );

  it.live("treats a head-only policy edit as POLICY_CHANGED and grants it nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        const spoofed = JSON.parse(JSON.stringify(TEST_POLICY));
        spoofed.boundaryInfrastructure.push("apps/server/src/main.ts");
        project.write(FORK_INVENTORY_PATH, JSON.stringify(spoofed, null, 2));
        project.write("apps/server/src/main.ts", "export const main = 2;\n");
        const headSpoof = yield* runCheck(project.root, project.base);
        // The head policy approves main.ts, but only the base policy counts and
        // the base does not list the path: the edit stays unclassified.
        assert.deepStrictEqual(verdicts(headSpoof.findings), {
          [FORK_INVENTORY_PATH]: "POLICY_CHANGED",
          "apps/server/src/main.ts": "UNCLASSIFIED",
        });
        // Once the spoof lands in a base, that base's policy grants the path:
        // trust follows the committed base, never the PR author.
        const spoofBase = project.commit("spoof");
        project.write("apps/server/src/main.ts", "export const main = 3;\n");
        const againstSpoof = yield* runOk(project.root, spoofBase);
        assert.deepStrictEqual(verdicts(againstSpoof.findings), {
          "apps/server/src/main.ts": "ALLOW_INFRASTRUCTURE",
        });
      }),
    ),
  );

  it.live("diffs a stacked branch against its immediate parent only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* withFixture();
        project.write("apps/server/src/main.ts", "export const main = 2;\n");
        const middle = project.commit("middle: unclassified edit");
        project.write("docs/fork.md", "# fork v2\n");
        project.commit("head: owned edit");
        const againstMiddle = yield* runOk(project.root, middle);
        assert.strictEqual(againstMiddle.forkPoint, middle);
        assert.deepStrictEqual(verdicts(againstMiddle.findings), {
          "docs/fork.md": "ALLOW_OWNED",
        });
        const againstBase = yield* runCheck(project.root, project.base);
        assert.deepStrictEqual(verdicts(againstBase.findings), {
          "apps/server/src/main.ts": "UNCLASSIFIED",
          "docs/fork.md": "ALLOW_OWNED",
        });
      }),
    ),
  );

  it.live("fails closed on missing, malformed, and invalid policy plus unresolvable bases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const missing = yield* withFixture("");
        const missingError = yield* runFail(missing.root, missing.base);
        assert.isTrue(missingError.includes("cannot read the trusted policy"), missingError);

        const malformed = yield* withFixture("{oops");
        const malformedError = yield* runFail(malformed.root, malformed.base);
        assert.isTrue(malformedError.includes("is not valid"), malformedError);

        const badCounts = JSON.parse(JSON.stringify(TEST_POLICY));
        badCounts.baseline.counts.total = 99;
        const invalid = yield* withFixture(JSON.stringify(badCounts));
        const invalidError = yield* runFail(invalid.root, invalid.base);
        assert.isTrue(invalidError.includes("fails validation"), invalidError);
        assert.isTrue(invalidError.includes("baseline count total is 99"), invalidError);

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
