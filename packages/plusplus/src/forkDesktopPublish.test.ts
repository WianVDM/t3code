import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { createBuildConfig } from "../../../scripts/build-desktop-artifact.ts";

const emptyEnv = Layer.mergeAll(
  Path.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);

it.effect("omits the update feed for an official build with no repository", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "win",
      "nsis",
      "0.0.33",
      false,
      false,
      undefined,
      undefined,
    ).pipe(Effect.provide(emptyEnv));

    assert.isNull(config.publish);
  }),
);

it.effect("points fork and plusplus variant feeds at the fork repository", () =>
  Effect.gen(function* () {
    for (const variant of ["fork", "plusplus"] as const) {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
        false,
        "x64",
        variant,
      ).pipe(Effect.provide(emptyEnv));

      assert.deepStrictEqual(config.publish, [
        { provider: "github", owner: "WianVDM", repo: "t3code", releaseType: "release" },
      ]);
    }
  }),
);
