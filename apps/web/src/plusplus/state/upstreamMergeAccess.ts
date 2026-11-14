import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export const noUpstreamMergeAccessAtom = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("upstream-merge-access:none"),
);

export const upstreamMergeAccess = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plusplus:upstream-merge-access",
  tag: WS_METHODS.plusplusUpstreamMergeAccess,
  staleTimeMs: 10 * 60_000,
});

const checkUpstreamMergeAccess = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:plusplus:check-upstream-merge-access",
  tag: WS_METHODS.plusplusUpstreamMergeAccess,
});

export async function readUpstreamMergeAccess(environmentId: EnvironmentId): Promise<boolean> {
  const result = await runAtomCommand(
    appAtomRegistry,
    checkUpstreamMergeAccess,
    { environmentId, input: {} },
    {
      label: "check upstream merge access",
      reportFailure: false,
      reportDefect: false,
    },
  );
  return result._tag === "Success" && result.value;
}
