import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV,
  T3_PI_RUNTIME_MODE_ENV,
  T3_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  piT3ContextBridgeReportPath,
  removePiT3SessionScopedFiles,
  resolvePiLaunchArgs,
} from "./mcpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");
    assert.equal(launch.env[T3_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-t3-mcp-extension.ts");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [T3_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [T3_MCP_BEARER_ENV]: "stale-token",
        [T3_PI_MCP_EXTENSION_PATH_ENV]: "/stale/extension.ts",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasT3Mcp);
    assert.isUndefined(permissionOnly.env[T3_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[T3_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[T3_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
    assert.equal(
      permissionOnly.env[T3_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-t3-mcp-extension.ts",
    );
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      sessionPath: "/fake/persisted.jsonl",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasT3Mcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });

  it.effect("materializes a session-scoped extension with the bridge payload embedded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const contextBridge = {
        instructions: {
          source: "claudeAgent",
          block: "<!-- t3-context-bridge -->\nBRIDGED_CONTENT_MARKER",
          files: [
            {
              path: "/home/.claude/CLAUDE.md",
              tier: "global" as const,
              status: "injected" as const,
            },
          ],
        },
        skillRoots: ["/home/.codex/skills"],
      };
      const dest = yield* materializePiT3McpExtension(cacheDir, {
        contextBridge,
        sessionId: "session-1",
      });
      assert.isTrue(dest.endsWith("pi-t3-mcp-extension.session-1.ts"));
      const source = yield* fs.readFileString(dest);
      assert.include(source, "BRIDGED_CONTENT_MARKER");
      assert.include(source, "/home/.codex/skills");

      // An unchanged payload is not rewritten; a changed one is.
      const firstStat = yield* fs.stat(dest);
      yield* materializePiT3McpExtension(cacheDir, { contextBridge, sessionId: "session-1" });
      const secondStat = yield* fs.stat(dest);
      assert.deepEqual(secondStat.mtime, firstStat.mtime);
      const updated = {
        ...contextBridge,
        instructions: { ...contextBridge.instructions, block: "UPDATED_BRIDGED_CONTENT" },
      };
      yield* materializePiT3McpExtension(cacheDir, {
        contextBridge: updated,
        sessionId: "session-1",
      });
      assert.include(yield* fs.readFileString(dest), "UPDATED_BRIDGED_CONTENT");

      // Sessions without a route share the static extension file.
      const shared = yield* materializePiT3McpExtension(cacheDir);
      assert.isTrue(shared.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      assert.include(yield* fs.readFileString(shared), "const CONTEXT_BRIDGE = null;");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the session-scoped files and keeps the shared extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const contextBridge = {
        instructions: {
          source: "claudeAgent",
          block: "BRIDGED_CONTENT_MARKER",
          files: [],
        },
        skillRoots: [],
      };
      const sessionDest = yield* materializePiT3McpExtension(cacheDir, {
        contextBridge,
        sessionId: "session-1",
      });
      const sharedDest = yield* materializePiT3McpExtension(cacheDir);
      const reportPath = piT3ContextBridgeReportPath(cacheDir, "session-1");
      yield* fs.makeDirectory(`${cacheDir}/context-bridge`);
      yield* fs.writeFileString(reportPath, "{}");

      yield* removePiT3SessionScopedFiles(cacheDir, "session-1");

      assert.isFalse(yield* fs.exists(sessionDest));
      assert.isFalse(yield* fs.exists(reportPath));
      assert.isTrue(yield* fs.exists(sharedDest));

      // Already-gone files stay a no-op, so teardown never fails on a session
      // whose extension never wrote its report.
      yield* removePiT3SessionScopedFiles(cacheDir, "session-1");
      assert.isTrue(yield* fs.exists(sharedDest));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("passes the context bridge report path only to bridged sessions and strips inherited ones", () => {
    const reportPath = piT3ContextBridgeReportPath("C:\\t3\\cache", "session/1");
    assert.equal(reportPath, "C:/t3/cache/context-bridge/session_1.json");

    const bridged = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV]: "/inherited/report.json" },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.session-1.ts",
      contextBridgeReportPath: reportPath,
    });
    assert.equal(bridged.env[T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV], reportPath);

    const unbridged = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV]: "/inherited/report.json" },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.isUndefined(unbridged.env[T3_PI_CONTEXT_BRIDGE_REPORT_PATH_ENV]);
  });
});
