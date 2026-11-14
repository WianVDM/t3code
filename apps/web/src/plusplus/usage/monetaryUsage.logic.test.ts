import { describe, expect, it } from "vite-plus/test";

import { monetaryUsageOf, monetaryUsageText, type MonetaryUsage } from "./monetaryUsage.logic";

const checkedAt = "2026-10-25T16:00:00.000Z";

function limits(input: { readonly monetaryUsage?: MonetaryUsage; readonly plusplus?: unknown }) {
  return { checkedAt, windows: [], ...input };
}

describe("monetaryUsageOf", () => {
  it("reads sidecar-only monetary usage", () => {
    expect(monetaryUsageOf(limits({ plusplus: { monetaryUsage: { usedUsd: 1.25 } } }))).toEqual({
      usedUsd: 1.25,
    });
  });

  it("prefers the sidecar over a conflicting legacy field", () => {
    expect(
      monetaryUsageOf(
        limits({
          monetaryUsage: { usedUsd: 1 },
          plusplus: { monetaryUsage: { usedUsd: 2.5, limitUsd: 10 } },
        }),
      ),
    ).toEqual({ usedUsd: 2.5, limitUsd: 10 });
  });

  it("falls back to the legacy field when no sidecar is present", () => {
    expect(monetaryUsageOf(limits({ monetaryUsage: { remainingUsd: 4 } }))).toEqual({
      remainingUsd: 4,
    });
  });

  it("returns null when no amount is set or no monetary usage exists", () => {
    expect(monetaryUsageOf(limits({ plusplus: { monetaryUsage: {} } }))).toBeNull();
    expect(monetaryUsageOf(limits({}))).toBeNull();
  });
});

describe("monetaryUsageText", () => {
  it("joins the amounts it has", () => {
    expect(monetaryUsageText({ usedUsd: 2.5, limitUsd: 10 })).toBe("$2.50 used · $10.00 limit");
    expect(monetaryUsageText({ remainingUsd: 4 })).toBe("$4.00 left");
    expect(monetaryUsageText({ usedUsd: 1.25, remainingUsd: 2, limitUsd: 3.25 })).toBe(
      "$1.25 used · $2.00 left · $3.25 limit",
    );
  });
});
