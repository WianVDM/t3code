import { useEffect } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import {
  registerNewThreadRunner,
  startUpstreamMerge,
  useUpstreamRelease,
  useUpstreamReleasePolling,
} from "../../state/upstreamRelease";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isForkDesktopBuild } from "../upstreamRelease.logic";

function SidebarUpstreamReleasePillContent() {
  useUpstreamReleasePolling();
  const newThread = useNewThreadHandler();
  const result = useUpstreamRelease();

  useEffect(() => {
    return registerNewThreadRunner(newThread);
  }, [newThread]);

  if (result?.kind !== "unmerged") {
    return null;
  }

  const { tag } = result;
  const title = `Upstream ${tag} ready to merge`;
  const description = `Upstream release ${tag} is not yet merged into main. Click to start a merge thread.`;

  const handleClick = () => {
    void startUpstreamMerge(tag, { newThread });
  };

  return (
    <div
      data-sidebar-pill="upstream-release"
      className="group/provider-update relative flex min-w-0 flex-col overflow-hidden rounded-md border border-sidebar-border/70 text-xs shadow-xs transition-colors bg-sidebar-control-surface text-sidebar-foreground group-has-[button[data-provider-update-main]:hover]/provider-update:bg-sidebar-row-hover"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={description}
              data-provider-update-main
              className="relative z-[1] flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left cursor-pointer"
              onClick={handleClick}
            >
              <PullRequestGlyph.merged className="size-3.5 shrink-0" />
              <span className="min-w-0 wrap-break-word">{title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function SidebarUpstreamReleasePill() {
  if (!isForkDesktopBuild) {
    return null;
  }

  return <SidebarUpstreamReleasePillContent />;
}
