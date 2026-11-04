import { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.34" }));
vi.mock("./branding", () => branding);

import { APP_VERSION } from "./branding";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  manualServerUpdateCommand,
  resolveVersionMismatch,
} from "./versionSkew";

const MISMATCH_HINT =
  "Version mismatch. Try syncing the client and server to the same T3 Code version.";

describe("versionSkew", () => {
  it("returns the GitHub update command only when no registry descriptor is present", () => {
    expect(manualServerUpdateCommand("0.0.45")).toBe("t3 update 0.0.45");
  });

  it.each([
    { kind: "npm-global", prefix: "/opt/node" },
    { kind: "npx" },
    { kind: "pnpm-dlx" },
    { kind: "bunx" },
  ] as const)(
    "returns no command for the $kind installation",
    (installation) => {
      expect(manualServerUpdateCommand("0.0.45", installation)).toBeNull();
    },
  );
  beforeEach(() => {
    branding.APP_VERSION = "0.0.34";
  });

  it("dismisses only the current failed attempt without clearing its retry state", () => {
    const failure = {
      status: "failed",
      stage: "downloading",
      fromVersion: "0.0.33",
      targetVersion: "0.0.34",
      message: "Download failed.",
    } as const satisfies ServerUpdateState;
    const retryFailure = { ...failure };
    const otherEnvironmentFailure = { ...failure };

    dismissServerUpdateFailure(failure);

    expect(isServerUpdateFailureDismissed(failure)).toBe(true);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe("Download failed.");
    expect(isServerUpdateFailureDismissed(retryFailure)).toBe(false);
    expect(isServerUpdateFailureDismissed(otherEnvironmentFailure)).toBe(false);
  });

  it("returns a mismatch when the server is behind the client", () => {
    expect(resolveVersionMismatch("0.0.33")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "0.0.33",
      hint: MISMATCH_HINT,
    });
  });

  it("does not warn when the server is ahead of the client", () => {
    expect(resolveVersionMismatch("0.0.35")).toBeNull();
    expect(resolveVersionMismatch("9.9.9")).toBeNull();
  });

  it("does not warn when a nightly and a stable build share a core version", () => {
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toBeNull();

    branding.APP_VERSION = "0.0.34-nightly.20260818.1124";
    expect(resolveVersionMismatch("0.0.34")).toBeNull();
  });

  it.each(["0.0.34-nightly.20260823.1124", "0.0.34-nightly.20260824.1124"])(
    "warns when nightly server %s is behind a nightly client on the same release",
    (serverVersion) => {
      branding.APP_VERSION = "0.0.34-nightly.20260824.1125";

      expect(resolveVersionMismatch(serverVersion)).toEqual({
        clientVersion: "0.0.34-nightly.20260824.1125",
        serverVersion,
        hint: MISMATCH_HINT,
      });
    },
  );

  it("warns when a plusplus server revision is behind a plusplus client on the same base", () => {
    branding.APP_VERSION = "0.0.34-plusplus.2";

    expect(resolveVersionMismatch("0.0.34-plusplus.1")).toEqual({
      clientVersion: "0.0.34-plusplus.2",
      serverVersion: "0.0.34-plusplus.1",
      hint: MISMATCH_HINT,
    });
  });

  it.each([
    ["0.0.34-plusplus.2", "0.0.34-plusplus.2"],
    ["0.0.34-plusplus.2", "0.0.34-plusplus.3"],
  ])(
    "does not warn when a plusplus server revision matches or outruns plusplus client %s",
    (clientVersion, serverVersion) => {
      branding.APP_VERSION = clientVersion;

      expect(resolveVersionMismatch(serverVersion)).toBeNull();
    },
  );

  it("resets skew when the plusplus upstream base moves, regardless of revision", () => {
    branding.APP_VERSION = "0.0.35-plusplus.1";

    expect(resolveVersionMismatch("0.0.34-plusplus.1")).toEqual({
      clientVersion: "0.0.35-plusplus.1",
      serverVersion: "0.0.34-plusplus.1",
      hint: MISMATCH_HINT,
    });
    expect(resolveVersionMismatch("0.0.34-plusplus.99")).toMatchObject({
      serverVersion: "0.0.34-plusplus.99",
    });

    branding.APP_VERSION = "0.0.34-plusplus.99";
    expect(resolveVersionMismatch("0.0.35-plusplus.1")).toBeNull();
  });

  it("compares cores only across nightly and plusplus channels", () => {
    branding.APP_VERSION = "0.0.34-plusplus.5";
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toBeNull();

    branding.APP_VERSION = "0.0.34-nightly.20260818.1124";
    expect(resolveVersionMismatch("0.0.34-plusplus.5")).toBeNull();

    branding.APP_VERSION = "0.0.35-plusplus.1";
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toMatchObject({
      serverVersion: "0.0.34-nightly.20260818.1124",
    });
  });

  // regression: #7579 versions were compared as strings, not semver
  it("treats a nightly server built past the client as ahead, not skew", () => {
    expect(resolveVersionMismatch("0.0.35-nightly.20260818.1124")).toBeNull();
  });

  it("still warns when a nightly client outruns the server by a release", () => {
    branding.APP_VERSION = "0.0.35-nightly.20260818.1124";

    expect(resolveVersionMismatch("0.0.34")).toEqual({
      clientVersion: "0.0.35-nightly.20260818.1124",
      serverVersion: "0.0.34",
      hint: MISMATCH_HINT,
    });
  });

  it("falls back to string inequality when a version is not semver", () => {
    expect(resolveVersionMismatch("dev")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "dev",
      hint: MISMATCH_HINT,
    });

    branding.APP_VERSION = "dev";
    expect(resolveVersionMismatch("dev")).toBeNull();
    expect(resolveVersionMismatch("0.0.34")).toMatchObject({ serverVersion: "0.0.34" });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });
});
