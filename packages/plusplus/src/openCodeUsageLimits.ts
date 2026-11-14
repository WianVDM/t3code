import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { clampPercent } from "./usageLimits.ts";

/**
 * Provider-neutral OpenCode Go usage-window construction. Credential discovery
 * (auth.json, SQLite), the key fallback chain, and HTTP stay in the
 * provider-opencode facade.
 */

export const OPENCODE_GO_PROBE_FAILED_MESSAGE = "OpenCode Go could not read usage.";

export const OpenCodeGoUsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});

export const OpenCodeGoUsageResponse = Schema.Struct({
  usage: Schema.Struct({
    rolling: OpenCodeGoUsageWindow,
    weekly: OpenCodeGoUsageWindow,
    monthly: OpenCodeGoUsageWindow,
  }),
});

export function openCodeGoUsageToWindows(
  body: typeof OpenCodeGoUsageResponse.Type,
): ServerProviderUsageWindow[] {
  return [
    {
      id: "go_rolling",
      kind: "session",
      label: "Go · Session",
      windowDurationMins: 5 * 60,
      usedPercent: clampPercent(body.usage.rolling.percent),
      resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
    },
    {
      id: "go_weekly",
      kind: "weekly",
      label: "Go · Weekly",
      windowDurationMins: 7 * 24 * 60,
      usedPercent: clampPercent(body.usage.weekly.percent),
      resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
    },
    {
      id: "go_monthly",
      kind: "monthly",
      label: "Go · Monthly",
      usedPercent: clampPercent(body.usage.monthly.percent),
      resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
    },
  ];
}
