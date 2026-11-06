import { ServerSettings } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { deepMerge } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mapSettingsSecrets } from "../settingsSecrets.ts";

export class OldForkSettingsError extends Schema.TaggedError<OldForkSettingsError>()(
  "OldForkSettingsError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return `Could not overlay the old fork's settings and credentials: ${describeCause(this.cause)}`;
  }
}

const isOldForkSettingsError = Schema.is(OldForkSettingsError);

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    // Effect wrappers can carry null-prototype payloads that String() cannot render.
    return "unknown error";
  }
};

const SETTINGS_FILE = "settings.json";
// Files the old fork owns outright when present; everything else in userdata stays untouched.
const VERBATIM_FILES = ["keybindings.json", "model-manifest.json"] as const;
const THEMES_DIRECTORY = "themes";
const SECRETS_DIRECTORY = "secrets";
// Instance credentials some drivers keep in files instead of the secret store.
const PROVIDER_AUTH_DIRECTORY = "provider-auth";
// Hashed from driver and instance id, so an equal name is the same binding's credentials.
const PROVIDER_AUTH_SECRET_FILE = /^provider-auth-[0-9a-f]{64}\.bin$/;
const OWNER_ONLY_FILE_MODE = 0o600;
// Owner, cloud-link, and session material belongs to this installation, never to the old fork.
const DESTINATION_OWNED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "identity",
  "cloud",
  "sessions",
]);

const decodeJsonDocument = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));
const encodeJsonDocument = Schema.encodeSync(fromJsonStringPretty(Schema.Unknown));
const decodeServerSettings = Schema.decodeUnknownOption(ServerSettings);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Source leaves and arrays win; keys only the destination has survive. */
export const mergeSettings = (destination: unknown, source: unknown): Record<string, unknown> => {
  const base: Record<string, unknown> = isRecord(destination) ? { ...destination } : {};
  return isRecord(source) ? deepMerge(base, source) : base;
};

/** Secret names the settings read from this server's store; literals and external references move nothing. */
export const requiredSettingsSecretNames = (settings: ServerSettings): ReadonlyArray<string> => {
  const names = new Set<string>();
  mapSettingsSecrets(settings, (secret) => {
    if (secret.sensitive && secret.redacted) names.add(secret.secretName);
    return secret;
  });
  return [...names];
};

const withoutDestinationOwnedKeys = (settings: unknown): unknown =>
  isRecord(settings)
    ? Object.fromEntries(
        Object.entries(settings).filter(([key]) => !DESTINATION_OWNED_SETTINGS_KEYS.has(key)),
      )
    : settings;

// One unreadable field must not hide the credentials the rest of the file uses.
const settingsDocuments = (settings: Record<string, unknown>): ReadonlyArray<ServerSettings> => {
  const whole = decodeServerSettings(settings);
  if (Option.isSome(whole)) return [whole.value];
  return Object.entries(settings).flatMap(([key, value]) => {
    const single = decodeServerSettings({ [key]: value });
    return Option.isSome(single) ? [single.value] : [];
  });
};

const collectFiles = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const pending: Array<{ readonly absolute: string; readonly relative: string }> = [
    { absolute: root, relative: "" },
  ];
  while (pending.length > 0) {
    const directory = pending.pop() as { readonly absolute: string; readonly relative: string };
    const entries = yield* fs.readDirectory(directory.absolute).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as ReadonlyArray<string>),
      ),
    );
    for (const entry of entries) {
      const absolute = path.join(directory.absolute, entry);
      const relative = directory.relative === "" ? entry : path.join(directory.relative, entry);
      const info = yield* fs.stat(absolute).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory") pending.push({ absolute, relative });
      else files.push(relative);
    }
  }
  return files;
});

// Owner-only before the rename publishes the file, like the secret store itself writes.
const writeSecretFile = Effect.fn("writeSecretFile")(function* (
  filePath: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filePath);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: `.${path.basename(filePath)}.`,
      });
      const temporaryPath = path.join(temporaryDirectory, "contents.tmp");
      yield* fs.writeFile(temporaryPath, bytes);
      yield* fs.chmod(temporaryPath, OWNER_ONLY_FILE_MODE);
      yield* fs.rename(temporaryPath, filePath);
    }),
  );
  yield* fs.chmod(filePath, OWNER_ONLY_FILE_MODE);
});

/**
 * Overlays an old fork's settings and credentials onto this installation's userdata. The fork's
 * settings win, destination-only ones survive, and the server identity stays here: environment
 * id, anonymous id, runtime state, and signing, session, and cloud-link secrets are never read
 * from the old fork.
 */
export const overlayOldForkFiles = Effect.fn("overlayOldForkFiles")(function* (
  sourceUserdata: string,
  destinationUserdata: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.gen(function* () {
    const sourceSecrets = path.join(sourceUserdata, SECRETS_DIRECTORY);
    const destinationSecrets = path.join(destinationUserdata, SECRETS_DIRECTORY);
    const settingsPath = path.join(destinationUserdata, SETTINGS_FILE);

    const readJsonDocument = Effect.fnUntraced(function* (filePath: string) {
      if (!(yield* fs.exists(filePath))) return undefined;
      const decoded = yield* Effect.option(decodeJsonDocument(yield* fs.readFileString(filePath)));
      if (Option.isNone(decoded)) {
        yield* Effect.logWarning("Ignoring a settings file this build cannot parse.", {
          path: filePath,
        });
        return undefined;
      }
      return decoded.value;
    });

    const copySecret = (fileName: string) =>
      fs.readFile(path.join(sourceSecrets, fileName)).pipe(
        Effect.option,
        Effect.flatMap((bytes) =>
          Option.isNone(bytes)
            ? Effect.succeed(false)
            : writeSecretFile(path.join(destinationSecrets, fileName), bytes.value).pipe(
                Effect.as(true),
              ),
        ),
      );

    // Credentials land first: merged settings must never point at a secret this server lacks.
    const providerAuthRoot = path.join(sourceUserdata, PROVIDER_AUTH_DIRECTORY);
    for (const relative of yield* collectFiles(providerAuthRoot)) {
      yield* writeSecretFile(
        path.join(destinationUserdata, PROVIDER_AUTH_DIRECTORY, relative),
        yield* fs.readFile(path.join(providerAuthRoot, relative)),
      );
    }
    const providerAuthSecrets = (yield* fs.readDirectory(sourceSecrets).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as ReadonlyArray<string>),
      ),
    )).filter((entry) => PROVIDER_AUTH_SECRET_FILE.test(entry));
    for (const fileName of providerAuthSecrets) {
      yield* copySecret(fileName);
    }

    const merged = mergeSettings(
      yield* readJsonDocument(settingsPath),
      withoutDestinationOwnedKeys(
        yield* readJsonDocument(path.join(sourceUserdata, SETTINGS_FILE)),
      ),
    );
    const missing: Array<string> = [];
    const requiredSecrets = new Set(settingsDocuments(merged).flatMap(requiredSettingsSecretNames));
    for (const secretName of requiredSecrets) {
      const fileName = `${secretName}.bin`;
      if (yield* copySecret(fileName)) continue;
      if (yield* fs.exists(path.join(destinationSecrets, fileName))) continue;
      missing.push(secretName);
    }
    if (missing.length > 0) {
      return yield* new OldForkSettingsError({
        cause: new Error(
          `the settings reference credentials neither home stores, so nothing was written: ${missing.join(", ")}`,
        ),
      });
    }
    yield* writeFileStringAtomically({
      filePath: settingsPath,
      contents: `${encodeJsonDocument(merged)}\n`,
    });

    for (const name of VERBATIM_FILES) {
      const sourceFilePath = path.join(sourceUserdata, name);
      if (!(yield* fs.exists(sourceFilePath))) continue;
      yield* writeFileStringAtomically({
        filePath: path.join(destinationUserdata, name),
        contents: yield* fs.readFileString(sourceFilePath),
      });
    }

    const sourceThemes = path.join(sourceUserdata, THEMES_DIRECTORY);
    for (const relative of yield* collectFiles(sourceThemes)) {
      yield* writeFileStringAtomically({
        filePath: path.join(destinationUserdata, THEMES_DIRECTORY, relative),
        contents: yield* fs.readFileString(path.join(sourceThemes, relative)),
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      isOldForkSettingsError(cause) ? cause : new OldForkSettingsError({ cause }),
    ),
  );
});
