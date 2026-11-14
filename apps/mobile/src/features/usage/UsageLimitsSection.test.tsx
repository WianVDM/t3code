import { ProviderDriverKind, type ServerProviderUsageLimits } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The real `AccountLimits` renders through react-dom; only its native leaves are stubbed so
// the monetary line is what the assertions see.
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Linking: { openURL: vi.fn() },
    Pressable: (props: { readonly children?: ReactNode }) =>
      createElement("button", null, props.children),
    View: (props: { readonly children?: ReactNode }) => createElement("div", null, props.children),
  };
});
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ui/AppText", async () => {
  const { createElement } = await import("react");
  return {
    AppText: (props: { readonly children?: ReactNode }) =>
      createElement("span", null, props.children),
  };
});
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: vi.fn(),
  useEnvironmentScope: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: vi.fn() }));
vi.mock("./usageLimitsRefresh", () => ({
  environmentIdsKey: vi.fn(),
  limitsAutoRefreshSetAtom: {},
  limitsRefreshFailuresAtom: {},
  refreshEnvironmentLimits: vi.fn(),
}));
vi.mock("./usageProviders", () => ({
  usageProviderKind: () => null,
  useProviderColors: () => ({}),
}));

import { AccountLimits } from "./UsageLimitsSection";

const CHECKED_AT = "2026-10-25T16:00:00.000Z";

function limits(overrides: Partial<ServerProviderUsageLimits>): ServerProviderUsageLimits {
  return { checkedAt: CHECKED_AT, windows: [], ...overrides };
}

function renderAccount(usageLimits: ServerProviderUsageLimits): string {
  return renderToString(
    <AccountLimits
      driver={ProviderDriverKind.make("claudeAgent")}
      label="Claude Code"
      instanceLabel="Claude Code"
      detail={undefined}
      limits={usageLimits}
      now={Date.parse(CHECKED_AT)}
      first
    />,
  );
}

describe("AccountLimits monetary usage", () => {
  it("renders a released legacy-only payload", () => {
    const html = renderAccount(limits({ monetaryUsage: { usedUsd: 1.5, limitUsd: 10 } }));
    expect(html).toContain("$1.50 used · $10.00 limit");
  });

  it("renders a sidecar-only payload from a newer server", () => {
    const html = renderAccount(limits({ plusplus: { monetaryUsage: { usedUsd: 2.5 } } }));
    expect(html).toContain("$2.50 used");
  });

  it("prefers the sidecar over a conflicting legacy field", () => {
    const html = renderAccount(
      limits({
        monetaryUsage: { usedUsd: 1 },
        plusplus: { monetaryUsage: { remainingUsd: 7.5 } },
      }),
    );
    expect(html).toContain("$7.50 left");
    expect(html).not.toContain("$1.00 used");
  });

  it("treats an empty sidecar as authoritative and a malformed one as absent", () => {
    const cleared = renderAccount(
      limits({ monetaryUsage: { usedUsd: 4 }, plusplus: { monetaryUsage: {} } }),
    );
    expect(cleared).not.toContain("$4.00");
    const malformed = renderAccount(
      limits({ monetaryUsage: { usedUsd: 4 }, plusplus: { monetaryUsage: 5 } }),
    );
    expect(malformed).toContain("$4.00 used");
  });
});
