import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AntigravityModels,
  AntigravityQuotaSummary,
  antigravityModelWindows,
  antigravitySummaryWindows,
} from "./antigravityUsageLimits.ts";

const decodeSummary = Schema.decodeUnknownSync(AntigravityQuotaSummary);
const decodeModels = Schema.decodeUnknownSync(AntigravityModels);

const requestedAt = Date.parse("2026-10-21T10:16:04.000Z");

describe("antigravitySummaryWindows", () => {
  it("names families, kinds, and cadences from bucket ids and windows", () => {
    const windows = antigravitySummaryWindows(
      decodeSummary({
        groups: [
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              {
                bucketId: "gemini-argon-5h",
                window: "5h",
                remainingFraction: 0.5,
                resetTime: "2026-10-21T13:16:04Z",
                description: "Partly used.",
              },
            ],
          },
          {
            buckets: [
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 0.25,
                resetTime: "2026-10-28T10:16:04Z",
              },
              { bucketId: "custom", remainingFraction: 0.75, displayName: "Extra" },
            ],
          },
        ],
      }),
      requestedAt,
    );
    expect(windows).toEqual([
      {
        id: "gemini-argon-5h",
        label: "Gemini 4 Argon · 5-hour",
        kind: "session",
        usedPercent: 50,
        resetsAt: "2026-10-21T13:16:04.000Z",
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 75,
        resetsAt: "2026-10-28T10:16:04.000Z",
        windowDurationMins: 10080,
      },
      { id: "custom", label: "custom · Extra", kind: "other", usedPercent: 25 },
    ]);
  });

  it("omits rolling resets for untouched buckets and keeps used or described ones", () => {
    const windows = antigravitySummaryWindows(
      decodeSummary({
        buckets: [
          {
            bucketId: "gemini-5h",
            window: "5h",
            remainingFraction: 1,
            // A full-window rolling reset measured from the request time.
            resetTime: "2026-10-21T15:16:05Z",
          },
          {
            bucketId: "gemini-weekly",
            window: "weekly",
            remainingFraction: 0.96,
            resetTime: "2026-10-28T08:29:53Z",
            description: "Partly used.",
          },
        ],
      }),
      requestedAt,
    );
    const byId = new Map(windows.map((window) => [window.id, window]));
    expect(byId.get("gemini-5h")?.resetsAt).toBeUndefined();
    expect(byId.get("gemini-weekly")?.resetsAt).toBe("2026-10-28T08:29:53.000Z");
  });

  it("skips disabled buckets and buckets without a finite fraction", () => {
    const windows = antigravitySummaryWindows(
      decodeSummary({
        buckets: [
          { bucketId: "off", window: "5h", remainingFraction: 0.5, disabled: true },
          { bucketId: "missing", window: "5h" },
        ],
      }),
      requestedAt,
    );
    expect(windows).toEqual([]);
  });
});

describe("antigravityModelWindows", () => {
  it("maps provider families and keeps the most-used reading per window", () => {
    const windows = antigravityModelWindows(
      decodeModels({
        models: {
          "gemini-3-pro": {
            modelProvider: "MODEL_PROVIDER_GOOGLE",
            quotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-22T00:00:00Z" },
          },
          "gemini-3-flash": {
            quotaInfo: { remainingFraction: 0.5 },
            weeklyQuotaInfo: { remainingFraction: 0.75 },
          },
          "claude-sonnet-5": { modelProvider: "MODEL_PROVIDER_ANTHROPIC", quotaInfo: {} },
          "gpt-5.5": {
            modelProvider: "MODEL_PROVIDER_OPENAI",
            quotaInfo: { remainingFraction: 1 },
          },
          "unknown-model": { quotaInfo: { remainingFraction: 0.5 } },
        },
      }),
    );
    // The most-used reading wins, so the winner's reset metadata replaces the loser's.
    expect(windows).toEqual([
      { id: "gemini-quota", label: "Gemini · Reported quota", kind: "other", usedPercent: 50 },
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: 25,
        windowDurationMins: 10080,
      },
      { id: "gpt-quota", label: "GPT · Reported quota", kind: "other", usedPercent: 0 },
    ]);
  });
});
