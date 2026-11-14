import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./usageLimits.ts";

/**
 * Provider-neutral Cursor usage-limit parsing and window catalog. Credential
 * discovery, Keychain access, and HTTP stay in the provider-cursor facade.
 */

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "Combined usage across both allowances, not a third quota.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok and Composer use this first. Auto can use either pool.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Claude, GPT, and Gemini use this pool. Grok and Composer fall back here.",
  },
] as const;

export function cursorUsageWindowDetails(id: string) {
  return CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
}

export function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

export interface CursorUsageResponse {
  readonly billingCycleEnd?: string | number | undefined;
  readonly planUsage?:
    | {
        readonly totalPercentUsed?: number | undefined;
        readonly autoPercentUsed?: number | undefined;
        readonly apiPercentUsed?: number | undefined;
      }
    | undefined;
}

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(response: CursorUsageResponse, checkedAt: string) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}
