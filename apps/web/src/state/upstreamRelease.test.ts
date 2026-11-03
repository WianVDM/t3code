import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { AuthOrchestrationOperateScope, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  const tag = "v1.2.3";
  const prompt = `Merge upstream release ${tag}`;
  const title = "Merge upstream release";
  const projectRef = { environmentId: "environment-1", projectId: "project-1" };
  const project = { workspaceRoot: "/fork/checkout" };
  const draft = {
    threadId: "thread-1",
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    createdAt: "2026-01-02T03:04:05.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    envMode: "worktree",
    startFromOrigin: false,
  };
  const modelSelection = {
    instanceId: "codex",
    model: "gpt-5.4",
    options: { reasoningEffort: "high" },
  };
  const defaultModelSelection = {
    instanceId: "claude",
    model: "claude-opus-4",
    options: { effort: "max" },
  };
  const providersAtom = { key: "providers-atom" };
  const providerStatuses = [{ id: "codex-status" }];
  const environmentServerConfigsAtom = { key: "server-configs-atom" };
  const clientSettings = { clientSetting: true };
  const mergedSettings = { mergedSetting: true };
  const promptInjectionState = { injection: "none" };
  const composer = {
    prompt,
    activeProvider: "codex",
    modelSelectionByProvider: { codex: modelSelection },
    runtimeMode: null,
    interactionMode: null,
  };
  const registrySet = vi.fn();
  const registryGet = vi.fn();
  const appAtomRegistry = { set: registrySet, get: registryGet };
  const startTurn = { label: "start upstream merge" };

  return {
    tag,
    prompt,
    title,
    draftId: "draft-1",
    messageId: "message-1",
    retryThreadId: "retry-thread",
    toastId: "toast-1",
    projectRef,
    project,
    draft,
    modelSelection,
    defaultModelSelection,
    providersAtom,
    providerStatuses,
    environmentServerConfigsAtom,
    clientSettings,
    mergedSettings,
    promptInjectionState,
    composer,
    appAtomRegistry,
    registrySet,
    registryGet,
    startTurn,
    readDesktopUpdateState: vi.fn(),
    shouldDeferUpstreamMerge: vi.fn(),
    pickForkProject: vi.fn(),
    readProjects: vi.fn(),
    readProject: vi.fn(),
    newThread: vi.fn(),
    buildUpstreamMergePrompt: vi.fn(),
    deriveThreadTitleSeed: vi.fn(),
    newMessageId: vi.fn(),
    newThreadId: vi.fn(),
    runAtomCommand: vi.fn(),
    readEnvironmentScope: vi.fn(),
    providersIgnoringCheckedAtAtom: vi.fn(),
    getClientSettings: vi.fn(),
    mergeEnvironmentSettings: vi.fn(),
    getComposerPromptInjectionState: vi.fn(),
    resolveComposerProviderModelSelection: vi.fn(),
    squashAtomCommandFailure: vi.fn(),
    wasBootstrapThreadDeleted: vi.fn(),
    markPromotedDraftThreadByRef: vi.fn(),
    restoreFailedDraftThread: vi.fn(),
    draftStore: {
      setPrompt: vi.fn(),
      getDraftSession: vi.fn(),
      getComposerDraft: vi.fn(),
    },
    stackedThreadToast: vi.fn(),
    toastAdd: vi.fn(),
    toastClose: vi.fn(),
    refreshUpstreamReleaseNow: vi.fn(),
    refreshUpstreamReleaseIfStale: vi.fn(),
    readCachedUpstreamRelease: vi.fn(),
    isUpstreamCacheEntryFresh: vi.fn(),
  };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));
vi.mock("react", () => ({ useEffect: vi.fn() }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/client-runtime/errors", () => ({
  wasBootstrapThreadDeleted: state.wasBootstrapThreadDeleted,
}));
vi.mock("@t3tools/client-runtime/operations", () => ({
  deriveThreadTitleSeed: state.deriveThreadTitleSeed,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: state.runAtomCommand,
  squashAtomCommandFailure: state.squashAtomCommandFailure,
}));
vi.mock("../composerDraftStore", () => ({
  markPromotedDraftThreadByRef: state.markPromotedDraftThreadByRef,
  restoreFailedDraftThread: state.restoreFailedDraftThread,
  useComposerDraftStore: { getState: () => state.draftStore },
}));
vi.mock("../components/chat/composerProviderModelSelection", () => ({
  resolveComposerProviderModelSelection: state.resolveComposerProviderModelSelection,
}));
vi.mock("../components/chat/composerProviderState", () => ({
  getComposerPromptInjectionState: state.getComposerPromptInjectionState,
}));
vi.mock("../components/upstreamRelease.logic", () => ({
  buildUpstreamMergePrompt: state.buildUpstreamMergePrompt,
  FORK_REPOSITORY: "WianVDM/t3code",
  isForkDesktopBuild: true,
  isUpstreamCacheEntryFresh: state.isUpstreamCacheEntryFresh,
  pickForkProject: state.pickForkProject,
  readCachedUpstreamRelease: state.readCachedUpstreamRelease,
  refreshUpstreamReleaseIfStale: state.refreshUpstreamReleaseIfStale,
  refreshUpstreamReleaseNow: state.refreshUpstreamReleaseNow,
  shouldDeferUpstreamMerge: state.shouldDeferUpstreamMerge,
  UPSTREAM_POLL_INTERVAL_MS: 1_000,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: state.stackedThreadToast,
  toastManager: { add: state.toastAdd, close: state.toastClose },
}));
vi.mock("../hooks/useLiveRefresh", () => ({ useLiveRefresh: vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: state.getClientSettings,
  mergeEnvironmentSettings: state.mergeEnvironmentSettings,
}));
vi.mock("../lib/utils", () => ({
  newMessageId: state.newMessageId,
  newThreadId: state.newThreadId,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: state.appAtomRegistry }));
vi.mock("./desktopUpdate", () => ({ readDesktopUpdateState: state.readDesktopUpdateState }));
vi.mock("./server", () => ({
  environmentServerConfigsAtom: state.environmentServerConfigsAtom,
  providersIgnoringCheckedAtAtom: state.providersIgnoringCheckedAtAtom,
}));
vi.mock("./session", () => ({ readEnvironmentScope: state.readEnvironmentScope }));
vi.mock("./entities", () => ({
  readProject: state.readProject,
  readProjects: state.readProjects,
}));
vi.mock("./threads", () => ({ threadEnvironment: { startTurn: state.startTurn } }));

import {
  registerNewThreadRunner,
  runManualUpstreamCheck,
  startUpstreamMerge,
  upstreamReleaseStateAtom,
} from "./upstreamRelease";

function setup() {
  state.readDesktopUpdateState.mockReset().mockReturnValue(null);
  state.shouldDeferUpstreamMerge.mockReset().mockReturnValue(false);
  state.pickForkProject.mockReset().mockReturnValue(state.projectRef);
  state.readProjects.mockReset().mockReturnValue([state.project]);
  state.readProject.mockReset().mockReturnValue(state.project);
  state.newThread.mockReset().mockResolvedValue({
    draftId: state.draftId,
    threadId: state.draft.threadId,
  });
  state.buildUpstreamMergePrompt.mockReset().mockReturnValue(state.prompt);
  state.deriveThreadTitleSeed.mockReset().mockReturnValue(state.title);
  state.newMessageId.mockReset().mockReturnValue(state.messageId);
  state.newThreadId.mockReset().mockReturnValue(state.retryThreadId);
  state.runAtomCommand.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.readEnvironmentScope.mockReset().mockReturnValue(true);
  state.registryGet
    .mockReset()
    .mockImplementation((atom) =>
      atom === state.environmentServerConfigsAtom ? new Map() : state.providerStatuses,
    );
  state.providersIgnoringCheckedAtAtom.mockReset().mockReturnValue(state.providersAtom);
  state.getClientSettings.mockReset().mockReturnValue(state.clientSettings);
  state.mergeEnvironmentSettings.mockReset().mockReturnValue(state.mergedSettings);
  state.getComposerPromptInjectionState.mockReset().mockReturnValue(state.promptInjectionState);
  state.resolveComposerProviderModelSelection.mockReset().mockReturnValue({
    selectedProviderEntry: { instanceId: state.modelSelection.instanceId },
    selectedModelSelection: state.modelSelection,
  });
  state.squashAtomCommandFailure.mockReset().mockReturnValue(new Error("Merge agent failed"));
  state.wasBootstrapThreadDeleted.mockReset().mockReturnValue(false);
  state.markPromotedDraftThreadByRef.mockReset();
  state.restoreFailedDraftThread.mockReset();
  state.draftStore.setPrompt.mockReset();
  state.draftStore.getDraftSession.mockReset().mockReturnValue(state.draft);
  state.draftStore.getComposerDraft.mockReset().mockReturnValue(state.composer);
  state.stackedThreadToast.mockReset().mockImplementation((options) => options);
  state.toastAdd.mockReset().mockReturnValue(state.toastId);
  state.toastClose.mockReset();
  state.refreshUpstreamReleaseNow.mockReset().mockResolvedValue({
    kind: "unmerged",
    tag: state.tag,
  });
  state.refreshUpstreamReleaseIfStale.mockReset();
  state.readCachedUpstreamRelease.mockReset().mockReturnValue(null);
  state.isUpstreamCacheEntryFresh.mockReset().mockReturnValue(false);
  state.registrySet.mockReset();
}

describe("startUpstreamMerge", () => {
  it("returns before opening a runner or dispatching a command when the merge is deferred", async () => {
    setup();
    state.shouldDeferUpstreamMerge.mockReturnValue(true);

    await startUpstreamMerge(state.tag, { newThread: state.newThread });

    expect(state.newThread).not.toHaveBeenCalled();
    expect(state.runAtomCommand).not.toHaveBeenCalled();
    expect(state.draftStore.setPrompt).not.toHaveBeenCalled();
    expect(state.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Update the fork first",
      description: "A desktop update is ready. Update the fork before merging upstream.",
    });
  });

  it("returns before opening a runner or dispatching a command without orchestration scope", async () => {
    setup();
    state.readEnvironmentScope.mockReturnValue(false);

    await startUpstreamMerge(state.tag, { newThread: state.newThread });

    expect(state.readEnvironmentScope).toHaveBeenCalledWith(
      state.projectRef.environmentId,
      AuthOrchestrationOperateScope,
    );
    expect(state.newThread).not.toHaveBeenCalled();
    expect(state.runAtomCommand).not.toHaveBeenCalled();
    expect(state.draftStore.setPrompt).not.toHaveBeenCalled();
    expect(state.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not start upstream merge",
      description: "This connection cannot change threads or projects.",
    });
  });

  it("starts the merge with the prompt, thread creation, and local-base worktree preparation", async () => {
    setup();
    await startUpstreamMerge(state.tag, { newThread: state.newThread });

    expect(state.newThread).toHaveBeenCalledWith(state.projectRef, {
      envMode: "worktree",
      branch: "main",
    });
    expect(state.draftStore.setPrompt).toHaveBeenCalledWith(state.draftId, state.prompt);
    expect(state.runAtomCommand).toHaveBeenCalledTimes(1);
    const [registry, command, request] = state.runAtomCommand.mock.calls[0]!;
    expect(registry).toBe(state.appAtomRegistry);
    expect(command).toBe(state.startTurn);
    expect(request.environmentId).toBe(state.draft.environmentId);
    const input = request.input as StartThreadTurnInput;
    expect(input.threadId).toBe(state.draft.threadId);
    expect(input.message).toEqual({
      messageId: state.messageId,
      role: "user",
      text: state.prompt,
      attachments: [],
    });
    expect(input).toMatchObject({
      modelSelection: state.modelSelection,
      titleSeed: state.title,
      runtimeMode: state.draft.runtimeMode,
      interactionMode: state.draft.interactionMode,
    });
    expect(input.bootstrap).toEqual({
      createThread: {
        projectId: state.draft.projectId,
        title: state.title,
        modelSelection: state.modelSelection,
        runtimeMode: state.draft.runtimeMode,
        interactionMode: state.draft.interactionMode,
        branch: state.draft.branch,
        worktreePath: state.draft.worktreePath,
        createdAt: state.draft.createdAt,
      },
      prepareWorktree: {
        projectCwd: state.project.workspaceRoot,
        baseBranch: "main",
        startFromOrigin: false,
      },
      runSetupScript: true,
    });
    expect(state.restoreFailedDraftThread).not.toHaveBeenCalled();
  });

  it("applies the resolved default model to the turn input and bootstrap for a fresh draft without an active provider", async () => {
    setup();
    const freshComposer = {
      prompt: state.prompt,
      activeProvider: null,
      modelSelectionByProvider: {},
      runtimeMode: null,
      interactionMode: null,
    };
    state.draftStore.getComposerDraft.mockReturnValue(freshComposer);
    state.resolveComposerProviderModelSelection.mockReturnValue({
      selectedProviderEntry: { instanceId: state.defaultModelSelection.instanceId },
      selectedModelSelection: state.defaultModelSelection,
    });

    await startUpstreamMerge(state.tag, { newThread: state.newThread });

    expect(state.getComposerPromptInjectionState).toHaveBeenCalledWith(state.prompt);
    expect(state.getClientSettings).toHaveBeenCalledTimes(1);
    expect(state.mergeEnvironmentSettings).toHaveBeenCalledWith(
      DEFAULT_SERVER_SETTINGS,
      state.clientSettings,
    );
    expect(state.resolveComposerProviderModelSelection).toHaveBeenCalledTimes(1);
    expect(state.resolveComposerProviderModelSelection).toHaveBeenCalledWith({
      providerStatuses: state.providerStatuses,
      settings: state.mergedSettings,
      activeProjectId: state.draft.projectId,
      draftModelState: freshComposer,
      threadModelSelection: null,
      projectModelSelection: null,
      promptInjectionState: state.promptInjectionState,
      candidateInstanceIds: [null],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    expect(state.runAtomCommand).toHaveBeenCalledTimes(1);
    const [, , request] = state.runAtomCommand.mock.calls[0]!;
    const input = request.input as StartThreadTurnInput;
    expect(input.modelSelection).toEqual(state.defaultModelSelection);
    expect(input.bootstrap).toMatchObject({
      createThread: { modelSelection: state.defaultModelSelection },
    });
  });

  it("restores the failed draft with its prompt and reports the command failure", async () => {
    setup();
    const failure = { _tag: "Failure", cause: "start failed" };
    const error = new Error("The merge agent could not start.");
    state.runAtomCommand.mockResolvedValue(failure);
    state.squashAtomCommandFailure.mockReturnValue(error);
    state.wasBootstrapThreadDeleted.mockReturnValue(true);

    await startUpstreamMerge(state.tag, { newThread: state.newThread });

    expect(state.draftStore.setPrompt).toHaveBeenCalledWith(state.draftId, state.prompt);
    expect(state.squashAtomCommandFailure).toHaveBeenCalledWith(failure);
    expect(state.wasBootstrapThreadDeleted).toHaveBeenCalledWith(error);
    expect(state.restoreFailedDraftThread).toHaveBeenCalledWith(
      state.draftId,
      state.draft,
      state.retryThreadId,
    );
    expect(state.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not start upstream merge",
      description: error.message,
    });
  });

  it("stops before promotion and dispatch when an update lands while the runner opens the draft", async () => {
    setup();
    // First check (before the runner) passes; the re-check right before dispatch defers.
    state.shouldDeferUpstreamMerge.mockReturnValueOnce(false).mockReturnValue(true);

    await startUpstreamMerge(state.tag, { newThread: state.newThread });

    expect(state.newThread).toHaveBeenCalledTimes(1);
    expect(state.draftStore.setPrompt).toHaveBeenCalledWith(state.draftId, state.prompt);
    expect(state.markPromotedDraftThreadByRef).not.toHaveBeenCalled();
    expect(state.runAtomCommand).not.toHaveBeenCalled();
    expect(state.restoreFailedDraftThread).not.toHaveBeenCalled();
    expect(state.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Update the fork first",
      description: "A desktop update is ready. Update the fork before merging upstream.",
    });
  });
});

describe("runManualUpstreamCheck", () => {
  it("keeps the release notification without a merge action when the merge is deferred", async () => {
    setup();
    const result = { kind: "unmerged", tag: state.tag } as const;
    state.refreshUpstreamReleaseNow.mockResolvedValue(result);
    state.shouldDeferUpstreamMerge.mockReturnValue(true);

    await runManualUpstreamCheck();

    expect(state.refreshUpstreamReleaseNow).toHaveBeenCalledTimes(1);
    expect(state.registrySet).toHaveBeenCalledWith(upstreamReleaseStateAtom, result);
    expect(state.toastAdd).toHaveBeenCalledTimes(1);
    const notification = state.toastAdd.mock.calls[0]![0];
    expect(notification).toMatchObject({
      type: "info",
      title: `Upstream ${state.tag} is ready to merge`,
      description: "Update the fork first, then merge upstream.",
    });
    expect(notification).not.toHaveProperty("actionProps");
    expect(state.newThread).not.toHaveBeenCalled();
    expect(state.runAtomCommand).not.toHaveBeenCalled();
  });

  it("dispatches through the registered fallback runner from the non-deferred toast action", async () => {
    setup();
    state.refreshUpstreamReleaseNow.mockResolvedValue({ kind: "unmerged", tag: state.tag });
    const unregister = registerNewThreadRunner(state.newThread);

    try {
      await runManualUpstreamCheck();

      expect(state.toastAdd).toHaveBeenCalledTimes(1);
      const notification = state.toastAdd.mock.calls[0]![0];
      expect(notification).toMatchObject({
        type: "info",
        title: `Upstream ${state.tag} is ready to merge`,
      });
      const onClick = notification.actionProps?.onClick;
      expect(onClick).toBeTypeOf("function");

      onClick!();
      expect(state.toastClose).toHaveBeenCalledWith(state.toastId);

      // Flush the single microtask between the runner resolving and dispatch;
      // startUpstreamMerge has no awaits in between.
      await Promise.resolve();

      expect(state.newThread).toHaveBeenCalledWith(state.projectRef, {
        envMode: "worktree",
        branch: "main",
      });
      expect(state.markPromotedDraftThreadByRef).toHaveBeenCalledTimes(1);
      expect(state.runAtomCommand).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
