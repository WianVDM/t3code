import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  sessions: [] as ReadonlyArray<unknown> | null,
  turnItems: [] as ReadonlyArray<unknown>,
  runs: [] as ReadonlyArray<unknown>,
  providerThreads: [] as ReadonlyArray<unknown>,
  visibleTurnItems: [] as ReadonlyArray<unknown>,
  nodes: [] as ReadonlyArray<unknown>,
  thread: null as unknown,
  canOperate: true,
  reveal: vi.fn(),
}));

vi.mock(import("../../lib/revealThreadTerminal"), () => ({
  revealThreadTerminal: ((...args: ReadonlyArray<unknown>) => state.reveal(...args)) as never,
  revealThreadTerminalInRightPanel: ((...args: ReadonlyArray<unknown>) =>
    state.reveal(...args)) as never,
}));
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useKnownTerminalSessions: (() => state.sessions) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: (() => ({
    projection: {
      turnItems: state.turnItems,
      runs: state.runs,
      providerThreads: state.providerThreads,
      nodes: state.nodes,
      thread: state.thread,
    },
  })) as never,
  useThreadVisibleTurnItems: (() => state.visibleTurnItems) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.canOperate) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, fakeTimers, render } from "../../../test/render";
import { ProcessDetailsDialogHost } from "./ChatOverlayHosts";
import { ThreadProcessesPanel } from "./ThreadProcessesPanel";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function terminalSession(input: {
  readonly terminalId: string;
  readonly status: "starting" | "running" | "exited" | "error";
  readonly hasRunningSubprocess?: boolean;
  readonly label?: string;
  readonly startedAt?: string;
  readonly updatedAt?: string;
}) {
  return {
    target: { environmentId, threadId, terminalId: input.terminalId },
    state: {
      summary: {
        threadId,
        terminalId: input.terminalId,
        cwd: "C:/repo",
        worktreePath: null,
        status: input.status,
        pid: 1234,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: input.hasRunningSubprocess ?? false,
        label: input.label ?? "",
        updatedAt: input.updatedAt ?? "2026-03-17T19:12:28.000Z",
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      },
    },
  };
}

function commandItem(input: {
  readonly id: string;
  readonly nativeId: string;
  readonly command: string;
  readonly output?: string;
  readonly status?: "pending" | "running" | "waiting";
  readonly runId?: string | null;
  readonly startedAt?: string | null;
}) {
  return {
    id: TurnItemId.make(input.id),
    threadId,
    type: "command_execution",
    status: input.status ?? "running",
    title: null,
    runId: input.runId ?? null,
    nativeItemRef: { nativeId: input.nativeId },
    input: input.command,
    output: input.output,
    startedAt: input.startedAt == null ? null : DateTime.makeUnsafe(input.startedAt),
  };
}

function projectedRow(item: ReturnType<typeof commandItem>) {
  return {
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

interface SetupInput {
  readonly sessions?: ReadonlyArray<unknown> | null;
  /** Shorthand for a single provider thread ("pt-1") carrying this roster. */
  readonly tasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly providerThreads?: ReadonlyArray<unknown>;
  readonly runs?: ReadonlyArray<unknown>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly visibleTurnItems?: ReadonlyArray<unknown>;
  readonly nodes?: ReadonlyArray<unknown>;
  /** The thread's linked pull requests, including any active watch. */
  readonly pullRequests?: ReadonlyArray<unknown>;
  /** Marks the thread as a provider-native subagent thread (runless by definition). */
  readonly providerNative?: boolean;
  readonly canOperate?: boolean;
  readonly onStopBackgroundWork?: () => void;
}

function subject(input: SetupInput): ReactElement {
  return (
    <AppAtomRegistryProvider>
      <ThreadProcessesPanel
        environmentId={environmentId}
        threadId={threadId}
        isStoppingBackgroundWork={false}
        onStopBackgroundWork={input.onStopBackgroundWork ?? (() => {})}
      />
      <ProcessDetailsDialogHost
        threadKey={`${environmentId}:${threadId}`}
        environmentId={environmentId}
        visibleTurnItems={state.visibleTurnItems as ReadonlyArray<OrchestrationV2ProjectedTurnItem>}
        cwd={undefined}
        workspaceRoot={undefined}
        onOpenThread={() => {}}
        onOpenTurnDiff={() => {}}
      />
    </AppAtomRegistryProvider>
  );
}

function applyState(input: SetupInput) {
  state.sessions = input.sessions === undefined ? [] : input.sessions;
  state.turnItems = input.turnItems ?? [];
  state.visibleTurnItems = input.visibleTurnItems ?? [];
  state.runs = input.runs ?? [];
  state.nodes = input.nodes ?? [];
  state.thread = appThread({
    providerNative: input.providerNative ?? false,
    pullRequests: input.pullRequests ?? [],
  });
  state.providerThreads =
    input.providerThreads ??
    (input.tasks === undefined || input.tasks.length === 0
      ? []
      : [{ id: "pt-1", pendingBackgroundTasks: input.tasks }]);
  state.canOperate = input.canOperate ?? true;
}

async function setup(input: SetupInput = {}) {
  applyState(input);
  state.reveal.mockClear();

  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(subject(input)));
  // The mocked hooks read `state` while rendering, so an update rerenders with new state.
  const update = async (next: SetupInput) => {
    const merged: SetupInput = { ...input, ...next };
    applyState(merged);
    await act(async () => screen.rerender(subject(merged)));
  };
  const moved = stack.move();
  return {
    screen,
    update,
    [Symbol.asyncDispose]: () => moved.disposeAsync(),
  };
}

function appThread(input: {
  readonly providerNative: boolean;
  readonly pullRequests: ReadonlyArray<unknown>;
}) {
  return {
    activeProviderThreadId: null,
    pullRequests: input.pullRequests,
    lineage: {
      parentThreadId: input.providerNative ? ThreadId.make("thread-parent") : null,
      relationshipToParent: input.providerNative ? "subagent" : null,
      rootThreadId: threadId,
    },
    creationSource: input.providerNative ? "provider" : "web",
  };
}

function rootTurnNode(status: "pending" | "running" | "waiting" | "completed") {
  return { kind: "root_turn", runId: null, status, startedAt: null, completedAt: null };
}

function findButton(name: string) {
  return [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(name),
  );
}

it("reveals a busy terminal through its existing owner, and does not relaunch it", async () => {
  await using fixture = await setup({
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "dev server",
      }),
    ],
  });
  const { screen } = fixture;
  const row = screen.getByRole("button", { name: /dev server/ });
  await expect.element(row).toBeVisible();
  await userEvent.click(row);
  expect(state.reveal).toHaveBeenCalledTimes(1);
  expect(state.reveal).toHaveBeenCalledWith({ environmentId, threadId }, "term-2");
  // Clicking again reveals the same id again; no duplicate surface or fresh PTY is created
  // here, the reveal path only activates the existing terminal.
  await userEvent.click(row);
  expect(state.reveal).toHaveBeenCalledTimes(2);
  expect(state.reveal).toHaveBeenLastCalledWith({ environmentId, threadId }, "term-2");
});

it("omits idle, exited and errored terminals from the process list", async () => {
  await using fixture = await setup({
    sessions: [
      terminalSession({ terminalId: "term-1", status: "running", label: "ready shell" }),
      terminalSession({ terminalId: "term-2", status: "exited", label: "finished script" }),
      terminalSession({ terminalId: "term-3", status: "error", label: "broken shell" }),
      terminalSession({
        terminalId: "term-4",
        status: "running",
        hasRunningSubprocess: true,
        label: "busy shell",
      }),
      terminalSession({ terminalId: "term-5", status: "starting", label: "starting shell" }),
    ],
  });
  const { screen } = fixture;
  await expect.element(screen.getByRole("button", { name: /busy shell/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /starting shell/ })).toBeVisible();
  expect(screen.container.textContent).not.toContain("ready shell");
  expect(screen.container.textContent).not.toContain("finished script");
  expect(screen.container.textContent).not.toContain("broken shell");
});

it("drops a terminal row once its session exits, so no stale row can be revealed", async () => {
  await using fixture = await setup({
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "dev server",
      }),
    ],
  });
  const { screen, update } = fixture;
  await expect.element(screen.getByRole("button", { name: /dev server/ })).toBeVisible();
  await update({
    sessions: [terminalSession({ terminalId: "term-2", status: "exited", label: "dev server" })],
  });
  // The only way a stale reveal can happen is through a row that outlived its session.
  await expect.element(page.getByRole("button", { name: /dev server/ })).not.toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("dev server");
});

it("keeps provider rows when terminal metadata is unavailable", async () => {
  await using fixture = await setup({
    sessions: null,
    tasks: [{ taskId: "opaque-1", kind: "background_task", description: "Provider job" }],
  });
  void fixture;
  await expect.element(page.getByText("Provider job")).toBeVisible();
});

it("keeps an opaque provider task status-only: no button, no details, no subscription", async () => {
  await using fixture = await setup({
    tasks: [{ taskId: "opaque-1", kind: "background_task", description: "Provider job" }],
  });
  void fixture;
  await expect.element(page.getByText("Provider job")).toBeVisible();
  expect(findButton("Provider job")).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("lays out an opaque provider row as a centered flex row like the button rows", async () => {
  await using fixture = await setup({
    tasks: [{ taskId: "opaque-1", kind: "background_task", description: "Provider job" }],
  });
  void fixture;
  const label = page.getByText("Provider job").element();
  const row = label.closest("li")?.querySelector("div");
  expect(row).not.toBeNull();
  const style = getComputedStyle(row as HTMLElement);
  expect(style.display).toBe("flex");
  expect(style.alignItems).toBe("center");
});

it("labels linked rows from their projected status and opaque rows as provider-reported, in hover", async () => {
  const waitingItem = commandItem({
    id: "item-w",
    nativeId: "task-w",
    command: "tail -f log",
    status: "waiting",
  });
  const pendingItem = commandItem({
    id: "item-p",
    nativeId: "task-p",
    command: "npm run build",
    status: "pending",
  });
  await using fixture = await setup({
    tasks: [
      { taskId: "task-w", kind: "command", description: "waiting job" },
      { taskId: "task-p", kind: "command", description: "pending job" },
      { taskId: "task-o", kind: "background_task", description: "opaque job" },
    ],
    turnItems: [waitingItem, pendingItem],
    visibleTurnItems: [projectedRow(waitingItem), projectedRow(pendingItem)],
  });
  void fixture;
  // Rows carry no status text anymore — the status moved into the hover detail.
  const waitingRow = page.getByText("waiting job").element().closest("li")!;
  const pendingRow = page.getByText("pending job").element().closest("li")!;
  const opaqueRow = page.getByText("opaque job").element().closest("li")!;
  expect(waitingRow.textContent).not.toContain("Waiting");
  expect(pendingRow.textContent).not.toContain("Pending");

  await userEvent.hover(waitingRow.querySelector("button")!);
  await expect.element(page.getByText("Command · Waiting")).toBeVisible();
  await userEvent.unhover(waitingRow.querySelector("button")!);

  await userEvent.hover(pendingRow.querySelector("button")!);
  await expect.element(page.getByText("Command · Pending")).toBeVisible();
  await userEvent.unhover(pendingRow.querySelector("button")!);

  await userEvent.hover(opaqueRow.querySelector("[tabindex]")!);
  await expect.element(page.getByText("Background task · Provider-reported")).toBeVisible();
  await expect.element(page.getByText("Details unavailable")).toBeVisible();
  await expect.element(page.getByText("task-o")).toBeVisible();
});

it("keeps roster and earlier background rows with a thread-level Stop while a foreground run is active", async () => {
  const rosterItem = commandItem({
    id: "item-bg",
    nativeId: "bg-1",
    command: "npm run dev",
    output: "ready on :3000",
    runId: "run-2",
  });
  const foregroundItem = commandItem({
    id: "item-fg",
    nativeId: "fg-1",
    command: "vp test",
    runId: "run-2",
  });
  const earlierItem = commandItem({
    id: "item-old",
    nativeId: "old-1",
    command: "old watcher",
    runId: "run-1",
  });
  const onStop = vi.fn();
  await using fixture = await setup({
    onStopBackgroundWork: onStop,
    runs: [
      { id: "run-1", ordinal: 1, status: "completed" },
      { id: "run-2", ordinal: 2, status: "running" },
    ],
    tasks: [{ taskId: "bg-1", kind: "command", description: "npm run dev" }],
    turnItems: [rosterItem, foregroundItem, earlierItem],
    visibleTurnItems: [
      projectedRow(rosterItem),
      projectedRow(foregroundItem),
      projectedRow(earlierItem),
    ],
  });
  const { screen } = fixture;
  // Roster-backed background work from the active run stays listed.
  await expect.element(page.getByText("npm run dev")).toBeVisible();
  // Background work from an earlier settled run survives the new run.
  await expect.element(page.getByText("old watcher")).toBeVisible();
  // A foreground tool call of the active run is never promoted into background work.
  expect(screen.container.textContent).not.toContain("vp test");
  // The same handler interrupts the active run, so while one is active the button says so.
  const stop = screen.getByRole("button", { name: "Stop thread" });
  await expect.element(stop).toBeVisible();
  await userEvent.hover(stop);
  await expect
    .element(page.getByText("Stop the current turn and all background work"))
    .toBeVisible();
  await userEvent.click(stop);
  expect(onStop).toHaveBeenCalledTimes(1);

  // The current-run roster-backed row stays linked: its details open the live output.
  await userEvent.click(screen.getByRole("button", { name: /npm run dev/ }));
  const dialog = () => document.querySelector('[role="dialog"]');
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  expect(dialog()?.textContent).toContain("ready on :3000");
});

it("shows no stale provider row and no no-op Stop when the latest run is rolled_back", async () => {
  const item = commandItem({
    id: "item-1",
    nativeId: "bg-1",
    command: "npm run dev",
    runId: "run-1",
  });
  await using fixture = await setup({
    runs: [{ id: "run-1", ordinal: 1, status: "rolled_back" }],
    tasks: [{ taskId: "bg-1", kind: "command", description: "npm run dev" }],
    turnItems: [item],
    visibleTurnItems: [projectedRow(item)],
  });
  const { screen } = fixture;
  // The rolled-back run left no interruption target, so neither the roster row nor the
  // inferred item may surface as a live process Stop would pretend to end.
  expect(screen.container.textContent).not.toContain("npm run dev");
  expect(screen.container.textContent).not.toContain("Processes");
  await expect
    .element(page.getByRole("button", { name: "Stop background work" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Stop thread" })).not.toBeInTheDocument();
});

it("omits a provider-native thread's runless foreground items while its root turn is active, keeps roster rows, and hides Stop", async () => {
  await using fixture = await setup({
    providerNative: true,
    nodes: [rootTurnNode("running")],
    tasks: [{ taskId: "bg-1", kind: "command", description: "dev server" }],
    turnItems: [commandItem({ id: "item-fg", nativeId: "fg-1", command: "ls -la", runId: null })],
  });
  const { screen } = fixture;
  // Roster rows are authoritative and stay listed either way.
  await expect.element(page.getByText("dev server")).toBeVisible();
  // A runless item-only row is the native thread's foreground work while its root turn runs.
  expect(screen.container.textContent).not.toContain("ls -la");
  // There is no app run for thread-level Stop to target; the native subagent Stop lives in Lineage.
  await expect
    .element(page.getByRole("button", { name: "Stop background work" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Stop thread" })).not.toBeInTheDocument();
});

it("keeps a settled provider-native thread's runless background work listed", async () => {
  await using fixture = await setup({
    providerNative: true,
    nodes: [rootTurnNode("completed")],
    turnItems: [
      commandItem({ id: "item-bg", nativeId: "bg-9", command: "tail -f log", runId: null }),
    ],
  });
  void fixture;
  await expect.element(page.getByText("tail -f log")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Stop background work" }))
    .not.toBeInTheDocument();
});

it("opens read-only details for a linked task, and keeps them when the task disappears", async () => {
  const item = commandItem({
    id: "item-1",
    nativeId: "task-9",
    command: "npm run dev",
    output: "ready",
  });
  await using fixture = await setup({
    tasks: [{ taskId: "task-9", kind: "command", description: "npm run dev" }],
    turnItems: [item],
    visibleTurnItems: [projectedRow(item)],
  });
  const { screen, update } = fixture;
  await userEvent.click(screen.getByRole("button", { name: /npm run dev/ }));
  const dialog = () => document.querySelector('[role="dialog"]');
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  expect(dialog()?.textContent).toContain("ready");

  // The task leaving the pending roster must not close the dialog or blank its final output.
  await update({ tasks: [], visibleTurnItems: [] });
  expect(dialog()).not.toBeNull();
  expect(dialog()?.textContent).toContain("ready");
});

it("keeps details available while Stop is disabled for read-only users", async () => {
  const item = commandItem({
    id: "item-1",
    nativeId: "task-9",
    command: "npm run dev",
    output: "ready",
  });
  const onStop = vi.fn();
  await using fixture = await setup({
    canOperate: false,
    onStopBackgroundWork: onStop,
    tasks: [{ taskId: "task-9", kind: "command", description: "npm run dev" }],
    turnItems: [item],
    visibleTurnItems: [projectedRow(item)],
  });
  const { screen } = fixture;
  const stop = screen.getByRole("button", { name: "Stop background work" });
  await expect.element(stop).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /npm run dev/ }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  expect(onStop).not.toHaveBeenCalled();
});

it("Stop triggers exactly one thread-level background-work stop and keeps the roster rows", async () => {
  const onStop = vi.fn();
  await using fixture = await setup({
    onStopBackgroundWork: onStop,
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "dev server",
      }),
    ],
    tasks: [{ taskId: "task-9", kind: "command", description: "npm run dev" }],
  });
  const { screen } = fixture;
  // No active run: Stop only targets background work and says so.
  const stop = screen.getByRole("button", { name: "Stop background work" });
  await userEvent.hover(stop);
  await expect.element(page.getByText("Stop all background work")).toBeVisible();
  await userEvent.click(stop);
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(state.reveal).not.toHaveBeenCalled();
  // Stopping is not optimistic: until the roster changes, the row stays put.
  await expect.element(page.getByText("npm run dev")).toBeVisible();
});

it("hides Stop when only terminal processes are listed", async () => {
  await using fixture = await setup({
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "dev server",
      }),
    ],
  });
  const { screen } = fixture;
  await expect.element(screen.getByRole("button", { name: /dev server/ })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Stop background work" }))
    .not.toBeInTheDocument();
});

it("renders nothing when there are no active processes", async () => {
  await using fixture = await setup({});
  const { screen } = fixture;
  expect(screen.container.textContent ?? "").not.toContain("Processes");
});

it("heads the section with the exact live count, including rows beyond the initial window", async () => {
  await using fixture = await setup({
    sessions: Array.from({ length: 8 }, (_, index) =>
      terminalSession({
        terminalId: `term-${index + 2}`,
        status: "running",
        hasRunningSubprocess: true,
        label: `shell ${index}`,
      }),
    ),
  });
  void fixture;
  // 8 live rows but the list windows to 6; the heading still counts all of them.
  await expect.element(page.getByText("Processes · 8 running", { exact: true })).toBeVisible();
  expect(screen_queryAll("shell")).toHaveLength(6);

  function screen_queryAll(text: string) {
    return [...document.querySelectorAll("li")].filter((li) => li.textContent?.includes(text));
  }
});

it("shows terminal session details on hover: kind, status, uptime, cwd and PID", async () => {
  await using fixture = await setup({
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "dev server",
        startedAt: "2026-03-17T19:00:00.000Z",
      }),
    ],
  });
  const { screen } = fixture;
  await userEvent.hover(screen.getByRole("button", { name: /dev server/ }));
  await expect.element(page.getByText("Terminal · Running")).toBeVisible();
  await expect.element(page.getByText("Session uptime")).toBeVisible();
  await expect.element(page.getByText("PID 1234")).toBeVisible();
  await expect.element(page.getByText("C:/repo")).toBeVisible();
});

it("shows projected status, identity, and an already-projected output preview in a linked row's hover", async () => {
  const item = commandItem({
    id: "item-1",
    nativeId: "task-9",
    command: "npm run build",
    output: "compiling\nready on :3000\n",
    startedAt: "2026-03-17T19:10:28.000Z",
  });
  await using fixture = await setup({
    tasks: [{ taskId: "task-9", kind: "command", description: "build watcher" }],
    turnItems: [item],
    visibleTurnItems: [projectedRow(item)],
  });
  const { screen } = fixture;
  await userEvent.hover(screen.getByRole("button", { name: /build watcher/ }));
  await expect.element(page.getByText("Command · Running")).toBeVisible();
  await expect.element(page.getByText("npm run build")).toBeVisible();
  await expect.element(page.getByText("ready on :3000")).toBeVisible();
});

it("ticks a known elapsed time on the row", async () => {
  // The first render's effect reads Date.now for the initial elapsed, so the fake clock is
  // installed before render and advanced after.
  using _timers = fakeTimers({ now: Date.parse("2026-03-17T19:12:28.000Z") });
  await using fixture = await setup({
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "dev server",
        startedAt: "2026-03-17T19:10:28.000Z",
      }),
    ],
  });
  const { screen } = fixture;
  const row = screen.getByRole("button", { name: /dev server/ });
  await vi.waitFor(() => {
    expect(row.element().textContent).toContain("2m");
  });
  await act(async () => {
    vi.advanceTimersByTime(61_000);
  });
  await vi.waitFor(() => {
    expect(row.element().textContent).toContain("3m");
  });
});

it("renders an em dash for unknown starts and never falls back to updatedAt", async () => {
  await using fixture = await setup({
    sessions: [
      terminalSession({
        terminalId: "term-2",
        status: "running",
        hasRunningSubprocess: true,
        label: "new shell",
        updatedAt: "2026-03-17T19:12:28.000Z",
      }),
      terminalSession({
        terminalId: "term-3",
        status: "running",
        hasRunningSubprocess: true,
        label: "old shell",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    ],
  });
  const { screen } = fixture;
  // Different updatedAt values must not become different fake uptimes: both are unknown.
  expect(document.querySelectorAll('[aria-label="Elapsed time unavailable"]')).toHaveLength(2);
  expect(document.body.textContent).not.toContain("0m");

  // The hover says the same: Session uptime is an em dash, not a fabricated elapsed.
  await userEvent.hover(screen.getByRole("button", { name: /new shell/ }));
  await expect.element(page.getByText("Session uptime")).toBeVisible();
  const uptimeRow = page.getByText("Session uptime").element().parentElement;
  expect(uptimeRow?.querySelector('[aria-label="Elapsed time unavailable"]')).not.toBeNull();
});

it("labels an app-owned pull request watch as Watching, without provider opaqueness", async () => {
  await using fixture = await setup({
    pullRequests: [
      {
        host: "github.com",
        repository: "acme/app",
        number: 1,
        url: "https://github.com/acme/app/pull/1",
        source: "agent",
        linkedAt: "2026-03-17T19:00:00.000Z",
        snapshot: null,
        stack: null,
        watch: {
          startedAt: "2026-03-17T19:05:00.000Z",
          headSha: null,
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: "2026-03-17T19:05:00.000Z",
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ],
  });
  void fixture;
  const row = page.getByText("Watching pull request #1");
  await expect.element(row).toBeVisible();

  await userEvent.hover(row.element().closest("li")!.querySelector("[tabindex]")!);
  // The watch is app-owned, so the hover must not claim a provider reported it or that
  // details are unavailable.
  await expect.element(page.getByText("Monitor · Watching")).toBeVisible();
  expect(document.body.textContent).not.toContain("Provider-reported");
  expect(document.body.textContent).not.toContain("Details unavailable");
});
