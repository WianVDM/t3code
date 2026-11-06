import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it("keeps production base state resolution at ~/.t3/userdata regardless of app branding", () => {
  const joinPath = (...segments: string[]) => segments.join("/");
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: "/home/user",
    joinPath,
    t3Home: Option.none(),
  });
  assert.equal(baseDir, "/home/user/.t3");
  assert.equal(
    resolveDesktopStateDir({ baseDir, isDevelopment: false, joinPath, t3Home: Option.none() }),
    "/home/user/.t3/userdata",
  );
});

it("respects T3CODE_HOME for the base state directory in production", () => {
  const joinPath = (...segments: string[]) => segments.join("/");
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: "/home/user",
    joinPath,
    t3Home: Option.some("/custom/t3-home"),
  });
  assert.equal(baseDir, "/custom/t3-home");
  assert.equal(
    resolveDesktopStateDir({
      baseDir,
      isDevelopment: false,
      joinPath,
      t3Home: Option.some("/custom/t3-home"),
    }),
    "/custom/t3-home/userdata",
  );
});
it.effect("gives the fork its own Windows profile without migrating official state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-profile-" });
    yield* fs.makeDirectory(path.join(directory, "t3code-v2"), { recursive: true });
    yield* fs.writeFileString(path.join(directory, "t3code-v2", "Local State"), "official-keys");

    const destination = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
      desktopVariant: "fork",
    });

    assert.equal(destination, path.join(directory, "t3code-fork"));
    assert.isFalse(yield* fs.exists(path.join(destination, "Local State")));
    assert.equal(
      yield* fs.readFileString(path.join(directory, "t3code-v2", "Local State")),
      "official-keys",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
