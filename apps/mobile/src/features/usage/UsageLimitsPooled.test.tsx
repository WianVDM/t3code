import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The pooled section renders through react-dom; only its native leaves and ambient state are
// stubbed so the account collection and monetary lines are what the assertions see.
const state = vi.hoisted(() => ({ presentations: new Map() }));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: () => state.presentations,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Linking: { openURL: vi.fn() },
    Pressable: (props: { readonly children?: ReactNode }) =>
      createElement("button", null, props.children),
    View: (props: { readonly children?: ReactNode }) => createElement("div", null, props.children),
  };
});
vi.mock("react-native-svg", () => ({
  Defs: () => null,
  Path: () => null,
  Pattern: () => null,
  Rect: () => null,
  Svg: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ui/ScreenScrollView", async () => {
  const { createElement } = await import("react");
  return {
    ScreenScrollView: (props: { readonly children?: ReactNode }) =>
      createElement("div", null, props.children),
  };
});
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", async () => {
  const { createElement } = await import("react");
  return {
    AppText: (props: { readonly children?: ReactNode }) =>
      createElement("span", null, props.children),
  };
});
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: () => null }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
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

import { UsageLimitsSection } from "./UsageLimitsPooled";

const CHECKED_AT = "2026-10-25T16:00:00.000Z";
const pi = ProviderDriverKind.make("pi");

function account(
  id: string,
  usageLimits: UsageLimitSourceAccount["usageLimits"],
): UsageLimitSourceAccount {
  return { id, driver: pi, usageLimits };
}

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("pi"),
    driver: pi,
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function renderPooled(...providers: ServerProvider[]): string {
  state.presentations = new Map([
    [
      EnvironmentId.make("env-a"),
      { entry: { target: { label: "Laptop" } }, serverConfig: { providers } },
    ],
  ]);
  return renderToString(
    <UsageLimitsSection
      now={Date.parse(CHECKED_AT)}
      failedLabels={[]}
      selectedEnvironmentIds={null}
    />,
  );
}

describe("pooled monetary sidecar reads", () => {
  it("renders a sidecar-only payload from a newer server", () => {
    const html = renderPooled(
      provider({
        plusplus: {
          usageAccounts: [
            account("metered.json", {
              checkedAt: CHECKED_AT,
              // A window keeps the account collectable; the monetary data is sidecar-only.
              windows: [{ id: "credit_limit", kind: "other", label: "Credits", usedPercent: 12 }],
              plusplus: { monetaryUsage: { usedUsd: 1.25 } },
            }),
          ],
        },
      }),
    );
    expect(html).toContain("$1.25 used");
  });

  it("renders a released legacy-only payload", () => {
    const html = renderPooled(
      provider({
        usageAccounts: [
          account("metered.json", {
            checkedAt: CHECKED_AT,
            windows: [],
            monetaryUsage: { usedUsd: 1.5, limitUsd: 10 },
          }),
        ],
      }),
    );
    expect(html).toContain("$1.50 used · $10.00 limit");
  });

  it("prefers the sidecar over a conflicting legacy field", () => {
    const html = renderPooled(
      provider({
        usageAccounts: [
          account("metered.json", {
            checkedAt: CHECKED_AT,
            windows: [],
            monetaryUsage: { usedUsd: 1 },
            plusplus: { monetaryUsage: { remainingUsd: 7.5 } },
          }),
        ],
      }),
    );
    expect(html).toContain("$7.50 left");
    expect(html).not.toContain("$1.00 used");
  });

  it("treats an empty sidecar account list as authoritative", () => {
    const html = renderPooled(
      provider({
        usageAccounts: [
          account("metered.json", {
            checkedAt: CHECKED_AT,
            windows: [],
            monetaryUsage: { usedUsd: 4 },
          }),
        ],
        plusplus: { usageAccounts: [] },
      }),
    );
    expect(html).not.toContain("$4.00");
    expect(html).toContain("No provider on the selected environments reports subscription limits.");
  });
});
