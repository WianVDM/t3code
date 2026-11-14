import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function sidecarAccountProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [] },
    usageAccounts: [
      {
        id: "openrouter-sidecar-only",
        driver: ProviderDriverKind.make("openrouter"),
        usageLimits: {
          checkedAt,
          windows: [{ id: "credit_limit", kind: "other", label: "Credits", usedPercent: 12 }],
          plusplus: { monetaryUsage: { usedUsd: 1.25 } },
        },
      },
      {
        id: "openrouter-conflicting",
        driver: ProviderDriverKind.make("openrouter"),
        usageLimits: {
          checkedAt,
          windows: [],
          monetaryUsage: { usedUsd: 1 },
          plusplus: { monetaryUsage: { usedUsd: 2.5, limitUsd: 10 } },
        },
      },
    ],
  };
}

describe("UsageLimitsPooled monetary sidecar", () => {
  it("renders sidecar-only monetary usage and prefers it over a conflicting legacy field", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [sidecarAccountProvider()] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("$1.25 used")).toBeVisible();
    await expect.element(screen.getByText("$2.50 used · $10.00 limit")).toBeVisible();
    // The monetary rows live in the ++ component and name their account through the
    // renderAccountName slot, which must keep rendering the pooled account name.
    const row = [...document.querySelectorAll("span")]
      .find((element) => element.textContent === "$1.25 used")
      ?.closest("span.flex");
    expect(row?.textContent).toContain("openrouter-sidecar-only");
  });
});
