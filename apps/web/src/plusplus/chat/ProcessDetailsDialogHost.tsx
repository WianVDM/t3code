import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@t3tools/contracts";

import type { ToolCallDiffTarget } from "~/diffPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadVisibleTurnItems } from "~/state/entities";
import {
  closeThreadOverlay,
  makeThreadOverlayAtom,
  useThreadOverlay,
} from "~/components/chat/ChatOverlayHosts";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { V2ItemInspector } from "~/components/chat/V2ItemInspector";

export interface ProcessDetailsRequest {
  readonly title: string;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

const processDetailsDialogAtom =
  makeThreadOverlayAtom<ProcessDetailsRequest>("process-details-dialog");

export function openProcessDetailsDialog(threadKey: string, request: ProcessDetailsRequest): void {
  appAtomRegistry.set(processDetailsDialogAtom, { threadKey, value: request });
}

/**
 * Read-only viewer for a pending background task's turn item. The atom holds the item as of the
 * click; while the dialog is open the host re-resolves the live row by source refs so output
 * keeps streaming, and falls back to the snapshot when the task leaves the projection, so its
 * final output stays readable. Closing only disposes the viewer and its output subscription.
 */
export function ProcessDetailsDialogHost(props: {
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly onOpenToolDiff: (target: ToolCallDiffTarget) => void;
}) {
  const state = useThreadOverlay(processDetailsDialogAtom, props.threadKey);
  const visibleTurnItems = useThreadVisibleTurnItems(state === null ? null : props.threadRef);
  const live =
    state === null
      ? undefined
      : visibleTurnItems.find(
          (row) =>
            row.sourceThreadId === state.projectedItem.sourceThreadId &&
            row.sourceItemId === state.projectedItem.sourceItemId,
        );
  const projectedItem = live ?? state?.projectedItem ?? null;
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(processDetailsDialogAtom);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{state?.title ?? "Process"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {state !== null && projectedItem !== null && props.threadRef !== null ? (
            <V2ItemInspector
              projectedItem={projectedItem}
              environmentId={props.threadRef.environmentId}
              cwd={props.cwd}
              workspaceRoot={props.workspaceRoot}
              onOpenToolDiff={props.onOpenToolDiff}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
