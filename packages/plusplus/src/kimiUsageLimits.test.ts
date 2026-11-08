import { describe, expect, it } from "vite-plus/test";

import { kimiProbeFailedLimits, kimiUsageResponseToLimits } from "./kimiUsageLimits.ts";

const checkedAt = "2026-10-22T12:00:00.000Z";

/** The Pi-native facade keeps raw `limit_*` keys as window ids. */
const piUsageResponseToLimits = (response: unknown, at: string) =>
  kimiUsageResponseToLimits(response, at, { genericLimitWindowId: (key) => key });

describe("Kimi Code usage limits mapping", () => {
  it("maps the full real payload to session and weekly windows", () => {
    const payload = {
      usage: {
        limit: "100",
        used: "90",
        remaining: "10",
        resetTime: "2026-10-27T06:09:31.207136Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "8",
            remaining: "92",
            resetTime: "2026-10-22T14:09:31.207136Z",
          },
        },
      ],
      usages: {
        limit_5h: { used_ratio: 0.08, reset_time: "2026-10-22T14:09:30Z" },
        limit_7d: { used_ratio: 0.8989, reset_time: "2026-10-27T06:09:30Z" },
      },
    };

    const limits = piUsageResponseToLimits(payload, checkedAt);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.checkedAt).toBe(checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "kimi-5h",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 8,
        resetsAt: "2026-10-22T14:09:30Z",
        windowDurationMins: 300,
      },
      {
        id: "kimi-7d",
        kind: "weekly",
        label: "Kimi Code Weekly",
        usedPercent: 89.89,
        resetsAt: "2026-10-27T06:09:30Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("parses string-formatted numbers tolerantly", () => {
    const payload = {
      usages: {
        limit_5h: { used_ratio: "0.08", reset_time: "2026-10-22T14:09:30Z" },
        limit_7d: { used_ratio: "0.8989", reset_time: "2026-10-27T06:09:30Z" },
      },
    };

    const limits = piUsageResponseToLimits(payload, checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "kimi-5h",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 8,
        resetsAt: "2026-10-22T14:09:30Z",
        windowDurationMins: 300,
      },
      {
        id: "kimi-7d",
        kind: "weekly",
        label: "Kimi Code Weekly",
        usedPercent: 89.89,
        resetsAt: "2026-10-27T06:09:30Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("falls back to usage and limits[] when usages key is absent", () => {
    const fallbackPayload = {
      usage: {
        limit: "100",
        used: "90",
        remaining: "10",
        resetTime: "2026-10-27T06:09:31.207136Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "8",
            remaining: "92",
            resetTime: "2026-10-22T14:09:31.207136Z",
          },
        },
      ],
    };

    const limits = piUsageResponseToLimits(fallbackPayload, checkedAt);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "kimi-limit-0",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 8,
        resetsAt: "2026-10-22T14:09:31.207136Z",
        windowDurationMins: 300,
      },
      {
        id: "kimi-7d",
        kind: "weekly",
        label: "Kimi Code Weekly",
        usedPercent: 90,
        resetsAt: "2026-10-27T06:09:31.207136Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("treats an unparseable or empty payload as probe failure", () => {
    for (const invalid of [
      {},
      null,
      undefined,
      "not an object",
      { usages: {} },
      { usages: { limit_5h: { used_ratio: "invalid-number" } } },
      { usage: { limit: "0", used: "0" } },
    ]) {
      const limits = piUsageResponseToLimits(invalid, checkedAt);
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Kimi Code usage limits could not be read.",
      });
      expect(limits.windows).toEqual([]);
    }
  });

  it("handles additional limit_* keys under usages as other kind", () => {
    const payload = {
      usages: {
        limit_30d: { used_ratio: 0.5, reset_time: "2026-11-20T00:00:00Z" },
      },
    };
    const limits = piUsageResponseToLimits(payload, checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "limit_30d",
        kind: "other",
        label: "Kimi Code limit_30d",
        usedPercent: 50,
        resetsAt: "2026-11-20T00:00:00Z",
        windowDurationMins: 43200,
      },
    ]);
  });
});

describe("kimiUsageResponseToLimits (hub reader defaults)", () => {
  it("prefixes generic limit_* window ids with kimi-", () => {
    const payload = {
      usages: {
        limit_30d: { used_ratio: 0.5, reset_time: "2026-11-20T00:00:00Z" },
      },
    };
    expect(kimiUsageResponseToLimits(payload, checkedAt).windows).toEqual([
      {
        id: "kimi-limit_30d",
        kind: "other",
        label: "Kimi Code limit_30d",
        usedPercent: 50,
        resetsAt: "2026-11-20T00:00:00Z",
        windowDurationMins: 43200,
      },
    ]);
  });

  it("maps the standard 5-hour and 7-day keys identically in both reader modes", () => {
    const payload = {
      usages: {
        limit_5h: { used_ratio: 0.2, reset_time: "2026-10-22T14:09:30Z" },
        limit_7d: { used_ratio: 0.4, reset_time: "2026-10-27T06:09:30Z" },
      },
    };
    expect(kimiUsageResponseToLimits(payload, checkedAt)).toEqual(
      piUsageResponseToLimits(payload, checkedAt),
    );
  });

  it("exposes the shared probe-failed fallback", () => {
    expect(kimiProbeFailedLimits(checkedAt)).toEqual({
      checkedAt,
      windows: [],
      unavailable: {
        reason: "probeFailed",
        message: "Kimi Code usage limits could not be read.",
      },
    });
    expect(kimiUsageResponseToLimits(undefined, checkedAt)).toEqual(
      kimiProbeFailedLimits(checkedAt),
    );
  });
});
