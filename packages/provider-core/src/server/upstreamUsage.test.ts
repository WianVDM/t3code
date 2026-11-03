import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, UsageLimitSourceError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  discoverUpstreamCredentials,
  probeUpstreamUsage,
  type StoredUpstreamCredential,
  type UpstreamUsageReader,
  type UpstreamUsageReaderContext,
} from "./upstreamUsage.ts";

const driver = ProviderDriverKind.make("codex");

const succeededAccount = (context: UpstreamUsageReaderContext) => ({
  id: context.credential.providerId,
  driver: context.driver,
  usageLimits: { checkedAt: context.checkedAt, windows: [] },
});

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

describe("probeUpstreamUsage", () => {
  it.effect("returns an unsupported account for a provider with no registered reader", () =>
    Effect.gen(function* () {
      const readers: Readonly<Record<string, UpstreamUsageReader>> = {};

      const accounts = yield* probeUpstreamUsage({
        driver,
        credentials: [{ providerId: "opencode", authType: "api", secret: "opencode-secret" }],
        readers,
      });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.id).toBe("opencode");
      expect(accounts[0]?.usageLimits.unavailable).toEqual({ reason: "unsupported" });
    }),
  );

  it.effect(
    "isolates a throwing or failing reader as probeFailed without affecting other accounts",
    () =>
      Effect.gen(function* () {
        const credentials: ReadonlyArray<StoredUpstreamCredential> = [
          { providerId: "pi", authType: "api_key", secret: "pi-secret" },
          { providerId: "opencode", authType: "api", secret: "opencode-secret" },
          { providerId: "anthropic", authType: "api_key", secret: "anthropic-secret" },
        ];
        const readers: Readonly<Record<string, UpstreamUsageReader>> = {
          pi: () =>
            Effect.sync(() => {
              throw new Error("transport exploded");
            }),
          opencode: () => Effect.fail(new UsageLimitSourceError({ detail: "rate limited" })),
          anthropic: (context) =>
            Effect.succeed({
              id: context.credential.providerId,
              driver: context.driver,
              usageLimits: { checkedAt: context.checkedAt, windows: [] },
            }),
        };

        const accounts = yield* probeUpstreamUsage({ driver, credentials, readers });

        expect(accounts.map((account) => account.id)).toEqual(["pi", "opencode", "anthropic"]);
        expect(accounts[0]?.usageLimits.unavailable).toEqual({
          reason: "probeFailed",
          message: "pi could not read usage.",
        });
        expect(accounts[1]?.usageLimits.unavailable).toEqual({
          reason: "probeFailed",
          message: "opencode could not read usage.",
        });
        expect(accounts[2]?.usageLimits.unavailable).toBeUndefined();
        expect(accounts[2]?.usageLimits.windows).toEqual([]);
      }),
  );

  it.effect("probes independent accounts concurrently and keeps result order", () =>
    Effect.gen(function* () {
      const piStarted = yield* Deferred.make<void>();
      const opencodeStarted = yield* Deferred.make<void>();
      const readers: Readonly<Record<string, UpstreamUsageReader>> = {
        pi: (context) =>
          Deferred.succeed(piStarted, undefined).pipe(
            Effect.andThen(Deferred.await(opencodeStarted)),
            Effect.as(succeededAccount(context)),
          ),
        opencode: (context) =>
          Deferred.succeed(opencodeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(piStarted)),
            Effect.as(succeededAccount(context)),
          ),
      };

      // Each reader waits on the other, so a sequential probe could never finish.
      const accounts = yield* probeUpstreamUsage({
        driver,
        credentials: [
          { providerId: "pi", authType: "api_key", secret: "pi-secret" },
          { providerId: "opencode", authType: "api", secret: "opencode-secret" },
        ],
        readers,
      });

      expect(accounts.map((account) => account.id)).toEqual(["pi", "opencode"]);
      expect(accounts.every((account) => account.usageLimits.unavailable === undefined)).toBe(true);
    }),
  );

  it.effect("reports a credential with no usable key as unsupported without probing", () =>
    Effect.gen(function* () {
      const probed = yield* Ref.make<ReadonlyArray<string>>([]);
      const readers: Readonly<Record<string, UpstreamUsageReader>> = {
        pi: (context) =>
          Ref.update(probed, (ids) => [...ids, context.credential.providerId]).pipe(
            Effect.as(succeededAccount(context)),
          ),
      };

      const accounts = yield* probeUpstreamUsage({
        driver,
        credentials: [
          { providerId: "pi", authType: "api_key" },
          { providerId: "opencode", authType: "api", secret: "   " },
        ],
        readers,
      });

      expect(yield* Ref.get(probed)).toEqual([]);
      expect(accounts.map((account) => account.id)).toEqual(["pi", "opencode"]);
      expect(accounts.map((account) => account.usageLimits.unavailable?.reason)).toEqual([
        "unsupported",
        "unsupported",
      ]);
    }),
  );

  it.effect(
    "propagates a reader's interrupt cause instead of publishing probeFailed accounts",
    () =>
      Effect.gen(function* () {
        const readers: Readonly<Record<string, UpstreamUsageReader>> = {
          pi: () =>
            Effect.gen(function* () {
              const child = yield* Effect.never.pipe(Effect.forkChild({ startImmediately: true }));
              yield* Fiber.interrupt(child);
              return yield* Fiber.join(child);
            }),
        };

        const exit = yield* Effect.exit(
          probeUpstreamUsage({
            driver,
            credentials: [{ providerId: "pi", authType: "api_key", secret: "pi-secret" }],
            readers,
          }),
        );

        expect(Exit.isSuccess(exit)).toBe(false);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
  );
});
