/**
 * Context bridge runtime glue for adapters: per-turn ContextBridgeSettings access and
 * the Effect wrappers every instruction call site shares. Resolution never fails a turn:
 * a settings read error or a defect logs a warning and yields no bridged context.
 *
 * @module provider-core/server/contextBridgeRuntime
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  buildBridgedInstructions,
  resolveBridgedInstructions,
  resolveBridgedSkillRoots,
  type BridgedInstructionsResolution,
  type BridgedSkillRoots,
} from "./contextBridge.ts";
import { ProviderHost } from "./ProviderHost.ts";

/**
 * The current ContextBridgeSettings, or `undefined` when the host or its
 * settings are unavailable. Callers treat `undefined` as "nothing bridged".
 */
export const currentContextBridgeSettings = Effect.fn(
  "ContextBridgeRuntime.currentContextBridgeSettings",
)(function* () {
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
export const bridgedInstructionsForTurn = Effect.fn(
  "ContextBridgeRuntime.bridgedInstructionsForTurn",
)(function* (input: { readonly targetDriver: string; readonly cwd: string | null | undefined }) {
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

export interface BridgedContextForTurn {
  readonly instructions: BridgedInstructionsResolution | null;
  readonly skillRoots: BridgedSkillRoots | null;
}

/**
 * Each route (instructions, skills) resolves independently so one failing route never
 * suppresses the other, and a settings read failure yields two nulls. Targets that
 * inject outside the prompt stream (pi) need the per-file outcomes, not just the block.
 */
export const bridgedContextForTurn = Effect.fn("ContextBridgeRuntime.bridgedContextForTurn")(
  function* (input: { readonly targetDriver: string; readonly cwd: string | null | undefined }) {
    const settings = yield* currentContextBridgeSettings();
    if (settings === undefined) return { instructions: null, skillRoots: null };
    const userHome = yield* HostProcess.HomeDirectory;
    const resolve = <A>(
      feature: "instructions" | "skills",
      run: () => A,
    ): Effect.Effect<A | null> =>
      Effect.sync(run).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`context-bridge.${feature}-resolve-failed`, {
            targetDriver: input.targetDriver,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    const bridgeInput = {
      settings,
      targetDriver: input.targetDriver,
      cwd: input.cwd ?? undefined,
      userHome,
    };
    const instructions = yield* resolve("instructions", () =>
      resolveBridgedInstructions(bridgeInput),
    );
    const skillRoots = yield* resolve("skills", () => resolveBridgedSkillRoots(bridgeInput));
    return { instructions, skillRoots };
  },
);
