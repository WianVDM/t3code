import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { normalizeDesktopVariant, resolveDesktopVariant } from "./DesktopVariant.ts";

it("normalizes only the fork marker", () => {
  assert.equal(normalizeDesktopVariant(undefined), "official");
  assert.equal(normalizeDesktopVariant(""), "official");
  assert.equal(normalizeDesktopVariant("beta"), "official");
  assert.equal(normalizeDesktopVariant("fork"), "fork");
  assert.equal(normalizeDesktopVariant(" fork "), "fork");
});

it.effect("reads the stamped variant from the packaged app package.json", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-variant-" });
    yield* fs.writeFileString(
      path.join(appPath, "package.json"),
      JSON.stringify({ t3codeDesktopVariant: "fork" }),
    );

    const variant = yield* resolveDesktopVariant({
      isPackaged: true,
      appPath,
      envVariant: undefined,
    });

    assert.equal(variant, "fork");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ignores the environment variable in packaged builds without a stamp", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const appPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-variant-" });

    const variant = yield* resolveDesktopVariant({
      isPackaged: true,
      appPath,
      envVariant: "fork",
    });

    assert.equal(variant, "official");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("treats an unreadable or unmarked packaged app as official", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-variant-" });

    const missing = yield* resolveDesktopVariant({
      isPackaged: true,
      appPath,
      envVariant: undefined,
    });
    assert.equal(missing, "official");

    yield* fs.writeFileString(path.join(appPath, "package.json"), "not json {");
    const invalid = yield* resolveDesktopVariant({
      isPackaged: true,
      appPath,
      envVariant: undefined,
    });
    assert.equal(invalid, "official");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("falls back to the environment variant in unpackaged runs", () =>
  Effect.gen(function* () {
    const fork = yield* resolveDesktopVariant({
      isPackaged: false,
      appPath: "/definitely/missing",
      envVariant: "fork",
    });
    assert.equal(fork, "fork");

    const official = yield* resolveDesktopVariant({
      isPackaged: false,
      appPath: "/definitely/missing",
      envVariant: undefined,
    });
    assert.equal(official, "official");
  }).pipe(Effect.provide(NodeServices.layer)),
);
