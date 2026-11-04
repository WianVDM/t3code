// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { importOldForkDatabase, mergeOldForkDatabase } from "./importOldFork.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
      }).pipe(Effect.provide(layerDatabase));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

const seedOldFork = (sourcePath: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 55 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'Old fork thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO orchestration_v2_events (event_id, command_id, thread_id, event_type, occurred_at, payload_json)
      VALUES ('old-fork-event', 'old-fork-command', ${threadId}, 'thread.created', '2026-01-01T00:00:00.000Z', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
      VALUES ('old-fork-effect', 'old-fork-command', ${threadId}, 'startTurn', '{}', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at)
      VALUES (${threadId}, 'codex', 'codex', 'live', '2026-01-01T00:00:00.000Z')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

it.effect(
  "imports an old fork V2 snapshot into a missing destination, preserving ids without live runtime state",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-old-fork-"));
    const sourcePath = NodePath.join(directory, "old-fork.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("old-fork-thread");
    return Effect.gen(function* () {
      yield* seedOldFork(sourcePath, threadId);
      const original = NodeFS.readFileSync(sourcePath);
      yield* importOldForkDatabase(sourcePath, destinationPath);
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const imported = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(imported.prepare("SELECT thread_id FROM projection_threads").all(), [
          { thread_id: threadId },
        ]);
        assert.deepEqual(imported.prepare("SELECT event_id FROM orchestration_v2_events").all(), [
          { event_id: "old-fork-event" },
        ]);
        assert.equal(
          imported.prepare("SELECT count(*) AS count FROM orchestration_v2_effect_outbox").get()
            ?.count,
          0,
        );
        assert.equal(
          imported.prepare("SELECT count(*) AS count FROM provider_session_runtime").get()?.count,
          0,
        );
      } finally {
        imported.close();
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("rejects importing an old fork database onto itself", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-old-fork-self-"));
  const sourcePath = NodePath.join(directory, "old-fork.sqlite");
  const threadId = ThreadId.make("old-fork-thread");
  return Effect.gen(function* () {
    yield* seedOldFork(sourcePath, threadId);
    const original = NodeFS.readFileSync(sourcePath);
    const result = yield* Effect.result(importOldForkDatabase(sourcePath, sourcePath));
    assert.equal(result._tag, "Failure");
    assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("leaves an existing V2 destination untouched when importing an old fork", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-old-fork-dest-"));
  const sourcePath = NodePath.join(directory, "old-fork.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  const threadId = ThreadId.make("old-fork-thread");
  return Effect.gen(function* () {
    yield* seedOldFork(sourcePath, threadId);
    const destination = new NodeSqlite.DatabaseSync(destinationPath);
    try {
      destination.exec(
        "CREATE TABLE v2_work (text TEXT); INSERT INTO v2_work VALUES ('existing V2 work');",
      );
    } finally {
      destination.close();
    }
    yield* Effect.result(importOldForkDatabase(sourcePath, destinationPath));
    const checked = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
    try {
      assert.deepEqual(checked.prepare("SELECT text FROM v2_work").all(), [
        { text: "existing V2 work" },
      ]);
      assert.equal(
        checked.prepare("SELECT count(*) AS count FROM projection_threads").get()?.count,
        0,
      );
      assert.equal(
        checked.prepare("SELECT count(*) AS count FROM orchestration_v2_events").get()?.count,
        0,
      );
    } finally {
      checked.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("removes copies left by a killed start, but not one that is still running", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-abandoned-"));
  const killed = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
  const running = `.v2-import-${process.pid}-Kq81Zx`;
  const unrelated = ".v2-import-not-a-copy";
  return Effect.gen(function* () {
    for (const name of [`.v2-import-${killed}-Wm3nPa`, ".v2-import-Q3xZ9a", running]) {
      NodeFS.mkdirSync(NodePath.join(directory, name));
      NodeFS.writeFileSync(NodePath.join(directory, name, "snapshot.sqlite"), "partial copy");
    }
    NodeFS.mkdirSync(NodePath.join(directory, unrelated));
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    NodeFS.writeFileSync(destinationPath, "existing V2 database");
    yield* initializeV2Database(destinationPath);
    assert.deepEqual(
      NodeFS.readdirSync(directory).sort(),
      [running, unrelated, "statev2.sqlite"].sort(),
    );
    assert.equal(NodeFS.readFileSync(destinationPath, "utf8"), "existing V2 database");
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

const mergeHome = (directory: string, name: string) => {
  const home = NodePath.join(directory, name);
  const userdata = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  return { home, userdata, dbPath: NodePath.join(userdata, "statev2.sqlite") };
};

interface MergeEvent {
  readonly eventId: string;
  readonly aggregateKind: "project" | "thread";
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly commandId: string;
  readonly payload: Record<string, unknown>;
  readonly causationEventId?: string | null;
}

const projectCreated = (input: {
  readonly eventId: string;
  readonly projectId: string;
  readonly title: string;
  readonly occurredAt: string;
}): MergeEvent => ({
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

const threadPayload = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly occurredAt: string;
}) => ({
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
});

const threadEvent = (input: {
  readonly eventId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly occurredAt: string;
  readonly streamVersion?: number;
  readonly eventType?: "thread.created" | "thread.metadata-updated";
  readonly causationEventId?: string | null;
}): MergeEvent => ({
  eventId: input.eventId,
  aggregateKind: "thread",
  streamId: input.threadId,
  streamVersion: input.streamVersion ?? 0,
  eventType: input.eventType ?? "thread.created",
  occurredAt: input.occurredAt,
  commandId: `command:${input.eventId}`,
  causationEventId: input.causationEventId ?? null,
  payload: threadPayload(input),
});

const seedMergeDatabase = (
  dbPath: string,
  events: ReadonlyArray<MergeEvent>,
  receipts: ReadonlyArray<{
    readonly commandId: string;
    readonly aggregateId: string;
    readonly resultEventId: string;
  }> = [],
) =>
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?, '{}', 2)
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
            event.causationEventId ?? null,
            event.commandId,
            JSON.stringify(event.payload),
          );
        }
        const findSequence = database.prepare(
          "SELECT sequence FROM orchestration_events WHERE event_id = ?",
        );
        const insertReceipt = database.prepare(`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
            status, command_type
          ) VALUES (?, 'thread', ?, ?, ?, 'accepted', 'thread.create')
        `);
        for (const receipt of receipts) {
          const row = findSequence.get(receipt.resultEventId);
          if (row === undefined) throw new Error(`Missing event ${receipt.resultEventId}`);
          insertReceipt.run(
            receipt.commandId,
            receipt.aggregateId,
            "2026-01-01T00:00:00.000Z",
            row.sequence as number,
          );
        }
      } finally {
        database.close();
      }
    });
  });

const seedRuntimeState = (dbPath: string, prefix: string) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(dbPath);
    try {
      database
        .prepare(
          `INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at)
           VALUES (?, 'codex', 'codex', 'live', '2026-01-01T00:00:00.000Z')`,
        )
        .run(`${prefix}-runtime`);
      database
        .prepare(
          `INSERT INTO orchestration_v2_effect_outbox (
             effect_id, command_id, thread_id, effect_type, payload_json, status,
             available_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'startTurn', '{}', 'pending', ?, ?, ?)`,
        )
        .run(
          `${prefix}-effect`,
          `${prefix}-command`,
          `${prefix}-thread`,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
      database
        .prepare(
          `INSERT INTO scheduled_tasks (
             task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
             workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
             created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
             last_run_status, last_run_error, run_count
           ) VALUES (?, 'Task', 'Prompt', 1, '{"type":"interval","everyMs":60000}', ?, NULL,
             '{}', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
             'user', 'web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             NULL, NULL, 'never', NULL, 0)`,
        )
        .run(`${prefix}-task`, `${prefix}-project`);
      database
        .prepare(
          `INSERT INTO auth_sessions (
             session_id, subject, scopes, method, issued_at, expires_at
           ) VALUES (?, ?, '["read"]', 'pairing', '2026-01-01T00:00:00.000Z',
             '2027-01-01T00:00:00.000Z')`,
        )
        .run(`${prefix}-session`, prefix);
      database
        .prepare(
          `INSERT INTO auth_pairing_links (
             id, credential, method, scopes, subject, created_at, expires_at
           ) VALUES (?, ?, 'pairing', '["read"]', ?, '2026-01-01T00:00:00.000Z',
             '2027-01-01T00:00:00.000Z')`,
        )
        .run(`${prefix}-pairing`, `${prefix}-credential`, prefix);
    } finally {
      database.close();
    }
  });

const seedBasicMergeHomes = (directory: string) =>
  Effect.gen(function* () {
    const source = mergeHome(directory, "source");
    const destination = mergeHome(directory, "destination");
    const markerPath = NodePath.join(directory, "old-fork-merge.marker");
    yield* seedMergeDatabase(source.dbPath, [
      projectCreated({
        eventId: "source-project-created",
        projectId: "source-project",
        title: "Source project",
        occurredAt: "2026-01-01T00:00:00.000Z",
      }),
      threadEvent({
        eventId: "source-thread-created",
        threadId: "source-thread",
        projectId: "source-project",
        title: "Source thread",
        occurredAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    yield* seedMergeDatabase(destination.dbPath, [
      projectCreated({
        eventId: "destination-project-created",
        projectId: "destination-project",
        title: "Destination project",
        occurredAt: "2026-01-01T00:00:02.000Z",
      }),
      threadEvent({
        eventId: "destination-thread-created",
        threadId: "destination-thread",
        projectId: "destination-project",
        title: "Destination thread",
        occurredAt: "2026-01-01T00:00:03.000Z",
      }),
    ]);
    return { source, destination, markerPath };
  });

it.effect(
  "merges shared ancestry with old-fork-wins streams and retains destination-only history",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-shared-"));
    const source = mergeHome(directory, "source");
    const destination = mergeHome(directory, "destination");
    const markerPath = NodePath.join(directory, "old-fork-merge.marker");
    return Effect.gen(function* () {
      const sharedProject = projectCreated({
        eventId: "shared-project-created",
        projectId: "shared-project",
        title: "Shared project",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
      const sharedThreadCreated = threadEvent({
        eventId: "shared-thread-created",
        threadId: "shared-thread",
        projectId: "shared-project",
        title: "Old fork thread",
        occurredAt: "2026-01-01T00:00:01.000Z",
      });
      yield* seedMergeDatabase(
        source.dbPath,
        [
          sharedProject,
          sharedThreadCreated,
          threadEvent({
            eventId: "old-fork-wins",
            threadId: "shared-thread",
            projectId: "shared-project",
            title: "Old fork wins",
            occurredAt: "2026-01-01T00:00:02.000Z",
            streamVersion: 1,
            eventType: "thread.metadata-updated",
          }),
        ],
        [
          {
            commandId: "command:old-fork-wins",
            aggregateId: "shared-thread",
            resultEventId: "old-fork-wins",
          },
        ],
      );
      yield* seedMergeDatabase(
        destination.dbPath,
        [
          sharedProject,
          sharedThreadCreated,
          threadEvent({
            eventId: "destination-loses",
            threadId: "shared-thread",
            projectId: "shared-project",
            title: "Destination loses",
            occurredAt: "2026-01-01T00:00:02.000Z",
            streamVersion: 1,
            eventType: "thread.metadata-updated",
          }),
          projectCreated({
            eventId: "destination-project-created",
            projectId: "destination-project",
            title: "Destination project",
            occurredAt: "2026-01-01T00:00:03.000Z",
          }),
          threadEvent({
            eventId: "destination-thread-created",
            threadId: "destination-thread",
            projectId: "destination-project",
            title: "Destination thread",
            occurredAt: "2026-01-01T00:00:04.000Z",
          }),
        ],
        [
          {
            commandId: "command:destination-loses",
            aggregateId: "shared-thread",
            resultEventId: "destination-loses",
          },
          {
            commandId: "command:destination-thread-created",
            aggregateId: "destination-thread",
            resultEventId: "destination-thread-created",
          },
        ],
      );
      const sourceBefore = NodeFS.readFileSync(source.dbPath);

      yield* mergeOldForkDatabase({
        sourceHome: source.home,
        destinationHome: destination.home,
        markerPath,
      });

      assert.deepEqual(NodeFS.readFileSync(source.dbPath), sourceBefore);
      assert.isTrue(NodeFS.existsSync(markerPath));
      const merged = new NodeSqlite.DatabaseSync(destination.dbPath, { readOnly: true });
      try {
        const events = merged
          .prepare(
            `SELECT event_id AS eventId, sequence, aggregate_kind AS aggregateKind,
                    stream_id AS streamId, stream_version AS streamVersion
             FROM orchestration_events ORDER BY sequence`,
          )
          .all();
        assert.deepEqual(
          events.map((event) => event.eventId),
          [
            "shared-project-created",
            "shared-thread-created",
            "old-fork-wins",
            "destination-project-created",
            "destination-thread-created",
          ],
        );
        assert.deepEqual(
          events.map((event) => event.sequence),
          [1, 2, 3, 4, 5],
        );
        assert.deepEqual(
          events.map((event) => [event.streamId, event.streamVersion]),
          [
            ["shared-project", 0],
            ["shared-thread", 0],
            ["shared-thread", 1],
            ["destination-project", 0],
            ["destination-thread", 0],
          ],
        );
        assert.deepEqual(
          merged
            .prepare("SELECT project_id AS projectId FROM projection_projects ORDER BY project_id")
            .all()
            .map((project) => project.projectId),
          ["destination-project", "shared-project"],
        );
        const threads = merged
          .prepare(
            `SELECT thread_id AS threadId, title FROM orchestration_v2_projection_threads
             ORDER BY thread_id`,
          )
          .all();
        assert.deepEqual(
          threads.map((thread) => [thread.threadId, thread.title]),
          [
            ["destination-thread", "Destination thread"],
            ["shared-thread", "Old fork wins"],
          ],
        );
        assert.equal(
          merged
            .prepare(
              `SELECT last_sequence AS lastSequence FROM orchestration_v2_projection_metadata
               WHERE projection_name = 'thread-projections'`,
            )
            .get()?.lastSequence,
          5,
        );
        assert.deepEqual(
          merged
            .prepare(
              `SELECT receipt.command_id AS commandId, receipt.result_sequence AS resultSequence,
                      event.event_id AS eventId
               FROM orchestration_command_receipts AS receipt
               JOIN orchestration_events AS event ON event.sequence = receipt.result_sequence
               ORDER BY receipt.command_id`,
            )
            .all(),
          [
            {
              commandId: "command:destination-thread-created",
              resultSequence: 5,
              eventId: "destination-thread-created",
            },
            {
              commandId: "command:old-fork-wins",
              resultSequence: 3,
              eventId: "old-fork-wins",
            },
          ],
        );
        // The discarded destination event takes its receipt with it instead of leaving a dangling row.
        assert.deepEqual(
          merged
            .prepare(
              `SELECT command_id AS commandId FROM orchestration_command_receipts
               ORDER BY command_id`,
            )
            .all()
            .map((receipt) => receipt.commandId),
          ["command:destination-thread-created", "command:old-fork-wins"],
        );
        assert.deepEqual(merged.prepare("PRAGMA foreign_key_check").all(), []);
        assert.deepEqual(merged.prepare("PRAGMA integrity_check").all(), [
          { integrity_check: "ok" },
        ]);
      } finally {
        merged.close();
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("keeps destination live state and never imports the old fork's live state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-live-"));
  return Effect.gen(function* () {
    const { source, destination, markerPath } = yield* seedBasicMergeHomes(directory);
    yield* seedRuntimeState(source.dbPath, "source");
    yield* seedRuntimeState(destination.dbPath, "destination");

    yield* mergeOldForkDatabase({
      sourceHome: source.home,
      destinationHome: destination.home,
      markerPath,
    });

    const merged = new NodeSqlite.DatabaseSync(destination.dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        merged
          .prepare("SELECT thread_id AS threadId FROM provider_session_runtime")
          .all()
          .map((row) => row.threadId),
        ["destination-runtime"],
      );
      assert.deepEqual(
        merged
          .prepare("SELECT effect_id AS effectId FROM orchestration_v2_effect_outbox")
          .all()
          .map((row) => row.effectId),
        ["destination-effect"],
      );
      assert.deepEqual(
        merged
          .prepare("SELECT task_id AS taskId FROM scheduled_tasks")
          .all()
          .map((row) => row.taskId),
        ["destination-task"],
      );
      assert.deepEqual(
        merged
          .prepare("SELECT session_id AS sessionId FROM auth_sessions")
          .all()
          .map((row) => row.sessionId),
        ["destination-session"],
      );
      assert.deepEqual(
        merged
          .prepare("SELECT id FROM auth_pairing_links")
          .all()
          .map((row) => row.id),
        ["destination-pairing"],
      );
    } finally {
      merged.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("overlays old-fork settings and themes without touching secrets", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-settings-"));
  return Effect.gen(function* () {
    const { source, destination, markerPath } = yield* seedBasicMergeHomes(directory);
    const write = (filePath: string, contents: string) => {
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, contents);
    };
    write(NodePath.join(destination.userdata, "settings.json"), '{"from":"destination"}');
    write(NodePath.join(source.userdata, "settings.json"), '{"from":"source"}');
    write(NodePath.join(destination.userdata, "keybindings.json"), '{"from":"destination"}');
    write(NodePath.join(source.userdata, "keybindings.json"), '{"from":"source"}');
    write(NodePath.join(destination.userdata, "model-manifest.json"), '{"from":"destination"}');
    write(NodePath.join(source.userdata, "model-manifest.json"), '{"from":"source"}');
    write(NodePath.join(destination.userdata, "themes", "destination-only.json"), "destination");
    write(NodePath.join(source.userdata, "themes", "source-only.json"), "source");
    write(NodePath.join(destination.userdata, "themes", "shared.json"), "destination");
    write(NodePath.join(source.userdata, "themes", "shared.json"), "source");
    write(
      NodePath.join(destination.userdata, "secrets", "destination-secret.bin"),
      "destination secret",
    );
    write(NodePath.join(source.userdata, "secrets", "source-secret.bin"), "source secret");
    const sourceSettings = NodeFS.readFileSync(
      NodePath.join(source.userdata, "settings.json"),
      "utf8",
    );

    yield* mergeOldForkDatabase({
      sourceHome: source.home,
      destinationHome: destination.home,
      markerPath,
    });

    assert.equal(
      NodeFS.readFileSync(NodePath.join(destination.userdata, "settings.json"), "utf8"),
      sourceSettings,
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(destination.userdata, "keybindings.json"), "utf8"),
      '{"from":"source"}',
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(destination.userdata, "model-manifest.json"), "utf8"),
      '{"from":"source"}',
    );
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(destination.userdata, "themes")).sort(), [
      "destination-only.json",
      "shared.json",
      "source-only.json",
    ]);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(destination.userdata, "themes", "shared.json"), "utf8"),
      "source",
    );
    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(destination.userdata, "themes", "destination-only.json"),
        "utf8",
      ),
      "destination",
    );
    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(destination.userdata, "secrets", "destination-secret.bin"),
        "utf8",
      ),
      "destination secret",
    );
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(destination.userdata, "secrets", "source-secret.bin")),
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(source.userdata, "settings.json"), "utf8"),
      sourceSettings,
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("retries from the marker without duplicating merged history", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-retry-"));
  return Effect.gen(function* () {
    const { source, destination, markerPath } = yield* seedBasicMergeHomes(directory);
    const sourceBefore = NodeFS.readFileSync(source.dbPath);

    yield* mergeOldForkDatabase({
      sourceHome: source.home,
      destinationHome: destination.home,
      markerPath,
    });
    const eventsAfterFirst = new NodeSqlite.DatabaseSync(destination.dbPath, { readOnly: true });
    const firstIds = eventsAfterFirst
      .prepare("SELECT event_id AS eventId FROM orchestration_events ORDER BY sequence")
      .all()
      .map((event) => event.eventId);
    eventsAfterFirst.close();

    yield* mergeOldForkDatabase({
      sourceHome: source.home,
      destinationHome: destination.home,
      markerPath,
    });

    const merged = new NodeSqlite.DatabaseSync(destination.dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        merged
          .prepare("SELECT event_id AS eventId FROM orchestration_events ORDER BY sequence")
          .all()
          .map((event) => event.eventId),
        firstIds,
      );
      assert.deepEqual(
        merged
          .prepare(
            "SELECT thread_id AS threadId FROM orchestration_v2_projection_threads ORDER BY thread_id",
          )
          .all()
          .map((thread) => thread.threadId),
        ["destination-thread", "source-thread"],
      );
    } finally {
      merged.close();
    }
    assert.isTrue(NodeFS.existsSync(markerPath));
    assert.deepEqual(NodeFS.readFileSync(source.dbPath), sourceBefore);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("aborts an invalid conflict without changing the destination", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-conflict-"));
  const source = mergeHome(directory, "source");
  const destination = mergeHome(directory, "destination");
  const markerPath = NodePath.join(directory, "old-fork-merge.marker");
  return Effect.gen(function* () {
    const sharedProject = projectCreated({
      eventId: "shared-project-created",
      projectId: "shared-project",
      title: "Shared project",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    const sharedThread = threadEvent({
      eventId: "shared-thread-created",
      threadId: "shared-thread",
      projectId: "shared-project",
      title: "Shared thread",
      occurredAt: "2026-01-01T00:00:01.000Z",
    });
    yield* seedMergeDatabase(source.dbPath, [
      sharedProject,
      sharedThread,
      threadEvent({
        eventId: "duplicate-selected-event",
        threadId: "shared-thread",
        projectId: "shared-project",
        title: "Source conflict",
        occurredAt: "2026-01-01T00:00:02.000Z",
        streamVersion: 1,
        eventType: "thread.metadata-updated",
      }),
    ]);
    yield* seedMergeDatabase(destination.dbPath, [
      sharedProject,
      sharedThread,
      projectCreated({
        eventId: "destination-project-created",
        projectId: "destination-project",
        title: "Destination project",
        occurredAt: "2026-01-01T00:00:03.000Z",
      }),
      threadEvent({
        eventId: "destination-thread-created",
        threadId: "destination-thread",
        projectId: "destination-project",
        title: "Destination thread",
        occurredAt: "2026-01-01T00:00:04.000Z",
      }),
      threadEvent({
        eventId: "duplicate-selected-event",
        threadId: "destination-thread",
        projectId: "destination-project",
        title: "Destination conflict",
        occurredAt: "2026-01-01T00:00:05.000Z",
        streamVersion: 1,
        eventType: "thread.metadata-updated",
      }),
    ]);
    const sourceBefore = NodeFS.readFileSync(source.dbPath);
    const destinationBefore = NodeFS.readFileSync(destination.dbPath);

    const result = yield* Effect.result(
      mergeOldForkDatabase({
        sourceHome: source.home,
        destinationHome: destination.home,
        markerPath,
      }),
    );

    assert.equal(result._tag, "Failure");
    assert.deepEqual(NodeFS.readFileSync(destination.dbPath), destinationBefore);
    assert.deepEqual(NodeFS.readFileSync(source.dbPath), sourceBefore);
    assert.isFalse(NodeFS.existsSync(markerPath));
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
