import type {
  OrchestrationV2AppThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2TurnItemStatus,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive, isProviderNativeSubagentThread } from "@t3tools/contracts";
import type { PendingBackgroundWorkTurnItem } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  PULL_REQUEST_WATCH_TASK_ID_PREFIX,
  pendingBackgroundTurnItemsByTaskId,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

/**
 * Processes shows only live work: a starting session, or a shell with a running subprocess.
 * Idle ready shells and exited/error sessions are omitted — surfacing them here would either
 * fabricate history or, worse, invite a reveal that resurrects a dead PTY.
 */
export function isActiveProcessTerminal(
  summary: Pick<TerminalSummary, "status" | "hasRunningSubprocess">,
): boolean {
  return (
    summary.status === "starting" || (summary.status === "running" && summary.hasRunningSubprocess)
  );
}

const TASK_KIND_LABELS: Record<OrchestrationV2PendingBackgroundTask["kind"], string> = {
  command: "Command",
  monitor: "Monitor",
  background_task: "Background task",
  subagent: "Subagent",
};

// The run statuses thread-level Stop interrupts: it picks up the active run, holds the queue,
// and clears PR watches, so while one of these is live Stop is not background-only.
const FOREGROUND_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** True while a run the thread-level Stop would interrupt is active. */
export function hasActiveForegroundRun(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
): boolean {
  return runs.some((run) => FOREGROUND_RUN_STATUSES.has(run.status));
}

/**
 * Provider-native subagent threads have no app runs; their foreground tool calls are runless.
 * While their root turn is pending/running/waiting, runless items are that turn's foreground
 * work, not background processes. An unknown root state counts as active: omitting a row is
 * safer than promoting foreground work into Processes.
 */
export function deriveRunlessBackgroundOwnerActive(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource"> | null;
  readonly nativeRootStatus: OrchestrationV2ExecutionNode["status"] | null;
}): boolean {
  if (input.thread === null || !isProviderNativeSubagentThread(input.thread)) return false;
  if (input.nativeRootStatus === null) return true;
  return isOrchestrationV2WorkActive(input.nativeRootStatus);
}

/**
 * Processes Stop is thread-level interruption, which needs an app run to target. A
 * provider-native thread without runs has none, so the button would be a no-op; Lineage keeps
 * that thread's real whole-subagent Stop.
 */
export function threadProcessesStopAvailable(input: {
  readonly providerNative: boolean;
  readonly runCount: number;
}): boolean {
  return !(input.providerNative && input.runCount === 0);
}

export function threadProcessTaskLabel(task: OrchestrationV2PendingBackgroundTask): string {
  const description = task.description?.trim();
  return description && description.length > 0 ? description : TASK_KIND_LABELS[task.kind];
}

/**
 * Pull request watches are app-owned monitors, not opaque provider work: the app created the
 * task id and the thread's pull request links carry everything there is to know about them.
 */
export function isPullRequestWatchTask(
  task: Pick<OrchestrationV2PendingBackgroundTask, "taskId" | "kind">,
): boolean {
  return task.kind === "monitor" && task.taskId.startsWith(PULL_REQUEST_WATCH_TASK_ID_PREFIX);
}

/** Kind label for the hover detail; forward-compatible unknown kinds read as background tasks. */
export function threadProcessTaskKindLabel(
  kind: OrchestrationV2PendingBackgroundTask["kind"],
): string {
  return (
    TASK_KIND_LABELS[kind as keyof typeof TASK_KIND_LABELS] ?? TASK_KIND_LABELS.background_task
  );
}

const TASK_STATUS_LABELS: Partial<Record<OrchestrationV2TurnItemStatus, string>> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
};

/**
 * Linked rows report their projected item's status; opaque roster-only rows only know the work
 * exists, so they get the generic label instead of a fabricated one.
 */
export function threadProcessTaskStatusLabel(row: ThreadProcessTaskRow): string {
  const item = row.item?.item;
  // Forward-compatible union members without a known type carry no status to report.
  if (item === undefined || item === null || !("status" in item)) return "Active";
  return TASK_STATUS_LABELS[item.status] ?? "Active";
}

export interface ThreadProcessTaskRow {
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly label: string;
  /**
   * The live projected item backing this task, when one still exists. Rows without one are
   * status-only: the roster is authoritative about the task existing, but there is nothing
   * truthful to inspect.
   */
  readonly item: OrchestrationV2ProjectedTurnItem | null;
  /**
   * The genuine start of the work, when known: the projected item's start, else a
   * roster-stamped start. Null means unknown — never a proxy like updatedAt or first render,
   * so a row can keep truthful timing even when no visible details row exists.
   */
  readonly startedAt: string | null;
}

const TOOLTIP_PREVIEW_MAX_LENGTH = 160;

/**
 * The command or tool a linked row is running, for the hover detail. Opaque rows have nothing
 * truthful to show, so they get null.
 */
export function threadProcessTaskIdentity(row: ThreadProcessTaskRow): string | null {
  const item = row.item?.item;
  if (!item) return null;
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    if (command.length > 0) return command;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) return toolName.trim();
  }
  const title = item.title?.trim();
  return title && title.length > 0 ? title : null;
}

/**
 * The last non-empty line of output already on the projected item. Reading only the projection
 * keeps the hover free of output subscriptions.
 */
export function threadProcessTaskPreview(row: ThreadProcessTaskRow): string | null {
  const item = row.item?.item;
  if (!item) return null;
  const output = Reflect.get(item, "output");
  if (typeof output !== "string") return null;
  const lastLine =
    output
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ?? null;
  if (lastLine === null) return null;
  return lastLine.length > TOOLTIP_PREVIEW_MAX_LENGTH
    ? `${lastLine.slice(0, TOOLTIP_PREVIEW_MAX_LENGTH)}…`
    : lastLine;
}

export function deriveThreadProcessTaskRows<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}): ReadonlyArray<ThreadProcessTaskRow> {
  const candidatesByTaskId = pendingBackgroundTurnItemsByTaskId({
    turnItems: input.turnItems,
    runs: input.runs,
  });
  const rows: ThreadProcessTaskRow[] = [];
  for (const task of input.tasks) {
    const candidate = candidatesByTaskId.get(task.taskId);
    // Subagents belong to Lineage — both roster subagents and roster entries (e.g. a
    // background_task) that resolve to a subagent turn item.
    if (task.kind === "subagent" || candidate?.type === "subagent") continue;
    const item =
      candidate === undefined
        ? null
        : (input.visibleTurnItems.find(
            (row) => row.sourceThreadId === input.threadId && row.sourceItemId === candidate.id,
          ) ?? null);
    rows.push({
      task,
      label: threadProcessTaskLabel(task),
      item,
      startedAt:
        candidate?.startedAt != null
          ? DateTime.formatIso(candidate.startedAt)
          : (task.startedAt ?? null),
    });
  }
  return rows;
}
