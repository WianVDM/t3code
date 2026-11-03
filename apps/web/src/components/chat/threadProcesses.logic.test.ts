import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { ThreadId, TurnItemId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

import {
  deriveRunlessBackgroundOwnerActive,
  deriveThreadProcessTaskRows,
  hasActiveForegroundRun,
  isActiveProcessTerminal,
  isPullRequestWatchTask,
  threadProcessesStopAvailable,
  threadProcessTaskIdentity,
  threadProcessTaskKindLabel,
  threadProcessTaskLabel,
  threadProcessTaskPreview,
  threadProcessTaskStatusLabel,
} from "./threadProcesses.logic";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");

type ItemSpec = {
  readonly id: string;
  readonly type: "command_execution" | "dynamic_tool" | "subagent";
  readonly status?:
    | "pending"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly title?: string | null;
  readonly nativeId?: string | null;
  readonly runId?: string | null;
  readonly startedAt?: string | null;
};

function turnItem(spec: ItemSpec) {
  return {
    id: TurnItemId.make(spec.id),
    type: spec.type,
    status: spec.status ?? "running",
    title: spec.title ?? null,
    runId: (spec.runId ?? null) as never,
    nativeItemRef:
      spec.nativeId === undefined
        ? null
        : ({ nativeId: spec.nativeId } as { readonly nativeId: string | null }),
    ...(spec.startedAt !== undefined
      ? { startedAt: spec.startedAt === null ? null : DateTime.makeUnsafe(spec.startedAt) }
      : {}),
  };
}

function projectedRow(item: ReturnType<typeof turnItem>, sourceThread = threadId) {
  return {
    sourceThreadId: sourceThread,
    sourceItemId: item.id,
    item,
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

describe("isActiveProcessTerminal", () => {
  it.each([
    ["a starting session", true, { status: "starting", hasRunningSubprocess: false }],
    [
      "a running session with a live subprocess",
      true,
      { status: "running", hasRunningSubprocess: true },
    ],
    ["an idle ready shell", false, { status: "running", hasRunningSubprocess: false }],
    ["an exited session", false, { status: "exited", hasRunningSubprocess: false }],
    [
      "an exited session that last ran something",
      false,
      { status: "exited", hasRunningSubprocess: true },
    ],
    ["an errored session", false, { status: "error", hasRunningSubprocess: false }],
  ] as const)("%s: %s", (_case, active, summary) => {
    expect(isActiveProcessTerminal(summary)).toBe(active);
  });
});

describe("threadProcessTaskLabel", () => {
  it("prefers the provider description and falls back to the kind", () => {
    expect(
      threadProcessTaskLabel({ taskId: "a", kind: "command", description: "npm run dev" }),
    ).toBe("npm run dev");
    expect(threadProcessTaskLabel({ taskId: "a", kind: "command", description: "  " })).toBe(
      "Command",
    );
    expect(threadProcessTaskLabel({ taskId: "a", kind: "monitor" })).toBe("Monitor");
    expect(threadProcessTaskLabel({ taskId: "a", kind: "background_task" })).toBe(
      "Background task",
    );
  });
});

describe("threadProcessTaskStatusLabel", () => {
  const linkedRow = (status: "pending" | "running" | "waiting") => {
    const item = turnItem({ id: "item-1", type: "command_execution", status, nativeId: "t-1" });
    return {
      task: { taskId: "t-1", kind: "command" as const },
      label: "job",
      item: projectedRow(item),
      startedAt: null,
    };
  };

  it.each([
    ["pending", "Pending"],
    ["waiting", "Waiting"],
    ["running", "Running"],
  ] as const)("labels a linked %s item %s", (status, label) => {
    expect(threadProcessTaskStatusLabel(linkedRow(status))).toBe(label);
  });

  it("labels an opaque roster-only row Active", () => {
    expect(
      threadProcessTaskStatusLabel({
        task: { taskId: "opaque-1", kind: "background_task" },
        label: "Provider job",
        item: null,
        startedAt: null,
      }),
    ).toBe("Active");
  });
});

const appThread = (input?: { readonly providerNative?: boolean }) => ({
  lineage: {
    parentThreadId: input?.providerNative ? otherThreadId : null,
    relationshipToParent: input?.providerNative ? ("subagent" as const) : null,
    rootThreadId: threadId,
  },
  creationSource: input?.providerNative ? ("provider" as const) : ("web" as const),
});

describe("hasActiveForegroundRun", () => {
  it.each([
    ["preparing", true],
    ["starting", true],
    ["running", true],
    ["waiting", true],
    ["queued", false],
    ["completed", false],
    ["interrupted", false],
    ["failed", false],
    ["cancelled", false],
    ["rolled_back", false],
  ] as const)("a %s run means foreground work active: %s", (status, active) => {
    expect(hasActiveForegroundRun([{ status }])).toBe(active);
  });

  it("is false with no runs", () => {
    expect(hasActiveForegroundRun([])).toBe(false);
  });
});

describe("deriveRunlessBackgroundOwnerActive", () => {
  it("is false for an ordinary app thread, even with a running root status", () => {
    expect(
      deriveRunlessBackgroundOwnerActive({ thread: appThread(), nativeRootStatus: "running" }),
    ).toBe(false);
  });

  it("is false without a thread", () => {
    expect(deriveRunlessBackgroundOwnerActive({ thread: null, nativeRootStatus: "running" })).toBe(
      false,
    );
  });

  it.each(["pending", "running", "waiting"] as const)(
    "is true for a provider-native thread whose root turn is %s",
    (status) => {
      expect(
        deriveRunlessBackgroundOwnerActive({
          thread: appThread({ providerNative: true }),
          nativeRootStatus: status,
        }),
      ).toBe(true);
    },
  );

  it("is false for a provider-native thread whose root turn settled", () => {
    expect(
      deriveRunlessBackgroundOwnerActive({
        thread: appThread({ providerNative: true }),
        nativeRootStatus: "completed",
      }),
    ).toBe(false);
  });

  it("is true for a provider-native thread whose root turn status is unknown", () => {
    expect(
      deriveRunlessBackgroundOwnerActive({
        thread: appThread({ providerNative: true }),
        nativeRootStatus: null,
      }),
    ).toBe(true);
  });
});

describe("threadProcessesStopAvailable", () => {
  it("is available for an ordinary thread without runs", () => {
    expect(threadProcessesStopAvailable({ providerNative: false, runCount: 0 })).toBe(true);
  });

  it("is suppressed for a provider-native thread without runs", () => {
    expect(threadProcessesStopAvailable({ providerNative: true, runCount: 0 })).toBe(false);
  });

  it("is available for a provider-native thread with a run", () => {
    expect(threadProcessesStopAvailable({ providerNative: true, runCount: 1 })).toBe(true);
  });
});

describe("deriveThreadProcessTaskRows", () => {
  it("links a roster task to its projected item through the native id, not the item id", () => {
    const item = turnItem({ id: "item-1", type: "command_execution", nativeId: "task-9" });
    const row = projectedRow(item);
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command", description: "npm run dev" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [row],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("npm run dev");
    expect(rows[0]?.item).toBe(row);
    expect(rows[0]?.item?.sourceThreadId).toBe(threadId);
    expect(rows[0]?.item?.sourceItemId).toBe(TurnItemId.make("item-1"));
  });

  it("prefers the linked item's genuine start over the roster stamp", () => {
    const item = turnItem({
      id: "item-1",
      type: "command_execution",
      nativeId: "task-9",
      startedAt: "2026-04-20T00:00:01.000Z",
    });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [
        {
          taskId: "task-9",
          kind: "command",
          startedAt: "2026-04-20T00:00:02.000Z",
        },
      ],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [projectedRow(item)],
    });
    expect(rows[0]?.startedAt).toBe("2026-04-20T00:00:01.000Z");
  });

  it("keeps a roster-stamped start on an opaque row with no projected item", () => {
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [
        { taskId: "opaque-1", kind: "background_task", startedAt: "2026-04-20T00:00:02.000Z" },
      ],
      turnItems: [],
      runs: [],
      visibleTurnItems: [],
    });
    expect(rows).toEqual([
      {
        task: {
          taskId: "opaque-1",
          kind: "background_task",
          startedAt: "2026-04-20T00:00:02.000Z",
        },
        label: "Background task",
        item: null,
        startedAt: "2026-04-20T00:00:02.000Z",
      },
    ]);
  });

  it("keeps a candidate's timing when the details row left the visible projection", () => {
    const item = turnItem({
      id: "item-1",
      type: "command_execution",
      nativeId: "task-9",
      startedAt: "2026-04-20T00:00:01.000Z",
    });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [],
    });
    // No details to open, but the timing is still genuine.
    expect(rows[0]?.item).toBeNull();
    expect(rows[0]?.startedAt).toBe("2026-04-20T00:00:01.000Z");
  });

  it("reports unknown timing as null instead of falling back to updatedAt or first render", () => {
    const item = turnItem({ id: "item-1", type: "command_execution", nativeId: "task-9" });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [projectedRow(item)],
    });
    expect(rows[0]?.startedAt).toBeNull();
    const opaque = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "opaque-1", kind: "background_task" }],
      turnItems: [],
      runs: [],
      visibleTurnItems: [],
    });
    expect(opaque[0]?.startedAt).toBeNull();
  });

  it("keeps an opaque provider task status-only", () => {
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "opaque-1", kind: "background_task" }],
      turnItems: [],
      runs: [],
      visibleTurnItems: [],
    });
    expect(rows).toEqual([
      {
        task: { taskId: "opaque-1", kind: "background_task" },
        label: "Background task",
        item: null,
        startedAt: null,
      },
    ]);
  });

  it("excludes subagent roster tasks; they belong to Lineage", () => {
    const item = turnItem({ id: "item-1", type: "subagent", nativeId: "agent-1" });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "agent-1", kind: "subagent", description: "Review" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [projectedRow(item)],
    });
    expect(rows).toEqual([]);
  });

  it("excludes a subagent roster task even when no turn item matches it", () => {
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "agent-1", kind: "subagent", description: "Review" }],
      turnItems: [],
      runs: [],
      visibleTurnItems: [],
    });
    expect(rows).toEqual([]);
  });

  it("excludes a background task whose matching turn item is a subagent", () => {
    const item = turnItem({ id: "item-1", type: "subagent", nativeId: "agent-9" });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "agent-9", kind: "background_task" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [projectedRow(item)],
    });
    expect(rows).toEqual([]);
  });

  it("does not link a task to a completed item", () => {
    const item = turnItem({
      id: "item-1",
      type: "command_execution",
      status: "completed",
      nativeId: "task-9",
    });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [projectedRow(item)],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item).toBeNull();
  });

  it("does not link a task to an item from a rolled-back run", () => {
    const item = turnItem({
      id: "item-1",
      type: "command_execution",
      nativeId: "task-9",
      runId: "run-1",
    });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command" }],
      turnItems: [item],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      visibleTurnItems: [projectedRow(item)],
    });
    expect(rows[0]?.item).toBeNull();
  });

  it("does not link a task when the item left the visible projection", () => {
    const item = turnItem({ id: "item-1", type: "command_execution", nativeId: "task-9" });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [],
    });
    expect(rows[0]?.item).toBeNull();
  });

  it("never links a task to a row sourced from another thread", () => {
    const item = turnItem({ id: "item-1", type: "command_execution", nativeId: "task-9" });
    const rows = deriveThreadProcessTaskRows({
      threadId,
      tasks: [{ taskId: "task-9", kind: "command" }],
      turnItems: [item],
      runs: [],
      visibleTurnItems: [projectedRow(item, otherThreadId)],
    });
    expect(rows[0]?.item).toBeNull();
  });
});

describe("threadProcessTaskKindLabel", () => {
  it.each([
    ["command", "Command"],
    ["monitor", "Monitor"],
    ["background_task", "Background task"],
  ] as const)("labels kind %s as %s", (kind, label) => {
    expect(threadProcessTaskKindLabel(kind)).toBe(label);
  });

  it("labels a forward-compatible unknown kind generically", () => {
    expect(threadProcessTaskKindLabel("workflow" as never)).toBe("Background task");
  });
});

describe("isPullRequestWatchTask", () => {
  it("recognizes the app-owned watch id namespace", () => {
    expect(
      isPullRequestWatchTask({
        taskId: "pull-request-watch:github.com/acme/app#1",
        kind: "monitor",
      }),
    ).toBe(true);
  });

  it("does not mistake a provider monitor or a lookalike id for a watch", () => {
    expect(isPullRequestWatchTask({ taskId: "monitor-1", kind: "monitor" })).toBe(false);
    expect(
      isPullRequestWatchTask({
        taskId: "pull-request-watch:github.com/acme/app#1",
        kind: "command",
      }),
    ).toBe(false);
  });
});

describe("threadProcessTaskIdentity", () => {
  it("is the command for a linked command execution", () => {
    const item = turnItem({ id: "item-1", type: "command_execution", nativeId: "t-1" });
    const withInput = {
      ...item,
      input: "npm run dev",
    } as unknown as ReturnType<typeof turnItem>;
    const row = {
      task: { taskId: "t-1", kind: "command" as const },
      label: "dev server",
      item: projectedRow(withInput),
      startedAt: null,
    };
    expect(threadProcessTaskIdentity(row)).toBe("npm run dev");
  });

  it("is the tool name for a linked dynamic tool", () => {
    const item = {
      ...turnItem({ id: "item-1", type: "dynamic_tool", nativeId: "t-1" }),
      toolName: "t3_thread_wait",
    } as unknown as ReturnType<typeof turnItem>;
    const row = {
      task: { taskId: "t-1", kind: "background_task" as const },
      label: "Wait",
      item: projectedRow(item),
      startedAt: null,
    };
    expect(threadProcessTaskIdentity(row)).toBe("t3_thread_wait");
  });

  it("is null for an opaque row", () => {
    expect(
      threadProcessTaskIdentity({
        task: { taskId: "opaque-1", kind: "background_task" },
        label: "Provider job",
        item: null,
        startedAt: null,
      }),
    ).toBeNull();
  });
});

describe("threadProcessTaskPreview", () => {
  it("shows the last non-empty projected output line, truncated", () => {
    const item = {
      ...turnItem({ id: "item-1", type: "command_execution", nativeId: "t-1" }),
      output: "compiling\n\nready on :3000\n",
    } as unknown as ReturnType<typeof turnItem>;
    const row = {
      task: { taskId: "t-1", kind: "command" as const },
      label: "dev server",
      item: projectedRow(item),
      startedAt: null,
    };
    expect(threadProcessTaskPreview(row)).toBe("ready on :3000");
  });

  it("is null when no output is projected and for opaque rows", () => {
    const item = turnItem({ id: "item-1", type: "command_execution", nativeId: "t-1" });
    expect(
      threadProcessTaskPreview({
        task: { taskId: "t-1", kind: "command" },
        label: "dev server",
        item: projectedRow(item),
        startedAt: null,
      }),
    ).toBeNull();
    expect(
      threadProcessTaskPreview({
        task: { taskId: "opaque-1", kind: "background_task" },
        label: "Provider job",
        item: null,
        startedAt: null,
      }),
    ).toBeNull();
  });
});
