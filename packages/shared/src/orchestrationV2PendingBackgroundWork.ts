import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";

import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";
import { threadPullRequestKeyOf } from "./threadPullRequests.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

// Plans and text streams can stay open across tool calls without executing work.
const EXECUTION_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  ...BACKGROUND_TURN_ITEM_TYPES,
  "file_change",
  "file_search",
  "web_search",
  "compaction",
]);

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

/**
 * Includes `waiting`: a successful turn persists as waiting until checkpoint capture flips it to
 * completed, and waiting is only set from completed. Excludes `rolled_back`: the provider-thread
 * roster is not run-tied, so a rolled-back latest run must fail the gate entirely (not only item
 * filter).
 */
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

/**
 * Task id namespace for app-owned pull request watches. Unlike provider roster tasks these are
 * fully described by the thread's pull request links, so clients can recognize them by prefix
 * instead of treating them as opaque provider work.
 */
export const PULL_REQUEST_WATCH_TASK_ID_PREFIX = "pull-request-watch:";

export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

export function deriveBlockedOnThreadWait(input: {
  readonly activeRun: Pick<OrchestrationV2Run, "id" | "status"> | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): boolean {
  if (input.activeRun?.status !== "running") return false;
  let hasWait = false;
  for (const item of input.turnItems) {
    if (
      item.runId !== input.activeRun.id ||
      !EXECUTION_TURN_ITEM_TYPES.has(item.type) ||
      (item.status !== "running" && item.status !== "waiting") ||
      // App-owned rows track the child, including the child a blocking delegate is waiting for.
      (item.type === "subagent" && item.origin === "app_owned")
    ) {
      continue;
    }
    if (item.type !== "dynamic_tool") return false;
    const tool = resolveT3McpToolId(item.toolName);
    if (
      tool !== "t3_thread_wait" &&
      !(
        tool === "delegate_task" &&
        Predicate.isObject(item.input) &&
        Reflect.get(item.input, "mode") === "wait"
      )
    ) {
      return false;
    }
    hasWait = true;
  }
  return hasWait;
}

export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind">>,
): boolean {
  return tasks.some((task) => backgroundWorkKindHoldsCompletion(task.kind));
}

function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
      return false;
    case "subagent":
    case "monitor":
    case "background_task":
      return true;
  }
}

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status"> & {
  readonly queueHeld?: OrchestrationV2Run["queueHeld"];
};

type PendingBackgroundWorkPullRequest = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "source" | "watch"
>;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
> & { readonly providerInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"] };

export type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** Shell readers join the owner, even when its provider thread belongs to a child app thread. */
  readonly owningProviderInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"];
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly prompt?: string | undefined;
  readonly childThreadId?: ThreadId | null;
  readonly startedAt?: OrchestrationV2TurnItem["startedAt"];
};

// Mirrors latestUnheldRun on this narrowed run shape: the newest run not waiting in a held
// queue. Queue-held runs never outrank the run they wait behind as the thread's outcome.
function latestUnheldPendingBackgroundRun(
  runs: ReadonlyArray<PendingBackgroundWorkRun>,
): PendingBackgroundWorkRun | null {
  let latest: PendingBackgroundWorkRun | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

function isLatestRunSettledForBackgroundWait(
  latestRun: PendingBackgroundWorkRun | null | undefined,
): boolean {
  if (latestRun === undefined || latestRun === null) {
    return false;
  }
  return SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName.trim();
    }
  }
  if (item.type === "subagent" && typeof item.prompt === "string") {
    const prompt = item.prompt.trim();
    return prompt.length > 0 ? prompt : undefined;
  }
  return undefined;
}

function pendingTaskFromTurnItem(
  taskId: string,
  item: PendingBackgroundWorkTurnItem,
): PendingBackgroundWorkTask {
  const description = descriptionFromTurnItem(item);
  const named = {
    taskId,
    ...(description === undefined ? {} : { description }),
    // Only the item's own start is truthful timing; nothing is backfilled when it is unknown.
    ...(item.startedAt === undefined || item.startedAt === null
      ? {}
      : { startedAt: DateTime.formatIso(item.startedAt) }),
  };
  switch (item.type) {
    case "subagent":
      return {
        ...named,
        kind: "subagent",
        ...(item.owningProviderInstanceId === undefined
          ? {}
          : { providerInstanceId: item.owningProviderInstanceId }),
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
      };
    case "command_execution":
      return { ...named, kind: "command" };
    default:
      return { ...named, kind: "background_task" };
  }
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/**
 * The turn items the pending-work list names, without its settled-run gate.
 * Stop ends exactly these, so the list and Stop cannot disagree.
 */
export function pendingBackgroundTurnItems<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<Item> {
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  return input.turnItems.filter(
    (item) =>
      BACKGROUND_TURN_ITEM_TYPES.has(item.type) &&
      isOrchestrationV2WorkActive(item.status) &&
      !(item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) &&
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

/**
 * Candidate background turn items keyed by the roster task id they answer to. Roster task
 * ids are the provider's native ids, which differ from turn item ids, so this join reuses
 * the same nativeTaskIdFromTurnItem/pendingBackgroundTurnItems semantics as
 * derivePendingBackgroundWork rather than casting a taskId to a TurnItemId.
 */
export function pendingBackgroundTurnItemsByTaskId<
  Item extends PendingBackgroundWorkTurnItem,
>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyMap<string, Item> {
  const byTaskId = new Map<string, Item>();
  for (const item of pendingBackgroundTurnItems(input)) {
    byTaskId.set(nativeTaskIdFromTurnItem(item), item);
  }
  return byTaskId;
}

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

function collectRosterTasks(
  byTaskId: Map<string, PendingBackgroundWorkTask>,
  providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>,
  activeProviderThreadId: string | null | undefined,
): void {
  const threads =
    activeProviderThreadId === undefined || activeProviderThreadId === null
      ? providerThreads
      : providerThreads.filter((thread) => thread.id === activeProviderThreadId);

  for (const providerThread of threads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      const { description: rawDescription, ...named } = task;
      const description = rawDescription?.trim();
      byTaskId.set(task.taskId, {
        ...named,
        ...(task.kind === "subagent"
          ? { providerInstanceId: providerThread.providerInstanceId }
          : {}),
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    }
  }
}

/**
 * Ongoing work for the Processes panel. Unlike derivePendingBackgroundWork — the composer
 * banner's list, which goes quiet while a turn runs — this stays truthful through a follow-up
 * foreground turn: the provider roster is always authoritative, and a turn item is included
 * unless an active run owns it. Items an active run owns are foreground work unless the roster
 * claims them, so they never get promoted into background processes.
 */
export function deriveOngoingThreadBackgroundWork(input: {
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
  /**
   * True while the owner of runless work — a provider-native thread's root turn — is active
   * or its state is unknown. Runless items are that turn's foreground work then, so item-only
   * inference is skipped; roster tasks stay authoritative either way.
   */
  readonly runlessOwnerActive?: boolean;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  // A rolled-back latest run fails the whole provider-work gate, matching
  // derivePendingBackgroundWork: the roster is not run-tied and rollback removed the
  // interruption target, so any roster or inferred row would be a stale no-op. Pull request
  // watches stay independent monitors.
  if (latestUnheldPendingBackgroundRun(input.runs ?? [])?.status === "rolled_back") {
    return pullRequestWatchTasks(input.pullRequests);
  }

  const activeRunIds = new Set(
    (input.runs ?? [])
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .map((run) => String(run.id)),
  );

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();
  collectRosterTasks(byTaskId, input.providerThreads, input.activeProviderThreadId);

  for (const item of pendingBackgroundTurnItems(input)) {
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }
    if (item.runId === undefined || item.runId === null) {
      if (input.runlessOwnerActive === true) {
        continue;
      }
    } else if (activeRunIds.has(String(item.runId))) {
      continue;
    }
    byTaskId.set(taskId, pendingTaskFromTurnItem(taskId, item));
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /**
   * Run rows used to exclude items owned by rolled_back runs. Optional for
   * callers that already filtered (SQL shell path); in-memory callers should
   * pass projection runs so policy cannot drift.
   */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const hasActiveRun =
    input.hasActiveRun ?? input.runs?.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? false;
  if (hasActiveRun) {
    return [];
  }
  if (input.latestRun == null) {
    return pullRequestWatchTasks(input.pullRequests);
  }
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();
  collectRosterTasks(byTaskId, input.providerThreads, input.activeProviderThreadId);

  for (const item of pendingBackgroundTurnItems(input)) {
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    byTaskId.set(taskId, pendingTaskFromTurnItem(taskId, item));
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

function pullRequestWatchTasks(
  pullRequests: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (pullRequests ?? []).flatMap((link) =>
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            taskId: `${PULL_REQUEST_WATCH_TASK_ID_PREFIX}${threadPullRequestKeyOf(link)}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
            startedAt: link.watch.startedAt,
          },
        ],
  );
}
