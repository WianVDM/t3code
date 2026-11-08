import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { openRouterKeyData, openRouterUsageAccount } from "./openRouterUsage.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const input = {
  driver: ProviderDriverKind.make("openrouter"),
  credential: { provider: "openrouter", key: "secret" },
  checkedAt,
};

describe("openRouterKeyData", () => {
  it("extracts the data payload and rejects malformed bodies", () => {
    expect(openRouterKeyData({ data: { usage: 1 } })).toEqual({ usage: 1 });
    for (const body of [undefined, null, "nope", [1, 2], { data: null }, { data: "x" }, {}]) {
      expect(openRouterKeyData(body)).toBeUndefined();
    }
  });
});

describe("openRouterUsageAccount", () => {
  it("folds a missing or malformed probe into a probeFailed account", () => {
    expect(openRouterUsageAccount(input, undefined)).toEqual({
      id: "openrouter",
      driver: input.driver,
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "OpenRouter could not read this account's usage.",
        },
      },
    });
  });

  it("derives the credit-limit window and monetary usage from finite non-negative values", () => {
    const account = openRouterUsageAccount(
      input,
      openRouterKeyData({
        data: { usage: 2.5, limit: 10, limit_remaining: 7.5, is_free_tier: false },
      }),
    );
    expect(account.plan).toBe("OpenRouter Pay as you go");
    expect(account.usageLimits.windows).toEqual([
      {
        id: "credit_limit",
        kind: "other",
        label: "OpenRouter credit limit",
        usedPercent: 25,
      },
    ]);
    expect(account.usageLimits.monetaryUsage).toEqual({
      usedUsd: 2.5,
      remainingUsd: 7.5,
      limitUsd: 10,
    });
    expect(account.usageLimits.externalUsage).toEqual({
      label: "OpenRouter activity",
      url: "https://openrouter.ai/activity",
    });
  });

  it("keeps an account without a credit limit windowless but still monetary", () => {
    const account = openRouterUsageAccount(
      input,
      openRouterKeyData({ data: { usage: 1.25, is_free_tier: true } }),
    );
    expect(account.plan).toBe("OpenRouter Free Tier");
    expect(account.usageLimits.windows).toEqual([]);
    expect(account.usageLimits.monetaryUsage).toEqual({ usedUsd: 1.25 });
    expect(account.usageLimits.unavailable).toBeUndefined();
  });

  it("ignores negative or non-finite money and clamps the window", () => {
    const account = openRouterUsageAccount(
      input,
      openRouterKeyData({ data: { usage: -5, limit: 0, limit_remaining: Number.NaN } }),
    );
    expect(account.plan).toBe("OpenRouter");
    expect(account.usageLimits.windows).toEqual([]);
    expect(account.usageLimits.monetaryUsage).toEqual({ limitUsd: 0 });
    const clamped = openRouterUsageAccount(
      input,
      openRouterKeyData({ data: { usage: 30, limit: 10 } }),
    );
    expect(clamped.usageLimits.windows[0]?.usedPercent).toBe(100);
  });
});
