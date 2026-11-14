import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  elapsedShare,
  exhaustedUsageWindow,
  paceOf,
  paceRemainingPercent,
  reconcileProviderUsageSnapshot,
  resolveNewThreadModelSelection,
  resolveUsageLimitsAfterProbe,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("new thread model fallback", () => {
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const fallback = { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5-1" };
  const limited = provider({
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [{ ...window, usedPercent: 100 }],
    },
  });
  const available = provider({
    instanceId: fallback.instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
  });

  const defaults = {
    defaultSelection: selection,
    fallbackSelection: fallback,
    providers: [limited, available],
    now,
  };
  it.each([
    ["exhausted default", {}, fallback],
    ["explicit selection", { explicitSelection: selection }, selection],
    ["missing default", { defaultSelection: null }, null],
    ["no fallback", { fallbackSelection: null }, selection],
    ["expired window", { now: Date.parse("2026-09-04T00:00:00Z") }, selection],
    [
      "environment disabled",
      {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [fallback.instanceId]: { driver: available.driver, enabled: false, config: {} },
          },
        },
      },
      selection,
    ],
  ] as const)("resolves %s", (_name, overrides, expected) => {
    expect(resolveNewThreadModelSelection({ ...defaults, ...overrides }).selection).toEqual(
      expected,
    );
  });
  it.each([
    { enabled: false },
    { installed: false },
    { auth: { status: "unauthenticated" as const } },
    { availability: "unavailable" as const },
    { usageLimits: limited.usageLimits },
  ])("rejects an unusable fallback: %j", (overrides) => {
    expect(
      resolveNewThreadModelSelection({
        ...defaults,
        providers: [limited, { ...available, ...overrides }],
      }).selection,
    ).toEqual(selection);
  });
  it.each([undefined, "invalid"])("treats an unknown reset as exhausted: %s", (resetsAt) => {
    expect(
      exhaustedUsageWindow(
        provider({
          usageLimits: {
            checkedAt: limited.checkedAt,
            windows: [{ ...window, usedPercent: 100, resetsAt }],
          },
        }),
        now,
      ),
    ).toBeDefined();
  });
  it.each([
    ["cursor", ["autoPercentUsed"], "claude-opus-5-5", false],
    ["cursor", ["autoPercentUsed"], "composer-2.5", false],
    ["cursor", ["autoPercentUsed", "apiPercentUsed"], "composer-2.5", true],
    ["antigravity", ["gemini-weekly"], "claude-opus-5-5", false],
    ["antigravity", ["3p-weekly"], "claude-opus-5-5", true],
    ["antigravity", ["gemini-weekly"], "antigravity-default", true],
    ["opencode", ["go_weekly"], "opencode/big-pickle", false],
    ["opencode", ["go_weekly"], "opencode-go/big-pickle", true],
  ] as const)("matches %s pools %s to %s", (driver, ids, model, usesFallback) => {
    const defaultSelection = { ...selection, model };
    expect(
      resolveNewThreadModelSelection({
        ...defaults,
        defaultSelection,
        providers: [
          provider({
            driver: ProviderDriverKind.make(driver),
            usageLimits: {
              checkedAt: limited.checkedAt,
              windows: ids.map((id) => ({ ...window, id, usedPercent: 100 })),
            },
          }),
          available,
        ],
      }).selection,
    ).toEqual(usesFallback ? fallback : defaultSelection);
  });
});

describe("pace", () => {
  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceRemainingPercent(window, now)).toBe(40);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });
});

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual(sameTime);
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});

describe("reconcileProviderUsageSnapshot", () => {
  const good = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const failed = {
    checkedAt: "2026-09-03T12:00:00.000Z",
    windows: [],
    unavailable: { reason: "probeFailed" as const },
  };
  const accounts = [
    {
      id: "a@example.com.json",
      driver: ProviderDriverKind.make("codex"),
      email: "a@example.com",
      usageLimits: good,
    },
  ];

  it("keeps last-good limits through a failed probe for the same account", () => {
    const published = provider({
      usageLimits: good,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const probed = provider({
      usageLimits: failed,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    expect(reconcileProviderUsageSnapshot({ published, probed }).usageLimits).toBe(good);
  });

  it("drops last-good limits on an account or workspace switch", () => {
    const published = provider({
      usageLimits: good,
      auth: { status: "authenticated", email: "a@example.com", workspaceId: "ws-a" },
    });
    const otherEmail = provider({
      usageLimits: failed,
      auth: { status: "authenticated", email: "b@example.com", workspaceId: "ws-a" },
    });
    expect(reconcileProviderUsageSnapshot({ published, probed: otherEmail }).usageLimits).toBe(
      failed,
    );
    const otherWorkspace = provider({
      usageLimits: failed,
      auth: { status: "authenticated", email: "a@example.com", workspaceId: "ws-b" },
    });
    expect(reconcileProviderUsageSnapshot({ published, probed: otherWorkspace }).usageLimits).toBe(
      failed,
    );
  });

  it("retains the original workspace while last-good limits are retained", () => {
    const published = provider({
      usageLimits: good,
      auth: { status: "authenticated", workspaceId: "ws-a" },
    });
    const probed = provider({ usageLimits: failed, auth: { status: "authenticated" } });
    const next = reconcileProviderUsageSnapshot({ published, probed });
    expect(next.usageLimits).toBe(good);
    expect(next.auth.workspaceId).toBe("ws-a");
  });

  it("keeps published accounts through an empty authenticated probe", () => {
    const published = provider({
      usageAccounts: accounts,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const emptyProbe = provider({ auth: { status: "authenticated", email: "a@example.com" } });
    expect(reconcileProviderUsageSnapshot({ published, probed: emptyProbe }).usageAccounts).toBe(
      accounts,
    );
  });

  it("drops published accounts on sign-out, uninstall, or account switch", () => {
    const published = provider({
      usageAccounts: accounts,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    const signedOut = provider({ auth: { status: "unauthenticated" } });
    expect(
      reconcileProviderUsageSnapshot({ published, probed: signedOut }).usageAccounts,
    ).toBeUndefined();
    const uninstalled = provider({
      installed: false,
      auth: { status: "authenticated", email: "a@example.com" },
    });
    expect(
      reconcileProviderUsageSnapshot({ published, probed: uninstalled }).usageAccounts,
    ).toBeUndefined();
    const switched = provider({ auth: { status: "authenticated", email: "b@example.com" } });
    expect(
      reconcileProviderUsageSnapshot({ published, probed: switched }).usageAccounts,
    ).toBeUndefined();
  });
});
