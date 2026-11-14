import { describe, expect, it } from "@effect/vitest";

import { cursorUsageResponseToLimits, cursorUsageWindowDetails } from "./cursorUsageLimits.ts";

const checkedAt = "2026-09-16T00:00:00.000Z";

describe("Cursor usage limits parsing", () => {
  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it("describes each catalog window", () => {
    expect(cursorUsageWindowDetails("autoPercentUsed")?.label).toBe("Cursor Models");
    expect(cursorUsageWindowDetails("unknown")).toBeUndefined();
  });
});
