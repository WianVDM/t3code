/**
 * Context bridge runtime glue for adapters: per-turn ContextBridgeSettings access and
 * the Effect wrappers every instruction call site shares. The host is explicit because
 * turn/session contexts do not provide ProviderHost. Resolution never fails a turn: a
 * settings read error or a defect logs a warning and yields no bridged context.
 *
 * @module provider-core/server/contextBridgeRuntime
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  buildBridgedInstructions,
  resolveBridgedInstructions,
  resolveBridgedSkillRoots,
  type BridgedInstructionsResolution,
  type BridgedSkillRoots,
} from "./contextBridge.ts";
import type { ProviderHost } from "./ProviderHost.ts";

/**
 * The current ContextBridgeSettings, or `undefined` when the settings read
 * fails. Callers treat `undefined` as "nothing bridged".
 */
export const currentContextBridgeSettings = Effect.fn(
  "ContextBridgeRuntime.currentContextBridgeSettings",
)(function* (host: ProviderHost["Service"]) {
  return yield* host.settings.get.pipe(
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
)(function* (input: {
  readonly host: ProviderHost["Service"];
  readonly targetDriver: string;
  readonly cwd: string | null | undefined;
}) {
  const settings = yield* currentContextBridgeSettings(input.host);
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

/**
 * Windows compares paths case-insensitively, and resolve() trims trailing
 * separators and dots.
 */
function sameLocation(a: string, b: string): boolean {
  return NodePath.resolve(a).toLowerCase() === NodePath.resolve(b).toLowerCase();
}

/**
 * Pi resolves its `~/.pi/agent` paths against PI_CODING_AGENT_DIR, falling
 * back to HOME. Report `nativeHome` only when one deviates from the server
 * home: an explicit PI_CODING_AGENT_DIR other than the default, or a launch
 * HOME different from it. An agent dir that merely restates
 * `userHome/.pi/agent` is not a move; leave it undefined so the default
 * expansion/filter behavior stays.
 */
function derivePiNativeHome(
  environment: NodeJS.ProcessEnv | undefined,
  userHome: string,
): string | undefined {
  const defaultAgentDir = NodePath.join(userHome, ".pi", "agent");
  const agentDir = environment?.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return sameLocation(agentDir, defaultAgentDir) ? undefined : agentDir;
  const home = environment?.HOME?.trim();
  if (home && !sameLocation(home, userHome)) return NodePath.join(home, ".pi", "agent");
  return undefined;
}

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
  function* (input: {
    readonly host: ProviderHost["Service"];
    readonly targetDriver: string;
    readonly cwd: string | null | undefined;
    /**
     * The launch environment for the provider process. Pi resolves its
     * globals against PI_CODING_AGENT_DIR (default ~/.pi/agent), so when it
     * is the target the bridge dedupes against that directory instead of
     * the process home. Other providers never set it and keep the default.
     */
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const settings = yield* currentContextBridgeSettings(input.host);
    if (settings === undefined) return { instructions: null, skillRoots: null };
    const userHome = yield* HostProcess.HomeDirectory;
    const nativeHome =
      input.targetDriver === "pi" ? derivePiNativeHome(input.environment, userHome) : undefined;
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
      ...(nativeHome === undefined ? {} : { nativeHome }),
    };
    const instructions = yield* resolve("instructions", () =>
      resolveBridgedInstructions(bridgeInput),
    );
    const skillRoots = yield* resolve("skills", () => resolveBridgedSkillRoots(bridgeInput));
    return { instructions, skillRoots };
  },
);
