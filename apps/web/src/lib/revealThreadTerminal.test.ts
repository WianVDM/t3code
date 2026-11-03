import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { revealThreadTerminal, revealThreadTerminalInRightPanel } from "./revealThreadTerminal";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("settled-thread"));
const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), threadRef.threadId);

beforeEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
});

it("reopens the existing panel and selects a running terminal in its split", () => {
  const panels = useRightPanelStore.getState();
  panels.openTerminal(threadRef, "terminal-1");
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "setup-install");
  panels.activateTerminal(threadRef, surfaceId, "terminal-1");
  panels.close(threadRef);

  revealThreadTerminal(threadRef, "setup-install");
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    isOpen: true,
    activeSurfaceId: surfaceId,
    surfaces: [
      {
        terminalIds: ["terminal-1", "setup-install"],
        activeTerminalId: "setup-install",
      },
    ],
  });
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual([]);
});

it("reveals terminals in their own environment without changing another environment's drawer", () => {
  revealThreadTerminal(threadRef, "default");
  revealThreadTerminal(remoteRef, "setup-install");
  const state = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
  expect(selectThreadTerminalUiState(state, threadRef).terminalIds).toEqual(["default"]);
  expect(selectThreadTerminalUiState(state, remoteRef).terminalIds).toEqual(["setup-install"]);
});

it("moves a drawer terminal into the right panel without suppressing or closing it", () => {
  const drawer = useTerminalUiStateStore.getState();
  drawer.ensureTerminal(threadRef, "term-1", { open: true, active: true });
  drawer.ensureTerminal(threadRef, "term-2", { open: true, active: true });

  revealThreadTerminalInRightPanel(threadRef, "term-1");

  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  const surface = panel.surfaces.find(
    (entry) => entry.kind === "terminal" && entry.terminalIds.includes("term-1"),
  );
  expect(panel.isOpen).toBe(true);
  expect(panel.activeSurfaceId).toBe(surface?.id);
  expect(surface).toMatchObject({ terminalIds: ["term-1"], activeTerminalId: "term-1" });

  // The drawer keeps its other terminal; the moved one is released without close suppression.
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual(["term-2"]);
  expect(useTerminalUiStateStore.getState().suppressedTerminalIdsByThreadKey).toEqual({});

  // Repeating the reveal activates in place; no duplicate surface appears.
  revealThreadTerminalInRightPanel(threadRef, "term-1");
  const panelAgain = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  expect(
    panelAgain.surfaces.filter(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes("term-1"),
    ),
  ).toHaveLength(1);
  expect(panelAgain.activeSurfaceId).toBe(surface?.id);
});

it("activates a terminal already in a panel split in place and leaves the drawer alone", () => {
  const panels = useRightPanelStore.getState();
  panels.openTerminal(threadRef, "term-1");
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "term-2");
  panels.activateTerminal(threadRef, surfaceId, "term-1");
  panels.close(threadRef);
  useTerminalUiStateStore.getState().ensureTerminal(threadRef, "term-3", { open: true });

  revealThreadTerminalInRightPanel(threadRef, "term-2");

  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    isOpen: true,
    activeSurfaceId: surfaceId,
    surfaces: [{ terminalIds: ["term-1", "term-2"], activeTerminalId: "term-2" }],
  });
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual(["term-3"]);
});

it("opens a terminal the drawer never owned in the panel, without touching the drawer", () => {
  revealThreadTerminalInRightPanel(threadRef, "term-9");
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
  ).toMatchObject([{ kind: "terminal", terminalIds: ["term-9"] }]);
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual([]);
});

it("adds a reused terminal id to its stale same-key surface before releasing the drawer", () => {
  const panels = useRightPanelStore.getState();
  // term-1 created this surface, then its tab was closed: terminal:term-1 now holds only
  // term-2, and the drawer allocator was free to hand term-1 out again.
  panels.openTerminal(threadRef, "term-1");
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "term-2");
  panels.closeTerminal(threadRef, surfaceId, "term-1");
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
  ).toMatchObject([{ id: "terminal:term-1", terminalIds: ["term-2"] }]);
  useTerminalUiStateStore.getState().ensureTerminal(threadRef, "term-1", {
    open: true,
    active: true,
  });

  revealThreadTerminalInRightPanel(threadRef, "term-1");

  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  // openTerminal upserts by surface id and would have left the stale surface unchanged, so the
  // reveal must add the requested id to the same-key surface itself.
  expect(panel.surfaces.filter((entry) => entry.id === "terminal:term-1")).toHaveLength(1);
  expect(panel.isOpen).toBe(true);
  expect(panel.activeSurfaceId).toBe("terminal:term-1");
  expect(panel.surfaces[0]).toMatchObject({
    kind: "terminal",
    terminalIds: ["term-2", "term-1"],
    activeTerminalId: "term-1",
  });
  // The drawer's ownership is released only because a panel surface now contains the id;
  // otherwise the reveal would have orphaned it.
  expect(
    selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalIds,
  ).toEqual([]);
  expect(useTerminalUiStateStore.getState().suppressedTerminalIdsByThreadKey).toEqual({});
});
