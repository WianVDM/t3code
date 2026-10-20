/**
 * Context bridge runtime glue for adapters: per-turn access to the server's
 * ContextBridgeSettings plus the Effect wrappers every instruction call site
 * shares. Settings are read on every call so a change applies to the next
 * turn without a restart.
 *
 * Resolution never fails a turn. The host is optional (`Effect.serviceOption`
 * keeps the requirement out of every adapter's environment), a settings read
 * error or a defect while building the block logs a warning and yields no
 * bridged context.
 *
 * @module provider-core/server/contextBridgeRuntime
 */
import type { ContextBridgeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { buildBridgedInstructions } from "./contextBridge.ts";
import { ProviderHost } from "./ProviderHost.ts";

/**
 * The current ContextBridgeSettings, or `undefined` when the host or its
 * settings are unavailable. Callers treat `undefined` as "nothing bridged".
 */
export const currentContextBridgeSettings = (): Effect.Effect<ContextBridgeSettings | undefined> =>
  Effect.gen(function* () {
    const host = yield* Effect.serviceOption(ProviderHost);
    if (Option.isNone(host)) return undefined;
    return yield* host.value.settings.get.pipe(
      Effect.map((settings) => settings.contextBridge),
      Effect.catchCause((cause) =>
        Effect.logWarning("context-bridge.settings-read-failed", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  });

/**
 * The bridged `<project_context>` block for one turn ("" when nothing
 * applies). `targetDriver` is the adapter's own driver kind; `cwd` is the
 * turn's working directory.
 */
export const bridgedInstructionsForTurn = (input: {
  readonly targetDriver: string;
  readonly cwd: string | null | undefined;
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const settings = yield* currentContextBridgeSettings();
    if (settings === undefined) return "";
    const userHome = yield* HostProcess.HomeDirectory;
    return yield* Effect.sync(() =>
      buildBridgedInstructions({
        settings,
        targetDriver: input.targetDriver,
        cwd: input.cwd ?? undefined,
        userHome,
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("context-bridge.instructions-resolve-failed", {
          targetDriver: input.targetDriver,
          cause,
        }).pipe(Effect.as("")),
      ),
    );
  });
