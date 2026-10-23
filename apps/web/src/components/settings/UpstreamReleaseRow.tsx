import { useUpstreamRelease } from "../../state/upstreamRelease";
import { isForkDesktopBuild } from "../upstreamRelease.logic";
import { SettingsRow } from "./settingsLayout";

function UpstreamReleaseRowContent() {
  const result = useUpstreamRelease();

  if (!result || result.kind === "unknown") {
    return null;
  }

  const description =
    result.kind === "merged" ? `Merged through ${result.tag}` : `${result.tag} is ready to merge`;

  return <SettingsRow title="Upstream" description={description} />;
}

export function UpstreamReleaseRow() {
  if (!isForkDesktopBuild) {
    return null;
  }

  return <UpstreamReleaseRowContent />;
}
