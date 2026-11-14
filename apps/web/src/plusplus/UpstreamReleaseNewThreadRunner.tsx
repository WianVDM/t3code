import { useEffect } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { registerNewThreadRunner } from "~/plusplus/state/upstreamRelease";

/**
 * Mounted from the app sidebar layout, which stays mounted across chat and
 * Settings, so it owns the runner both surfaces' upstream-release toast
 * actions invoke.
 */
export function UpstreamReleaseNewThreadRunner() {
  const handleNewThread = useNewThreadHandler();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the new-thread runner registration while mounted
  useEffect(() => {
    return registerNewThreadRunner(handleNewThread);
  }, [handleNewThread]);
  return null;
}
