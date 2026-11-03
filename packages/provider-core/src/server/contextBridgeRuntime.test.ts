// @effect-diagnostics nodeBuiltinImport:off
import { describe, it, assert } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ContextBridgeSettings,
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  bridgedContextForTurn,
  bridgedInstructionsForTurn,
  currentContextBridgeSettings,
} from "./contextBridgeRuntime.ts";
import * as ProviderHost from "./ProviderHost.ts";

const decodeContextBridge = Schema.decodeSync(ContextBridgeSettings);

function layerProviderHost(settings: typeof DEFAULT_SERVER_SETTINGS) {
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: {
        get: Effect.succeed(settings),
        withSnapshot: (use) => use(settings),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(true),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  );
}

const layerFailingSettings = Layer.succeed(
  ProviderHost.ProviderHost,
  ProviderHost.ProviderHost.of({
    paths: {
      cwd: process.cwd(),
      baseDir: "/t3",
      stateDir: "/t3/userdata",
      providerStatusCacheDir: "/t3/caches",
      attachmentsDir: "/t3/userdata/attachments",
    },
    settings: {
      get: Effect.fail(
        new ServerSettingsError({
          settingsPath: "/t3/userdata/settings.json",
          operation: "read-file",
        }),
      ),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(true),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("unused"),
  }),
);

const bridgedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  contextBridge: decodeContextBridge({
    enabled: true,
    routes: { codex: { instructions: "default" } },
  }),
};

describe("bridgedInstructionsForTurn", () => {
  it.effect("includes the bridged block when the route is enabled", () =>
    Effect.gen(function* () {
      const tempRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "context-bridge-runtime-"),
      );
      try {
        const cwd = NodePath.join(tempRoot, "project");
        NodeFS.mkdirSync(cwd, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(cwd, "CLAUDE.md"), "bridged project rules", "utf8");

        const bridged = yield* bridgedInstructionsForTurn({ targetDriver: "codex", cwd });
        assert.include(bridged, "<!-- t3-context-bridge -->");
        assert.include(bridged, 'source="claudeAgent"');
        assert.include(bridged, "bridged project rules");
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(layerProviderHost(bridgedSettings)),
      Effect.provideService(HostProcess.HomeDirectory, NodePath.join("/nonexistent", "home")),
    ),
  );

  it.effect("is unchanged when the bridge is disabled", () =>
    Effect.gen(function* () {
      const bridged = yield* bridgedInstructionsForTurn({
        targetDriver: "codex",
        cwd: process.cwd(),
      });
      assert.strictEqual(bridged, "");
    }).pipe(Effect.provide(layerProviderHost(DEFAULT_SERVER_SETTINGS))),
  );

  it.effect("resolves nothing without a host or with unreadable settings", () =>
    Effect.gen(function* () {
      const withoutHost = yield* bridgedInstructionsForTurn({
        targetDriver: "codex",
        cwd: process.cwd(),
      });
      assert.strictEqual(withoutHost, "");
      assert.isUndefined(yield* currentContextBridgeSettings());

      const withFailingSettings = yield* bridgedInstructionsForTurn({
        targetDriver: "codex",
        cwd: process.cwd(),
      }).pipe(Effect.provide(layerFailingSettings));
      assert.strictEqual(withFailingSettings, "");
    }),
  );
});

describe("bridgedContextForTurn", () => {
  const piTargetSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    contextBridge: decodeContextBridge({
      enabled: true,
      routes: { pi: { instructions: "claudeAgent", skills: "claudeAgent" } },
    }),
  };

  it.effect("resolves the pi-target instruction resolution and skill roots", () => {
    const tempRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "context-bridge-runtime-"),
    );
    const cwd = NodePath.join(tempRoot, "project");
    const userHome = NodePath.join(tempRoot, "home");
    NodeFS.mkdirSync(cwd, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(userHome, ".claude"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(userHome, ".claude", "CLAUDE.md"),
      "global claude rules",
      "utf8",
    );
    return Effect.gen(function* () {
      const bridged = yield* bridgedContextForTurn({ targetDriver: "pi", cwd });
      assert.strictEqual(bridged.instructions?.source, "claudeAgent");
      assert.include(bridged.instructions?.block ?? "", "global claude rules");
      assert.strictEqual(bridged.instructions?.files.length, 1);
      assert.strictEqual(bridged.instructions?.files[0]?.status, "injected");
      // pi loads ~/.claude/skills natively; the bridged route drops it.
      assert.deepEqual(bridged.skillRoots, {
        global: [],
        project: [NodePath.join(cwd, ".claude", "skills")],
      });
    }).pipe(
      Effect.provide(layerProviderHost(piTargetSettings)),
      Effect.provideService(HostProcess.HomeDirectory, userHome),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempRoot, { recursive: true, force: true }))),
    );
  });

  it.effect("yields two nulls when the bridge is disabled or the settings unreadable", () =>
    Effect.gen(function* () {
      const disabled = yield* bridgedContextForTurn({
        targetDriver: "pi",
        cwd: process.cwd(),
      });
      assert.isNull(disabled.instructions);
      assert.isNull(disabled.skillRoots);

      const failing = yield* bridgedContextForTurn({
        targetDriver: "pi",
        cwd: process.cwd(),
      }).pipe(Effect.provide(layerFailingSettings));
      assert.isNull(failing.instructions);
      assert.isNull(failing.skillRoots);
    }).pipe(Effect.provide(layerProviderHost(DEFAULT_SERVER_SETTINGS))),
  );
});
