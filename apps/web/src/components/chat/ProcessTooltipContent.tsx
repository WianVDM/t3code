import { FolderIcon, GitBranchIcon, TerminalIcon } from "lucide-react";

import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { AgentElapsed } from "./AgentElapsed";

/**
 * Rich hover for a Processes row, in the Lineage style. Everything shown is already projected or
 * reported in the terminal summary — the hover never subscribes to output and never fabricates
 * timing.
 */
export function ProcessTooltipContent(props: {
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  /** Genuine start of the process; null means unknown, and the hover then shows an em dash. */
  readonly startedAt: string | null;
  /**
   * When set, elapsed renders as its own labeled row (e.g. a terminal's session uptime) instead
   * of trailing the status, so it is never mistaken for a child command's duration.
   */
  readonly elapsedLabel?: string;
  /** The command or tool the row is running, when projected. */
  readonly identity?: string | null;
  readonly cwd?: string | null;
  readonly worktreePath?: string | null;
  readonly pid?: number | null;
  /** Last projected output line, when one was already projected. */
  readonly preview?: string | null;
  readonly note?: string | null;
}) {
  // An unknown start is still reported, as an em dash — matching the row, which never
  // fabricates a 0m or falls back to a proxy like updatedAt.
  const elapsed =
    props.startedAt === null ? (
      <span className="shrink-0 text-muted-foreground" aria-label="Elapsed time unavailable">
        —
      </span>
    ) : (
      <AgentElapsed
        agent={{ status: "running", startedAt: props.startedAt, completedAt: null }}
        compact
      />
    );
  return (
    <ThreadHoverCard title={props.title}>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span className="min-w-0 truncate font-medium">
          {props.kind} · {props.status}
        </span>
        {props.elapsedLabel === undefined ? elapsed : null}
      </div>
      {props.elapsedLabel !== undefined ? (
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span>{props.elapsedLabel}</span>
          {elapsed}
        </div>
      ) : null}
      {props.identity ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="sr-only">Running</span>
          <MiddleTruncate value={props.identity} className="flex" showTitle={false} />
        </div>
      ) : null}
      {props.cwd ? (
        <div className="flex min-w-0 items-center gap-2">
          <FolderIcon aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">Working directory</span>
          <MiddleTruncate value={props.cwd} className="flex" showTitle={false} />
        </div>
      ) : null}
      {props.worktreePath ? (
        <div className="flex min-w-0 items-center gap-2">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">Worktree</span>
          <MiddleTruncate value={props.worktreePath} className="flex" showTitle={false} />
        </div>
      ) : null}
      {props.pid !== null && props.pid !== undefined ? (
        <div className="flex min-w-0 items-center gap-2">
          <span>PID {props.pid}</span>
        </div>
      ) : null}
      {props.preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">Latest output</span>
          <MiddleTruncate value={props.preview} className="flex" showTitle={false} />
        </div>
      ) : null}
      {props.note ? <div>{props.note}</div> : null}
    </ThreadHoverCard>
  );
}
