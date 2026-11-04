// @effect-diagnostics nodeBuiltinImport:off
import { describe, it, assert } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ContextBridgeSettings,
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ServerProviderSkill,
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
  mergeBridgedSkillsForSnapshot,
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
        // pi does not load ~/.claude/skills by itself, so the claudeAgent
        // global root has to arrive through the bridge.
        assert.deepEqual(bridged.skillRoots, skillRoots.bridged);
      }),
    ),
  );

  it.effect("honors a pi native home redirect and keeps home-anchored skills bridged", () =>
    withPiTargetFixture(({ tempRoot, userHome, skillRoots }) =>
      Effect.gen(function* () {
        const agentDir = NodePath.join(tempRoot, "custom-agent-home");
        // The redirect moves pi's own agent skills root; it must not pull the
        // claudeAgent source root along with it.
        NodeFS.mkdirSync(NodePath.join(agentDir, "skills"), { recursive: true });
        const host = yield* ProviderHost.ProviderHost;

        // An explicit PI_CODING_AGENT_DIR moves pi's native discovery, so
        // ~/.claude/skills must stay bridged at the server home.
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

        // No redirect: pi's native skill discovery never covered
        // ~/.claude/skills, so the bridged root is the same either way.
        const noRedirect = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
          environment: { HOME: userHome },
        });
        assert.deepEqual(noRedirect.skillRoots, skillRoots.bridged);
      }),
    ),
  );

  it.effect("treats a PI_CODING_AGENT_DIR restating the default as unmoved", () =>
    withPiTargetFixture(({ userHome, skillRoots }) =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        // Restating ~/.pi/agent under the server home is not a move, and the
        // claudeAgent global root is bridged whether or not pi's home moves.
        const restated = yield* bridgedContextForTurn({
          host,
          targetDriver: "pi",
          cwd: skillRoots.cwd,
          environment: { PI_CODING_AGENT_DIR: NodePath.join(userHome, ".pi", "agent") },
        });
        assert.deepEqual(restated.skillRoots, skillRoots.bridged);
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

describe("mergeBridgedSkillsForSnapshot", () => {
  const nativeSkills: ReadonlyArray<ServerProviderSkill> = [
    { name: "zeta-native", path: "/native/zeta/SKILL.md", enabled: true },
    { name: "alpha-native", path: "/native/alpha/SKILL.md", enabled: true },
  ];

  const claudeSkillsRoute = (targetDriver: string) => ({
    ...DEFAULT_SERVER_SETTINGS,
    contextBridge: decodeContextBridge({
      enabled: true,
      routes: { [targetDriver]: { skills: "claudeAgent" } },
    }),
  });

  function withBridgeFixture<A, E, R>(
    settings: typeof DEFAULT_SERVER_SETTINGS,
    use: (fixture: { tempRoot: string; userHome: string; cwd: string }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, ProviderHost.ProviderHost>> {
    return Effect.gen(function* () {
      const tempRoot = makeTempRoot();
      try {
        const userHome = NodePath.join(tempRoot, "home");
        const cwd = NodePath.join(tempRoot, "project");
        NodeFS.mkdirSync(cwd, { recursive: true });
        return yield* use({ tempRoot, userHome, cwd }).pipe(
          Effect.provide(layerProviderHost(settings)),
          Effect.provideService(HostProcess.HomeDirectory, userHome),
        );
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }

  function writeSkillFile(root: string, entry: string, contents: string): void {
    const dir = NodePath.join(root, entry);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "SKILL.md"), contents, "utf8");
  }

  function writeSkill(root: string, entry: string, name = entry): void {
    writeSkillFile(
      root,
      entry,
      `---\nname: ${name}\ndescription: ${entry} description\n---\n\nBody.\n`,
    );
  }

  function skillNames(skills: ReadonlyArray<ServerProviderSkill>): string[] {
    return skills.map((skill) => skill.name);
  }

  it.effect.each(["pi", "codex", "opencode"] as const)(
    "bridges claudeAgent skills into %s beside native skills",
    (targetDriver) =>
      withBridgeFixture(claudeSkillsRoute(targetDriver), ({ userHome, cwd }) =>
        Effect.gen(function* () {
          writeSkill(NodePath.join(userHome, ".claude", "skills"), "global-review");
          writeSkill(NodePath.join(cwd, ".claude", "skills"), "project-deploy");
          const host = yield* ProviderHost.ProviderHost;
          const merged = yield* mergeBridgedSkillsForSnapshot({
            host,
            targetDriver,
            cwd,
            nativeSkills,
          });
          assert.deepEqual(skillNames(merged), [
            "alpha-native",
            "global-review",
            "project-deploy",
            "zeta-native",
          ]);
          const globalSkill = merged.find((skill) => skill.name === "global-review");
          const projectSkill = merged.find((skill) => skill.name === "project-deploy");
          assert.strictEqual(globalSkill?.scope, "user");
          assert.strictEqual(projectSkill?.scope, "project");
          assert.isTrue(globalSkill?.path.endsWith(NodePath.join("global-review", "SKILL.md")));
          assert.isTrue(globalSkill?.enabled);
        }),
      ),
  );

  it.effect("uses an explicitly routed source over the default source", () =>
    withBridgeFixture(
      {
        ...DEFAULT_SERVER_SETTINGS,
        contextBridge: decodeContextBridge({
          enabled: true,
          defaultSource: "pi",
          routes: { codex: { skills: "claudeAgent" } },
        }),
      },
      ({ userHome, cwd }) =>
        Effect.gen(function* () {
          writeSkill(NodePath.join(userHome, ".claude", "skills"), "claude-skill");
          writeSkill(NodePath.join(userHome, ".pi", "agent", "skills"), "pi-skill");
          const host = yield* ProviderHost.ProviderHost;
          const merged = yield* mergeBridgedSkillsForSnapshot({
            host,
            targetDriver: "codex",
            cwd,
            nativeSkills,
          });
          assert.deepEqual(skillNames(merged), ["alpha-native", "claude-skill", "zeta-native"]);
        }),
    ),
  );

  it.effect("returns native skills untouched when no route bridges", () =>
    Effect.gen(function* () {
      const cases = [
        DEFAULT_SERVER_SETTINGS,
        {
          ...DEFAULT_SERVER_SETTINGS,
          contextBridge: decodeContextBridge({
            enabled: true,
            routes: { codex: { skills: "native" } },
          }),
        },
        {
          ...DEFAULT_SERVER_SETTINGS,
          contextBridge: decodeContextBridge({
            enabled: true,
            defaultSource: "codex",
            routes: { codex: { skills: "default" } },
          }),
        },
      ];
      for (const settings of cases) {
        const merged = yield* withBridgeFixture(settings, ({ userHome, cwd }) =>
          Effect.gen(function* () {
            writeSkill(NodePath.join(userHome, ".claude", "skills"), "global-review");
            writeSkill(NodePath.join(cwd, ".claude", "skills"), "project-deploy");
            const host = yield* ProviderHost.ProviderHost;
            return yield* mergeBridgedSkillsForSnapshot({
              host,
              targetDriver: "codex",
              cwd,
              nativeSkills,
            });
          }),
        );
        assert.strictEqual(merged, nativeSkills);
      }
    }),
  );

  it.effect("returns native skills when the settings read fails", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const merged = yield* mergeBridgedSkillsForSnapshot({
        host,
        targetDriver: "codex",
        cwd: process.cwd(),
        nativeSkills,
      });
      assert.strictEqual(merged, nativeSkills);
    }).pipe(Effect.provide(layerFailingSettings)),
  );

  it.effect("prefers frontmatter names and keeps global over project over native", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome, cwd }) =>
      Effect.gen(function* () {
        const globalRoot = NodePath.join(userHome, ".claude", "skills");
        const projectRoot = NodePath.join(cwd, ".claude", "skills");
        // The trailing comment belongs to YAML, not to the name, so it still dedupes.
        writeSkill(globalRoot, "shared-global", "shared # global wins");
        writeSkill(globalRoot, "renamed-dir", "renamed-skill");
        writeSkill(projectRoot, "shared", "shared");
        writeSkill(projectRoot, "project-own");
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd,
          nativeSkills: [
            ...nativeSkills,
            { name: "shared", path: "/native/shared/SKILL.md", enabled: true },
          ],
        });
        assert.deepEqual(skillNames(merged), [
          "alpha-native",
          "project-own",
          "renamed-skill",
          "shared",
          "zeta-native",
        ]);
        const shared = merged.filter((skill) => skill.name === "shared");
        assert.strictEqual(shared.length, 1);
        assert.strictEqual(shared[0]?.description, "shared-global description");
        assert.strictEqual(shared[0]?.scope, "user");
        assert.isTrue(
          shared[0]?.path.includes(NodePath.join(".claude", "skills", "shared-global")),
        );
      }),
    ),
  );

  it.effect("falls back to the directory name when frontmatter has no name", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome, cwd }) =>
      Effect.gen(function* () {
        writeSkillFile(
          NodePath.join(userHome, ".claude", "skills"),
          "dir-only",
          "# No frontmatter\n",
        );
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd,
          nativeSkills: [],
        });
        assert.deepEqual(skillNames(merged), ["dir-only"]);
        assert.isUndefined(merged[0]?.description);
      }),
    ),
  );
  it.effect("falls back to the directory name for unusable frontmatter names", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome }) =>
      Effect.gen(function* () {
        const globalRoot = NodePath.join(userHome, ".claude", "skills");
        // OpenCode still invokes these by directory name, so the snapshot must list them.
        writeSkillFile(globalRoot, "unclosed", "---\nname: unclosed\n");
        writeSkillFile(globalRoot, "empty-name", "---\nname:\n---\n");
        writeSkillFile(globalRoot, "empty-quoted", '---\nname: ""\n---\n');
        writeSkill(globalRoot, "kept");
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd: NodePath.join(userHome, "project"),
          nativeSkills: [],
        });
        assert.deepEqual(skillNames(merged), ["empty-name", "empty-quoted", "kept", "unclosed"]);
      }),
    ),
  );

  it.effect("reads quoted names and folded or literal descriptions", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome }) =>
      Effect.gen(function* () {
        const globalRoot = NodePath.join(userHome, ".claude", "skills");
        writeSkillFile(
          globalRoot,
          "quoted",
          "---\nname: \"Quoted Skill\" # comment\ndescription: 'Single quoted description'\n---\n\nBody.\n",
        );
        writeSkillFile(
          globalRoot,
          "folded",
          "---\nname: folded\ndescription: >\n  Folded first line\n  folded second line\n---\n\nBody.\n",
        );
        writeSkillFile(
          globalRoot,
          "literal",
          "---\nname: literal\ndescription: |\n  Literal first line\n  Literal second line\n---\n\nBody.\n",
        );
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd: NodePath.join(userHome, "project"),
          nativeSkills: [],
        });
        assert.deepEqual(
          merged.map((skill) => [skill.name, skill.description]),
          [
            ["folded", "Folded first line folded second line"],
            ["literal", "Literal first line\nLiteral second line"],
            ["Quoted Skill", "Single quoted description"],
          ],
        );
      }),
    ),
  );

  it.effect("skips entries that are not skill directories", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome, cwd }) =>
      Effect.gen(function* () {
        const globalRoot = NodePath.join(userHome, ".claude", "skills");
        const projectRoot = NodePath.join(cwd, ".claude", "skills");
        NodeFS.mkdirSync(NodePath.join(globalRoot, "no-skill-md"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(globalRoot, "loose.md"), "not a skill dir", "utf8");
        writeSkill(globalRoot, "kept");
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd,
          nativeSkills: [],
        });
        assert.deepEqual(skillNames(merged), ["kept"]);
        // A project root that does not exist is not an error either.
        assert.isFalse(NodeFS.existsSync(projectRoot));
      }),
    ),
  );

  it.effect("dedupes names case-insensitively, keeping global over project over native", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome, cwd }) =>
      Effect.gen(function* () {
        const globalRoot = NodePath.join(userHome, ".claude", "skills");
        const projectRoot = NodePath.join(cwd, ".claude", "skills");
        writeSkill(globalRoot, "deploy-global", "Deploy");
        // Case-insensitive filesystems cannot hold both names side by side, so the
        // three spellings collapse to whichever scope came first.
        writeSkill(projectRoot, "deploy-project", "deploy");
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd,
          nativeSkills: [
            ...nativeSkills,
            { name: "DEPLOY", path: "/native/DEPLOY/SKILL.md", enabled: true },
          ],
        });
        assert.deepEqual(skillNames(merged), ["alpha-native", "Deploy", "zeta-native"]);
        const deploy = merged.filter((skill) => skill.name.toLowerCase() === "deploy");
        assert.strictEqual(deploy.length, 1);
        assert.strictEqual(deploy[0]?.scope, "user");
        assert.isTrue(
          deploy[0]?.path.includes(NodePath.join(".claude", "skills", "deploy-global")),
        );
      }),
    ),
  );

  it.effect("keeps native skills that differ only by case", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome, cwd }) =>
      Effect.gen(function* () {
        writeSkill(NodePath.join(userHome, ".claude", "skills"), "global-review");
        // Case-sensitive native roots can hold both spellings; neither is bridged.
        const caseDistinctNative: ReadonlyArray<ServerProviderSkill> = [
          { name: "Foo", path: "/native/Foo/SKILL.md", enabled: true },
          { name: "foo", path: "/native/foo/SKILL.md", enabled: true },
        ];
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd,
          nativeSkills: caseDistinctNative,
        });
        assert.deepEqual(skillNames(merged), ["Foo", "foo", "global-review"]);
        assert.strictEqual(merged[0], caseDistinctNative[0]);
        assert.strictEqual(merged[1], caseDistinctNative[1]);
      }),
    ),
  );

  it.effect("sorts by name and preserves native skill identity", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ userHome, cwd }) =>
      Effect.gen(function* () {
        writeSkill(NodePath.join(userHome, ".claude", "skills"), "middle");
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd,
          nativeSkills,
        });
        assert.deepEqual(skillNames(merged), ["alpha-native", "middle", "zeta-native"]);
        assert.strictEqual(merged[0], nativeSkills[1]);
        assert.strictEqual(merged[2], nativeSkills[0]);
      }),
    ),
  );

  it.effect("keeps the bridged claude root when pi's agent home is redirected", () =>
    withBridgeFixture(claudeSkillsRoute("pi"), ({ tempRoot, userHome, cwd }) =>
      Effect.gen(function* () {
        writeSkill(NodePath.join(userHome, ".claude", "skills"), "global-review");
        const agentDir = NodePath.join(tempRoot, "custom-agent");
        writeSkill(NodePath.join(agentDir, "skills"), "pi-agent-skill");
        const host = yield* ProviderHost.ProviderHost;
        const redirected = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "pi",
          cwd,
          environment: { PI_CODING_AGENT_DIR: agentDir },
          nativeSkills,
        });
        assert.deepEqual(skillNames(redirected), ["alpha-native", "global-review", "zeta-native"]);
        const homeRedirect = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "pi",
          cwd,
          environment: { HOME: NodePath.join(tempRoot, "other-home") },
          nativeSkills,
        });
        assert.deepEqual(skillNames(homeRedirect), [
          "alpha-native",
          "global-review",
          "zeta-native",
        ]);
      }),
    ),
  );

  it.effect("fails soft and returns native skills on a defect", () =>
    withBridgeFixture(claudeSkillsRoute("codex"), ({ cwd }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(cwd, ".claude", "skills"), { recursive: true });
        const host = yield* ProviderHost.ProviderHost;
        const merged = yield* mergeBridgedSkillsForSnapshot({
          host,
          targetDriver: "codex",
          cwd: {} as unknown as string,
          nativeSkills,
        });
        assert.strictEqual(merged, nativeSkills);
      }),
    ),
  );
});
