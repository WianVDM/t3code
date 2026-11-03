import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import {
  startUpstreamMerge,
  useUpstreamRelease,
  useUpstreamReleasePolling,
} from "../../state/upstreamRelease";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { cn } from "../../lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isForkDesktopBuild, shouldDeferUpstreamMerge } from "../upstreamRelease.logic";

function SidebarUpstreamReleasePillContent() {
  useUpstreamReleasePolling();
  const newThread = useNewThreadHandler();
  const result = useUpstreamRelease();
  const desktopUpdateState = useDesktopUpdateState();

  if (result?.kind !== "unmerged") {
    return null;
  }

  const { tag } = result;
  const deferred = shouldDeferUpstreamMerge(desktopUpdateState);
  const title = deferred
    ? `Upstream ${tag} ready, install fork update first`
    : `Upstream ${tag} ready to merge`;
  const description = deferred
    ? `Upstream release ${tag} is not yet merged into main. Install the pending fork update before merging upstream.`
    : `Upstream release ${tag} is not yet merged into main. Click to start a merge thread.`;

  const handleClick = () => {
    if (deferred) {
      return;
    }
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
              aria-disabled={deferred || undefined}
              data-provider-update-main
              className={cn(
                "relative z-[1] flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left",
                deferred ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              )}
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
