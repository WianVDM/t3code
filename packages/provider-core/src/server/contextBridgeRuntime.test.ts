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

// Ancestor walks reach the filesystem root, so fixtures must sit outside the
// user profile: real files like ~/.claude/CLAUDE.md would leak in as project
// instructions. Windows temp is inside the profile, so use Windows\Temp.
function makeTempRoot(): string {
  const tempBase =
    HostProcess.Platform.defaultValue() === "win32"
      ? NodePath.join(process.env.SystemDrive ?? "C:", "\\", "Windows", "Temp")
      : NodeFS.realpathSync(NodeOS.tmpdir());
  return NodeFS.mkdtempSync(NodePath.join(tempBase, "context-bridge-runtime-"));
}

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
      const tempRoot = makeTempRoot();
      try {
        const cwd = NodePath.join(tempRoot, "project");
        NodeFS.mkdirSync(cwd, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(cwd, "CLAUDE.md"), "bridged project rules", "utf8");

        const host = yield* ProviderHost.ProviderHost;
        const bridged = yield* bridgedInstructionsForTurn({
          host,
          targetDriver: "codex",
          cwd,
        });
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
      const host = yield* ProviderHost.ProviderHost;
      const bridged = yield* bridgedInstructionsForTurn({
        host,
        targetDriver: "codex",
        cwd: process.cwd(),
      });
      assert.strictEqual(bridged, "");
    }).pipe(Effect.provide(layerProviderHost(DEFAULT_SERVER_SETTINGS))),
  );

  it.effect("resolves nothing when the settings read fails", () =>
    Effect.gen(function* () {
      const failingHost = yield* ProviderHost.ProviderHost;
      const withFailingSettings = yield* bridgedInstructionsForTurn({
        host: failingHost,
        targetDriver: "codex",
        cwd: process.cwd(),
      });
      assert.strictEqual(withFailingSettings, "");
      assert.isUndefined(yield* currentContextBridgeSettings(failingHost));
    }).pipe(Effect.provide(layerFailingSettings)),
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

  function withSkillFixture(tempRoot: string, userHome: string) {
    const cwd = NodePath.join(tempRoot, "project");
    NodeFS.mkdirSync(cwd, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(userHome, ".claude", "skills"), { recursive: true });
    return {
      cwd,
      bridged: {
        global: [NodePath.join(userHome, ".claude", "skills")],
        project: [NodePath.join(cwd, ".claude", "skills")],
      },
      unbridged: {
        global: [],
        project: [NodePath.join(cwd, ".claude", "skills")],
      },
    };
  }

  function withPiTargetFixture<A, E, R>(
    use: (fixture: {
      tempRoot: string;
      userHome: string;
      skillRoots: ReturnType<typeof withSkillFixture>;
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, ProviderHost.ProviderHost>> {
    return Effect.gen(function* () {
      const tempRoot = makeTempRoot();
      try {
        const userHome = NodePath.join(tempRoot, "home");
        const skillRoots = withSkillFixture(tempRoot, userHome);
        const result = yield* use({ tempRoot, userHome, skillRoots }).pipe(
          Effect.provide(layerProviderHost(piTargetSettings)),
          Effect.provideService(HostProcess.HomeDirectory, userHome),
        );
        return result;
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }

  it.effect("resolves the pi-target instruction resolution and skill roots", () =>
    withPiTargetFixture(({ userHome, skillRoots }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(userHome, ".claude"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(userHome, ".claude", "CLAUDE.md"),
          "global claude rules",
          "utf8",
        );
        const host = yield* ProviderHost.ProviderHost;
        const bridged = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
        });
        assert.strictEqual(bridged.instructions?.source, "claudeAgent");
        assert.include(bridged.instructions?.block ?? "", "global claude rules");
        assert.strictEqual(bridged.instructions?.files.length, 1);
        assert.strictEqual(bridged.instructions?.files[0]?.status, "injected");
        // pi loads ~/.claude/skills natively, so the bridged route drops it.
        assert.deepEqual(bridged.skillRoots, skillRoots.unbridged);
      }),
    ),
  );

  it.effect("honors a pi native home redirect and keeps home-anchored skills bridged", () =>
    withPiTargetFixture(({ tempRoot, userHome, skillRoots }) =>
      Effect.gen(function* () {
        const agentDir = NodePath.join(tempRoot, "custom-agent-home");
        const host = yield* ProviderHost.ProviderHost;

        // An explicit PI_CODING_AGENT_DIR moves pi's native discovery, so
        // ~/.claude/skills must stay bridged.
        const viaAgentDir = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
          environment: { PI_CODING_AGENT_DIR: agentDir },
        });
        assert.deepEqual(viaAgentDir.skillRoots, skillRoots.bridged);

        // A launch HOME different from the server home redirects the same way.
        const viaHome = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
          environment: { HOME: NodePath.join(tempRoot, "other-home") },
        });
        assert.deepEqual(viaHome.skillRoots, skillRoots.bridged);

        // No redirect: pi's native global skills root is dropped.
        const noRedirect = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
          environment: { HOME: userHome },
        });
        assert.deepEqual(noRedirect.skillRoots, skillRoots.unbridged);
      }),
    ),
  );

  it.effect("treats a PI_CODING_AGENT_DIR restating the default as unmoved", () =>
    withPiTargetFixture(({ userHome, skillRoots }) =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        // Restating ~/.pi/agent under the server home is not a move: pi still
        // loads ~/.claude/skills natively, so the bridged root stays filtered.
        const restated = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
          environment: { PI_CODING_AGENT_DIR: NodePath.join(userHome, ".pi", "agent") },
        });
        assert.deepEqual(restated.skillRoots, skillRoots.unbridged);
      }),
    ),
  );

  it.effect("yields two nulls when the bridge is disabled or the settings unreadable", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const disabled = yield* bridgedContextForTurn({
        host,
        targetDriver: "pi",
        cwd: process.cwd(),
      });
      assert.isNull(disabled.instructions);
      assert.isNull(disabled.skillRoots);
    }).pipe(Effect.provide(layerProviderHost(DEFAULT_SERVER_SETTINGS))),
  );

  it.effect("yields two nulls when the settings read fails", () =>
    Effect.gen(function* () {
      const failingHost = yield* ProviderHost.ProviderHost;
      const failing = yield* bridgedContextForTurn({
        host: failingHost,
        targetDriver: "pi",
        cwd: process.cwd(),
      });
      assert.isNull(failing.instructions);
      assert.isNull(failing.skillRoots);
    }).pipe(Effect.provide(layerFailingSettings)),
  );
});
