// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  SEAM_REGISTRY_PATH,
  fingerprintMismatches,
  fingerprintOf,
  locateRegion,
  normalizeRegion,
  parseSeamRegistry,
  readFileAt,
  refreshRegistry,
  serializeRegistry,
  upsertSyncEntry,
  validateSeamRegistry,
  withLegacyEntries,
  type SeamAnchor,
  type SeamRegistry,
} from "./seamRegistry.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const PLACEHOLDER = "sha256:0000000000000000";

describe("normalizeRegion", () => {
  const cases: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
    ["CRLF endings", "a\r\nb\r\n", "a\nb"],
    ["trailing whitespace per line", "a  \n\tb\t \n", "a\n\tb"],
    ["outer blank lines", "\n\n  a\n\nb\n\n", "  a\n\nb"],
    ["already normal", "a\nb", "a\nb"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    assert.strictEqual(normalizeRegion(input), expected);
  });
});

const SOURCE = `import { Schema } from "effect";

export const ServerSettings = Schema.Struct({
  alpha: Schema.String,
  usageModelFilter: Schema.optionalKey(Schema.String),
  omega: Schema.Number,
});

export class Widget {
  render() {
    return 1;
  }
  size = 3;
}

export function checkProvider(input: string) {
  const first = 1;
  const second = discoverSkills(input);
  const third = 3;
  const fourth = 4;
  const fifth = 5;
  const sixth = 6;
  return [first, second, third, fourth, fifth, sixth];
}

export function unrelated() {
  return "unrelated";
}
`;

const textOf = (path: string, source: string, anchor: SeamAnchor): string => {
  const lookup = locateRegion(path, source, anchor);
  assert.strictEqual(lookup._tag, "Found", JSON.stringify(lookup));
  return lookup._tag === "Found" ? lookup.text : "";
};
const fingerprintAt = (source: string, anchor: SeamAnchor): string =>
  fingerprintOf(textOf("a.ts", source, anchor));

describe("locateRegion fingerprints", () => {
  const symbolAnchor = { symbol: "checkProvider" } as const;
  const lineAnchor = { symbol: "checkProvider", text: "discoverSkills(" } as const;

  it("moves with edits inside the region only", () => {
    const symbolBefore = fingerprintAt(SOURCE, symbolAnchor);
    const lineBefore = fingerprintAt(SOURCE, lineAnchor);

    const elsewhere = SOURCE.replace('return "unrelated"', 'return "changed"');
    assert.strictEqual(fingerprintAt(elsewhere, symbolAnchor), symbolBefore);
    assert.strictEqual(fingerprintAt(elsewhere, lineAnchor), lineBefore);

    const inside = SOURCE.replace("const first = 1;", "const first = 10;");
    assert.notStrictEqual(fingerprintAt(inside, symbolAnchor), symbolBefore);
    assert.notStrictEqual(fingerprintAt(inside, lineAnchor), lineBefore);

    // Three lines from the text match: inside the symbol, outside the window.
    const farInside = SOURCE.replace("const fifth = 5;", "const fifth = 55;");
    assert.notStrictEqual(fingerprintAt(farInside, symbolAnchor), symbolBefore);
    assert.strictEqual(fingerprintAt(farInside, lineAnchor), lineBefore);

    // Formatting noise never moves a fingerprint.
    const noisy = SOURCE.replace(/\n/g, "  \r\n");
    assert.strictEqual(fingerprintAt(noisy, symbolAnchor), symbolBefore);
    assert.strictEqual(fingerprintAt(noisy, lineAnchor), lineBefore);
  });

  it("reports a renamed symbol as Missing and a repeated text line as Ambiguous", () => {
    const renamed = SOURCE.replace("function checkProvider", "function checkProviderStatus");
    assert.deepStrictEqual(locateRegion("a.ts", renamed, symbolAnchor), { _tag: "Missing" });

    const duplicated = SOURCE.replace("const third = 3;", "const third = discoverSkills(first);");
    assert.deepStrictEqual(locateRegion("a.ts", duplicated, lineAnchor), {
      _tag: "Ambiguous",
      matches: 2,
    });
    assert.deepStrictEqual(locateRegion("a.ts", SOURCE, { text: "nowhere" }), { _tag: "Missing" });
  });
});

describe("locateRegion anchors", () => {
  it("resolves dotted members through Schema.Struct, classes, and a file-level text", () => {
    assert.strictEqual(
      textOf("a.ts", SOURCE, { symbol: "ServerSettings.usageModelFilter" }),
      "usageModelFilter: Schema.optionalKey(Schema.String)",
    );
    assert.strictEqual(
      textOf("a.ts", SOURCE, { symbol: "Widget.render" }),
      "render() {\n    return 1;\n  }",
    );
    assert.strictEqual(textOf("a.ts", SOURCE, { symbol: "Widget.size" }), "size = 3;");
    assert.strictEqual(
      textOf("a.ts", SOURCE, { symbol: "ServerSettings" }).split("\n")[0],
      "export const ServerSettings = Schema.Struct({",
    );
    assert.deepStrictEqual(locateRegion("a.ts", SOURCE, { symbol: "Widget.absent" }), {
      _tag: "Missing",
    });
    assert.strictEqual(textOf("a.ts", SOURCE, { text: "import { Schema }" }).split("\n").length, 3);
  });

  it("prefers the value of a value and type pair that share a name", () => {
    const constAndType = "export const Seam = 1;\nexport type Seam = typeof Seam;\n";
    assert.strictEqual(textOf("a.ts", constAndType, { symbol: "Seam" }), "export const Seam = 1;");
    const typeFirst = "export interface Seam {}\nexport const Seam = 1;\n";
    assert.strictEqual(textOf("a.ts", typeFirst, { symbol: "Seam" }), "export const Seam = 1;");
  });

  it("treats overloaded declarations as Ambiguous", () => {
    const overloaded =
      "export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any) {}\n";
    assert.deepStrictEqual(locateRegion("a.ts", overloaded, { symbol: "f" }), {
      _tag: "Ambiguous",
      matches: 3,
    });
  });

  it("locates JSON keys by dotted path and ignores sibling keys", () => {
    const manifest = (sibling: string) =>
      JSON.stringify({ name: "x", scripts: { "knip:check": "knip", build: sibling } }, null, 2);
    const anchor = { key: "scripts.knip:check" } as const;
    assert.strictEqual(textOf("package.json", manifest("a"), anchor), '"knip"');
    assert.strictEqual(
      fingerprintOf(textOf("package.json", manifest("a"), anchor)),
      fingerprintOf(textOf("package.json", manifest("b"), anchor)),
    );
    assert.deepStrictEqual(locateRegion("package.json", manifest("a"), { key: "scripts.nope" }), {
      _tag: "Missing",
    });
    assert.deepStrictEqual(locateRegion("package.json", "{oops", anchor), { _tag: "Missing" });
  });

  it("locates YAML block-mapping keys by indentation and rejects flow mappings", () => {
    const workflow = [
      "name: ci",
      "# a comment",
      "jobs:",
      "  release:",
      "    runs-on: ubuntu",
      "",
      "    steps:",
      "      - run: echo",
      "  lint:",
      "    runs-on: ubuntu",
      "env: {A: 1}",
      "",
    ].join("\n");
    assert.strictEqual(
      textOf("ci.yml", workflow, { key: "jobs.release" }),
      "  release:\n    runs-on: ubuntu\n\n    steps:\n      - run: echo",
    );
    assert.strictEqual(
      textOf("ci.yml", workflow, { key: "jobs.lint.runs-on" }),
      "    runs-on: ubuntu",
    );
    assert.strictEqual(textOf("ci.yml", workflow, { key: "name" }), "name: ci");
    for (const missing of ["jobs.nope", "env.A", "jobs.release.runs-on.deeper", "steps"]) {
      assert.deepStrictEqual(
        locateRegion("ci.yml", workflow, { key: missing }),
        { _tag: "Missing" },
        missing,
      );
    }
    assert.deepStrictEqual(locateRegion("ci.yml", "a:\n  b: 1\na:\n  b: 2\n", { key: "a" }), {
      _tag: "Ambiguous",
      matches: 2,
    });
  });

  it("extends a YAML key over a block sequence written at the key's own indent", () => {
    const matrix = (second: string) =>
      ["strategy:", "  os:", "  - linux", `  - ${second}`, "  name: x", ""].join("\n");
    const anchor = { key: "strategy.os" } as const;
    assert.strictEqual(
      textOf("ci.yml", matrix("windows"), anchor),
      "  os:\n  - linux\n  - windows",
    );
    assert.notStrictEqual(
      fingerprintOf(textOf("ci.yml", matrix("windows"), anchor)),
      fingerprintOf(textOf("ci.yml", matrix("macos"), anchor)),
    );
  });

  it("returns the whole text for a file anchor", () => {
    assert.strictEqual(textOf("x.json", "{}\n", { file: true }), "{}\n");
  });
});

const baseRegistry = (): SeamRegistry => ({
  version: 1,
  upstreamRef: "a".repeat(40),
  features: { demo: { title: "Demo", issue: 1 } },
  files: {
    "a.ts": {
      delta: [1, 0],
      seams: [
        {
          id: "demo.hook",
          feature: "demo",
          mechanism: "hook",
          anchor: { symbol: "checkProvider" },
          fingerprint: PLACEHOLDER,
        },
      ],
    },
    "b.ts": { delta: [2, 2], legacy: true },
  },
  siblings: [],
});

describe("validateSeamRegistry", () => {
  const withSeam = (patch: Record<string, unknown>): SeamRegistry => {
    const registry = baseRegistry();
    const entry = registry.files["a.ts"];
    if (entry === undefined || "legacy" in entry) throw new Error("fixture");
    return {
      ...registry,
      files: { ...registry.files, "a.ts": { ...entry, seams: [{ ...entry.seams[0], ...patch }] } },
    } as SeamRegistry;
  };

  it("accepts a valid registry", () => {
    assert.deepStrictEqual(validateSeamRegistry(baseRegistry()), []);
  });

  it("rejects each rule violation by name", () => {
    const cases: ReadonlyArray<readonly [name: string, registry: SeamRegistry, expected: string]> =
      [
        [
          "unknown feature",
          withSeam({ feature: "other", id: "other.hook" }),
          "unknown feature other",
        ],
        ["id prefix", withSeam({ id: "demo" }), "id must match demo."],
        [
          "override without reason",
          withSeam({ mechanism: "override" }),
          "an override needs a reason",
        ],
        ["swap without target", withSeam({ mechanism: "swap" }), "a swap needs a target"],
        [
          "generated without a file anchor",
          withSeam({ mechanism: "generated" }),
          "a generated seam needs a {file:true} anchor",
        ],
        [
          "target on a non-swap",
          withSeam({ target: "plusplus/x.ts" }),
          "only a swap carries a target",
        ],
        [
          "key anchor on a TS file",
          withSeam({ anchor: { key: "a.b" } }),
          "key anchors only work on .json, .yml and .yaml files",
        ],
        [
          "unsorted keys",
          {
            ...baseRegistry(),
            files: {
              "b.ts": { delta: [1, 1], legacy: true },
              "a.ts": { delta: [1, 1], legacy: true },
            },
          },
          "files keys must be unique and sorted",
        ],
        [
          "non-normalized path",
          { ...baseRegistry(), files: { "./a.ts": { delta: [1, 1], legacy: true } } },
          "not a normalized repo-relative file path",
        ],
        [
          "unknown sibling feature",
          {
            ...baseRegistry(),
            siblings: [
              { feature: "ghost", upstream: "a.md", plusplus: "p.md", fingerprint: PLACEHOLDER },
            ],
          },
          "unknown feature ghost",
        ],
      ];
    for (const [name, registry, expected] of cases) {
      const issues = validateSeamRegistry(registry);
      assert.isTrue(
        issues.some((issue) => issue.includes(expected)),
        `${name}: ${issues.join(" | ")}`,
      );
    }
  });

  it("rejects duplicate seam ids", () => {
    const registry = baseRegistry();
    const entry = registry.files["a.ts"];
    if (entry === undefined || "legacy" in entry) throw new Error("fixture");
    const duplicated: SeamRegistry = {
      ...registry,
      files: {
        ...registry.files,
        "a.ts": { ...entry, seams: [entry.seams[0], entry.seams[0]] },
      },
    };
    assert.isTrue(validateSeamRegistry(duplicated).some((issue) => issue.includes("duplicate")));
  });

  it.effect("rejects an entry that is both legacy and anchored, and unknown properties", () =>
    Effect.gen(function* () {
      const both = JSON.stringify({
        ...baseRegistry(),
        files: { "a.ts": { delta: [1, 0], legacy: true, seams: [] } },
      });
      assert.include((yield* Effect.flip(parseSeamRegistry(both))).message, "not valid");
      const extra = JSON.stringify({ ...baseRegistry(), surprise: true });
      assert.include((yield* Effect.flip(parseSeamRegistry(extra))).message, "not valid");
      const badFingerprint = JSON.stringify({
        ...baseRegistry(),
        siblings: [{ feature: "demo", upstream: "a.md", plusplus: "p.md", fingerprint: "md5:1" }],
      });
      assert.include((yield* Effect.flip(parseSeamRegistry(badFingerprint))).message, "not valid");
    }),
  );
});

describe("the committed registry", () => {
  it.effect("decodes and validates without git", () =>
    Effect.gen(function* () {
      const text = NodeFS.readFileSync(NodePath.join(REPO_ROOT, SEAM_REGISTRY_PATH), "utf8");
      const registry = yield* parseSeamRegistry(text);
      assert.isAbove(Object.keys(registry.files).length, 0);
      assert.strictEqual(serializeRegistry(registry), text);
    }),
  );
});

describe("upsertSyncEntry", () => {
  it("replaces the entry for the same upstreamRef instead of duplicating it", () => {
    const ref = "b".repeat(40);
    const entry = { tag: "v1.0.0", upstreamRef: ref, conflicts: [], dropped: [] };
    const once = upsertSyncEntry({ version: 1, syncs: [] }, entry);
    const twice = upsertSyncEntry(once, { ...entry, dropped: ["x.ts"] });
    assert.strictEqual(twice.syncs.length, 1);
    assert.deepStrictEqual(twice.syncs[0]?.dropped, ["x.ts"]);
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config can sign or ignore
// fixture files. Git on Windows cannot open os.devNull as a config path, so
// isolation uses a real empty file.
const emptyGitConfigDir = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seam-env-")),
);
const emptyGitConfig = NodePath.join(emptyGitConfigDir, "empty-git-config");
NodeFS.writeFileSync(emptyGitConfig, "");
afterAll(() => {
  NodeFS.rmSync(emptyGitConfigDir, { recursive: true, force: true });
});
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

// An upstream commit, then a fork commit on top that modifies two upstream
// files, deletes one, and adds a ++ file.
function refreshFixture() {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seam-")));
  const write = (file: string, content: string | Uint8Array) => {
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
    git("init");
    write("a.ts", SOURCE);
    write("b.ts", "export function stays() {\n  return 1;\n}\n");
    write("docs/old.md", "one\ntwo\n");
    write("docs/gone.md", "x\ny\nz\n");
    write("docs/blob.bin", Uint8Array.of(0, 1, 2));
    const upstreamRef = commitAll("upstream");
    write("a.ts", SOURCE.replace("const first = 1;", "const first = 1;\n  const hook = true;"));
    write("b.ts", "export function stays() {\n  return 2;\n}\n");
    write("docs/old.md", "one\ntwo\nthree\n");
    write("docs/blob.bin", Uint8Array.of(0, 1, 2, 3));
    git("rm", "-f", "--quiet", "docs/gone.md");
    write("plusplus/seams.json", "{}\n");
    const forkTree = (commitAll("fork"), git("rev-parse", "HEAD^{tree}"));
    return {
      root,
      upstreamRef,
      forkTree,
      write,
      git,
      [Symbol.dispose]() {
        NodeFS.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const isolated = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const anchoredEntry = (symbol: string) =>
  ({
    delta: [0, 0],
    seams: [
      {
        id: "demo.hook",
        feature: "demo",
        mechanism: "hook",
        anchor: { symbol },
        fingerprint: PLACEHOLDER,
      },
    ],
  }) as const;

describe("refreshRegistry", () => {
  it.live("reports unregistered, dropped, and broken entries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* Effect.acquireDisposable(Effect.sync(refreshFixture));
        const registry: SeamRegistry = {
          ...baseRegistry(),
          files: {
            "a.ts": anchoredEntry("checkProvider"),
            "b.ts": anchoredEntry("renamedAway"),
            "stale.ts": { delta: [1, 1], legacy: true },
          },
        };
        const refreshed = yield* isolated(
          refreshRegistry({
            cwd: project.root,
            registry,
            upstreamRef: project.upstreamRef,
            forkTree: project.forkTree,
          }),
        );
        assert.deepStrictEqual(refreshed.unregistered, [
          "docs/blob.bin",
          "docs/gone.md",
          "docs/old.md",
        ]);
        assert.deepStrictEqual(refreshed.dropped, ["stale.ts"]);
        assert.strictEqual(refreshed.broken.length, 1);
        assert.include(refreshed.broken[0], "demo.hook (b.ts)");
        assert.include(refreshed.broken[0], "anchor is missing");
        assert.strictEqual(refreshed.registry.upstreamRef, project.upstreamRef);

        const entry = refreshed.registry.files["a.ts"];
        assert.isTrue(entry !== undefined && "seams" in entry);
        if (entry !== undefined && "seams" in entry) {
          assert.deepStrictEqual(entry.delta, [1, 0]);
          assert.match(entry.seams[0].fingerprint, /^sha256:[0-9a-f]{16}$/);
          assert.notStrictEqual(entry.seams[0].fingerprint, PLACEHOLDER);
        }
        assert.isAbove(fingerprintMismatches(registry, refreshed.registry).length, 0);
      }),
    ),
  );

  it.live("bootstraps legacy entries with numstat deltas and is byte-stable on a second run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* Effect.acquireDisposable(Effect.sync(refreshFixture));
        const input = {
          cwd: project.root,
          upstreamRef: project.upstreamRef,
          forkTree: project.forkTree,
        };
        const seeded: SeamRegistry = {
          ...baseRegistry(),
          files: { "a.ts": anchoredEntry("checkProvider") },
        };
        const first = yield* isolated(refreshRegistry({ ...input, registry: seeded }));
        const completed = withLegacyEntries(
          first.registry,
          first.unregistered.map((path) => ({ path, delta: first.deltas.get(path) ?? [0, 0] })),
        );
        assert.deepStrictEqual(completed.files["docs/gone.md"], { delta: [0, 3], legacy: true });
        // numstat reports a binary change without line counts.
        assert.deepStrictEqual(completed.files["docs/blob.bin"], { delta: [0, 0], legacy: true });
        assert.deepStrictEqual(completed.files["docs/old.md"], { delta: [1, 0], legacy: true });
        assert.deepStrictEqual(completed.files["b.ts"], { delta: [1, 1], legacy: true });
        assert.deepStrictEqual(validateSeamRegistry(completed), []);

        const second = yield* isolated(refreshRegistry({ ...input, registry: completed }));
        assert.deepStrictEqual(second.unregistered, []);
        assert.deepStrictEqual(second.dropped, []);
        assert.deepStrictEqual(second.broken, []);
        assert.strictEqual(serializeRegistry(second.registry), serializeRegistry(completed));
        assert.deepStrictEqual(fingerprintMismatches(completed, second.registry), []);
      }),
    ),
  );

  it.live("reads a file at a ref and distinguishes an absent path from a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = yield* Effect.acquireDisposable(Effect.sync(refreshFixture));
        const present = yield* isolated(
          readFileAt(project.root, project.upstreamRef, "docs/old.md"),
        );
        assert.deepStrictEqual(present, Option.some("one\ntwo\n"));
        const absent = yield* isolated(readFileAt(project.root, project.upstreamRef, "nope.md"));
        assert.isTrue(Option.isNone(absent));
        const failure = yield* isolated(
          Effect.flip(readFileAt(project.root, "0".repeat(40), "docs/old.md")),
        );
        assert.include(failure.message, "git ls-tree");
      }),
    ),
  );
});
