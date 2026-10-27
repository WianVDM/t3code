import {
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  NO_PROVIDER_MODEL_SELECTION,
  type ProviderInstanceEntry,
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import {
  type ComposerThreadDraftState,
  deriveEffectiveComposerModelState,
} from "../../composerDraftStore";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { resolveComposerProviderSelection } from "../ChatView.logic";

const NO_PROVIDER_MODELS: ServerProvider["models"] = [];

/**
 * Pure form of `useComposerProviderModel`: the draft model state arrives as an input instead of a
 * store read, so non-React callers can resolve the same provider/model/options the composer would.
 */
export interface ComposerProviderModelSelectionInput extends Omit<
  Parameters<typeof resolveComposerProviderSelection>[0],
  "entries"
> {
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly activeProjectId: ProjectId | null;
  readonly draftModelState:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly promptInjectionState: ReturnType<typeof getComposerPromptInjectionState>;
}

export function resolveComposerProviderModelSelection(input: ComposerProviderModelSelectionInput) {
  const {
    providerStatuses,
    settings,
    activeProjectId,
    draftModelState,
    threadModelSelection,
    projectModelSelection,
    promptInjectionState,
    candidateInstanceIds,
    lockedProvider,
    lockedInstanceId,
  } = input;
  const providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry> = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providerStatuses),
      settings,
      activeProjectId,
    ),
  );
  const selection = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds,
    lockedProvider,
    lockedInstanceId,
  });
  const selectedInstanceId =
    selection.selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const selectedProvider: ProviderDriverKind =
    selection.selectedProviderEntry?.driverKind ?? selection.requestedDriverKind;
  const modelState = deriveEffectiveComposerModelState({
    draft: draftModelState,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection,
    projectModelSelection,
    settings,
  });
  const selectedProviderModels = selection.selectedProviderEntry?.models ?? NO_PROVIDER_MODELS;
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: modelState.selectedModel,
    models: selectedProviderModels,
    promptInjectionState,
    modelOptions: modelState.modelOptions?.[selectedInstanceId],
    planModeEnabled: settings.planModeEnabled,
  });
  return {
    providerInstanceEntries,
    ...selection,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    composerModelOptions: modelState.modelOptions,
    selectedModel: modelState.selectedModel,
    composerProviderState,
    selectedModelSelection: createModelSelection(
      selectedInstanceId,
      modelState.selectedModel,
      composerProviderState.modelOptionsForDispatch,
    ),
  };
}
