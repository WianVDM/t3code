import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { createBuildConfig } from "../../../scripts/build-desktop-artifact.ts";

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
    ).pipe(
      Effect.provide(
        Layer.mergeAll(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
    );

    assert.isNull(config.publish);
  }),
);
