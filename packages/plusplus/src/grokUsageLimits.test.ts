import { describe, expect, it } from "@effect/vitest";

import { grokUsageResponseToLimits, isGrokPrivacyModeRefusal } from "./grokUsageLimits.ts";

describe("Grok usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";
  const weeklyPeriod = {
    type: "USAGE_PERIOD_TYPE_WEEKLY",
    start: "2026-09-11T03:10:30.159171+00:00",
    end: "2026-09-18T03:10:30.159171+00:00",
  };

  it("shows zero usage for complete weekly and monthly periods with no percentage", () => {
    for (const [currentPeriod, kind, label, resetsAt] of [
      [weeklyPeriod, "weekly", "Weekly", "2026-09-18T03:10:30.159Z"],
      [
        {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          start: "2026-09-01T00:00:00.000Z",
          end: "2026-10-01T00:00:00.000Z",
        },
        "monthly",
        "Monthly",
        "2026-10-01T00:00:00.000Z",
      ],
    ] as const) {
      const response = { config: { currentPeriod } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows)
        .toEqual([{ id: "subscription", kind, label, usedPercent: 0, resetsAt }]);
    }
  });

  it("keeps incomplete, invalid, unordered, and unknown periods unreported", () => {
    for (const currentPeriod of [
      undefined,
      { ...weeklyPeriod, type: undefined },
      { ...weeklyPeriod, type: "USAGE_PERIOD_TYPE_DAILY" },
      { ...weeklyPeriod, start: undefined },
      { ...weeklyPeriod, end: undefined },
      { ...weeklyPeriod, start: "invalid" },
      { ...weeklyPeriod, end: "invalid" },
      { ...weeklyPeriod, start: weeklyPeriod.end },
      { ...weeklyPeriod, start: weeklyPeriod.end, end: weeklyPeriod.start },
    ]) {
      const response = { config: { currentPeriod } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows, JSON.stringify(response))
        .toEqual([]);
    }
  });

  // regression: #17061 show zero-use Grok billing periods
  it("rejects impossible calendar dates at either period boundary", () => {
    for (const [start, end] of [
      ["2026-02-30T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
      ["2026-02-23T00:00:00.000Z", "2026-02-30T00:00:00.000Z"],
    ]) {
      const response = { config: { currentPeriod: { ...weeklyPeriod, start, end } } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows, JSON.stringify(response))
        .toEqual([]);
    }
  });

  it("does not invent allowance or reset dates when billing omits them", () => {
    for (const response of [{}, { config: {} }, { config: { creditUsagePercent: NaN } }]) {
      const limits = grokUsageResponseToLimits(response, checkedAt);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable).toBeUndefined();
    }
    expect(
      grokUsageResponseToLimits({ config: { creditUsagePercent: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "subscription", kind: "other", label: "Subscription", usedPercent: 0 }]);
    expect(
      grokUsageResponseToLimits(
        {
          config: {
            creditUsagePercent: 120,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" },
          },
        },
        checkedAt,
      ).windows,
    ).toEqual([{ id: "subscription", kind: "monthly", label: "Monthly", usedPercent: 100 }]);
  });
});

describe("grok privacy-mode refusal", () => {
  it("classifies only the legacy privacy-mode 403 body", () => {
    expect(isGrokPrivacyModeRefusal("WKE=privacy-mode:legacy")).toBe(true);
    expect(isGrokPrivacyModeRefusal("forbidden")).toBe(false);
  });
});
