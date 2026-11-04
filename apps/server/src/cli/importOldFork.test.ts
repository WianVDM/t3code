// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import {
  ImportOldForkDestinationExistsError,
  ImportOldForkServerRunningError,
  ImportOldForkSourceIsDestinationError,
  ImportOldForkSourceMissingError,
} from "./importOldFork.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    effect,
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
  );

const makeBaseDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-import-old-fork-"));

const sourceIn = (baseDir: string) => NodePath.join(baseDir, "old-fork", "statev2.sqlite");
const destinationFor = (baseDir: string) => NodePath.join(baseDir, "userdata", "statev2.sqlite");

const makeDatabase = (databasePath: string, table: string) => {
  NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(`CREATE TABLE ${table} (note TEXT)`);
    database.prepare(`INSERT INTO ${table} VALUES (?)`).run(`from ${table}`);
  } finally {
    database.close();
  }
};

const tableNotes = (databasePath: string, table: string): Array<string> => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(`SELECT note FROM ${table}`)
      .all()
      .map((row) => String((row as { note: unknown }).note));
  } finally {
    database.close();
  }
};

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

describe("t3 import-old-fork", () => {
  it.effect("imports into a missing destination and says running turns are not resumed", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const sourcePath = sourceIn(baseDir);
        makeDatabase(sourcePath, "old_fork_marker");

        yield* runCli(["import-old-fork", "--source", sourcePath, "--base-dir", baseDir]);

        const destinationPath = destinationFor(baseDir);
        assert.deepEqual(tableNotes(destinationPath, "old_fork_marker"), ["from old_fork_marker"]);
        const printed = (yield* TestConsole.logLines).join("\n");
        expect(printed).toContain(`Imported ${sourcePath} into ${destinationPath}`);
        expect(printed).toContain("not resumed");
      }),
    ),
  );

  it.effect("reports a destination that already exists and never overwrites it", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const sourcePath = sourceIn(baseDir);
        makeDatabase(sourcePath, "old_fork_marker");
        const destinationPath = destinationFor(baseDir);
        makeDatabase(destinationPath, "existing_marker");

        const error = yield* runCli([
          "import-old-fork",
          "--source",
          sourcePath,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ImportOldForkDestinationExistsError);
        expect(String(error)).toContain("already exists");
        assert.deepEqual(tableNotes(destinationPath, "existing_marker"), ["from existing_marker"]);
        assert.throws(() => tableNotes(destinationPath, "old_fork_marker"));
      }),
    ),
  );

  it.effect("refuses while a live server owns the destination", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const sourcePath = sourceIn(baseDir);
        makeDatabase(sourcePath, "old_fork_marker");
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(baseDir, "userdata", "server-runtime.json"),
          `${JSON.stringify({
            version: 1,
            pid: child.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          })}\n`,
        );

        const error = yield* runCli([
          "import-old-fork",
          "--source",
          sourcePath,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ImportOldForkServerRunningError);
        expect(String(error)).toContain(`pid ${child.pid}`);
        assert.equal(NodeFS.existsSync(destinationFor(baseDir)), false);
      }),
    ),
  );

  it.effect("refuses its own destination database as the source", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const destinationPath = destinationFor(baseDir);
        makeDatabase(destinationPath, "existing_marker");

        const error = yield* runCli([
          "import-old-fork",
          "--source",
          destinationPath,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ImportOldForkSourceIsDestinationError);
        assert.deepEqual(tableNotes(destinationPath, "existing_marker"), ["from existing_marker"]);
      }),
    ),
  );

  it.effect("requires an explicit source and imports nothing without one", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = makeBaseDir();

        const result = yield* runCli(["import-old-fork", "--base-dir", baseDir]).pipe(
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert.equal(NodeFS.existsSync(destinationFor(baseDir)), false);
      }),
    ),
  );

  it.effect("reports a source that does not exist", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const sourcePath = sourceIn(baseDir);

        const error = yield* runCli([
          "import-old-fork",
          "--source",
          sourcePath,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ImportOldForkSourceMissingError);
        assert.equal(NodeFS.existsSync(destinationFor(baseDir)), false);
      }),
    ),
  );
});
