import { type DraftId, useComposerDraftModelState } from "../../composerDraftStore";
import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  type ComposerProviderModelSelectionInput,
  resolveComposerProviderModelSelection,
} from "./composerProviderModelSelection";

/**
 * The provider instances the composer offers, the selected one, and the model and options the
 * draft resolves to on it. The draft store is read first so the shared resolution stays inside
 * the only hook here; in the composer body it would straddle the composer's later hooks and lose
 * its cache.
 */
export function useComposerProviderModel(
  input: Omit<ComposerProviderModelSelectionInput, "draftModelState"> & {
    readonly threadRef: ScopedThreadRef | DraftId;
  },
) {
  const { threadRef, ...resolutionInput } = input;
  const draftModelState = useComposerDraftModelState(threadRef);
  return resolveComposerProviderModelSelection({ ...resolutionInput, draftModelState });
}
