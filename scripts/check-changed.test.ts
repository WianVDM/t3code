// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  checkJobResults,
  ciOnlyJobs,
  comparisonBase,
  defaultConcurrency,
  docReaderTests,
  gitLines,
  runSteps,
  splitTests,
  type Step,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("runs the server tests for the one guide they read and leaves other docs inert", () => {
    const packages = readWorkspace();
    assert.isTrue(
      decide(["docs/user/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    );
    assert.deepStrictEqual(docReaderTests(["docs/user/t3-connect-troubleshooting.md"]), [
      "apps/server/src/cloud/ConnectReachability.test.ts",
    ]);
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it("lists the CI-only jobs the remaining gates keep, in summary order", () => {
    assert.deepStrictEqual(
      ciOnlyJobs({ test: true, build: true, rust: true, release_smoke: true, windows: true }),
      ["full test suites", "build", "rust", "release smoke", "windows"],
    );
    assert.deepStrictEqual(ciOnlyJobs({ test_server: true }), ["full test suites"]);
    assert.deepStrictEqual(ciOnlyJobs({ test_web: true }), ["full test suites"]);
    assert.deepStrictEqual(ciOnlyJobs({ windows: true }), ["windows"]);
  });

  it("omits CI-only jobs whose gate is off", () => {
    assert.deepStrictEqual(ciOnlyJobs({ test: false, build: true, rust: false }), ["build"]);
    assert.deepStrictEqual(ciOnlyJobs({ windows: false }), []);
    assert.deepStrictEqual(ciOnlyJobs({}), []);
  });

  it("never reinstates the deleted mobile native gate", () => {
    // The fork's free CI graph has no mobile native job; a stray mobile_native
    // gate must not put the label back in the summary.
    const staleGate: Record<string, boolean> = { mobile_native: true };
    assert.deepStrictEqual(ciOnlyJobs(staleGate), []);
  });

  // A complete green run in the shape of GitHub's toJSON(needs). `changes`
  // carries the gates and the fail_open all-clear the shared policy reads.
  type JobEntry = { result?: string | undefined; outputs?: Record<string, string> };
  type Needs = Record<string, JobEntry>;
  const greenNeeds = (gates: Record<string, string> = {}): Needs => ({
    changes: { result: "success", outputs: { fail_open: "false", ...gates } },
    lint: { result: "success" },
    build: { result: "success" },
    test: { result: "success" },
    test_web: { result: "success" },
    test_server: { result: "success" },
    rust: { result: "success" },
    release_smoke: { result: "success" },
    shared_persistence_compat: { result: "success" },
    windows: { result: "success" },
  });
  const withJob = (needs: Needs, job: string, entry: JobEntry): Needs => ({
    ...needs,
    [job]: entry,
  });

  it("passes the CI graph when every job, Windows included, succeeds healthy", () => {
    assert.deepStrictEqual(checkJobResults(greenNeeds({ windows: "true" })), []);
    // A server shard detects before skipping its test steps, so it normally
    // succeeds even with its gate off; success needs no gate explanation.
    assert.deepStrictEqual(checkJobResults(greenNeeds({ test_server: "false" })), []);
  });

  it("allows a skipped optional job only when every gate it represents is off", () => {
    // Build merges the build and typecheck gates, so both must be off.
    assert.deepStrictEqual(
      checkJobResults(
        withJob(greenNeeds({ build: "false", typecheck: "false" }), "build", {
          result: "skipped",
        }),
      ),
      [],
    );
    assert.deepStrictEqual(
      checkJobResults(withJob(greenNeeds({ windows: "false" }), "windows", { result: "skipped" })),
      [],
    );
    assert.isNotEmpty(
      checkJobResults(
        withJob(greenNeeds({ build: "true", typecheck: "false" }), "build", {
          result: "skipped",
        }),
      ),
    );
    assert.isNotEmpty(
      checkJobResults(withJob(greenNeeds({ windows: "true" }), "windows", { result: "skipped" })),
    );
    // A gate the changes job never emitted explains nothing.
    assert.isNotEmpty(checkJobResults(withJob(greenNeeds(), "windows", { result: "skipped" })));
  });

  it("fails on empty needs, a missing expected job, and an extra job", () => {
    assert.isNotEmpty(checkJobResults({}));
    for (const job of Object.keys(greenNeeds())) {
      const needs = greenNeeds();
      delete needs[job];
      assert.isNotEmpty(checkJobResults(needs), `removing ${job} must fail`);
    }
    // mobile_native_static_analysis left the graph; a stale entry in needs
    // must fail rather than pass silently.
    assert.isNotEmpty(
      checkJobResults(
        withJob(greenNeeds(), "mobile_native_static_analysis", { result: "skipped" }),
      ),
    );
  });

  it("fails closed on failure, cancellation, and missing or unknown results", () => {
    for (const result of ["failure", "cancelled", "timed_out", undefined]) {
      assert.isNotEmpty(
        checkJobResults(withJob(greenNeeds({ windows: "false" }), "windows", { result })),
        `result ${result} must fail`,
      );
    }
    // Whatever the gates say, and on always-on jobs too.
    assert.isNotEmpty(
      checkJobResults(withJob(greenNeeds({ test: "false" }), "test", { result: "cancelled" })),
    );
    assert.isNotEmpty(checkJobResults(withJob(greenNeeds(), "lint", { result: "failure" })));
  });

  it("never lets an always-on job skip", () => {
    for (const job of ["changes", "lint", "shared_persistence_compat"]) {
      assert.isNotEmpty(
        checkJobResults(withJob(greenNeeds(), job, { result: "skipped" })),
        `${job} must never skip`,
      );
    }
  });

  it("fails a fail-open detection even with every job green", () => {
    const failOpen = greenNeeds();
    failOpen.changes = { result: "success", outputs: { fail_open: "true" } };
    assert.isNotEmpty(checkJobResults(failOpen));
    // A missing all-clear is as bad as an explicit true.
    const missing = greenNeeds();
    missing.changes = { result: "success", outputs: {} };
    assert.isNotEmpty(checkJobResults(missing));
    const noOutputs = greenNeeds();
    noOutputs.changes = { result: "success" };
    assert.isNotEmpty(checkJobResults(noOutputs));
  });

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\thread-transfer-report.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [
          ".github/scripts/ci-changes.test.cjs",
          ".github\\scripts\\thread-transfer-report.test.cjs",
        ],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files. Git on Windows cannot
// open os.devNull as a config path, so isolation uses a real empty file.
const emptyGitConfig = NodePath.join(
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-env-"))),
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
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const compare = (root: string, ref: Option.Option<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* comparisonBase(root, ref).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

function launcherFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    ".github/scripts/ci-changes.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  write(".gitignore", "node_modules/\nrecords/\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "package.json",
    JSON.stringify({ type: "module", scripts: { "knip:check": "knip --include files" } }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    process.exit(args.includes(process.env.FAIL_STEP) ? 23 : 0);
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
      "vitePlusCommand(args, platform)",
      'vitePlusCommand(args, "win32")',
    ),
  );
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  return {
    root,
    source,
    write,
    run(failStep = "") {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, TEMP: NodeOS.tmpdir(), RECORDS: records, FAIL_STEP: failStep },
      });
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "install")).toBe(false);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  expect(calls.some(({ args }) => args[0] === "exec" && args[1] === "knip")).toBe(true);
});

it("forwards the resolved base to the fork boundaries step", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const head = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: project.root,
    encoding: "utf8",
    env,
  }).trim();
  expect(
    project
      .calls()
      .find(({ args }) => args[1] === "node" && args[2] === "scripts/check-fork-boundaries.ts")
      ?.args,
  ).toEqual(["exec", "node", "scripts/check-fork-boundaries.ts", head]);
});

it("propagates a failing fork boundaries step", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run("scripts/check-fork-boundaries.ts");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("FAIL  fork boundaries");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it.each(["install", "lint"])("reports a failing %s step with its output", (step) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(step);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[0] === "install");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${step}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${step}`);
  expect(result.stdout).toContain(step === "install" ? "FAIL  unused patches" : "FAIL  lint");
  if (step === "lint") expect(result.stdout).toContain("pass  unused patches");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});
