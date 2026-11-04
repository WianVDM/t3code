import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  probeCodexSkillsForCwd,
} from "./CodexProvider.ts";

const bridgedCodexSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  contextBridge: {
    enabled: true,
    defaultSource: "claudeAgent",
    routes: { codex: { skills: "claudeAgent" } },
  },
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * An in-memory Codex app-server that scripts `initialize` and `skills/list`,
 * recording every method the client sends.
 */
const makeFakeCodexAppServer = () =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const output = yield* Queue.unbounded<Uint8Array>();
    const respond = (message: unknown) =>
      Queue.offer(output, encoder.encode(`${JSON.stringify(message)}\n`));
    let buffered = "";
    const handleLine = (line: string) =>
      Effect.gen(function* () {
        const request = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: { cwds?: string[] };
        };
        if (typeof request.method === "string") methods.push(request.method);
        if (request.id === undefined || request.method === undefined) return;
        if (request.method === "initialize") {
          yield* respond({
            id: request.id,
            result: {
              userAgent: "codex-cli 9.9.9",
              codexHome: "/fake/codex-home",
              platformFamily: "windows",
              platformOs: "windows",
            },
          });
          return;
        }
        if (request.method === "skills/list") {
          yield* respond({
            id: request.id,
            result: {
              data: [
                {
                  cwd: request.params?.cwds?.[0] ?? "",
                  errors: [],
                  skills: [
                    {
                      name: "native-skill",
                      path: "/fake/codex-home/skills/native-skill/SKILL.md",
                      description: "Native Codex skill",
                      enabled: true,
                      scope: "user",
                    },
                  ],
                },
              ],
            },
          });
          return;
        }
        yield* respond({
          id: request.id,
          error: { code: -32601, message: `${request.method} is not scripted` },
        });
      });
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(900_100_001),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array | string) =>
            Effect.gen(function* () {
              buffered +=
                typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
              const lines = buffered.split("\n");
              buffered = lines.pop() ?? "";
              yield* Effect.forEach(
                lines.filter((candidate) => candidate.trim().length > 0),
                handleLine,
              );
            }),
          ),
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return { methods, spawner };
  });

it.effect("merges bridged skills into the workspace probe without syncing extra roots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-probe-" });
    const userHome = path.join(tempRoot, "home");
    const cwd = path.join(tempRoot, "project");
    const writeSkill = (root: string, name: string) =>
      fs
        .makeDirectory(path.join(root, name), { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(
              path.join(root, name, "SKILL.md"),
              `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody.\n`,
            ),
          ),
        );
    yield* writeSkill(path.join(userHome, ".claude", "skills"), "bridged-global");
    yield* writeSkill(path.join(cwd, ".claude", "skills"), "bridged-project");
    const host = yield* ProviderHost.ProviderHost;
    const { methods, spawner } = yield* makeFakeCodexAppServer();
    const skills = yield* probeCodexSkillsForCwd({
      binaryPath: path.join(tempRoot, "codex"),
      cwd,
      host,
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.HomeDirectory, userHome),
    );
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
    expect(skills.map((skill) => skill.name)).toEqual([
      "bridged-global",
      "bridged-project",
      "native-skill",
    ]);
    expect(byName["bridged-global"]?.scope).toBe("user");
    expect(byName["bridged-project"]?.scope).toBe("project");
    expect(methods).toContain("skills/list");
    expect(methods).not.toContain("skills/extraRoots/set");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestProviderHost.layer({ settings: bridgedCodexSettings }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
