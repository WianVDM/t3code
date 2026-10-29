import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { ProviderInstanceId, ProviderThreadId } from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  deriveOngoingThreadBackgroundWork,
  derivePendingBackgroundWork,
  pendingBackgroundTurnItemsByTaskId,
} from "./orchestrationV2PendingBackgroundWork.ts";

describe("derivePendingBackgroundWork", () => {
  it("stamps an inferred task with its item's genuine start, and stamps nothing when unknown", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems: [
        {
          id: "timed-item",
          type: "command_execution",
          status: "running",
          title: "npm test",
          startedAt: DateTime.makeUnsafe("2026-04-20T00:00:01.000Z"),
        },
        { id: "untimed-item", type: "command_execution", status: "running", title: "npm build" },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "timed-item",
        kind: "command",
        description: "npm test",
        startedAt: "2026-04-20T00:00:01.000Z",
      },
      { taskId: "untimed-item", kind: "command", description: "npm build" },
    ]);
  });

  it("preserves a roster task's startedAt and never fabricates one", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "timed", kind: "command", startedAt: "2026-04-20T00:00:02.000Z" },
            { taskId: "untimed", kind: "background_task" },
          ],
        },
      ],
      turnItems: [],
    });
    expect(tasks).toEqual([
      { taskId: "timed", kind: "command", startedAt: "2026-04-20T00:00:02.000Z" },
      { taskId: "untimed", kind: "background_task" },
    ]);
  });

  it("takes each subagent item's instance from its joined owner", () => {
    const owner = ProviderInstanceId.make("claude-owner");
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems: [
        {
          id: "owned-item",
          owningProviderInstanceId: owner,
          type: "subagent",
          status: "running",
          title: null,
        },
        { id: "unknown-item", type: "subagent", status: "running", title: null },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "owned-item", kind: "subagent", providerInstanceId: owner },
      { taskId: "unknown-item", kind: "subagent" },
    ]);
  });

  it("takes a roster subagent's instance from its owning provider thread", () => {
    const owner = ProviderInstanceId.make("claude-owner");
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: ProviderThreadId.make("pt-owner"),
          providerInstanceId: owner,
          pendingBackgroundTasks: [
            {
              taskId: "roster-item",
              kind: "subagent",
              providerInstanceId: ProviderInstanceId.make("other"),
            },
          ],
        },
      ],
      turnItems: [],
    });
    expect(tasks).toEqual([{ taskId: "roster-item", kind: "subagent", providerInstanceId: owner }]);
  });

  it("returns empty while the latest run is not settled", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: null,
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("does not keep a settled parent waiting for an idle child", () => {
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [{ id: "idle-child", type: "subagent", status: "idle", title: "Review" }],
      }),
    ).toEqual([]);
  });

  it("returns pending work when the latest run is waiting (post-success, pre-checkpoint)", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "npm test", kind: "command" }]);
  });

  it("excludes rolled_back items when the latest run is waiting", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "waiting" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-new",
        description: "still pending",
        kind: "command",
      },
    ]);
  });

  it("includes nonterminal turn items and excludes completed ones", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
        {
          id: "item-2" as never,
          type: "command_execution",
          status: "completed",
          title: "done",
          nativeItemRef: { nativeId: "cmd-2" },
          input: "echo done",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "npm test", kind: "command" }]);
  });

  it("dedupes roster entries against turn items by native task id", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "task-9", description: "Agent review", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Agent review",
          nativeItemRef: { nativeId: "task-9" },
          prompt: "review the plan",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "task-9", description: "Agent review", kind: "background_task" },
    ]);
  });

  it("excludes Grok persistent monitors", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "dynamic_tool",
          status: "running",
          title: "monitor logs",
          nativeItemRef: { nativeId: "mon-1" },
          input: { persistent: true, command: "tail -f" },
        },
        {
          id: "item-2" as never,
          type: "dynamic_tool",
          status: "running",
          title: "finite monitor",
          nativeItemRef: { nativeId: "mon-2" },
          input: { persistent: false, command: "sleep 5" },
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "mon-2", description: "finite monitor", kind: "background_task" },
    ]);
  });

  it("returns empty when the latest run is rolled_back even with a nonempty roster", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "abandoned",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "sleep 99",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("does not reclassify an older active run as background work", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "provider-task", kind: "background_task" }],
        },
      ],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "running" },
        { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      ],
      turnItems: [
        {
          id: "item-active" as never,
          type: "command_execution",
          status: "running",
          title: "foreground work",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-active" },
          input: "vp check",
        },
      ],
    });

    expect(tasks).toEqual([]);
  });

  it("includes items with a null run id even when runs list has rolled_back rows", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-null-run" as never,
          type: "command_execution",
          status: "running",
          title: "orphan item",
          runId: null,
          nativeItemRef: { nativeId: "cmd-null" },
          input: "echo orphan",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-null",
        description: "orphan item",
        kind: "command",
      },
    ]);
  });
});

describe("derivePendingBackgroundWork kinds", () => {
  it("keeps the roster's kinds and names turn items by their type", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bash", kind: "command" },
            { taskId: "watch", kind: "monitor" },
            { taskId: "workflow", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Review src/math.ts",
          nativeItemRef: { nativeId: "sub" },
          childThreadId: "thread:child" as never,
        },
        {
          id: "item-cmd" as never,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "cmd" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "bash", kind: "command" },
      { taskId: "watch", kind: "monitor" },
      { taskId: "workflow", kind: "background_task" },
      {
        taskId: "sub",
        description: "Review src/math.ts",
        kind: "subagent",
        childThreadId: "thread:child",
      },
      { taskId: "cmd", description: "npm test", kind: "command" },
    ]);
  });

  describe("pull request watches", () => {
    const watch = {
      startedAt: "2026-10-05T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-10-05T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const link = (
      number: number,
      extra: { source?: "agent" | "stack-dismissed"; watched?: boolean },
    ) => ({
      host: "github.com",
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      source: extra.source ?? "agent",
      ...(extra.watched === false ? {} : { watch }),
    });
    const pullRequests = [
      link(1, {}),
      link(2, { watched: false }),
      link(3, { source: "stack-dismissed" }),
    ];

    it("keeps a settled run waiting on each visible watch, as a monitor", () => {
      const tasks = derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [],
        pullRequests,
      });
      expect(tasks).toEqual([
        {
          taskId: "pull-request-watch:github.com/acme/app#1",
          description: "Watching pull request #1",
          kind: "monitor",
          startedAt: "2026-10-05T00:00:00.000Z",
        },
      ]);
      expect(backgroundWorkHoldsCompletion(tasks)).toBe(true);
    });

    it("keeps a thread that never ran waiting on its watch", () => {
      expect(
        derivePendingBackgroundWork({
          latestRun: null,
          providerThreads: [],
          turnItems: [],
          pullRequests,
        }).map((task) => task.taskId),
      ).toEqual(["pull-request-watch:github.com/acme/app#1"]);
    });

    it("lists no watch while a run is active", () => {
      expect(
        derivePendingBackgroundWork({
          latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
          providerThreads: [],
          turnItems: [],
          pullRequests,
        }),
      ).toEqual([]);
    });
  });
});

describe("deriveOngoingThreadBackgroundWork", () => {
  type RunStatus =
    | "preparing"
    | "queued"
    | "starting"
    | "running"
    | "waiting"
    | "completed"
    | "interrupted"
    | "failed"
    | "cancelled"
    | "rolled_back";
  const run = (id: string, ordinal: number, status: RunStatus) => ({
    id: id as never,
    ordinal,
    status,
  });
  const commandItem = (input: {
    readonly id: string;
    readonly title: string;
    readonly nativeId: string;
    readonly runId?: string | null;
  }) => ({
    id: input.id as never,
    type: "command_execution" as const,
    status: "running" as const,
    title: input.title,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    nativeItemRef: { nativeId: input.nativeId },
    input: input.title,
  });

  it("keeps the provider roster while a run is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [],
      activeProviderThreadId: "pt-1",
      runs: [run("run-1", 1, "running")],
    });
    expect(tasks).toEqual([{ taskId: "bg-1", description: "sleep 20", kind: "command" }]);
  });

  it("excludes a current-run command the roster does not claim", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        commandItem({ id: "item-1", title: "vp test", nativeId: "cmd-1", runId: "run-1" }),
      ],
      runs: [run("run-1", 1, "running")],
    });
    expect(tasks).toEqual([]);
  });

  it("keeps a current-run command the roster claims, as a single roster row", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "dev server", kind: "command" }],
        },
      ],
      turnItems: [
        commandItem({ id: "item-1", title: "dev server", nativeId: "bg-1", runId: "run-1" }),
      ],
      runs: [run("run-1", 1, "running")],
    });
    expect(tasks).toEqual([{ taskId: "bg-1", description: "dev server", kind: "command" }]);
  });

  it("keeps an inferred command's item start while a run is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          ...commandItem({
            id: "item-old",
            title: "old watcher",
            nativeId: "cmd-old",
            runId: "run-1",
          }),
          startedAt: DateTime.makeUnsafe("2026-04-20T00:00:03.000Z"),
        },
      ],
      runs: [run("run-1", 1, "completed"), run("run-2", 2, "running")],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-old",
        description: "old watcher",
        kind: "command",
        startedAt: "2026-04-20T00:00:03.000Z",
      },
    ]);
  });

  it("keeps background work from an earlier settled run while a new run is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        commandItem({ id: "item-old", title: "old watcher", nativeId: "cmd-old", runId: "run-1" }),
        commandItem({ id: "item-fg", title: "foreground", nativeId: "cmd-fg", runId: "run-2" }),
      ],
      runs: [run("run-1", 1, "completed"), run("run-2", 2, "running")],
    });
    expect(tasks).toEqual([{ taskId: "cmd-old", description: "old watcher", kind: "command" }]);
  });

  it("excludes items owned by a rolled-back run even when no run is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        commandItem({ id: "item-1", title: "abandoned", nativeId: "cmd-1", runId: "run-1" }),
      ],
      runs: [run("run-1", 1, "rolled_back")],
    });
    expect(tasks).toEqual([]);
  });

  it("fails the whole provider-work gate when the latest unheld run is rolled_back", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        commandItem({ id: "item-1", title: "abandoned", nativeId: "cmd-1", runId: "run-1" }),
      ],
      runs: [run("run-1", 1, "rolled_back")],
    });
    expect(tasks).toEqual([]);
  });

  it("keeps pull request watch monitors when the latest unheld run is rolled_back", () => {
    const watch = {
      startedAt: "2026-10-05T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-10-05T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        commandItem({ id: "item-1", title: "abandoned", nativeId: "cmd-1", runId: "run-1" }),
      ],
      runs: [run("run-1", 1, "rolled_back")],
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/app",
          number: 1,
          url: "https://github.com/acme/app/pull/1",
          source: "agent",
          watch,
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "pull-request-watch:github.com/acme/app#1",
        description: "Watching pull request #1",
        kind: "monitor",
        startedAt: "2026-10-05T00:00:00.000Z",
      },
    ]);
  });

  it("still gates on a rolled_back run when a newer run is only queue-held", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [],
      runs: [run("run-1", 1, "rolled_back"), { ...run("run-2", 2, "queued"), queueHeld: true }],
    });
    expect(tasks).toEqual([]);
  });

  it("keeps items with no run id while a run is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [commandItem({ id: "item-1", title: "orphan", nativeId: "cmd-1", runId: null })],
      runs: [run("run-1", 1, "running")],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "orphan", kind: "command" }]);
  });

  it("excludes runless item-only work while the runless owner is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [commandItem({ id: "item-1", title: "ls -la", nativeId: "cmd-1", runId: null })],
      runlessOwnerActive: true,
    });
    expect(tasks).toEqual([]);
  });

  it("keeps a runless roster-backed task while the runless owner is active", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "dev server", kind: "command" }],
        },
      ],
      turnItems: [
        commandItem({ id: "item-1", title: "dev server", nativeId: "bg-1", runId: null }),
      ],
      runlessOwnerActive: true,
    });
    expect(tasks).toEqual([{ taskId: "bg-1", description: "dev server", kind: "command" }]);
  });

  it("keeps runless item-only background work once the runless owner is settled", () => {
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        commandItem({ id: "item-1", title: "tail -f log", nativeId: "cmd-1", runId: null }),
      ],
      runlessOwnerActive: false,
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "tail -f log", kind: "command" }]);
  });

  it("keeps pull request watch monitors while a run is active", () => {
    const watch = {
      startedAt: "2026-10-05T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-10-05T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const tasks = deriveOngoingThreadBackgroundWork({
      providerThreads: [],
      turnItems: [],
      runs: [run("run-1", 1, "running")],
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/app",
          number: 1,
          url: "https://github.com/acme/app/pull/1",
          source: "agent",
          watch,
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "pull-request-watch:github.com/acme/app#1",
        description: "Watching pull request #1",
        kind: "monitor",
        startedAt: "2026-10-05T00:00:00.000Z",
      },
    ]);
  });
});

describe("pendingBackgroundTurnItemsByTaskId", () => {
  it("keys items by the provider's native id, which differs from the turn item id", () => {
    const items = [
      {
        id: "item-1",
        type: "command_execution",
        status: "running",
        title: null,
        nativeItemRef: { nativeId: "cmd-9" },
      },
      {
        id: "item-2",
        type: "dynamic_tool",
        status: "waiting",
        title: null,
        nativeItemRef: { nativeId: "tool-7" },
      },
    ] as const;
    const byTaskId = pendingBackgroundTurnItemsByTaskId({ turnItems: items });
    expect(byTaskId.get("cmd-9")).toBe(items[0]);
    expect(byTaskId.get("tool-7")).toBe(items[1]);
    expect(byTaskId.has("item-1")).toBe(false);
    expect(byTaskId.has("item-2")).toBe(false);
  });

  it("falls back to the item id when the provider reported no usable native id", () => {
    const items = [
      { id: "item-1", type: "dynamic_tool", status: "running", title: null, nativeItemRef: null },
      {
        id: "item-2",
        type: "command_execution",
        status: "running",
        title: null,
        nativeItemRef: { nativeId: "" },
      },
    ] as const;
    const byTaskId = pendingBackgroundTurnItemsByTaskId({ turnItems: items });
    expect(byTaskId.get("item-1")).toBe(items[0]);
    expect(byTaskId.get("item-2")).toBe(items[1]);
  });

  it("omits settled items, items from rolled-back runs, and persistent tools", () => {
    const completed = {
      id: "done",
      type: "command_execution",
      status: "completed",
      title: null,
      nativeItemRef: { nativeId: "cmd-done" },
    } as const;
    const rolledBack = {
      id: "rolled-back",
      type: "command_execution",
      status: "running",
      title: null,
      runId: "run-1",
      nativeItemRef: { nativeId: "cmd-rolled-back" },
    } as const;
    const persistent = {
      id: "persistent",
      type: "dynamic_tool",
      status: "running",
      title: null,
      input: { persistent: true },
      nativeItemRef: { nativeId: "tool-persistent" },
    } as const;
    const active = {
      id: "active",
      type: "subagent",
      status: "running",
      title: null,
      nativeItemRef: { nativeId: "agent-1" },
    } as const;
    const byTaskId = pendingBackgroundTurnItemsByTaskId({
      turnItems: [completed, rolledBack, persistent, active],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
    });
    expect([...byTaskId.keys()]).toEqual(["agent-1"]);
  });

  it("ignores items that cannot hold background work", () => {
    const byTaskId = pendingBackgroundTurnItemsByTaskId({
      turnItems: [
        { id: "note", type: "notification", status: "running", title: null },
        { id: "file", type: "file_change", status: "running", title: null },
      ],
    });
    expect(byTaskId.size).toBe(0);
  });
});
