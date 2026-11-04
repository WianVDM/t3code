import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { importOldForkDatabase } from "../persistence/importOldFork.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";

export class ImportOldForkSourceMissingError extends Schema.TaggedError<ImportOldForkSourceMissingError>()(
  "ImportOldForkSourceMissingError",
  { sourcePath: Schema.String },
) {
  override get message(): string {
    return `No old fork database at ${this.sourcePath}. Pass --source with the old fork's statev2.sqlite.`;
  }
}

export class ImportOldForkServerRunningError extends Schema.TaggedError<ImportOldForkServerRunningError>()(
  "ImportOldForkServerRunningError",
  { destinationPath: Schema.String, pid: Schema.Number, origin: Schema.String },
) {
  override get message(): string {
    return `A T3 Code server is already running against ${this.destinationPath} (pid ${this.pid} at ${this.origin}). Stop it before importing, or use a different --base-dir.`;
  }
}

export class ImportOldForkSourceIsDestinationError extends Schema.TaggedError<ImportOldForkSourceIsDestinationError>()(
  "ImportOldForkSourceIsDestinationError",
  { sourcePath: Schema.String },
) {
  override get message(): string {
    return `${this.sourcePath} is the destination database itself, so there is nothing to import.`;
  }
}

export class ImportOldForkDestinationExistsError extends Schema.TaggedError<ImportOldForkDestinationExistsError>()(
  "ImportOldForkDestinationExistsError",
  { sourcePath: Schema.String, destinationPath: Schema.String },
) {
  override get message(): string {
    return `Not imported: ${this.destinationPath} already exists. This command never overwrites it. Move or delete that database first if you want ${this.sourcePath} imported instead.`;
  }
}

const resolveImportPaths = Effect.fn("cli.importOldFork.resolveImportPaths")(function* (
  explicitBaseDir: Option.Option<string>,
) {
  const envHome = Option.filter(
    yield* Config.String("T3CODE_HOME").pipe(Config.option),
    (value) => value.trim().length > 0,
  );
  const configuredBaseDir = Option.orElse(explicitBaseDir, () => envHome);
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  // User-facing state work: always the shared userdata database, never dev.
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});
  return { baseDir, paths };
});

export const importOldForkCommand = Command.make("import-old-fork", {
  source: Flag.String("source").pipe(
    Flag.withDescription("Path to the old fork's statev2.sqlite to import."),
  ),
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Import an old fork's statev2.sqlite as this installation's history. Existing databases are never overwritten, and running turns are not resumed.",
  ),
  Command.withHandler(({ source, baseDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourcePath = path.resolve(yield* expandHomePath(source.trim()));
      const { paths } = yield* resolveImportPaths(baseDir);
      const destinationPath = paths.dbPath;

      if (!(yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new ImportOldForkSourceMissingError({ sourcePath });
      }
      // Same guard as a manual server start: a live server owns the destination.
      const runtime = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath);
      if (
        Option.isSome(runtime) &&
        runtime.value.pid > 0 &&
        runtime.value.pid !== process.pid &&
        isProcessAlive(runtime.value.pid)
      ) {
        return yield* new ImportOldForkServerRunningError({
          destinationPath,
          pid: runtime.value.pid,
          origin: runtime.value.origin,
        });
      }
      const sameFile =
        sourcePath === destinationPath ||
        (yield* Effect.gen(function* () {
          return (yield* fs.realPath(sourcePath)) === (yield* fs.realPath(destinationPath));
        }).pipe(Effect.orElseSucceed(() => false)));
      if (sameFile) {
        return yield* new ImportOldForkSourceIsDestinationError({ sourcePath });
      }
      if (yield* fs.exists(destinationPath).pipe(Effect.orElseSucceed(() => false))) {
        return yield* new ImportOldForkDestinationExistsError({ sourcePath, destinationPath });
      }

      yield* fs.makeDirectory(paths.stateDir, { recursive: true });
      yield* importOldForkDatabase(sourcePath, destinationPath);
      yield* Console.log(`Imported ${sourcePath} into ${destinationPath}.`);
      yield* Console.log(
        "Projects, threads, and completed work are restored as history. Running turns and other live work from the old fork are not resumed.",
      );
    }),
  ),
);
