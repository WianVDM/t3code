import {
  UsageLimitSourceError,
  type ProviderDriverKind,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeUnavailableUsageLimits } from "./usageLimits.ts";

/**
 * Provider-neutral upstream (CLI proxy) account probing. Credential discovery
 * from host auth files stays in the provider-core facade, which supplies the
 * per-provider readers.
 */

export interface StoredUpstreamCredential {
  readonly providerId: string;
  /** Pi stores API keys as "api_key"; OpenCode stores them as "api". */
  readonly authType: "api_key" | "api";
  readonly secret?: string;
}

export interface UpstreamUsageReaderContext {
  readonly driver: ProviderDriverKind;
  readonly credential: StoredUpstreamCredential;
  readonly checkedAt: string;
}

export type UpstreamUsageReader<R = never> = (
  context: UpstreamUsageReaderContext,
) => Effect.Effect<UsageLimitSourceAccount, UsageLimitSourceError, R>;

function unavailableAccount(
  context: UpstreamUsageReaderContext,
  reason: "unsupported" | "probeFailed",
  message?: string,
): UsageLimitSourceAccount {
  return {
    id: context.credential.providerId,
    driver: context.driver,
    usageLimits: makeUnavailableUsageLimits({
      checkedAt: context.checkedAt,
      reason,
      ...(message !== undefined ? { message } : {}),
    }),
  };
}

const PROBE_CONCURRENCY = 4;

export const probeUpstreamUsage = Effect.fn("probeUpstreamUsage")(function* <R>(input: {
  readonly driver: ProviderDriverKind;
  readonly credentials: ReadonlyArray<StoredUpstreamCredential>;
  readonly readers: Readonly<Record<string, UpstreamUsageReader<R>>>;
}): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, never, R> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.forEach(
    input.credentials,
    (credential) =>
      Effect.suspend(() => {
        const context: UpstreamUsageReaderContext = {
          driver: input.driver,
          credential,
          checkedAt,
        };
        const reader = input.readers[credential.providerId];
        // A keyless entry can only come back as a fake 401, so never spend a probe on it.
        if (reader === undefined || !credential.secret?.trim()) {
          return Effect.succeed(unavailableAccount(context, "unsupported"));
        }
        return reader(context).pipe(
          Effect.catchCause((cause) => {
            const interruptionReasons = cause.reasons.filter(Cause.isInterruptReason);
            // Cancellation is not a failed read, so it surfaces instead of a probeFailed account.
            if (interruptionReasons.length > 0) {
              return Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
            }
            return Effect.succeed(
              unavailableAccount(
                context,
                "probeFailed",
                `${credential.providerId} could not read usage.`,
              ),
            );
          }),
        );
      }),
    // One stalled reader must not serialize the rest behind its timeout.
    { concurrency: PROBE_CONCURRENCY },
  );
});
