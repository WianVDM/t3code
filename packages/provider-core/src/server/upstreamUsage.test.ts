import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverUpstreamCredentials } from "./upstreamUsage.ts";

describe("discoverUpstreamCredentials", () => {
  it.effect("discovers Pi api_key and OpenCode api entries from a temporary auth.json", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-upstream-usage-" });
      const authPath = path.join(dir, "auth.json");
      yield* fileSystem.writeFileString(
        authPath,
        JSON.stringify({
          pi: { type: "api_key", key: "pi-secret" },
          opencode: { type: "api", key: "opencode-secret" },
        }),
      );

      const credentials = yield* discoverUpstreamCredentials(authPath);

      expect(credentials).toEqual([
        { providerId: "pi", authType: "api_key", secret: "pi-secret" },
        { providerId: "opencode", authType: "api", secret: "opencode-secret" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("tolerates a missing auth file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-upstream-usage-" });

      const credentials = yield* discoverUpstreamCredentials(path.join(dir, "auth.json"));

      expect(credentials).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
