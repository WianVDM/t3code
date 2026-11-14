import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { clampPercent, makeUsageLimits } from "./usageLimits.ts";

/**
 * Provider-neutral Grok billing-response interpretation. Credential discovery,
 * config-scope guards, and HTTP stay in the provider-grok facade.
 */

export const GROK_PROBE_FAILED_MESSAGE = "Grok could not read usage limits.";
export const GROK_PRIVACY_MODE_MESSAGE =
  "Switch your xAI account to Privacy Mode to show Grok usage limits.";

export const GrokUsageResponse = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.Number),
      currentPeriod: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          start: Schema.optional(Schema.Unknown),
          end: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

export const GrokErrorResponse = Schema.Struct({ error: Schema.String });

/** xAI refuses Grok Build while the account's privacy setting is a legacy mode. */
export function isGrokPrivacyModeRefusal(error: string): boolean {
  return error.includes("WKE=privacy-mode:");
}

function parsePeriodBoundary(value: string | undefined) {
  if (
    !value ||
    value !== value.trim() ||
    !/^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  ) {
    return Number.NaN;
  }
  // Date parsing can normalize impossible calendar dates instead of rejecting them.
  const datePart = value.slice(0, value.indexOf("T"));
  const date = DateTime.make(`${datePart}T00:00:00.000Z`);
  if (Option.isNone(date)) return Number.NaN;
  const parts = DateTime.toPartsUtc(date.value);
  if (parts.month !== Number(datePart.slice(-5, -3)) || parts.day !== Number(datePart.slice(-2))) {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function grokUsageResponseToLimits(
  response: typeof GrokUsageResponse.Type,
  checkedAt: string,
) {
  const period = response.config?.currentPeriod;
  const periodType = period?.type?.replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind = periodType === "WEEKLY" ? "weekly" : periodType === "MONTHLY" ? "monthly" : "other";
  let usedPercent = response.config?.creditUsagePercent;
  if (
    usedPercent === undefined &&
    (kind === "weekly" || kind === "monthly") &&
    typeof period?.start === "string" &&
    parsePeriodBoundary(period?.start) < parsePeriodBoundary(period?.end)
  ) {
    // Grok omits a zero percentage while retaining the complete subscription period.
    usedPercent = 0;
  }
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    return makeUsageLimits({ checkedAt, windows: [] });
  }
  const reset = period?.end ? DateTime.make(period.end) : Option.none();
  const window: ServerProviderUsageWindow = {
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: clampPercent(usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}
