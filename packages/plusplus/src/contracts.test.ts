import {
  type ContextBridgeSettings,
  OrchestrationV2PendingBackgroundTask,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerProviderUsageLimits,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeContextBridgeSettingsPatch,
  mergeSidecarCarriers,
  pendingBackgroundTaskStartedAtFields,
  readContextBridgeSettings,
  readMonetaryUsage,
  readPendingBackgroundTaskStartedAt,
  readUsageAccounts,
  usageAccountsFields,
  withMonetaryUsage,
  withUsageAccountSidecars,
  withUsageAccounts,
} from "./contracts.ts";

const CHECKED_AT = "2026-09-03T12:00:00.000Z";

const legacyBridge: ContextBridgeSettings = {
  enabled: true,
  defaultSource: "claudeAgent",
  routes: { codex: { instructions: "claudeAgent" } },
};

const sidecarBridge: ContextBridgeSettings = {
  enabled: false,
  defaultSource: "pi",
  routes: { codex: { skills: "pi" } },
};

function account(id: string, percent: number): UsageLimitSourceAccount {
  return {
    id,
    driver: ProviderDriverKind.make("openrouter"),
    usageLimits: {
      checkedAt: CHECKED_AT,
      windows: [{ id: "credit_limit", kind: "other", label: "Credits", usedPercent: percent }],
    },
  };
}

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

describe("readContextBridgeSettings", () => {
  it("falls back to the legacy field and then to defaults", () => {
    expect(readContextBridgeSettings({ contextBridge: legacyBridge })).toEqual(legacyBridge);
    expect(readContextBridgeSettings({})).toEqual({
      enabled: false,
      defaultSource: "claudeAgent",
      routes: {},
    });
  });

  it("prefers a valid sidecar over a conflicting legacy field", () => {
    expect(
      readContextBridgeSettings({
        contextBridge: legacyBridge,
        plusplus: { contextBridge: sidecarBridge },
      }),
    ).toEqual(sidecarBridge);
  });

  it("reads a sidecar-only carrier", () => {
    expect(readContextBridgeSettings({ plusplus: { contextBridge: sidecarBridge } })).toEqual(
      sidecarBridge,
    );
  });

  it("falls back to legacy for malformed sidecars and carriers", () => {
    for (const plusplus of [
      { contextBridge: { enabled: "yes", defaultSource: "pi", routes: {} } },
      { contextBridge: { enabled: true } },
      { contextBridge: null },
      { contextBridge: [] },
      "garbage",
      [],
    ]) {
      expect(readContextBridgeSettings({ contextBridge: legacyBridge, plusplus })).toEqual(
        legacyBridge,
      );
    }
  });

  it("treats an empty sidecar route map as authoritative", () => {
    const cleared = { enabled: true, defaultSource: "claudeAgent", routes: {} };
    expect(
      readContextBridgeSettings({
        contextBridge: legacyBridge,
        plusplus: { contextBridge: cleared },
      }),
    ).toEqual(cleared);
  });
});

describe("mergeContextBridgeSettingsPatch", () => {
  const current = { contextBridge: legacyBridge };

  it("merges enabled and defaultSource against the resolved current settings", () => {
    expect(mergeContextBridgeSettingsPatch(current, { contextBridge: { enabled: false } })).toEqual(
      {
        ...legacyBridge,
        enabled: false,
      },
    );
  });

  it("replaces routes wholesale", () => {
    expect(
      mergeContextBridgeSettingsPatch(current, {
        contextBridge: { routes: { pi: { hooks: "claudeAgent" } } },
      }),
    ).toEqual({ ...legacyBridge, routes: { pi: { hooks: "claudeAgent" } } });
    expect(mergeContextBridgeSettingsPatch(current, { contextBridge: { routes: {} } })).toEqual({
      ...legacyBridge,
      routes: {},
    });
  });

  it("lets a valid sidecar patch win over conflicting legacy patch fields", () => {
    expect(
      mergeContextBridgeSettingsPatch(current, {
        contextBridge: { enabled: false },
        plusplus: { contextBridge: { enabled: true, defaultSource: "pi" } },
      }),
    ).toEqual({ ...legacyBridge, enabled: true, defaultSource: "pi" });
  });

  it("falls back to the legacy patch for a malformed sidecar patch", () => {
    expect(
      mergeContextBridgeSettingsPatch(current, {
        contextBridge: { enabled: false },
        plusplus: { contextBridge: { enabled: "yes" } },
      }),
    ).toEqual({ ...legacyBridge, enabled: false });
  });

  it("resolves against sidecar-first current settings", () => {
    const sidecarCurrent = {
      contextBridge: legacyBridge,
      plusplus: { contextBridge: sidecarBridge },
    };
    expect(
      mergeContextBridgeSettingsPatch(sidecarCurrent, { contextBridge: { enabled: true } }),
    ).toEqual({ ...sidecarBridge, enabled: true });
  });

  it("returns null when the patch touches neither representation", () => {
    expect(mergeContextBridgeSettingsPatch(current, {})).toBeNull();
    expect(mergeContextBridgeSettingsPatch(current, { plusplus: "garbage" })).toBeNull();
    expect(mergeContextBridgeSettingsPatch(current, { plusplus: { other: 1 } })).toBeNull();
  });
});

describe("mergeSidecarCarriers", () => {
  it("shallow-merges with the patch winning and keeps output sparse", () => {
    expect(mergeSidecarCarriers({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(mergeSidecarCarriers({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    expect(mergeSidecarCarriers(undefined, undefined)).toBeUndefined();
    expect(mergeSidecarCarriers("garbage", null)).toBeUndefined();
    expect(mergeSidecarCarriers({ a: 1 }, "garbage")).toEqual({ a: 1 });
  });
});

describe("pending background task startedAt", () => {
  it("prefers the sidecar and falls back to legacy, malformed, or absent", () => {
    expect(
      readPendingBackgroundTaskStartedAt({ startedAt: "old", plusplus: { startedAt: "new" } }),
    ).toBe("new");
    expect(readPendingBackgroundTaskStartedAt({ startedAt: "old" })).toBe("old");
    expect(readPendingBackgroundTaskStartedAt({ plusplus: { startedAt: "new" } })).toBe("new");
    expect(
      readPendingBackgroundTaskStartedAt({ startedAt: "old", plusplus: { startedAt: 42 } }),
    ).toBe("old");
    expect(
      readPendingBackgroundTaskStartedAt({ startedAt: "old", plusplus: { startedAt: "" } }),
    ).toBe("old");
    expect(readPendingBackgroundTaskStartedAt({})).toBeUndefined();
  });

  it("dual-writes when known and omits both when unknown (sparse output)", () => {
    expect(pendingBackgroundTaskStartedAtFields("2026-09-03T12:00:00.000Z")).toEqual({
      startedAt: "2026-09-03T12:00:00.000Z",
      plusplus: { startedAt: "2026-09-03T12:00:00.000Z" },
    });
    expect(pendingBackgroundTaskStartedAtFields(undefined)).toEqual({});
  });

  it("round-trips a sidecar task through the released schema", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2PendingBackgroundTask);
    const encode = Schema.encodeSync(OrchestrationV2PendingBackgroundTask);
    const task: OrchestrationV2PendingBackgroundTask = {
      taskId: "task_1",
      kind: "command",
      ...pendingBackgroundTaskStartedAtFields("2026-09-03T12:00:00.000Z"),
    };
    expect(decode(encode(task))).toEqual(task);
    // A released payload without the carrier decodes unchanged.
    const legacy = { taskId: "task_2", kind: "command", startedAt: "2026-09-03T12:00:00.000Z" };
    expect(decode(legacy)).toEqual(legacy);
    // An unknown kind keeps the carrier through the fallback decode.
    const future = {
      taskId: "task_3",
      kind: "future_kind",
      startedAt: "2026-09-03T12:00:00.000Z",
      plusplus: { startedAt: "2026-09-03T12:00:00.000Z" },
    };
    expect(decode(future)).toEqual({ ...future, kind: "background_task" });
  });
});

describe("monetaryUsage", () => {
  const legacy = { usedUsd: 1.5, remainingUsd: 8.5, limitUsd: 10 };
  const base = { checkedAt: CHECKED_AT, windows: [] };

  it("prefers the sidecar, including an authoritative empty object", () => {
    expect(
      readMonetaryUsage({ monetaryUsage: legacy, plusplus: { monetaryUsage: { usedUsd: 2 } } }),
    ).toEqual({
      usedUsd: 2,
    });
    expect(readMonetaryUsage({ monetaryUsage: legacy, plusplus: { monetaryUsage: {} } })).toEqual(
      {},
    );
    expect(readMonetaryUsage({ monetaryUsage: legacy })).toEqual(legacy);
    expect(readMonetaryUsage({ plusplus: { monetaryUsage: { usedUsd: 3 } } })).toEqual({
      usedUsd: 3,
    });
  });

  it("falls back to legacy for malformed sidecars", () => {
    expect(
      readMonetaryUsage({ monetaryUsage: legacy, plusplus: { monetaryUsage: { usedUsd: -1 } } }),
    ).toEqual(legacy);
    expect(readMonetaryUsage({ monetaryUsage: legacy, plusplus: { monetaryUsage: 5 } })).toEqual(
      legacy,
    );
    expect(readMonetaryUsage({})).toBeUndefined();
  });

  it("dual-writes and clears both representations when requested", () => {
    const written = withMonetaryUsage(
      { ...base, monetaryUsage: legacy, plusplus: { monetaryUsage: legacy } },
      legacy,
    );
    expect(written.monetaryUsage).toEqual(legacy);
    expect(written.plusplus).toEqual({ monetaryUsage: legacy });

    const cleared = withMonetaryUsage(written, undefined);
    expect(cleared).toEqual(base);
    expect("monetaryUsage" in cleared).toBe(false);
    expect("plusplus" in cleared).toBe(false);
  });

  it("preserves unknown sidecar areas when writing or clearing", () => {
    const withFuture = {
      ...base,
      monetaryUsage: legacy,
      plusplus: { monetaryUsage: legacy, future: 1 },
    };
    expect(withMonetaryUsage(withFuture, undefined).plusplus).toEqual({ future: 1 });
    expect(withMonetaryUsage(withFuture, { usedUsd: 4 }).plusplus).toEqual({
      monetaryUsage: { usedUsd: 4 },
      future: 1,
    });
  });

  it("round-trips through the released usage limits schema", () => {
    const decode = Schema.decodeUnknownSync(ServerProviderUsageLimits);
    const encode = Schema.encodeSync(ServerProviderUsageLimits);
    const limits = { ...base, monetaryUsage: legacy, plusplus: { monetaryUsage: legacy } };
    expect(decode(encode(limits))).toEqual(limits);
    expect(decode({ ...base, monetaryUsage: legacy })).toEqual({ ...base, monetaryUsage: legacy });
  });
});

describe("usageAccounts", () => {
  it("prefers the sidecar, including an authoritative empty array", () => {
    const accounts = [account("openrouter", 25)];
    expect(readUsageAccounts({ usageAccounts: accounts, plusplus: { usageAccounts: [] } })).toEqual(
      [],
    );
    expect(readUsageAccounts({ usageAccounts: accounts })).toEqual(accounts);
    expect(readUsageAccounts({ plusplus: { usageAccounts: accounts } })).toEqual(accounts);
    expect(readUsageAccounts({})).toBeUndefined();
  });

  it("falls back to legacy for malformed sidecars", () => {
    const accounts = [account("openrouter", 25)];
    expect(
      readUsageAccounts({ usageAccounts: accounts, plusplus: { usageAccounts: [{ id: "x" }] } }),
    ).toEqual(accounts);
    expect(readUsageAccounts({ usageAccounts: accounts, plusplus: { usageAccounts: {} } })).toEqual(
      accounts,
    );
  });

  it("dual-writes fields, stamps whole snapshots, and clears both", () => {
    const accounts = [account("openrouter", 25)];
    expect(usageAccountsFields(accounts)).toEqual({
      usageAccounts: accounts,
      plusplus: { usageAccounts: accounts },
    });
    expect(usageAccountsFields(undefined)).toEqual({});

    const written = withUsageAccounts(provider({}), accounts);
    expect(readUsageAccounts(written)).toEqual(accounts);
    expect(written.usageAccounts).toEqual(accounts);

    const cleared = withUsageAccounts(written, undefined);
    expect(cleared.usageAccounts).toBeUndefined();
    expect("plusplus" in cleared).toBe(false);
  });

  it("keeps other sidecar areas when stamping accounts", () => {
    const stamped = withUsageAccounts(provider({ plusplus: { future: 1 } }), []);
    expect(stamped.plusplus).toEqual({ future: 1, usageAccounts: [] });
  });

  it("stamps an account's monetary sidecar from its released field", () => {
    const withMonetary: UsageLimitSourceAccount = {
      ...account("openrouter", 25),
      usageLimits: {
        checkedAt: CHECKED_AT,
        windows: [],
        monetaryUsage: { usedUsd: 2 },
      },
    };
    const stamped = withUsageAccountSidecars(withMonetary);
    expect(stamped.usageLimits.monetaryUsage).toEqual({ usedUsd: 2 });
    expect(stamped.usageLimits.plusplus).toEqual({ monetaryUsage: { usedUsd: 2 } });
    // Without monetary data, no carrier is emitted.
    expect(
      withUsageAccountSidecars(account("openrouter", 25)).usageLimits.plusplus,
    ).toBeUndefined();
  });
});
