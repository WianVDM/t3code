import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";
import { museUsageLimitResetAt as resetAt } from "@t3tools/plusplus/museUsageLimits";

/**
 * Muse usage facade: refusal detection and reset calculation live in
 * `@t3tools/plusplus/museUsageLimits`; this module binds them to the SDK's
 * usage schema and the protocol's latest representable instant.
 */

export { isMuseUsageLimitFailure } from "@t3tools/plusplus/museUsageLimits";

export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  return resetAt(usage, nowMs, refusal, LATEST_DATE_MS);
}
