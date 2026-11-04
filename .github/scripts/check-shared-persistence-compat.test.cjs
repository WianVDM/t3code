const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  compareSharedPersistence,
  checkSharedPersistence,
  parseMigrationManifest,
} = require("./check-shared-persistence-compat.cjs");

const SCRIPT = path.join(__dirname, "check-shared-persistence-compat.cjs");
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations";
const MIGRATIONS_MODULE = "apps/server/src/persistence/Migrations.ts";

const manifestSource = (entries) =>
  [
    "const migrationEntries = [",
    ...entries.map(([id, name]) => `  [${id}, "${name}", Migration${id}],`),
    "] as const;",
    "",
  ].join("\n");

const side = (manifest, files) => ({ manifest, files: new Map(Object.entries(files)) });
const shared = { id: 1, name: "One" };
const sharedFile = "apps/server/src/persistence/Migrations/001_One.ts";

test("parses migration entries from the manifest block", () => {
  assert.deepEqual(
    parseMigrationManifest(
      manifestSource([
        [1, "One"],
        [2, "Two"],
      ]),
      "fixture",
    ),
    [shared, { id: 2, name: "Two" }],
  );
});

test("refuses a module without a manifest block", () => {
  assert.throws(
    () => parseMigrationManifest("export const nothing = 1;", "fixture"),
    /no migrationEntries/,
  );
});

test("passes when the fork carries exactly the upstream base's shared migrations", () => {
  const upstream = side([shared], { [sharedFile]: "CREATE TABLE one" });
  assert.deepEqual(compareSharedPersistence({ upstream, fork: upstream }), []);
});

test("passes when the upstream base is ahead of the fork", () => {
  const upstream = side([shared, { id: 2, name: "Two" }], {
    [sharedFile]: "CREATE TABLE one",
    "apps/server/src/persistence/Migrations/002_Two.ts": "CREATE TABLE two",
  });
  const fork = side([shared], { [sharedFile]: "CREATE TABLE one" });
  assert.deepEqual(compareSharedPersistence({ upstream, fork }), []);
});

test("reports fork-only migrations in the manifest and the directory", () => {
  const upstream = side([shared], { [sharedFile]: "CREATE TABLE one" });
  const fork = side([shared, { id: 2, name: "ForkOnly" }], {
    [sharedFile]: "CREATE TABLE one",
    "apps/server/src/persistence/Migrations/002_ForkOnly.ts": "CREATE TABLE fork_only",
  });
  const problems = compareSharedPersistence({ upstream, fork });
  assert.equal(problems.length, 2);
  assert.match(
    problems[0],
    /fork-only migration 2_ForkOnly: the upstream base has no migration at id 2/,
  );
  assert.match(problems[1], /fork-only migration file .*002_ForkOnly\.ts/);
});

test("reports DDL divergence in a shared migration", () => {
  const upstream = side([shared], { [sharedFile]: "CREATE TABLE one" });
  const fork = side([shared], { [sharedFile]: "CREATE TABLE one (fork_only TEXT)" });
  const problems = compareSharedPersistence({ upstream, fork });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /DDL divergence in .*001_One\.ts/);
});

test("reports manifest divergence at a shared id", () => {
  const upstream = side([shared], { [sharedFile]: "CREATE TABLE one" });
  const fork = side([{ id: 1, name: "Uno" }], { [sharedFile]: "CREATE TABLE one" });
  const problems = compareSharedPersistence({ upstream, fork });
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /manifest divergence at id 1: \+\+ registers "Uno", the upstream base registers "One"/,
  );
});

// end-to-end through git: the upstream side is a commit, the fork side the checkout.
function gitFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-shared-compat-"));
  const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  return { rootDir, git };
}

function writeCheckout(rootDir, entries, files) {
  fs.mkdirSync(path.join(rootDir, MIGRATIONS_DIR), { recursive: true });
  fs.writeFileSync(path.join(rootDir, MIGRATIONS_MODULE), manifestSource(entries));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(rootDir, MIGRATIONS_DIR, name), content);
  }
}

test("compares a git tree with the checkout and leaves test files out", () => {
  const { rootDir, git } = gitFixture();
  try {
    writeCheckout(rootDir, [[1, "One"]], {
      "001_One.ts": "CREATE TABLE one",
      "001_One.test.ts": "upstream test",
    });
    git("add", "-A");
    git("commit", "--quiet", "--message", "upstream base");
    const upstreamBase = git("rev-parse", "HEAD").trim();

    writeCheckout(
      rootDir,
      [
        [1, "One"],
        [2, "ForkOnly"],
      ],
      {
        "001_One.ts": "CREATE TABLE one (fork_only TEXT)",
        "001_One.test.ts": "fork test",
        "002_ForkOnly.ts": "CREATE TABLE fork_only",
      },
    );

    const problems = compareSharedPersistence(
      checkSharedPersistence({ treeish: upstreamBase, rootDir }),
    );
    assert.equal(problems.length, 3);
    assert.match(problems[0], /fork-only migration 2_ForkOnly/);
    assert.match(problems[1], /DDL divergence in .*001_One\.ts/);
    assert.match(problems[2], /fork-only migration file .*002_ForkOnly\.ts/);

    const failing = spawnSync(process.execPath, [SCRIPT, upstreamBase], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /fork-only migration file .*002_ForkOnly\.ts/);

    git("reset", "--quiet", "--hard", upstreamBase);
    git("clean", "--quiet", "-fd");
    const passing = spawnSync(process.execPath, [SCRIPT, upstreamBase], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(passing.status, 0);
    assert.match(
      passing.stdout,
      /shared persistence matches upstream base .*: 1 shared migrations\./,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
