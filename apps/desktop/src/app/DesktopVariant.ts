import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Keep in sync with DESKTOP_VARIANT_ENV_VAR in scripts/lib/desktop-variant.ts;
// the desktop runtime cannot import from the build scripts.
export const DESKTOP_VARIANT_ENV_VAR = "T3CODE_DESKTOP_VARIANT";

export type DesktopVariant = "official" | "fork";

export const FORK_DESKTOP_APP = {
  displayName: "T3 Code (Fork)",
  appUserModelId: "com.wianvdm.t3code.fork",
  t3HomeDirName: ".t3-fork",
  userDataDirName: "t3code-fork",
  windowsIconFileName: "t3-fork-windows.ico",
} as const;

/** Unknown values fall back to the official identity; the build script is the gate that rejects them. */
export const normalizeDesktopVariant = (value: string | undefined): DesktopVariant =>
  value?.trim() === "fork" ? "fork" : "official";

const StampedVariantJson = Schema.Struct({
  t3codeDesktopVariant: Schema.optional(Schema.String),
});
const decodeStampedVariantJson = Schema.decodeEffect(Schema.fromJsonString(StampedVariantJson));

/**
 * Packaged builds carry the variant in the staged app package.json next to
 * t3codeCommitHash; unpackaged runs fall back to the environment variable.
 */
export const resolveDesktopVariant = Effect.fn("desktop.variant.resolve")(function* (input: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly envVariant: string | undefined;
}) {
  if (!input.isPackaged) {
    return normalizeDesktopVariant(input.envVariant);
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs
    .readFileString(path.join(input.appPath, "package.json"))
    .pipe(Effect.option);
  return yield* Option.match(raw, {
    onNone: () => Effect.succeed(normalizeDesktopVariant(undefined)),
    onSome: (contents) =>
      decodeStampedVariantJson(contents).pipe(
        Effect.map((parsed) => normalizeDesktopVariant(parsed.t3codeDesktopVariant)),
        Effect.orElseSucceed(() => normalizeDesktopVariant(undefined)),
      ),
  });
});
