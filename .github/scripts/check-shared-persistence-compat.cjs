// ++ shares the SQLite persistence schema with stock T3 Code: either build can
// open the same database, so the migration manifest and shared migrations must
// stay the upstream base's. Fails on fork-only migrations or DDL divergence;
// upstream merges pass because the upstream side may be ahead.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_MODULE = "apps/server/src/persistence/Migrations.ts";
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations";

function parseMigrationManifest(source, label) {
  const block = /const migrationEntries = \[([\s\S]*?)\] as const;/u.exec(source);
  if (block === null) {
    throw new Error(`${label}: no migrationEntries manifest block in ${MIGRATIONS_MODULE}.`);
  }
  const entries = [];
  for (const match of block[1].matchAll(/\[\s*(\d+)\s*,\s*"([^"]+)"\s*,/gu)) {
    entries.push({ id: Number(match[1]), name: match[2] });
  }
  if (entries.length === 0) {
    throw new Error(`${label}: the migrationEntries manifest block has no entries.`);
  }
  return entries;
}

// Test files carry no DDL and stay fork-editable; everything else in the
// directory is shared schema definition and must match upstream byte for byte.
function listSharedMigrationFiles(readFile, relativeNames) {
  const files = new Map();
  for (const name of relativeNames.toSorted()) {
    if (name.endsWith(".test.ts")) continue;
    files.set(`${MIGRATIONS_DIR}/${name}`, normalize(readFile(name)));
  }
  return files;
}

// Windows checkouts can read CRLF where git stores LF; compare the logical text.
const normalize = (content) => content.replace(/\r\n/gu, "\n");

const git = (args, rootDir) =>
  execFileSync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function readUpstreamSide(treeish, rootDir) {
  const manifestSource = git(["show", `${treeish}:${MIGRATIONS_MODULE}`], rootDir);
  const names = git(["ls-tree", "-r", "--name-only", treeish, "--", MIGRATIONS_DIR], rootDir)
    .split("\n")
    .filter((name) => name !== "")
    .map((name) => name.slice(MIGRATIONS_DIR.length + 1));
  return {
    manifest: parseMigrationManifest(manifestSource, `upstream base ${treeish}`),
    files: listSharedMigrationFiles(
      (name) => git(["show", `${treeish}:${MIGRATIONS_DIR}/${name}`], rootDir),
      names,
    ),
  };
}

function readForkSide(rootDir) {
  const names = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name), `${prefix}${entry.name}/`);
      else names.push(`${prefix}${entry.name}`);
    }
  };
  walk(path.join(rootDir, MIGRATIONS_DIR), "");
  return {
    manifest: parseMigrationManifest(
      fs.readFileSync(path.join(rootDir, MIGRATIONS_MODULE), "utf8"),
      "this checkout",
    ),
    files: listSharedMigrationFiles(
      (name) => fs.readFileSync(path.join(rootDir, MIGRATIONS_DIR, name), "utf8"),
      names,
    ),
  };
}

function compareSharedPersistence({ upstream, fork }) {
  const problems = [];
  const upstreamById = new Map(upstream.manifest.map((entry) => [entry.id, entry]));
  for (const entry of fork.manifest) {
    const shared = upstreamById.get(entry.id);
    if (shared === undefined) {
      problems.push(
        `fork-only migration ${entry.id}_${entry.name}: the upstream base has no migration at id ${entry.id}. ` +
          "A fork-only migration makes databases unreadable to stock T3 Code.",
      );
    } else if (shared.name !== entry.name) {
      problems.push(
        `migration manifest divergence at id ${entry.id}: ++ registers "${entry.name}", ` +
          `the upstream base registers "${shared.name}".`,
      );
    }
  }
  for (const [file, content] of fork.files) {
    const shared = upstream.files.get(file);
    if (shared === undefined) {
      problems.push(`fork-only migration file ${file}: it is not in the upstream base.`);
    } else if (shared !== content) {
      problems.push(
        `DDL divergence in ${file}: the shared migration differs from the upstream base's. ` +
          "Shared migrations are immutable once upstream ships them; merge the change from upstream instead.",
      );
    }
  }
  return problems;
}

function checkSharedPersistence({ treeish, rootDir }) {
  return {
    upstream: readUpstreamSide(treeish, rootDir),
    fork: readForkSide(rootDir),
  };
}

function main(argv) {
  const treeish = argv[2];
  if (treeish === undefined || treeish.startsWith("-")) {
    console.error(
      "usage: node .github/scripts/check-shared-persistence-compat.cjs <upstream-tree-ish>",
    );
    console.error(
      "example: git fetch https://github.com/pingdotgg/t3code main && node .github/scripts/check-shared-persistence-compat.cjs FETCH_HEAD",
    );
    return 2;
  }
  let problems;
  let migrationCount;
  try {
    const { upstream, fork } = checkSharedPersistence({ treeish, rootDir: process.cwd() });
    problems = compareSharedPersistence({ upstream, fork });
    migrationCount = fork.manifest.length;
  } catch (error) {
    console.error(`shared-persistence compatibility check failed to run: ${error.message}`);
    return 1;
  }
  if (problems.length > 0) {
    console.error("shared persistence is not compatible with stock T3 Code:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `shared persistence matches upstream base ${treeish}: ${migrationCount} shared migrations.`,
  );
  return 0;
}

module.exports = {
  compareSharedPersistence,
  checkSharedPersistence,
  parseMigrationManifest,
  readForkSide,
  readUpstreamSide,
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
