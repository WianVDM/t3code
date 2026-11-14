import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OpenCodeGoUsageResponse, openCodeGoUsageToWindows } from "./openCodeUsageLimits.ts";

const decode = Schema.decodeUnknownSync(OpenCodeGoUsageResponse);

describe("openCodeGoUsageToWindows", () => {
  it("maps the rolling, weekly, and monthly windows with their cadences", () => {
    const windows = openCodeGoUsageToWindows(
      decode({
        usage: {
          rolling: { percent: 12.5, resetsAt: "2026-09-03T14:00:00.000Z" },
          weekly: { percent: 40, resetsAt: "2026-09-06T12:00:00.000Z" },
          monthly: { percent: 70, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      }),
    );
    expect(windows).toEqual([
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 300,
        usedPercent: 12.5,
        resetsAt: "2026-09-03T14:00:00.000Z",
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 10080,
        usedPercent: 40,
        resetsAt: "2026-09-06T12:00:00.000Z",
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: 70,
        resetsAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });

  it("clamps reported percentages into range", () => {
    const windows = openCodeGoUsageToWindows(
      decode({
        usage: {
          rolling: { percent: 150, resetsAt: "2026-09-03T14:00:00.000Z" },
          weekly: { percent: -20, resetsAt: "2026-09-06T12:00:00.000Z" },
          monthly: { percent: 0, resetsAt: "2026-10-01T00:00:00.000Z" },
        },
      }),
    );
    expect(windows.map((window) => window.usedPercent)).toEqual([100, 0, 0]);
  });
});
