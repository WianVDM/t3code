import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

export function revealThreadTerminal(threadRef: ScopedThreadRef, terminalId: string) {
  const panels = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  if (surface) {
    panels.activateTerminal(threadRef, surface.id, terminalId);
    panels.activateSurface(threadRef, surface.id);
    return;
  }
  useTerminalUiStateStore.getState().ensureTerminal(threadRef, terminalId, {
    open: true,
    active: true,
  });
}

/**
 * Processes reveal always targets the right side panel: a terminal already shown there (or in a
 * split) activates in place; a drawer terminal moves to a panel surface, then the drawer's UI
 * ownership is released with a filtered reconcile — never closeTerminal, which would suppress
 * the id, and never a session close or relaunch. The panel surface opens first so the terminal
 * always has exactly one owner and repeated reveals cannot duplicate the surface.
 */
export function revealThreadTerminalInRightPanel(threadRef: ScopedThreadRef, terminalId: string) {
  const panels = useRightPanelStore.getState();
  const containing = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  if (containing) {
    panels.activateTerminal(threadRef, containing.id, terminalId);
    panels.activateSurface(threadRef, containing.id);
  } else {
    // A same-key surface can outlive the id that created it: closing term-1's tab leaves
    // terminal:term-1 holding only term-2, and the drawer allocator can then hand term-1 out
    // again. openTerminal upserts by surface id and would leave that stale surface unchanged,
    // so the requested id must be added to the same-key surface explicitly.
    const sameKey = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
      (surface) => surface.kind === "terminal" && surface.id === `terminal:${terminalId}`,
    );
    if (sameKey) {
      panels.splitTerminal(threadRef, sameKey.id, terminalId);
    } else {
      panels.openTerminal(threadRef, terminalId);
    }
  }
  // Release the drawer's UI ownership only once a panel surface actually contains the id;
  // releasing earlier would orphan a terminal the panel never took over.
  const revealed = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).surfaces.some(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  if (!revealed) {
    return;
  }
  const drawer = useTerminalUiStateStore.getState();
  const drawerIds = selectThreadTerminalUiState(
    drawer.terminalUiStateByThreadKey,
    threadRef,
  ).terminalIds;
  if (drawerIds.includes(terminalId)) {
    drawer.reconcileTerminalIds(
      threadRef,
      drawerIds.filter((id) => id !== terminalId),
    );
  }
}
