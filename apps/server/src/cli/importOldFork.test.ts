// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestConsole from "effect/testing/TestConsole";
import { CliError, Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OldForkImportError } from "../persistence/importOldFork.ts";
import {
  ImportOldForkDestinationExistsError,
  ImportOldForkServerRunningError,
  ImportOldForkSourceIsDestinationError,
  ImportOldForkSourceMissingError,
  RetryOldForkMergeDestinationMissingError,
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

// The merge only ever runs against real event-sourced databases, so retry tests seed the
// same shape the persistence-level merge tests use instead of ad-hoc tables.
interface MergeSeedEvent {
  readonly eventId: string;
  readonly aggregateKind: "project" | "thread";
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly commandId: string;
  readonly payload: Record<string, unknown>;
}

const seedProjectCreated = (input: {
  readonly eventId: string;
  readonly projectId: string;
  readonly title: string;
  readonly occurredAt: string;
}): MergeSeedEvent => ({
  eventId: input.eventId,
  aggregateKind: "project",
  streamId: input.projectId,
  streamVersion: 0,
  eventType: "project.created",
  occurredAt: input.occurredAt,
  commandId: `command:${input.eventId}`,
  payload: {
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: `/workspace/${input.projectId}`,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    deletedAt: null,
  },
});

const seedThreadCreated = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly occurredAt: string;
}): MergeSeedEvent => ({
  eventId: input.eventId,
  aggregateKind: "thread",
  streamId: input.threadId,
  streamVersion: 0,
  eventType: "thread.created",
  occurredAt: input.occurredAt,
  commandId: `command:${input.eventId}`,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const seedMergeDatabase = (dbPath: string, events: ReadonlyArray<MergeSeedEvent>) =>
  Effect.gen(function* () {
    yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    yield* Effect.sync(() => {
      const database = new NodeSqlite.DatabaseSync(dbPath);
      try {
        const insertEvent = database.prepare(`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json, application_event_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'client', ?, '{}', 2)
        `);
        for (const event of events) {
          insertEvent.run(
            event.eventId,
            event.aggregateKind,
            event.streamId,
            event.streamVersion,
            event.eventType,
            event.occurredAt,
            event.commandId,
            event.commandId,
            JSON.stringify(event.payload),
          );
        }
      } finally {
        database.close();
      }
    });
  });

const mergeHome = (root: string, name: string) => {
  const home = NodePath.join(root, name);
  const userdata = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  return { home, userdata, dbPath: NodePath.join(userdata, "statev2.sqlite") };
};

const mergeMarkerIn = (baseDir: string) =>
  NodePath.join(baseDir, "userdata", "old-fork-import-plus-plus-v1.json");

const eventIdsIn = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return database
      .prepare("SELECT event_id AS eventId FROM orchestration_events")
      .all()
      .map((row) => String((row as { eventId: unknown }).eventId))
      .sort();
  } finally {
    database.close();
  }
};

const projectIdsIn = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return database
      .prepare("SELECT project_id AS projectId FROM projection_projects")
      .all()
      .map((row) => String((row as { projectId: unknown }).projectId))
      .sort();
  } finally {
    database.close();
  }
};

const writeServerRuntimeState = (userdata: string, pid: number) => {
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(userdata, "server-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid,
      port: 3773,
      origin: "http://127.0.0.1:3773",
      startedAt: "2026-10-01T00:00:00.000Z",
    })}\n`,
  );
};

const writeMergeLock = (markerPath: string, pid: number, createdAt: string) => {
  const lockPath = `${markerPath}.lock`;
  NodeFS.mkdirSync(NodePath.dirname(markerPath), { recursive: true });
  NodeFS.writeFileSync(lockPath, `${JSON.stringify({ pid, token: "held-by-test", createdAt })}\n`);
  return lockPath;
};

const oldForkSeedEvents = [
  seedProjectCreated({
    eventId: "old-fork-project-created",
    projectId: "old-fork-project",
    title: "Old fork project",
    occurredAt: "2026-01-01T00:00:00.000Z",
  }),
  seedThreadCreated({
    eventId: "old-fork-thread-created",
    threadId: "old-fork-thread",
    projectId: "old-fork-project",
    title: "Old fork thread",
    occurredAt: "2026-01-01T00:00:01.000Z",
  }),
];

const destinationSeedEvents = [
  seedProjectCreated({
    eventId: "current-project-created",
    projectId: "current-project",
    title: "Current project",
    occurredAt: "2026-02-01T00:00:00.000Z",
  }),
  seedThreadCreated({
    eventId: "current-thread-created",
    threadId: "current-thread",
    projectId: "current-project",
    title: "Current thread",
    occurredAt: "2026-02-01T00:00:01.000Z",
  }),
];

const allSeedEventIds = [
  "old-fork-project-created",
  "old-fork-thread-created",
  "current-project-created",
  "current-thread-created",
].sort();

// Retry resolves the old fork source from the home directory and the destination from the
// default base dir, so tests point both at a temporary home and keep T3CODE_HOME unset.
const runRetryAtHome = (args: ReadonlyArray<string>, home: string) =>
  runCli(args).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOME: "" } }))),
  );

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

describe("t3 retry-old-fork-merge", () => {
  it.effect("retries the merge for the default home against the default old fork source", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const source = mergeHome(root, ".t3-fork");
        const destination = mergeHome(root, ".t3");
        yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
        yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);
        const sourceBefore = NodeFS.readFileSync(source.dbPath);

        yield* runRetryAtHome(["retry-old-fork-merge"], root);

        const markerPath = mergeMarkerIn(destination.home);
        assert.isTrue(NodeFS.existsSync(markerPath));
        assert.deepEqual(eventIdsIn(destination.dbPath), allSeedEventIds);
        assert.deepEqual(projectIdsIn(destination.dbPath), ["current-project", "old-fork-project"]);
        assert.deepEqual(NodeFS.readFileSync(source.dbPath), sourceBefore);
        const printed = (yield* TestConsole.logLines).join("\n");
        expect(printed).toContain(
          `The old fork merge from ${source.home} into ${destination.home} completed.`,
        );
        expect(printed).toContain("never resumed or deleted");
      }),
    ),
  );

  it.effect(
    "retries the merge for an explicit --base-dir while the source stays the old fork home",
    () =>
      provideCliTestLayers(
        Effect.gen(function* () {
          const root = makeBaseDir();
          const source = mergeHome(root, ".t3-fork");
          const baseDir = NodePath.join(root, "custom-install");
          const destination = mergeHome(root, "custom-install");
          yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
          yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);

          yield* runRetryAtHome(["retry-old-fork-merge", "--base-dir", baseDir], root);

          assert.isTrue(NodeFS.existsSync(mergeMarkerIn(baseDir)));
          assert.deepEqual(eventIdsIn(destination.dbPath), allSeedEventIds);
          const printed = (yield* TestConsole.logLines).join("\n");
          expect(printed).toContain(
            `The old fork merge from ${source.home} into ${destination.home} completed.`,
          );
        }),
      ),
  );

  it.effect("resumes from the marker without re-merging or touching either database", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const source = mergeHome(root, ".t3-fork");
        const destination = mergeHome(root, "custom-install");
        yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
        yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);
        const sourceBefore = NodeFS.readFileSync(source.dbPath);
        const destinationBefore = NodeFS.readFileSync(destination.dbPath);
        const markerPath = mergeMarkerIn(destination.home);
        NodeFS.writeFileSync(markerPath, '{"version":1,"mergedAt":"2026-03-01T00:00:00.000Z"}\n');
        const markerBefore = NodeFS.readFileSync(markerPath);

        yield* runRetryAtHome(["retry-old-fork-merge", "--base-dir", destination.home], root);

        assert.deepEqual(NodeFS.readFileSync(source.dbPath), sourceBefore);
        assert.deepEqual(NodeFS.readFileSync(destination.dbPath), destinationBefore);
        assert.deepEqual(NodeFS.readFileSync(markerPath), markerBefore);
        assert.deepEqual(eventIdsIn(destination.dbPath), [
          "current-project-created",
          "current-thread-created",
        ]);
      }),
    ),
  );

  it.effect("refuses while a live server owns the destination and never starts the merge", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const source = mergeHome(root, ".t3-fork");
        const destination = mergeHome(root, "custom-install");
        yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
        yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);
        const destinationBefore = NodeFS.readFileSync(destination.dbPath);
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        writeServerRuntimeState(destination.userdata, child.pid);

        const error = yield* runRetryAtHome(
          ["retry-old-fork-merge", "--base-dir", destination.home],
          root,
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ImportOldForkServerRunningError);
        expect(String(error)).toContain(`pid ${child.pid}`);
        assert.deepEqual(NodeFS.readFileSync(destination.dbPath), destinationBefore);
        assert.equal(NodeFS.existsSync(mergeMarkerIn(destination.home)), false);
      }),
    ),
  );

  it.effect("retries across a stale server claim whose pid is no longer alive", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const source = mergeHome(root, ".t3-fork");
        const destination = mergeHome(root, "custom-install");
        yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
        yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);
        const exitedPid = yield* Effect.promise(async () => {
          const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.exit(0)"]);
          await NodeEvents.EventEmitter.once(child, "exit");
          assert(child.pid !== undefined);
          return child.pid;
        });
        writeServerRuntimeState(destination.userdata, exitedPid);

        yield* runRetryAtHome(["retry-old-fork-merge", "--base-dir", destination.home], root);

        assert.isTrue(NodeFS.existsSync(mergeMarkerIn(destination.home)));
        assert.deepEqual(eventIdsIn(destination.dbPath), allSeedEventIds);
      }),
    ),
  );

  it.effect("refuses while a live server owns the old fork home", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const source = mergeHome(root, ".t3-fork");
        const destination = mergeHome(root, "custom-install");
        yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
        yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);
        const destinationBefore = NodeFS.readFileSync(destination.dbPath);
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        writeServerRuntimeState(source.userdata, child.pid);

        const error = yield* runRetryAtHome(
          ["retry-old-fork-merge", "--base-dir", destination.home],
          root,
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(OldForkImportError);
        expect(String(error)).toContain("still running");
        assert.deepEqual(NodeFS.readFileSync(destination.dbPath), destinationBefore);
        assert.equal(NodeFS.existsSync(mergeMarkerIn(destination.home)), false);
      }),
    ),
  );

  it.effect("reports a destination that does not exist yet", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const source = mergeHome(root, ".t3-fork");
        const destination = mergeHome(root, "custom-install");
        yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);

        const error = yield* runRetryAtHome(
          ["retry-old-fork-merge", "--base-dir", destination.home],
          root,
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(RetryOldForkMergeDestinationMissingError);
        expect(String(error)).toContain("does not exist yet");
        assert.equal(NodeFS.existsSync(destination.dbPath), false);
        assert.equal(NodeFS.existsSync(mergeMarkerIn(destination.home)), false);
      }),
    ),
  );

  it.effect("reports an old fork source that does not exist", () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const root = makeBaseDir();
        const destination = mergeHome(root, "custom-install");
        yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);

        const error = yield* runRetryAtHome(
          ["retry-old-fork-merge", "--base-dir", destination.home],
          root,
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ImportOldForkSourceMissingError);
        const sourcePath = NodePath.join(root, ".t3-fork", "userdata", "statev2.sqlite");
        expect(String(error)).toContain(sourcePath);
        assert.equal(NodeFS.existsSync(mergeMarkerIn(destination.home)), false);
      }),
    ),
  );

  it.effect(
    "reports a merge lock held by a live process without claiming success or touching state",
    () =>
      provideCliTestLayers(
        Effect.gen(function* () {
          const root = makeBaseDir();
          const source = mergeHome(root, ".t3-fork");
          const destination = mergeHome(root, "custom-install");
          yield* seedMergeDatabase(source.dbPath, oldForkSeedEvents);
          yield* seedMergeDatabase(destination.dbPath, destinationSeedEvents);
          const sourceBefore = NodeFS.readFileSync(source.dbPath);
          const destinationBefore = NodeFS.readFileSync(destination.dbPath);
          const holder = NodeChildProcess.spawn(
            process.execPath,
            ["-e", "setTimeout(() => {}, 60000)"],
            {
              stdio: "ignore",
            },
          );
          const holderExit = NodeEvents.EventEmitter.once(holder, "exit").catch(() => undefined);
          assert.isNumber(holder.pid);
          const lockPath = writeMergeLock(
            mergeMarkerIn(destination.home),
            holder.pid as number,
            DateTime.formatIso(yield* DateTime.now),
          );
          const lockBefore = NodeFS.readFileSync(lockPath);

          const error = yield* runRetryAtHome(
            ["retry-old-fork-merge", "--base-dir", destination.home],
            root,
          ).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CliError.UserError);
          expect(String(error)).toContain("already merging");
          assert.deepEqual(NodeFS.readFileSync(source.dbPath), sourceBefore);
          assert.deepEqual(NodeFS.readFileSync(destination.dbPath), destinationBefore);
          assert.equal(NodeFS.existsSync(mergeMarkerIn(destination.home)), false);
          assert.equal(NodeFS.existsSync(`${mergeMarkerIn(destination.home)}.state`), false);
          assert.deepEqual(NodeFS.readFileSync(lockPath), lockBefore);
          const printed = (yield* TestConsole.logLines).join("\n");
          expect(printed).not.toContain("completed");
          holder.kill();
          yield* Effect.promise(() => holderExit);
        }),
      ),
  );
});
