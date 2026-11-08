// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { PiSettings } from "../settings.ts";
import { PiDriver } from "./driver.ts";

const layerTest = Layer.mergeAll(
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const personalSkill = {
  name: "skill:personal",
  source: "skill",
  sourceInfo: { scope: "user", path: "/home/.pi/agent/skills/personal/SKILL.md" },
};

const makePiSpawner = Effect.fnUntraced(function* (
  discovery: { readonly state?: unknown; readonly models?: ReadonlyArray<unknown> } = {},
  plainCwds: ReadonlyArray<string> = [],
) {
  const pendingCommand = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (cwd === "/pending" && request.type === "get_commands") {
            return Deferred.succeed(pendingCommand, undefined).pipe(Effect.asVoid);
          }
          const failed = cwd === "/failed" && request.type === "get_commands";
          const data =
            request.type === "get_commands"
              ? {
                  commands: [
                    personalSkill,
                    ...(cwd === "/machine" || plainCwds.includes(cwd ?? "")
                      ? []
                      : [
                          {
                            name: `skill:${cwd?.slice(1)}`,
                            source: "skill",
                            sourceInfo: {
                              scope: "project",
                              path: `${cwd}/.agents/skills/SKILL.md`,
                            },
                          },
                          { name: `prompt-${cwd?.slice(1)}`, source: "prompt" },
                        ]),
                  ],
                }
              : request.type === "get_available_models"
                ? { models: discovery.models ?? [{ provider: "test", id: "model" }] }
                : request.type === "get_state"
                  ? (discovery.state ?? {})
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: !failed, data, ...(failed ? { error: "commands unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version ? Stream.succeed(encoder.encode("pi 1.0.2\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches, pendingCommand };
});

const create = ({
  config = {},
  enabled = true,
  agentDir = "/isolated-pi",
}: {
  config?: Partial<PiSettings>;
  enabled?: boolean;
  agentDir?: string | undefined;
} = {}) =>
  PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-workspace-test"),
    displayName: "My Pi",
    accentColor: "#abcdef",
    environment: [{ name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false }],
    enabled,
    config: { ...PiDriver.defaultConfig(), binaryPath: "custom-pi", ...config },
  });

it.layer(layerTest)("PiDriver workspace discovery", (it) => {
  it.effect("keeps each workspace's skills and commands separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner();
      const instance = yield* create({
        config: { launchArgs: '--approve --skill "extra skill"' },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      yield* instance.snapshot.refresh;
      assert.isDefined(instance.snapshotForCwd);
      const [first, second] = yield* Effect.all(
        [instance.snapshotForCwd!("/first"), instance.snapshotForCwd!("/second")],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        first.skills.map((skill) => skill.name),
        ["personal", "first"],
      );
      assert.deepEqual(
        second.skills.map((skill) => skill.name),
        ["personal", "second"],
      );
      assert.deepEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "prompt-first"],
      );
      const machine = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        machine.skills.map((skill) => skill.name),
        ["personal"],
      );
      assert.deepEqual(
        machine.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
      const workspaceLaunch = launches.find((launch) => launch.options.cwd === "/first");
      assert.isDefined(workspaceLaunch);
      assert.equal(workspaceLaunch!.command, "custom-pi");
      assert.includeMembers(
        [...workspaceLaunch!.args],
        ["--approve", "--skill", "extra skill", "--no-session"],
      );
      assert.equal(workspaceLaunch!.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
      // Discovery processes are stopped as soon as they answer, so neither may start Pi's
      // network refresh at launch.
      for (const cwd of ["/machine", "/first"]) {
        const discovery = launches.find(
          (launch) => launch.options.cwd === cwd && launch.args.includes("--mode"),
        );
        assert.deepEqual(
          discovery?.args.filter((arg) => arg === "--offline"),
          ["--offline"],
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("does not run a disabled provider's workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* create({ enabled: false }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Pi must not spawn")),
        ),
      );
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/first");
      assert.isFalse(workspace.enabled);
      assert.deepEqual(workspace.skills, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "limits discovered thinking defaults to the known active model, known=%s",
    (known) =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner({
          state: {
            thinkingLevel: "high",
            ...(known ? { model: { provider: "test", id: "model" } } : {}),
          },
          models: [
            { provider: "test", id: "model", reasoning: true },
            { provider: "other", id: "model", reasoning: true },
            { provider: "test", id: "other", reasoning: true },
          ],
        });
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.deepEqual(
          snapshot.models.map((model) => [
            model.slug,
            (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
              descriptor.type === "select"
                ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
                : [],
            ),
          ]),
          [
            ["default", []],
            ["test/model", known ? ["high"] : []],
            ["other/model", []],
            ["test/other", []],
          ],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("does not additively report the kimi-coding credential Pi reports natively", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-kimi-" });
      yield* fileSystem.writeFileString(
        path.join(agentDir, "auth.json"),
        JSON.stringify({
          "kimi-coding": { type: "api_key", key: "kimi-key" },
          openrouter: { type: "api_key", key: "openrouter-key" },
        }),
      );
      const httpClient = HttpClient.make((request) => {
        if (request.url === "https://api.kimi.com/coding/v1/usages") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usages: { limit_5h: { used_ratio: 0.25 }, limit_7d: { used_ratio: 0.5 } },
              }),
            ),
          );
        }
        if (request.url === "https://openrouter.ai/api/v1/key") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { usage: 1, limit: 10, limit_remaining: 9 } }),
            ),
          );
        }
        return Effect.die(`Unexpected HTTP ${request.url}`);
      });
      const { spawner } = yield* makePiSpawner();
      const instance = yield* create({ agentDir }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        snapshot.usageLimits?.windows.map((window) => window.id),
        ["kimi-5h", "kimi-7d"],
      );
      assert.deepEqual(
        snapshot.usageAccounts?.map((account) => account.id),
        ["openrouter"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails command discovery instead of returning an empty successful workspace catalog",
    () =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner();
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        assert.isDefined(instance.snapshotForCwd);
        const error = yield* Effect.flip(instance.snapshotForCwd!("/failed"));
        assert.equal(error._tag, "ProviderDriverError");
        assert.equal(error.instanceId, instance.instanceId);
        assert.deepEqual(
          (yield* instance.snapshot.getSnapshot).skills.map((skill) => skill.name),
          ["personal"],
        );
      }).pipe(Effect.scoped),
  );
});

const writeBridgedSkill = (root: string, entry: string, name = entry): string => {
  const dir = NodePath.join(root, entry);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${entry} description\n---\n\nBody.\n`,
    "utf8",
  );
  return NodePath.join(dir, "SKILL.md");
};

const listTree = (root: string): string[] => {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const full = NodePath.join(dir, entry.name);
      entries.push(NodePath.relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  if (NodeFS.existsSync(root)) walk(root);
  return entries.sort();
};

const bridgeSettings = (contextBridge: ServerSettings["contextBridge"]): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  enableProviderUpdateChecks: false,
  contextBridge,
});

const claudeRoute = {
  enabled: true,
  defaultSource: "claudeAgent",
  routes: { pi: { skills: "claudeAgent" } },
} satisfies ServerSettings["contextBridge"];

it.layer(layerTest)("PiDriver bridged skills", (it) => {
  const makeFixture = Effect.fnUntraced(function* (agentDir?: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const settingsControl = yield* TestProviderHost.TestProviderHostSettings;
    const userHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-bridge-home-" });
    const workspaceCwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-bridge-ws-" });
    const { spawner, launches } = yield* makePiSpawner({}, [workspaceCwd]);
    const instance = yield* create({ agentDir }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { settingsControl, userHome, workspaceCwd, launches, instance };
  });

  it.effect("bridges default-source skills beside native discovery", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.settingsControl.set(
        bridgeSettings({ ...claudeRoute, routes: { pi: { skills: "default" } } }),
      );
      writeBridgedSkill(NodePath.join(fixture.userHome, ".claude", "skills"), "global-review");
      writeBridgedSkill(NodePath.join(fixture.workspaceCwd, ".claude", "skills"), "project-deploy");
      yield* fixture.instance.snapshot.refresh;
      assert.isDefined(fixture.instance.snapshotForCwd);
      const workspace = yield* fixture.instance.snapshotForCwd!(fixture.workspaceCwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.userHome),
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        ["global-review", "personal", "project-deploy"],
      );
      assert.deepEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact"],
      );
      const globalSkill = workspace.skills.find((skill) => skill.name === "global-review");
      const projectSkill = workspace.skills.find((skill) => skill.name === "project-deploy");
      assert.equal(globalSkill?.scope, "user");
      assert.equal(projectSkill?.scope, "project");
      assert.isTrue(globalSkill?.path.endsWith(NodePath.join("global-review", "SKILL.md")));
    }).pipe(Effect.scoped),
  );

  it.effect("uses the explicitly routed source over the default source", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.settingsControl.set(
        bridgeSettings({ enabled: true, defaultSource: "pi", routes: claudeRoute.routes }),
      );
      writeBridgedSkill(NodePath.join(fixture.userHome, ".claude", "skills"), "claude-skill");
      writeBridgedSkill(NodePath.join(fixture.userHome, ".pi", "agent", "skills"), "pi-skill");
      yield* fixture.instance.snapshot.refresh;
      assert.isDefined(fixture.instance.snapshotForCwd);
      const workspace = yield* fixture.instance.snapshotForCwd!(fixture.workspaceCwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.userHome),
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        ["claude-skill", "personal"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the native catalog untouched on a native route", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.settingsControl.set(
        bridgeSettings({ ...claudeRoute, routes: { pi: { skills: "native" } } }),
      );
      writeBridgedSkill(NodePath.join(fixture.userHome, ".claude", "skills"), "global-review");
      yield* fixture.instance.snapshot.refresh;
      assert.isDefined(fixture.instance.snapshotForCwd);
      const workspace = yield* fixture.instance.snapshotForCwd!(fixture.workspaceCwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.userHome),
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        ["personal"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("gives a bridged skill precedence over a same-named native skill", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.settingsControl.set(bridgeSettings(claudeRoute));
      writeBridgedSkill(
        NodePath.join(fixture.userHome, ".claude", "skills"),
        "personal-bridge",
        "personal",
      );
      yield* fixture.instance.snapshot.refresh;
      assert.isDefined(fixture.instance.snapshotForCwd);
      const workspace = yield* fixture.instance.snapshotForCwd!(fixture.workspaceCwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.userHome),
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        ["personal"],
      );
      const personal = workspace.skills[0];
      assert.equal(personal?.scope, "user");
      assert.isTrue(personal?.path.includes(NodePath.join(".claude", "skills", "personal-bridge")));
    }).pipe(Effect.scoped),
  );

  it.effect("bridges with a custom PI_CODING_AGENT_DIR without extending or materializing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-bridge-agent-" });
      const fixture = yield* makeFixture(agentDir);
      yield* fixture.settingsControl.set(bridgeSettings(claudeRoute));
      writeBridgedSkill(NodePath.join(fixture.userHome, ".claude", "skills"), "global-review");
      writeBridgedSkill(NodePath.join(agentDir, "skills"), "agent-skill");
      const before = {
        home: listTree(fixture.userHome),
        agent: listTree(agentDir),
        workspace: listTree(fixture.workspaceCwd),
      };
      yield* fixture.instance.snapshot.refresh;
      assert.isDefined(fixture.instance.snapshotForCwd);
      const workspace = yield* fixture.instance.snapshotForCwd!(fixture.workspaceCwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.userHome),
      );
      assert.deepEqual(
        workspace.skills.map((skill) => skill.name),
        ["global-review", "personal"],
      );
      const launch = fixture.launches.find(
        (candidate) => candidate.options.cwd === fixture.workspaceCwd,
      );
      assert.isDefined(launch);
      assert.equal(launch!.options.env?.PI_CODING_AGENT_DIR, agentDir);
      assert.deepEqual(listTree(fixture.userHome), before.home);
      assert.deepEqual(listTree(agentDir), before.agent);
      assert.deepEqual(listTree(fixture.workspaceCwd), before.workspace);
      assert.deepEqual(
        fixture.launches.filter((candidate) => candidate.options.cwd === fixture.workspaceCwd)
          .length,
        1,
      );
    }).pipe(Effect.scoped),
  );
});
