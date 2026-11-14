import type { DesktopUpdateState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { UpstreamReleaseResult } from "../upstreamRelease.logic";

const state = vi.hoisted(() => ({
  update: null as DesktopUpdateState | null,
  release: null as UpstreamReleaseResult | null,
  eligible: true,
  newThread: vi.fn(),
  startUpstreamMerge: vi.fn(),
  runManualUpstreamCheck: vi.fn(),
}));

vi.mock(import("../../state/desktopUpdate"), () => ({
  useDesktopUpdateState: () => state.update,
}));
vi.mock(import("../state/upstreamRelease"), () => ({
  useUpstreamRelease: () => state.release,
  useUpstreamMergeEligible: () => state.eligible,
  startUpstreamMerge: state.startUpstreamMerge,
  runManualUpstreamCheck: state.runManualUpstreamCheck,
}));
vi.mock(import("../../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => state.newThread,
}));
// Keep the real shouldDeferUpstreamMerge (the gate under test); pin only the
// build-variant flag so the row renders in this environment.
vi.mock(import("../upstreamRelease.logic"), async (original) => ({
  ...(await original()),
  isUpstreamReleaseNotificationBuild: true,
}));
// The real row reads write permission and overrides from live environment state;
// this suite tests the merge gate.
vi.mock(import("~/components/settings/settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({
    title,
    description,
    status,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status}
      {control}
    </div>
  ),
}));

import { UpstreamReleaseRow } from "./UpstreamReleaseRow";

const TAG = "v2026.2.1";

const forkUpToDate: DesktopUpdateState = {
  enabled: true,
  status: "up-to-date",
  channel: "latest",
  currentVersion: "1.1.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const forkUpdateAvailable: DesktopUpdateState = {
  ...forkUpToDate,
  status: "available",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0",
};

function setup() {
  state.update = null;
  state.release = { kind: "unmerged", tag: TAG };
  state.eligible = true;
  state.newThread.mockReset();
  state.startUpstreamMerge.mockReset().mockResolvedValue(undefined);
  state.runManualUpstreamCheck.mockReset().mockResolvedValue(undefined);
}

function mergeDraftButton(container: HTMLElement): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Create local upstream merge draft",
  );
  expect(found, "Create local upstream merge draft button").toBeDefined();
  return found as HTMLButtonElement;
}

it("hides the merge row without a matching local fork checkout", async () => {
  setup();
  state.eligible = false;
  state.update = forkUpToDate;
  await using screen = await render(<UpstreamReleaseRow />);
  expect(screen.container.textContent).toContain("Upstream base");
  expect(screen.container.textContent).not.toContain("ready to merge");
  expect(screen.container.querySelector("button")).toBeNull();
  expect(state.startUpstreamMerge).not.toHaveBeenCalled();
});

it("keeps the merge draft action disabled while a fork update is available", async () => {
  setup();
  state.update = forkUpdateAvailable;
  await using screen = await render(<UpstreamReleaseRow />);
  expect(screen.container.textContent).toContain(`${TAG} is ready to merge`);
  expect(screen.container.textContent).toContain(
    "Update the fork app first, then create the merge draft.",
  );
  const button = mergeDraftButton(screen.container);
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.startUpstreamMerge).not.toHaveBeenCalled();
});

it("creates the local merge draft with the tag and newThread runner when the fork is up to date", async () => {
  setup();
  state.update = forkUpToDate;
  await using screen = await render(<UpstreamReleaseRow />);
  expect(screen.container.textContent).not.toContain("Update the fork app first");
  expect(screen.container.textContent).toContain(
    "Creates a local merge draft thread in your fork checkout. Nothing is pushed.",
  );
  const button = mergeDraftButton(screen.container);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(state.startUpstreamMerge).toHaveBeenCalledTimes(1);
  expect(state.startUpstreamMerge).toHaveBeenCalledWith(TAG, { newThread: state.newThread });
});
