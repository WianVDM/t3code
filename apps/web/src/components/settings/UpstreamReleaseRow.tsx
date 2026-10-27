import { useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  runManualUpstreamCheck,
  startUpstreamMerge,
  useUpstreamRelease,
} from "../../state/upstreamRelease";
import { Button } from "../ui/button";
import { isForkDesktopBuild, shouldDeferUpstreamMerge } from "../upstreamRelease.logic";
import { SettingsRow } from "./settingsLayout";

function UpstreamReleaseRowContent() {
  const newThread = useNewThreadHandler();
  const updateState = useDesktopUpdateState();
  const result = useUpstreamRelease();
  const [isChecking, setIsChecking] = useState(false);

  if (!result) {
    return null;
  }

  if (result.kind === "unknown") {
    const handleRetry = () => {
      setIsChecking(true);
      void runManualUpstreamCheck().finally(() => setIsChecking(false));
    };
    return (
      <SettingsRow
        title="Upstream"
        description="Upstream release status is unavailable."
        status="The release check failed. Retry to check again."
        control={
          <Button size="sm" variant="outline" disabled={isChecking} onClick={handleRetry}>
            {isChecking ? "Checking…" : "Check again"}
          </Button>
        }
      />
    );
  }

  if (result.kind === "merged") {
    return <SettingsRow title="Upstream" description={`Merged through ${result.tag}`} />;
  }

  const deferMerge = shouldDeferUpstreamMerge(updateState);
  const handleStartMerge = () => {
    void startUpstreamMerge(result.tag, { newThread });
  };

  return (
    <SettingsRow
      title="Upstream"
      description={`${result.tag} is ready to merge`}
      status={deferMerge ? "Update the fork app first, then start the merge." : undefined}
      control={
        <Button size="sm" variant="outline" disabled={deferMerge} onClick={handleStartMerge}>
          Start merge
        </Button>
      }
    />
  );
}

export function UpstreamReleaseRow() {
  if (!isForkDesktopBuild) {
    return null;
  }

  return <UpstreamReleaseRowContent />;
}
