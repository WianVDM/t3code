import type { DesktopUpdateState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { UpstreamReleaseResult } from "../upstreamRelease.logic";

const state = vi.hoisted(() => ({
  update: null as DesktopUpdateState | null,
  release: null as UpstreamReleaseResult | null,
  newThread: vi.fn(),
  startUpstreamMerge: vi.fn(),
}));

vi.mock(import("../../state/desktopUpdate"), () => ({
  useDesktopUpdateState: () => state.update,
}));
vi.mock(import("../../state/upstreamRelease"), () => ({
  useUpstreamRelease: () => state.release,
  // Polling would hit the live atom registry and the network; the pill only needs the result.
  useUpstreamReleasePolling: () => {},
  registerNewThreadRunner: () => () => {},
  startUpstreamMerge: state.startUpstreamMerge,
}));
vi.mock(import("../../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => state.newThread,
}));
// Keep the real shouldDeferUpstreamMerge (the gate under test); pin only the
// build-variant flag so the pill renders as a fork build in this environment.
vi.mock(import("../upstreamRelease.logic"), async (original) => ({
  ...(await original()),
  isForkDesktopBuild: true,
}));

import { SidebarUpstreamReleasePill } from "./SidebarUpstreamReleasePill";

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
}

function pillButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("[data-provider-update-main]");
  expect(found, "upstream release pill button").not.toBeNull();
  return found!;
}

it("shows the unmerged pill but does not start the merge while a fork update is available", async () => {
  setup();
  state.update = forkUpdateAvailable;
  await using screen = await render(<SidebarUpstreamReleasePill />);
  const button = pillButton(screen.container);
  expect(button.textContent).toContain(`Upstream ${TAG} ready, install fork update first`);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await act(async () => button.click());
  expect(state.startUpstreamMerge).not.toHaveBeenCalled();
});

it("starts the merge with the tag and newThread runner when the fork is up to date", async () => {
  setup();
  state.update = forkUpToDate;
  await using screen = await render(<SidebarUpstreamReleasePill />);
  const button = pillButton(screen.container);
  expect(button.textContent).toContain(`Upstream ${TAG} ready to merge`);
  expect(button.getAttribute("aria-disabled")).toBeNull();
  await act(async () => button.click());
  expect(state.startUpstreamMerge).toHaveBeenCalledTimes(1);
  expect(state.startUpstreamMerge).toHaveBeenCalledWith(TAG, { newThread: state.newThread });
});
