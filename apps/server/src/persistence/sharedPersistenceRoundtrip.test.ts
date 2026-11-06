// Roundtrip for the shared-persistence contract: the migration manifest is
// stock T3 Code's (kept upstream's by
// .github/scripts/check-shared-persistence-compat.cjs), so the databases below
// are stock-compatible by construction.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const schemaDump = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;
  return rows;
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const buildStockDatabase = (dbPath: string, throughId: number | undefined) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: throughId });
    return { schema: yield* schemaDump, history: yield* history };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

// The exact startup path a ++ server takes when it opens the shared database.
const openWithForkBuild = (dbPath: string) =>
  Effect.gen(function* () {
    return { schema: yield* schemaDump, history: yield* history };
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

it.effect("keeps a stock-compatible database stock-compatible when ++ opens it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dbPath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-roundtrip-" }),
      "statev2.sqlite",
    );

    const stock = yield* buildStockDatabase(dbPath, undefined);
    assert.deepStrictEqual(stock.history, migrationManifest);

    const opened = yield* openWithForkBuild(dbPath);
    assert.deepStrictEqual(opened, stock);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "upgrades a stock-compatible database at the previous shared head to the shared schema",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-upgrade-" });

      const head = Math.max(...migrationManifest.map(([id]) => id));
      const previousHead = Math.max(
        ...migrationManifest.filter(([id]) => id < head).map(([id]) => id),
      );

      const behind = yield* buildStockDatabase(path.join(directory, "behind.sqlite"), previousHead);
      assert.deepStrictEqual(
        behind.history,
        migrationManifest.filter(([id]) => id <= previousHead),
      );

      const upgraded = yield* openWithForkBuild(path.join(directory, "behind.sqlite"));
      assert.deepStrictEqual(upgraded.history, migrationManifest);

      const reference = yield* buildStockDatabase(
        path.join(directory, "reference.sqlite"),
        undefined,
      );
      assert.deepStrictEqual(upgraded.schema, reference.schema);
    }).pipe(Effect.provide(NodeServices.layer)),
);
