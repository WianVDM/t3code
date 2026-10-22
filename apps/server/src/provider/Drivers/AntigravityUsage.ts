import { type AntigravitySettings, UsageReadError } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type {
  ProviderUsageInstance,
  ProviderUsageReader,
  ProviderUsageScan,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";

const ANTIGRAVITY_ACP_DIR = "antigravity-acp";

export class AntigravityUsage extends Context.Service<
  AntigravityUsage,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<ProviderUsageInstance<AntigravitySettings>>;
      readonly windowStartMs: number;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>, UsageReadError>;
  }
>()("t3/provider/Drivers/AntigravityUsage") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const cache = makeAntigravityUsageCache();

  const dataRoots = Effect.fn("AntigravityUsage.dataRoots")(function* (
    environment: NodeJS.ProcessEnv,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const configured = environment["ANTIGRAVITY_DATA_DIR"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const defaults = [
      ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
        path.join(home, ".gemini", name),
      ),
      path.join(home, ".config", "antigravity"),
    ];
    const canonical = new Set<string>();
    for (const root of configured?.length ? configured : defaults) {
      const resolved = path.resolve(expandHomePath(root, home));
      canonical.add(
        yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)),
      );
    }
    return [...canonical];
  });

  const scan: AntigravityUsage["Service"]["scan"] = Effect.fn("AntigravityUsage.scan")(function* ({
    instances,
    windowStartMs,
  }) {
    const roots = new Set<string>();
    for (const instance of instances) {
      for (const root of yield* dataRoots(instance.environment)) {
        roots.add(root);
      }
    }
    for (const { instanceId } of instances.filter((instance) => instance.configured)) {
      const directories = yield* resolveAntigravityInstanceDirectories(
        host.paths.stateDir,
        instanceId,
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Antigravity profile directory could not be resolved.",
              cause,
            }),
        ),
      );
      roots.add(path.join(directories.profile, ANTIGRAVITY_ACP_DIR));
    }
    // Profile conversations persist under <stateDir>/providers/antigravity/<key>/antigravity-acp
    // even when instances are unconfigured or were created under another state directory.
    const providersDir = path.join(host.paths.stateDir, "providers", "antigravity");
    const profileEntries = yield* fileSystem.readDirectory(providersDir).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Antigravity providers directory could not be read.",
            cause,
          }),
      ),
    );
    for (const entry of profileEntries) {
      roots.add(path.join(providersDir, entry, ANTIGRAVITY_ACP_DIR));
    }
    const conversationDirs = new Set<string>();
    for (const root of roots) {
      const resolvedRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const nested = path.join(resolvedRoot, "conversations");
      const dir = (yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false))))
        ? nested
        : resolvedRoot;
      conversationDirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    const result = yield* readAntigravityUsage([...conversationDirs], windowStartMs, cache).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const scanned: ProviderUsageScan[] = [];
    for (const dir of conversationDirs) {
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const failed = result.errors.some(
        (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
      );
      scanned.push({
        dir,
        files: !exists && !failed ? null : result.files.filter((file) => file.root === dir),
        status: failed ? "partial" : "ok",
        ...(failed ? { message: "Some Antigravity history could not be read." } : {}),
      });
    }
    return scanned;
  });

  return AntigravityUsage.of({ scan });
});

export const layer = Layer.effect(AntigravityUsage, make);

export const antigravityUsageReader: ProviderUsageReader<AntigravitySettings, AntigravityUsage> = {
  kind: "scan",
  provider: "antigravity",
  scan: ({ instances, windowStartMs }) =>
    AntigravityUsage.pipe(Effect.flatMap((usage) => usage.scan({ instances, windowStartMs }))),
};
