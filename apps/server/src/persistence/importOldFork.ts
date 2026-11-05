// @effect-diagnostics nodeBuiltinImport:off - O_EXCL lock creation and owned release need native fs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { isWindowsRenameLock, writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { rebuildMessageSearch } from "../orchestration-v2/messageSearchIndex.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { runMigrations } from "./Migrations.ts";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";
import { overlayOldForkFiles } from "./importOldForkSettings.ts";

export class OldForkImportError extends Schema.TaggedError<OldForkImportError>()(
  "OldForkImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not import the old fork database at ${this.sourcePath} to ${this.destinationPath}: ${describeCause(this.cause)}`;
  }
}

const isOldForkImportError = Schema.is(OldForkImportError);

class OldForkMergeError extends Schema.TaggedError<OldForkMergeError>()("OldForkMergeError", {
  reason: Schema.String,
  terminal: Schema.Boolean,
}) {
  override get message() {
    return this.reason;
  }
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    // Effect wrappers can carry null-prototype payloads that String() cannot render.
    return "unknown error";
  }
};

// These rows are live work, not history: an imported row would resume an agent process on the
// next boot. Command receipts and projections stay with the events they record.
const LIVE_STATE_TABLES = [
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "provider_session_runtime",
  "scheduled_tasks",
  "scheduled_task_webhook_pending",
  "scheduled_task_webhook_relay_deliveries",
  "auth_sessions",
  "auth_pairing_links",
] as const;

const clearLiveState = (snapshotPath: string): void => {
  const database = new NodeSqlite.DatabaseSync(snapshotPath);
  try {
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of LIVE_STATE_TABLES) {
      if (tables.has(table)) database.exec(`DELETE FROM "${table}"`);
    }
  } finally {
    database.close();
  }
};

/** Copies committed WAL data without ever writing to the opened database. */
const backupDatabase = async (fromPath: string, toPath: string): Promise<void> => {
  const database = new NodeSqlite.DatabaseSync(fromPath, { readOnly: true });
  try {
    await NodeSqlite.backup(database, toPath);
  } finally {
    database.close();
  }
};

/** Imports an old fork's V2 database as the destination database, without its live runtime state. */
export const importOldForkDatabase = Effect.fn("importOldForkDatabase")(function* (
  sourcePath: string,
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  const sameFile =
    source === destination ||
    (yield* Effect.gen(function* () {
      return (yield* fs.realPath(source)) === (yield* fs.realPath(destination));
    }).pipe(Effect.orElseSucceed(() => false)));
  if (sameFile) {
    return yield* new OldForkImportError({
      sourcePath,
      destinationPath,
      cause: new Error("The source and destination are the same database file."),
    });
  }
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(destination))) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(destination),
            prefix: `.v2-import-${process.pid}-`,
          });
          const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
          yield* Effect.tryPromise(() => backupDatabase(source, snapshotPath));
          yield* Effect.try(() => clearLiveState(snapshotPath));
          // Publish only a complete snapshot, without replacing an existing database.
          yield* fs.link(snapshotPath, destination).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists",
              () => Effect.void,
            ),
          );
        }),
      );
    }
    yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: destination })));
  }).pipe(
    Effect.mapError((cause) => new OldForkImportError({ sourcePath, destinationPath, cause })),
  );
});

export interface MergeOldForkInput {
  readonly sourceHome: string;
  readonly destinationHome: string;
  readonly markerPath: string;
  readonly retryTerminal?: boolean;
}

export type MergeOldForkOutcome =
  | { readonly status: "done" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "busy" };

// Far beyond any real sequence; parks destination rows while merged rows take the low numbers.
const MERGE_SEQUENCE_OFFSET = 1_000_000_000_000;

interface EventMetadataRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly aggregate_kind: string;
  readonly stream_id: string;
  readonly command_id: string | null;
  readonly causation_event_id: string | null;
}

interface PlannedEvent {
  readonly origin: "source" | "destination";
  readonly row: EventMetadataRow;
  newSequence: number;
  newStreamVersion: number;
}

interface ReceiptRow {
  readonly command_id: string;
  readonly aggregate_kind: string;
  readonly aggregate_id: string;
  readonly accepted_at: string;
  readonly result_sequence: number;
  readonly status: string;
  readonly error: string | null;
  readonly command_type: string;
}

const streamKey = (row: { aggregate_kind: string; stream_id: string }) =>
  `${row.aggregate_kind}\u0000${row.stream_id}`;

/**
 * Rewrites the candidate's canonical event log as: every old-fork stream in full, winning shared
 * streams, plus destination-only streams, resequenced contiguously. Synchronous raw sqlite on two
 * connections; throws on any unsupported conflict so the caller discards the candidate.
 */
const mergeCanonicalHistory = (sourcePath: string, candidatePath: string): void => {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  const candidate = new NodeSqlite.DatabaseSync(candidatePath);
  try {
    const tableInfo = (database: NodeSqlite.DatabaseSync) =>
      database.prepare("PRAGMA table_info('orchestration_events')").all() as Array<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: NodeSqlite.SQLInputValue;
        readonly pk: number;
      }>;
    const sourceColumns = tableInfo(source);
    const destinationColumns = tableInfo(candidate);
    if (JSON.stringify(sourceColumns) !== JSON.stringify(destinationColumns)) {
      throw new Error(
        "The source and destination event tables have different columns; this history cannot be merged.",
      );
    }
    const eventColumns = sourceColumns.map((column) => column.name);
    const quotedEventColumns = eventColumns
      .map((name) => `"${name.replaceAll('"', '""')}"`)
      .join(", ");

    const metadataSql = `
      SELECT sequence, event_id, aggregate_kind, stream_id, command_id, causation_event_id
      FROM orchestration_events ORDER BY sequence ASC
    `;
    const sourceRows = source.prepare(metadataSql).all() as unknown as Array<EventMetadataRow>;
    const destinationRows = candidate
      .prepare(metadataSql)
      .all() as unknown as Array<EventMetadataRow>;

    const sourceStreamKeys = new Set(sourceRows.map(streamKey));
    const sourceEventIds = new Set(sourceRows.map((row) => row.event_id));
    const selected: Array<PlannedEvent> = sourceRows.map((row) => ({
      origin: "source" as const,
      row,
      newSequence: 0,
      newStreamVersion: 0,
    }));
    const discarded: Array<EventMetadataRow> = [];
    for (const row of destinationRows) {
      if (sourceStreamKeys.has(streamKey(row))) discarded.push(row);
      else
        selected.push({ origin: "destination" as const, row, newSequence: 0, newStreamVersion: 0 });
    }

    const selectedEventIds = new Set<string>();
    for (const event of selected) {
      if (selectedEventIds.has(event.row.event_id)) {
        throw new Error(
          `Event ${event.row.event_id} appears in unrelated streams of both databases; this history cannot be merged.`,
        );
      }
      selectedEventIds.add(event.row.event_id);
    }
    const discardedDestinationEventIds = new Set(discarded.map((row) => row.event_id));
    for (const event of selected) {
      const causation = event.row.causation_event_id;
      if (causation === null || selectedEventIds.has(causation)) continue;
      if (event.origin === "destination" && discardedDestinationEventIds.has(causation)) continue;
      throw new Error(
        `Event ${event.row.event_id} was caused by ${causation}, which the merged history does not contain.`,
      );
    }
    // Destination live work must not point at history the merge discards.
    const discardedCommandIds = new Set<string>();
    for (const row of discarded) {
      if (!sourceEventIds.has(row.event_id) && row.command_id !== null) {
        discardedCommandIds.add(row.command_id);
      }
    }
    if (discardedCommandIds.size > 0) {
      const pendingEffects = candidate
        .prepare(
          `SELECT command_id FROM orchestration_v2_effect_outbox WHERE command_id IS NOT NULL`,
        )
        .all() as Array<{ command_id: string }>;
      for (const effect of pendingEffects) {
        if (discardedCommandIds.has(effect.command_id)) {
          throw new Error(
            `Pending destination work for command ${effect.command_id} depends on history the old fork replaces; let it finish before merging.`,
          );
        }
      }
    }

    const newSequenceByEventId = new Map<string, number>();
    const sourceSequenceMap = new Map<number, number>();
    const destinationSequenceMap = new Map<number, number>();
    const streamVersions = new Map<string, number>();
    selected.forEach((event, index) => {
      event.newSequence = index + 1;
      newSequenceByEventId.set(event.row.event_id, event.newSequence);
      (event.origin === "source" ? sourceSequenceMap : destinationSequenceMap).set(
        event.row.sequence,
        event.newSequence,
      );
      const key = streamKey(event.row);
      const version = streamVersions.get(key) ?? 0;
      streamVersions.set(key, version + 1);
      event.newStreamVersion = version;
    });

    const receiptsSql = `
      SELECT command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error, command_type
      FROM orchestration_command_receipts
    `;
    const sourceReceipts = source.prepare(receiptsSql).all() as unknown as Array<ReceiptRow>;
    const destinationReceipts = candidate
      .prepare(receiptsSql)
      .all() as unknown as Array<ReceiptRow>;
    const sourceEventBySequence = new Map(sourceRows.map((row) => [row.sequence, row]));
    const destinationEventBySequence = new Map(destinationRows.map((row) => [row.sequence, row]));
    const remapReceipt = (
      receipt: ReceiptRow,
      events: Map<number, EventMetadataRow>,
      origin: string,
    ) => {
      // Rejected commands record no result event.
      const resultSequence = Number(receipt.result_sequence);
      if (resultSequence === 0) return { receipt, resultEventId: null, resultSequence: 0 };
      const event = events.get(resultSequence);
      if (event === undefined) {
        throw new Error(
          `A ${origin} command receipt for ${receipt.command_id} records a missing event (sequence ${resultSequence}).`,
        );
      }
      const remapped = newSequenceByEventId.get(event.event_id);
      if (remapped === undefined) {
        throw new Error(
          `The ${origin} command receipt for ${receipt.command_id} records a result the merged history discards.`,
        );
      }
      return { receipt, resultEventId: event.event_id, resultSequence: remapped };
    };
    const mergedReceipts = new Map<
      string,
      { receipt: ReceiptRow; resultEventId: string | null; resultSequence: number }
    >();
    for (const receipt of sourceReceipts) {
      mergedReceipts.set(
        receipt.command_id,
        remapReceipt(receipt, sourceEventBySequence, "old fork"),
      );
    }
    for (const receipt of destinationReceipts) {
      // Receipts are idempotency checkpoints only, so a discarded destination result needs none.
      const resultEvent = destinationEventBySequence.get(Number(receipt.result_sequence));
      if (resultEvent !== undefined && !newSequenceByEventId.has(resultEvent.event_id)) continue;
      const remapped = remapReceipt(receipt, destinationEventBySequence, "destination");
      const existing = mergedReceipts.get(receipt.command_id);
      if (existing !== undefined) {
        if (existing.resultEventId !== remapped.resultEventId) {
          throw new Error(
            `Command ${receipt.command_id} recorded different results in the two databases; this history cannot be merged.`,
          );
        }
        continue;
      }
      mergedReceipts.set(receipt.command_id, remapped);
    }

    const remapPromptSequence = (
      payloadJson: string,
      origin: PlannedEvent["origin"],
      eventId: string,
    ): string => {
      if (!payloadJson.includes("promptSequence")) return payloadJson;
      const decoded: unknown = decodeJson(payloadJson);
      if (typeof decoded !== "object" || decoded === null) return payloadJson;
      const payload = decoded as Record<string, unknown>;
      const anchor = payload.promptSequence;
      if (typeof anchor !== "number" || !Number.isInteger(anchor)) return payloadJson;
      const remapped = (origin === "source" ? sourceSequenceMap : destinationSequenceMap).get(
        anchor,
      );
      if (remapped === undefined) {
        throw new Error(
          `A prompt stored on event ${eventId} references sequence ${anchor}, which the merged history discards.`,
        );
      }
      payload.promptSequence = remapped;
      return encodeJson(payload);
    };

    candidate.exec("BEGIN IMMEDIATE");
    try {
      // Drop the destination rows from streams the old fork replaces first: their event ids and
      // stream versions would otherwise collide with the rows re-inserted from the old fork.
      const deleteStream = candidate.prepare(
        `DELETE FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ?`,
      );
      const discardedStreamKeys = new Set(discarded.map(streamKey));
      for (const row of discarded) {
        const key = streamKey(row);
        if (!discardedStreamKeys.has(key)) continue;
        discardedStreamKeys.delete(key);
        deleteStream.run(row.aggregate_kind, row.stream_id);
      }
      candidate
        .prepare(
          `UPDATE orchestration_events SET sequence = sequence + ?, stream_version = stream_version + ?`,
        )
        .run(MERGE_SEQUENCE_OFFSET, MERGE_SEQUENCE_OFFSET);
      const insertEvent = candidate.prepare(`
        INSERT INTO orchestration_events (${quotedEventColumns})
        VALUES (${eventColumns.map(() => "?").join(", ")})
      `);
      const sourceFull = source.prepare(`SELECT * FROM orchestration_events WHERE sequence = ?`);
      const candidateFull = candidate.prepare(
        `SELECT * FROM orchestration_events WHERE sequence = ?`,
      );
      const deleteShifted = candidate.prepare(
        `DELETE FROM orchestration_events WHERE sequence = ?`,
      );
      for (const event of selected) {
        let full: Record<string, NodeSqlite.SQLInputValue> | undefined;
        if (event.origin === "source") {
          full = sourceFull.get(event.row.sequence) as unknown as
            | Record<string, NodeSqlite.SQLInputValue>
            | undefined;
        } else {
          const shiftedSequence = event.row.sequence + MERGE_SEQUENCE_OFFSET;
          full = candidateFull.get(shiftedSequence) as unknown as
            | Record<string, NodeSqlite.SQLInputValue>
            | undefined;
          // The parked row still owns this event_id; free it before the renumbered insert.
          deleteShifted.run(shiftedSequence);
        }
        if (full === undefined) {
          throw new Error(`Event ${event.row.event_id} vanished while merging.`);
        }
        const causationEventId = full.causation_event_id;
        const mergedCausationEventId =
          event.origin === "destination" &&
          typeof causationEventId === "string" &&
          discardedDestinationEventIds.has(causationEventId) &&
          !selectedEventIds.has(causationEventId)
            ? null
            : causationEventId;
        const values = eventColumns.map((name): NodeSqlite.SQLInputValue => {
          if (name === "sequence") return event.newSequence;
          if (name === "stream_version") return event.newStreamVersion;
          if (name === "payload_json") {
            return remapPromptSequence(String(full.payload_json), event.origin, event.row.event_id);
          }
          if (name === "causation_event_id") return mergedCausationEventId ?? null;
          return full[name] ?? null;
        });
        insertEvent.run(...values);
      }
      candidate
        .prepare(`DELETE FROM orchestration_events WHERE sequence >= ?`)
        .run(MERGE_SEQUENCE_OFFSET);
      candidate.prepare(`DELETE FROM sqlite_sequence WHERE name = 'orchestration_events'`).run();
      if (selected.length > 0) {
        candidate
          .prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('orchestration_events', ?)`)
          .run(selected.length);
      }
      candidate.exec(`DELETE FROM orchestration_command_receipts`);
      const insertReceipt = candidate.prepare(`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error,
          command_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { receipt, resultSequence } of mergedReceipts.values()) {
        insertReceipt.run(
          receipt.command_id,
          receipt.aggregate_kind,
          receipt.aggregate_id,
          receipt.accepted_at,
          resultSequence,
          receipt.status,
          receipt.error,
          receipt.command_type,
        );
      }
      candidate.exec("COMMIT");
    } catch (error) {
      try {
        candidate.exec("ROLLBACK");
      } catch {
        // The failed statement may already have ended the transaction.
      }
      throw error;
    }
  } finally {
    source.close();
    candidate.close();
  }
};

const rebuildAndValidateCandidate = Effect.fn("mergeOldForkDatabase.rebuildProjections")(function* (
  candidatePath: string,
) {
  const layerStores = Layer.mergeAll(
    OrchestrationEventStore.layer,
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
  );
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const rows = yield* sql<{ readonly max_sequence: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM orchestration_events
      `.pipe(NodeSqliteClient.readOnly);
    const throughSequence = rows[0]?.max_sequence ?? 0;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM projection_projects`;
        yield* applicationEvents.readApplicationEvents({ afterSequence: 0, throughSequence }).pipe(
          Stream.mapEffect(
            (stored) => ("aggregateKind" in stored ? projects.apply(stored) : Effect.void),
            { concurrency: 1 },
          ),
          Stream.runDrain,
        );
      }),
    );
    // Thread projections, positions, and projection metadata come from the shared rebuild.
    const verification = yield* maintenance.rebuild;
    if (!verification.valid) {
      return yield* new OldForkMergeError({
        reason: `Rebuilt projections failed verification: ${verification.missingThreadIds.length} missing, ${verification.unexpectedThreadIds.length} unexpected, ${verification.unreadableThreadIds.length} unreadable threads; projection sequence ${verification.projectionSequence} of ${verification.expectedSequence}.`,
        terminal: true,
      });
    }
    yield* rebuildMessageSearch(sql);
    const foreignKeys = yield* sql`PRAGMA foreign_key_check`;
    if (foreignKeys.length > 0) {
      return yield* new OldForkMergeError({
        reason: "The merged database failed its foreign key check and was discarded.",
        terminal: true,
      });
    }
    const integrity = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
    if (integrity[0]?.integrity_check !== "ok") {
      return yield* new OldForkMergeError({
        reason: `The merged database failed its integrity check (${integrity[0]?.integrity_check ?? "unknown"}) and was discarded.`,
        terminal: true,
      });
    }
  }).pipe(
    Effect.provide(
      Layer.merge(layerStores, ProjectionMaintenance.layer.pipe(Layer.provide(layerStores))).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: candidatePath })),
      ),
    ),
  );
});

/** Same guard as a manual server start: a live server owns the home's database. */
const refuseLiveServer = Effect.fn("mergeOldForkDatabase.refuseLiveServer")(function* (
  home: string,
  label: string,
) {
  const path = yield* Path.Path;
  const runtime = yield* readPersistedServerRuntimeState(
    path.join(home, "userdata", "server-runtime.json"),
  );
  if (
    Option.isSome(runtime) &&
    runtime.value.pid > 0 &&
    runtime.value.pid !== process.pid &&
    isProcessAlive(runtime.value.pid)
  ) {
    return yield* new OldForkMergeError({
      reason: `A T3 Code server for the ${label} home is still running (pid ${runtime.value.pid} at ${runtime.value.origin}). Stop it before merging.`,
      terminal: false,
    });
  }
});

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

const sqliteErrcode = (error: unknown): number | null =>
  typeof error === "object" &&
  error !== null &&
  "errcode" in error &&
  typeof error.errcode === "number"
    ? error.errcode & 0xff
    : null;

/** Contention clears when the other process exits; a database SQLite cannot read never will. */
const destinationReadError = (databasePath: string, error: unknown) => {
  const errcode = sqliteErrcode(error);
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED) {
    return new OldForkMergeError({
      reason: `Another process has ${databasePath} open. Stop every T3 Code server and desktop app before merging.`,
      terminal: false,
    });
  }
  return new OldForkMergeError({
    reason: `The database at ${databasePath} could not be read: ${describeCause(error)}. Repair or restore that file before retrying the merge.`,
    terminal: true,
  });
};

/** Fails while any other connection holds the database, even without a runtime-state file. */
const assertNoOtherConnection = Effect.fn("mergeOldForkDatabase.assertNoOtherConnection")(
  function* (databasePath: string) {
    yield* Effect.try(() => {
      const database = new NodeSqlite.DatabaseSync(databasePath);
      try {
        database.exec("PRAGMA busy_timeout = 0;");
        database.exec("BEGIN EXCLUSIVE;");
        database.exec("COMMIT;");
      } finally {
        database.close();
      }
    }).pipe(Effect.mapError((error) => destinationReadError(databasePath, error)));
  },
);

const publishCandidate = Effect.fn("mergeOldForkDatabase.publish")(function* (
  candidatePath: string,
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // Fold any WAL frames into the candidate so the rename publishes one self-contained file.
  yield* Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(candidatePath);
      try {
        database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } finally {
        database.close();
      }
    },
    catch: (error) => new OldForkMergeError({ reason: describeCause(error), terminal: false }),
  });
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    yield* fs.remove(candidatePath + suffix, { force: true });
  }
  let attempt = yield* Effect.result(fs.rename(candidatePath, destinationPath));
  for (
    let retry = 0;
    Result.isFailure(attempt) && isWindowsRenameLock(attempt.failure) && retry < 20;
    retry += 1
  ) {
    yield* Effect.sleep("100 millis");
    attempt = yield* Effect.result(fs.rename(candidatePath, destinationPath));
  }
  if (Result.isFailure(attempt)) return yield* attempt.failure;
  // Only once the candidate owns the destination path: these sidecars belong to the replaced
  // database, and removing them before the swap would drop its committed WAL data on failure.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    yield* fs.remove(destinationPath + suffix, { force: true });
  }
});

const overlayOldForkSettingsAndCredentials = Effect.fn("mergeOldForkDatabase.overlay")(function* (
  sourceUserdata: string,
  destinationUserdata: string,
) {
  // Failing the overlay leaves the published history in place, so a fixed old fork resumes it.
  yield* overlayOldForkFiles(sourceUserdata, destinationUserdata).pipe(
    Effect.mapError((error) => new OldForkMergeError({ reason: error.message, terminal: false })),
  );
});

type MergeLifecycleStatus = "published" | "done" | "blocked";

const writeLifecycleMarker = Effect.fn("mergeOldForkDatabase.writeMarker")(function* (input: {
  readonly filePath: string;
  readonly sourceHome: string;
  readonly destinationHome: string;
  readonly status: MergeLifecycleStatus;
  readonly reason?: string;
}) {
  const now = yield* DateTime.now;
  yield* writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${encodeJson({
      version: 2,
      status: input.status,
      recordedAt: DateTime.formatIso(now),
      sourceHome: input.sourceHome,
      destinationHome: input.destinationHome,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })}\n`,
  });
});

const readLifecycleState = Effect.fn("mergeOldForkDatabase.readState")(function* (
  statePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(statePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError(
      (error) => new OldForkMergeError({ reason: describeCause(error), terminal: false }),
    ),
  );
  if (contents === null) return null;
  return yield* Effect.try({
    try: () => {
      const decoded: unknown = decodeJson(contents);
      if (typeof decoded !== "object" || decoded === null) {
        throw new Error("The old fork merge state is not an object.");
      }
      const state = decoded as Record<string, unknown>;
      if (state.version !== 2) throw new Error("The old fork merge state has an unknown version.");
      if (state.status === "published" || state.status === "done") {
        return { status: state.status };
      }
      if (state.status === "blocked" && typeof state.reason === "string") {
        return { status: "blocked", reason: state.reason };
      }
      throw new Error("The old fork merge state is invalid.");
    },
    catch: (error) => new OldForkMergeError({ reason: describeCause(error), terminal: false }),
  });
});

interface MergeLock {
  readonly filePath: string;
  readonly token: string;
  readonly contents: string;
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const readLockContents = (filePath: string): string | null => {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const parseLockContents = (contents: string) => {
  try {
    const decoded: unknown = JSON.parse(contents);
    if (typeof decoded !== "object" || decoded === null) return null;
    const lock = decoded as Record<string, unknown>;
    if (
      typeof lock.pid !== "number" ||
      !Number.isInteger(lock.pid) ||
      lock.pid <= 0 ||
      typeof lock.token !== "string"
    ) {
      return null;
    }
    const createdAt = typeof lock.createdAt === "string" ? Date.parse(lock.createdAt) : NaN;
    return {
      pid: lock.pid,
      token: lock.token,
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
    };
  } catch {
    return null;
  }
};

// A live pid alone cannot prove a merge is running: a reboot or a recycled pid outlives the
// process that wrote the lock, so anything this old is reclaimable.
const MERGE_LOCK_STALE_AFTER_MS = 60 * 60 * 1000;
const MERGE_LOCK_MAX_ATTEMPTS = 8;
const MERGE_LOCK_RETRY_DELAY = "25 millis";

const isMergeLockActive = (
  lock: { readonly pid: number; readonly createdAt: number | null },
  now: DateTime.DateTime,
): boolean => {
  if (!isProcessAlive(lock.pid)) return false;
  if (lock.createdAt === null) return false;
  return DateTime.toEpochMillis(now) - lock.createdAt < MERGE_LOCK_STALE_AFTER_MS;
};

const removeLockIfUnchanged = (filePath: string, expectedContents: string): void => {
  try {
    if (readLockContents(filePath) !== expectedContents) return;
    NodeFS.unlinkSync(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
};

type MergeLockAttempt =
  | { readonly status: "acquired"; readonly lock: MergeLock }
  | { readonly status: "busy" }
  | { readonly status: "retry"; readonly contended: boolean };

const attemptMergeLock = (filePath: string, now: DateTime.DateTime): MergeLockAttempt => {
  const token = NodeCrypto.randomUUID();
  const contents = JSON.stringify({
    pid: process.pid,
    token,
    createdAt: DateTime.formatIso(now),
  });
  let descriptor: number;
  try {
    descriptor = NodeFS.openSync(
      filePath,
      NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existingContents = readLockContents(filePath);
    if (existingContents === null) return { status: "retry", contended: true };
    const existing = parseLockContents(existingContents);
    if (existing !== null && isMergeLockActive(existing, now)) return { status: "busy" };
    removeLockIfUnchanged(filePath, existingContents);
    return { status: "retry", contended: false };
  }
  try {
    NodeFS.writeFileSync(descriptor, contents, "utf8");
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return { status: "acquired", lock: { filePath, token, contents } };
};

const acquireMergeLock = Effect.fn("mergeOldForkDatabase.acquireLock")(function* (
  filePath: string,
) {
  for (let attempt = 0; attempt < MERGE_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const now = yield* DateTime.now;
    const outcome = yield* Effect.try({
      try: () => attemptMergeLock(filePath, now),
      catch: (error) => new OldForkMergeError({ reason: describeCause(error), terminal: false }),
    });
    if (outcome.status === "acquired") return outcome.lock;
    if (outcome.status === "busy") return null;
    // Reclaiming a dead lock retries at once; only a lost race waits, so racers do not spin on EEXIST.
    if (outcome.contended && attempt + 1 < MERGE_LOCK_MAX_ATTEMPTS) {
      yield* Effect.sleep(MERGE_LOCK_RETRY_DELAY);
    }
  }
  return null;
});

const releaseMergeLock = (lock: MergeLock): void => {
  const contents = readLockContents(lock.filePath);
  if (contents === null || parseLockContents(contents)?.token !== lock.token) return;
  removeLockIfUnchanged(lock.filePath, contents);
};

const isEmptyDatabase = (databasePath: string): boolean => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'effect_sql_migrations'`,
      )
      .all();
    for (const table of tables) {
      const name = String(table.name);
      const quotedName = `"${name.replaceAll('"', '""')}"`;
      if (database.prepare(`SELECT 1 FROM ${quotedName} LIMIT 1`).get() !== undefined) return false;
    }
    return true;
  } finally {
    database.close();
  }
};

/**
 * Merges an old fork's T3 home into this installation's home: the canonical event log with
 * complete old-fork streams winning, destination live state kept, settings and themes overlaid.
 * The sidecar records publication and terminal conflicts; the original marker means fully done.
 */
export const mergeOldForkDatabase = Effect.fn("mergeOldForkDatabase")(function* (
  input: MergeOldForkInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.resolve(input.markerPath);
  const statePath = `${markerPath}.state`;
  const lockPath = `${markerPath}.lock`;
  const sourceHome = path.resolve(input.sourceHome);
  const destinationHome = path.resolve(input.destinationHome);
  const sourceUserdata = path.join(sourceHome, "userdata");
  const destinationUserdata = path.join(destinationHome, "userdata");
  const sourcePath = path.join(sourceUserdata, "statev2.sqlite");
  const destinationPath = path.join(destinationUserdata, "statev2.sqlite");

  const complete = Effect.gen(function* () {
    yield* overlayOldForkSettingsAndCredentials(sourceUserdata, destinationUserdata);
    yield* writeLifecycleMarker({
      filePath: markerPath,
      sourceHome: input.sourceHome,
      destinationHome: input.destinationHome,
      status: "done",
    });
    yield* fs.remove(statePath, { force: true });
    return { status: "done" } as const;
  });

  const merge = Effect.gen(function* () {
    if (yield* fs.exists(markerPath)) {
      yield* fs.remove(statePath, { force: true });
      return { status: "done" };
    }
    const state = yield* readLifecycleState(statePath);
    if (state?.status === "blocked" && input.retryTerminal !== true) return state;
    if (state?.status === "published") return yield* complete;
    if (state?.status === "done") {
      yield* writeLifecycleMarker({
        filePath: markerPath,
        sourceHome: input.sourceHome,
        destinationHome: input.destinationHome,
        status: "done",
      });
      yield* fs.remove(statePath, { force: true });
      return { status: "done" };
    }
    if (state?.status === "blocked") yield* fs.remove(statePath);

    const sameFile =
      sourcePath === destinationPath ||
      (yield* Effect.gen(function* () {
        return (yield* fs.realPath(sourcePath)) === (yield* fs.realPath(destinationPath));
      }).pipe(Effect.orElseSucceed(() => false)));
    if (sameFile) {
      return yield* new OldForkImportError({
        sourcePath,
        destinationPath,
        cause: new Error("The old fork home and this installation share the same database file."),
      });
    }
    if (!(yield* fs.exists(sourcePath))) {
      return yield* new OldForkImportError({
        sourcePath,
        destinationPath,
        cause: new Error("No old fork database was found to merge."),
      });
    }

    yield* refuseLiveServer(destinationHome, "destination");
    yield* refuseLiveServer(sourceHome, "old fork");
    const destinationExists = yield* fs.exists(destinationPath);
    const adoptEmptyDestination =
      destinationExists &&
      (yield* Effect.try({
        try: () => isEmptyDatabase(destinationPath),
        catch: (error) => destinationReadError(destinationPath, error),
      }));
    if (!destinationExists || adoptEmptyDestination) {
      if (destinationExists) {
        yield* assertNoOtherConnection(destinationPath);
        yield* fs.remove(destinationPath);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          yield* fs.remove(destinationPath + suffix, { force: true });
        }
      }
      yield* importOldForkDatabase(sourcePath, destinationPath);
    } else {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(destinationPath),
            prefix: `.v2-import-${process.pid}-`,
          });
          const snapshotPath = path.join(temporaryDirectory, "source-snapshot.sqlite");
          const candidatePath = path.join(temporaryDirectory, "candidate.sqlite");
          // Every later step reads the snapshot, so the source file itself is never written.
          yield* Effect.tryPromise(() => backupDatabase(sourcePath, snapshotPath));
          yield* assertNoOtherConnection(destinationPath);
          yield* Effect.tryPromise(() => backupDatabase(destinationPath, candidatePath)).pipe(
            Effect.mapError((error) => destinationReadError(destinationPath, error)),
          );
          yield* runMigrations().pipe(
            Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
          );
          yield* runMigrations().pipe(
            Effect.provide(NodeSqliteClient.layer({ filename: candidatePath })),
          );
          yield* Effect.try({
            try: () => mergeCanonicalHistory(snapshotPath, candidatePath),
            catch: (error) =>
              new OldForkMergeError({ reason: describeCause(error), terminal: true }),
          });
          yield* rebuildAndValidateCandidate(candidatePath);
          yield* publishCandidate(candidatePath, destinationPath);
        }),
      );
    }

    yield* writeLifecycleMarker({
      filePath: statePath,
      sourceHome: input.sourceHome,
      destinationHome: input.destinationHome,
      status: "published",
    });
    return yield* complete;
  }).pipe(
    Effect.catchTags({
      OldForkMergeError: (error) => {
        if (!error.terminal) return Effect.fail(error);
        return Effect.gen(function* () {
          yield* writeLifecycleMarker({
            filePath: statePath,
            sourceHome: input.sourceHome,
            destinationHome: input.destinationHome,
            status: "blocked",
            reason: error.reason,
          });
          return yield* error;
        });
      },
    }),
  );

  return yield* Effect.gen(function* () {
    const lock = yield* acquireMergeLock(lockPath);
    if (lock === null) return { status: "busy" } as const;
    return yield* merge.pipe(Effect.ensuring(Effect.sync(() => releaseMergeLock(lock))));
  }).pipe(
    Effect.mapError((cause) =>
      isOldForkImportError(cause)
        ? cause
        : new OldForkImportError({ sourcePath, destinationPath, cause }),
    ),
  );
});
