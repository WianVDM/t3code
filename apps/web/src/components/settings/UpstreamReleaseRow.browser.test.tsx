import type { DesktopUpdateState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { UpstreamReleaseResult } from "../upstreamRelease.logic";

const state = vi.hoisted(() => ({
  update: null as DesktopUpdateState | null,
  release: null as UpstreamReleaseResult | null,
  newThread: vi.fn(),
  startUpstreamMerge: vi.fn(),
  runManualUpstreamCheck: vi.fn(),
}));

vi.mock(import("../../state/desktopUpdate"), () => ({
  useDesktopUpdateState: () => state.update,
}));
vi.mock(import("../../state/upstreamRelease"), () => ({
  useUpstreamRelease: () => state.release,
  startUpstreamMerge: state.startUpstreamMerge,
  runManualUpstreamCheck: state.runManualUpstreamCheck,
}));
vi.mock(import("../../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => state.newThread,
}));
// Keep the real shouldDeferUpstreamMerge (the gate under test); pin only the
// build-variant flag so the row renders as a fork desktop build.
vi.mock(import("../upstreamRelease.logic"), async (original) => ({
  ...(await original()),
  isForkDesktopBuild: true,
}));
// The real row reads write permission and overrides from live environment state;
// this suite tests the merge gate.
vi.mock(import("./settingsLayout"), async (original) => ({
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
  state.newThread.mockReset();
  state.startUpstreamMerge.mockReset().mockResolvedValue(undefined);
  state.runManualUpstreamCheck.mockReset().mockResolvedValue(undefined);
}

function startMergeButton(container: HTMLElement): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Start merge",
  );
  expect(found, "Start merge button").toBeDefined();
  return found as HTMLButtonElement;
}

it("keeps Start merge disabled while a fork update is available", async () => {
  setup();
  state.update = forkUpdateAvailable;
  await using screen = await render(<UpstreamReleaseRow />);
  expect(screen.container.textContent).toContain(`${TAG} is ready to merge`);
  expect(screen.container.textContent).toContain(
    "Update the fork app first, then start the merge.",
  );
  const button = startMergeButton(screen.container);
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.startUpstreamMerge).not.toHaveBeenCalled();
});

it("starts the merge with the tag and newThread runner when the fork is up to date", async () => {
  setup();
  state.update = forkUpToDate;
  await using screen = await render(<UpstreamReleaseRow />);
  expect(screen.container.textContent).not.toContain("Update the fork app first");
  const button = startMergeButton(screen.container);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(state.startUpstreamMerge).toHaveBeenCalledTimes(1);
  expect(state.startUpstreamMerge).toHaveBeenCalledWith(TAG, { newThread: state.newThread });
});
