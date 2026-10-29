import {
  AuthOrchestrationOperateScope,
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { deriveProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { deriveOngoingThreadBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  ActivityIcon,
  EyeIcon,
  LoaderCircleIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { revealThreadTerminalInRightPanel } from "../../lib/revealThreadTerminal";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { openProcessDetailsDialog } from "./ChatOverlayHosts";
import { ProcessTooltipContent } from "./ProcessTooltipContent";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  deriveRunlessBackgroundOwnerActive,
  deriveThreadProcessTaskRows,
  hasActiveForegroundRun,
  isActiveProcessTerminal,
  isPullRequestWatchTask,
  threadProcessesStopAvailable,
  threadProcessTaskIdentity,
  threadProcessTaskKindLabel,
  threadProcessTaskPreview,
  threadProcessTaskStatusLabel,
  type ThreadProcessTaskRow,
} from "./threadProcesses.logic";
import {
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const THREAD_PROCESSES_INITIAL_COUNT = 6;
const THREAD_PROCESSES_PAGE_COUNT = 12;

// The shared locked-row class assumes the button base styles (inline-flex items-center) that
// only ThreadDetailsControl supplies; a plain div needs its own flex centering.
const OPAQUE_PROCESS_ROW_CLASS = `flex items-center ${THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS}`;

interface TerminalProcessRow {
  readonly terminalId: string;
  readonly label: string;
  readonly starting: boolean;
  readonly startedAt: string | null;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly pid: number | null;
}

function deriveTerminalProcessRows(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<TerminalProcessRow> {
  return sessions.flatMap((session) => {
    const summary = session.state.summary;
    if (summary === null || !isActiveProcessTerminal(summary)) return [];
    return [
      {
        terminalId: session.target.terminalId,
        label: resolveTerminalSessionLabel(session.target.terminalId, summary),
        starting: summary.status === "starting",
        // Older servers omit startedAt; unknown stays unknown rather than falling back to
        // updatedAt, which only marks the last metadata repaint.
        startedAt: summary.startedAt ?? null,
        cwd: summary.cwd,
        worktreePath: summary.worktreePath,
        pid: summary.pid,
      },
    ];
  });
}

function taskKindIcon(kind: OrchestrationV2PendingBackgroundTask["kind"]) {
  switch (kind) {
    case "command":
      return TerminalIcon;
    case "monitor":
      return EyeIcon;
    default:
      return ActivityIcon;
  }
}

function ProcessRowList(props: {
  readonly label: string;
  readonly rows: number;
  readonly children: (visibleCount: number) => ReactNode;
}) {
  const [visibleCount, setVisibleCount] = useState(THREAD_PROCESSES_INITIAL_COUNT);
  const hiddenCount = Math.max(0, props.rows - visibleCount);
  return (
    <>
      {/*
        Plain overflow, not a ScrollArea: same constraint as the Lineage list — this sits inside
        an already scrolling panel, where a max-height-only virtual viewport measures badly.
      */}
      <ul
        aria-label={props.label}
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0"
      >
        {props.children(visibleCount)}
      </ul>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => count + THREAD_PROCESSES_PAGE_COUNT)}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Show {Math.min(hiddenCount, THREAD_PROCESSES_PAGE_COUNT)} more
        </button>
      ) : null}
    </>
  );
}

function ProcessGroupLabel(props: { readonly children: ReactNode }) {
  return (
    <div className="flex h-6 items-center px-2 text-2xs font-medium text-muted-foreground/70 select-none">
      {props.children}
    </div>
  );
}

/**
 * Row-level elapsed for a live process. Every listed process is active by construction, so the
 * elapsed always ticks. An unknown start renders an em dash — never a fabricated 0m and never
 * a proxy like updatedAt.
 */
function ProcessRowElapsed(props: { readonly startedAt: string | null }) {
  if (props.startedAt === null) {
    return (
      <span
        className="shrink-0 text-2xs text-muted-foreground"
        aria-label="Elapsed time unavailable"
      >
        —
      </span>
    );
  }
  return (
    <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
      <AgentElapsed
        agent={{ status: "running", startedAt: props.startedAt, completedAt: null }}
        compact
      />
    </span>
  );
}

export function ThreadProcessesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isStoppingBackgroundWork: boolean;
  readonly onStopBackgroundWork: () => void;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const threadKey = scopedThreadKey(ref);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(ref);
  const sessions = useKnownTerminalSessions({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);

  // Terminal metadata can be missing or failed for read-restricted users; that must not hide
  // the provider rows, so a null session list just means no terminal rows.
  const terminalRows = deriveTerminalProcessRows(sessions ?? []);
  // Ongoing work is derived here, not taken from the composer banner: the banner's list goes
  // quiet while a turn runs, but Processes must keep showing work that is still running.
  const runs = projection?.runs ?? [];
  // Provider-native threads have no app runs; their runless items are the root turn's
  // foreground work while it is active, so item-only inference must stand down.
  const nativeRootStatus =
    projection === null ? null : (deriveProviderSubagentStatus(projection)?.status ?? null);
  const runlessOwnerActive = deriveRunlessBackgroundOwnerActive({
    thread: projection?.thread ?? null,
    nativeRootStatus,
  });
  const backgroundTasks = deriveOngoingThreadBackgroundWork({
    providerThreads: projection?.providerThreads ?? [],
    turnItems: projection?.turnItems ?? [],
    activeProviderThreadId: projection?.thread.activeProviderThreadId ?? null,
    runs,
    pullRequests: projection?.thread.pullRequests,
    runlessOwnerActive,
  });
  const taskRows = deriveThreadProcessTaskRows({
    threadId: props.threadId,
    tasks: backgroundTasks,
    turnItems: projection?.turnItems ?? [],
    runs,
    visibleTurnItems,
  });

  if (terminalRows.length === 0 && taskRows.length === 0) {
    return null;
  }

  const revealTerminal = (terminalId: string) => {
    // Validate against the latest live summaries: a stale id must never reach the panel,
    // where an unknown terminal could be resurrected as a fresh PTY.
    const session = (sessions ?? []).find((entry) => entry.target.terminalId === terminalId);
    const summary = session?.state.summary;
    if (!summary || !isActiveProcessTerminal(summary)) return;
    revealThreadTerminalInRightPanel(ref, terminalId);
  };

  const showGroupLabels = terminalRows.length > 0 && taskRows.length > 0;
  const totalCount = terminalRows.length + taskRows.length;

  // Stop is thread-level interruption: while a foreground run is active it stops the current
  // turn too, so the label must say so instead of implying background-only scope.
  const foregroundActive = hasActiveForegroundRun(runs);
  const stopAriaLabel = foregroundActive ? "Stop thread" : "Stop background work";
  const stopTooltip = foregroundActive
    ? "Stop the current turn and all background work"
    : "Stop all background work";
  const showStop =
    taskRows.length > 0 &&
    threadProcessesStopAvailable({
      providerNative: projection !== null && isProviderNativeSubagentThread(projection.thread),
      runCount: runs.length,
    });

  const taskRowContent = (row: ThreadProcessTaskRow) => {
    const Icon = taskKindIcon(row.task.kind);
    return (
      <>
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
            {row.label}
          </span>
        </span>
        <ProcessRowElapsed startedAt={row.startedAt} />
      </>
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-processes-heading"
      title={totalCount > 0 ? `Processes · ${totalCount} running` : "Processes"}
      data-thread-processes-panel
      actions={
        showStop ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone="destructive"
                  aria-label={stopAriaLabel}
                  disabled={!canOperate || props.isStoppingBackgroundWork}
                  onClick={props.onStopBackgroundWork}
                />
              }
            >
              {props.isStoppingBackgroundWork ? (
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              ) : (
                <SquareIcon aria-hidden className="size-3 fill-current" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">{stopTooltip}</TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      {terminalRows.length > 0 ? (
        <div>
          {showGroupLabels ? <ProcessGroupLabel>Terminals</ProcessGroupLabel> : null}
          <ProcessRowList label="Active terminals" rows={terminalRows.length}>
            {(visibleCount) =>
              terminalRows.slice(0, visibleCount).map((row) => (
                <li
                  key={row.terminalId}
                  className="group relative flex h-8 items-center rounded-lg"
                >
                  <Tooltip>
                    <TooltipTrigger
                      delay={200}
                      render={
                        <ThreadDetailsControl
                          size="sm"
                          variant="ghost"
                          part="row"
                          onClick={() => revealTerminal(row.terminalId)}
                        />
                      }
                    >
                      <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                          {row.label}
                        </span>
                      </span>
                      <ProcessRowElapsed startedAt={row.startedAt} />
                    </TooltipTrigger>
                    <ThreadHoverCardPopup side="left">
                      <ProcessTooltipContent
                        title={row.label}
                        kind="Terminal"
                        status={row.starting ? "Starting" : "Running"}
                        startedAt={row.startedAt}
                        elapsedLabel="Session uptime"
                        cwd={row.cwd}
                        worktreePath={row.worktreePath}
                        pid={row.pid}
                      />
                    </ThreadHoverCardPopup>
                  </Tooltip>
                </li>
              ))
            }
          </ProcessRowList>
        </div>
      ) : null}
      {taskRows.length > 0 ? (
        <div>
          {showGroupLabels ? <ProcessGroupLabel>Background work</ProcessGroupLabel> : null}
          <ProcessRowList label="Background work" rows={taskRows.length}>
            {(visibleCount) =>
              taskRows.slice(0, visibleCount).map((row) => {
                const item = row.item;
                // Opaque tasks (no live projected item) stay status-only; there is nothing
                // truthful to open, so the row is not a button and subscribes to nothing. Its
                // hover still reports what the roster knows.
                if (item === null) {
                  // A pull request watch is app-owned, not provider-reported: the thread's
                  // links describe it fully, so the provider opaqueness note would be a lie.
                  const isWatch = isPullRequestWatchTask(row.task);
                  return (
                    <li key={row.task.taskId} className="flex h-8 items-center rounded-lg">
                      <Tooltip>
                        <TooltipTrigger
                          delay={200}
                          render={<div tabIndex={0} className={OPAQUE_PROCESS_ROW_CLASS} />}
                        >
                          {taskRowContent(row)}
                        </TooltipTrigger>
                        <ThreadHoverCardPopup side="left">
                          <ProcessTooltipContent
                            title={row.label}
                            kind={threadProcessTaskKindLabel(row.task.kind)}
                            status={isWatch ? "Watching" : "Provider-reported"}
                            startedAt={row.startedAt}
                            identity={isWatch ? null : row.task.taskId}
                            note={isWatch ? null : "Details unavailable"}
                          />
                        </ThreadHoverCardPopup>
                      </Tooltip>
                    </li>
                  );
                }
                return (
                  <li
                    key={row.task.taskId}
                    className="group relative flex h-8 items-center rounded-lg"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        delay={200}
                        render={
                          <ThreadDetailsControl
                            size="sm"
                            variant="ghost"
                            part="row"
                            onClick={() =>
                              openProcessDetailsDialog(threadKey, {
                                title: row.label,
                                projectedItem: item,
                              })
                            }
                          />
                        }
                      >
                        {taskRowContent(row)}
                      </TooltipTrigger>
                      <ThreadHoverCardPopup side="left">
                        <ProcessTooltipContent
                          title={row.label}
                          kind={threadProcessTaskKindLabel(row.task.kind)}
                          status={threadProcessTaskStatusLabel(row)}
                          startedAt={row.startedAt}
                          identity={threadProcessTaskIdentity(row)}
                          preview={threadProcessTaskPreview(row)}
                        />
                      </ThreadHoverCardPopup>
                    </Tooltip>
                  </li>
                );
              })
            }
          </ProcessRowList>
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
