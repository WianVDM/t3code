import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { resolveComposerProviderModelSelection } from "./composerProviderModelSelection";

const CHECKED_AT = "2026-01-01T00:00:00.000Z";
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");

function providerSnapshot(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "driver" | "instanceId">,
): ServerProvider {
  return {
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
  };
}

describe("resolveComposerProviderModelSelection", () => {
  it("selects the available instance and resolves the catalog default model for a fresh draft", () => {
    const result = resolveComposerProviderModelSelection({
      providerStatuses: [
        providerSnapshot({
          driver: ProviderDriverKind.make("claudeAgent"),
          instanceId: ProviderInstanceId.make("claudeAgent"),
          availability: "unavailable",
          installed: false,
          status: "error",
          auth: { status: "unauthenticated" },
        }),
        providerSnapshot({
          driver: CODEX_DRIVER,
          instanceId: CODEX_INSTANCE_ID,
          models: [
            {
              slug: "gpt-5-codex-mini",
              name: "GPT-5 Codex Mini",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5-codex",
              name: "GPT-5 Codex",
              isCustom: false,
              isDefault: true,
              capabilities: {
                optionDescriptors: [
                  { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: true },
                ],
              },
            },
          ],
        }),
      ],
      settings: DEFAULT_UNIFIED_SETTINGS,
      activeProjectId: null,
      draftModelState: { activeProvider: null, modelSelectionByProvider: {} },
      threadModelSelection: null,
      projectModelSelection: null,
      promptInjectionState: "none",
      candidateInstanceIds: [null],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    // The unavailable claudeAgent instance sorts first but must not be selected.
    expect(result.selectedProviderEntry?.instanceId).toBe(CODEX_INSTANCE_ID);
    expect(result.selectedInstanceId).toBe(CODEX_INSTANCE_ID);
    expect(result.selectedProvider).toBe(CODEX_DRIVER);

    // The catalog default wins over the first listed model.
    expect(result.selectedModel).toBe("gpt-5-codex");

    // The provider-reported fastMode default is dispatched as off until the user opts in.
    expect(result.composerProviderState.modelOptionsForDispatch).toEqual([
      { id: "fastMode", value: false },
    ]);
    expect(result.selectedModelSelection).toEqual({
      instanceId: CODEX_INSTANCE_ID,
      model: "gpt-5-codex",
      options: [{ id: "fastMode", value: false }],
    });
  });
});
