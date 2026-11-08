/**
 * Usage-limits facade: provider-neutral snapshot algebra lives in
 * `@t3tools/plusplus/usageLimits`; this module preserves the original
 * `@t3tools/provider-core/server/usageLimits` surface.
 */

export {
  applyUsageLimitsUpdate,
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  reconcileProviderUsageSnapshot,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/plusplus/usageLimits";
