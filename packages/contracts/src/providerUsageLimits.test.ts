import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProviderUsageLimits, UsageLimitSourceAccount } from "./providerUsageLimits.ts";

const decodeUsageLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);
const encodeUsageLimits = Schema.encodeSync(ServerProviderUsageLimits);

const released = {
  checkedAt: "2026-04-10T00:00:00.000Z",
  windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 42 }],
  monetaryUsage: { usedUsd: 1.5, limitUsd: 10 },
};

describe("ServerProviderUsageLimits", () => {
  it("decodes released payloads unchanged and keeps the carrier absent", () => {
    const decoded = decodeUsageLimits(released);
    expect(decoded).toEqual(released);
    expect("plusplus" in decoded).toBe(false);
    expect("plusplus" in encodeUsageLimits(decoded)).toBe(false);
  });

  it("round-trips the plusplus carrier verbatim, unknown areas included", () => {
    const carrier = { monetaryUsage: { usedUsd: 2 }, future: { kept: true } };
    const decoded = decodeUsageLimits({ ...released, plusplus: carrier });
    expect(decoded.plusplus).toEqual(carrier);
    expect(encodeUsageLimits(decoded).plusplus).toEqual(carrier);
    // The released field survives next to the carrier for old decoders.
    expect(decoded.monetaryUsage).toEqual(released.monetaryUsage);
  });
});

describe("UsageLimitSourceAccount", () => {
  it("keeps accounts with a sidecar-only monetary usage decodable", () => {
    const decodeAccount = Schema.decodeUnknownSync(UsageLimitSourceAccount);
    const account = decodeAccount({
      id: "openrouter",
      driver: "openrouter",
      usageLimits: {
        checkedAt: released.checkedAt,
        windows: [],
        plusplus: { monetaryUsage: { usedUsd: 3 } },
      },
    });
    expect(account.usageLimits.monetaryUsage).toBeUndefined();
    expect(account.usageLimits.plusplus).toEqual({ monetaryUsage: { usedUsd: 3 } });
  });
});
