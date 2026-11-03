import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { AntigravityUsage, layer as AntigravityUsageLayer } from "./AntigravityUsage.ts";

const hostLayer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(
  AntigravityUsageLayer.pipe(Layer.provide(hostLayer), Layer.provide(NodeServices.layer)),
  hostLayer,
  NodeServices.layer,
);

describe("AntigravityUsage", () => {
  it.effect(
    "includes profile conversation directories from stateDir even when instances are empty or unconfigured",
    () =>
      Effect.gen(function* () {
        const usage = yield* AntigravityUsage;
        const host = yield* ProviderHost.ProviderHost;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-home-" });
        const profileKey = "test-profile-account";
        const conversationsDir = path.join(
          host.paths.stateDir,
          "providers",
          "antigravity",
          profileKey,
          "antigravity-acp",
          "conversations",
        );
        yield* fileSystem.makeDirectory(conversationsDir, { recursive: true });
        const canonicalConversationsDir = yield* fileSystem.realPath(conversationsDir);

        const scanEmpty = yield* usage
          .scan({
            instances: [],
            windowStartMs: 0,
          })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
        expect(scanEmpty.map((scan) => scan.dir)).toContain(canonicalConversationsDir);

        const scanUnconfigured = yield* usage
          .scan({
            instances: [
              {
                instanceId: ProviderInstanceId.make("unconfigured-account"),
                configured: false,
                environment: {},
                config: undefined,
              },
            ],
            windowStartMs: 0,
          })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
        expect(scanUnconfigured.map((scan) => scan.dir)).toContain(canonicalConversationsDir);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("tolerates a missing providers/antigravity directory without failing", () =>
    Effect.gen(function* () {
      const usage = yield* AntigravityUsage;
      const fileSystem = yield* FileSystem.FileSystem;

      const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-home-missing-" });
      const scan = yield* usage
        .scan({
          instances: [],
          windowStartMs: 0,
        })
        .pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
      expect(scan).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
