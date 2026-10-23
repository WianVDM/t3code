import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildUpstreamMergePrompt,
  FORK_REPOSITORY,
  isForkDesktopBuild,
  isUpstreamCacheEntryFresh,
  pickForkProject,
  readCachedUpstreamRelease,
  refreshUpstreamReleaseIfStale,
  refreshUpstreamReleaseNow,
  UPSTREAM_POLL_INTERVAL_MS,
  type UpstreamReleaseResult,
} from "../components/upstreamRelease.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects } from "./entities";

const NO_PROJECT_FOUND_MESSAGE = `No project found for github.com/${FORK_REPOSITORY}. Add the fork checkout as a project first.`;

export type NewThreadRunner = ReturnType<typeof useNewThreadHandler>;

let activeNewThreadRunner: NewThreadRunner | null = null;

export function registerNewThreadRunner(runner: NewThreadRunner): () => void {
  activeNewThreadRunner = runner;
  return () => {
    if (activeNewThreadRunner === runner) {
      activeNewThreadRunner = null;
    }
  };
}

function getInitialUpstreamReleaseState(): UpstreamReleaseResult | null {
  if (!isForkDesktopBuild) {
    return null;
  }
  const cached = readCachedUpstreamRelease();
  if (!cached || !isUpstreamCacheEntryFresh(cached, Date.now())) {
    return null;
  }
  return cached.result;
}

export const upstreamReleaseStateAtom = Atom.make<UpstreamReleaseResult | null>(
  getInitialUpstreamReleaseState(),
).pipe(Atom.keepAlive, Atom.withLabel("upstream-release:state"));

async function refreshAndPublishIfStale(): Promise<void> {
  const result = await refreshUpstreamReleaseIfStale();
  appAtomRegistry.set(upstreamReleaseStateAtom, result);
}

export function useUpstreamReleasePolling(): void {
  useEffect(() => {
    if (!isForkDesktopBuild) {
      return;
    }
    void refreshAndPublishIfStale();
  }, []);

  useLiveRefresh(isForkDesktopBuild ? () => void refreshAndPublishIfStale() : null, {
    enabled: isForkDesktopBuild,
    key: "upstream-release",
    intervalMs: UPSTREAM_POLL_INTERVAL_MS,
  });
}

export function useUpstreamRelease(): UpstreamReleaseResult | null {
  return useAtomValue(upstreamReleaseStateAtom);
}

export async function startUpstreamMerge(
  tag: string,
  options?: {
    readonly newThread?: NewThreadRunner;
  },
): Promise<void> {
  const runner = options?.newThread ?? activeNewThreadRunner;
  const projectRef = pickForkProject(readProjects());

  if (!projectRef) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: NO_PROJECT_FOUND_MESSAGE,
      }),
    );
    return;
  }

  if (!runner) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not open a new thread. Open the sidebar and try again.",
      }),
    );
    return;
  }

  const session = await runner(projectRef, {
    envMode: "worktree",
    branch: "main",
  });

  if (!session) {
    return;
  }

  useComposerDraftStore.getState().setPrompt(session.draftId, buildUpstreamMergePrompt(tag));
}

export async function runManualUpstreamCheck(): Promise<void> {
  if (!isForkDesktopBuild) {
    return;
  }

  const result = await refreshUpstreamReleaseNow();
  appAtomRegistry.set(upstreamReleaseStateAtom, result);

  if (result.kind === "unknown") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check upstream releases",
        description: result.reason,
      }),
    );
    return;
  }

  if (result.kind === "unmerged") {
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `Upstream ${result.tag} is ready to merge`,
        actionProps: {
          children: "Start merge",
          onClick: () => {
            toastManager.close(toastId);
            void startUpstreamMerge(result.tag);
          },
        },
      }),
    );
  }
}
