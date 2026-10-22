// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME,
  ANTIGRAVITY_HOOK_SHIM_FILENAME,
  antigravityHookShimSource,
} from "./antigravityHookShimSource.ts";

let tempRoot: string;
let shimPath: string;
let workspaceRoot: string;
let capturePath: string;
let claudeSettingsPath: string;

const CAPTURE_HOOK_SOURCE = `let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(process.argv[2], data);
});
`;

beforeEach(() => {
  tempRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "agy-hook-shim-"),
  );
  shimPath = NodePath.join(tempRoot, ANTIGRAVITY_HOOK_SHIM_FILENAME);
  NodeFS.writeFileSync(shimPath, antigravityHookShimSource, "utf8");
  workspaceRoot = NodePath.join(tempRoot, "workspace");
  NodeFS.mkdirSync(workspaceRoot, { recursive: true });

  // A Claude-shaped PreToolUse command hook that captures its stdin. Real
  // Claude hooks launch scripts with a bare `node`, which the shim rewrites
  // to the executable running it.
  capturePath = NodePath.join(tempRoot, "captured-stdin.json");
  const captureHookPath = NodePath.join(tempRoot, "capture-hook.cjs");
  NodeFS.writeFileSync(captureHookPath, CAPTURE_HOOK_SOURCE, "utf8");
  claudeSettingsPath = NodePath.join(tempRoot, "claude-settings.json");
  NodeFS.writeFileSync(
    claudeSettingsPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `node "${captureHookPath}" "${capturePath}"`,
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );
  NodeFS.writeFileSync(
    NodePath.join(tempRoot, ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME),
    JSON.stringify({
      source: "claudeAgent",
      hookFiles: [claudeSettingsPath],
      hooksDirs: [".claude/hooks", ".claude/tmp.hooks"],
      userHome: tempRoot,
    }),
    "utf8",
  );
});

afterEach(() => {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
});

describe("antigravity hook shim", () => {
  it("translates a run_command PreToolUse payload to Claude's Bash hook shape", () => {
    const payload = {
      conversationId: "conversation-1",
      transcriptPath: "transcript.jsonl",
      workspacePaths: [workspaceRoot],
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "echo bridged",
          Cwd: workspaceRoot,
          toolSummary: "Echo a marker",
        },
      },
    };
    const result = NodeChildProcess.spawnSync(process.execPath, [shimPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    const decision = JSON.parse(result.stdout.trim()) as { decision: string };
    expect(decision.decision).toBe("allow");

    const captured = JSON.parse(NodeFS.readFileSync(capturePath, "utf8")) as {
      session_id: string;
      transcript_path: string;
      cwd: string;
      hook_event_name: string;
      tool_name: string;
      tool_input: { command: string; description: string };
    };
    expect(captured.hook_event_name).toBe("PreToolUse");
    expect(captured.tool_name).toBe("Bash");
    expect(captured.tool_input.command).toBe("echo bridged");
    expect(captured.tool_input.description).toBe("Echo a marker");
    expect(captured.cwd).toBe(workspaceRoot);
    expect(captured.session_id).toBe("conversation-1");
    expect(captured.transcript_path).toBe("transcript.jsonl");
  });

  it("allows everything when the payload is not JSON", () => {
    const result = NodeChildProcess.spawnSync(process.execPath, [shimPath], {
      input: "not json",
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ decision: "allow" });
  });
});
