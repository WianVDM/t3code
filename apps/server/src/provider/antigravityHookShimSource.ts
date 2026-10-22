/**
 * Source of the Antigravity hook shim, written into the private profile at
 * sync time (`<geminiHome>/config/t3-context-bridge/agy-hook-shim.mjs`).
 *
 * The server ships inside an asar/SEA bundle, so an external process cannot
 * execute a file out of it; the shim travels as a string and lands on disk
 * next to its `shim.config.json`. It is self-contained: the route resolution
 * is precomputed by the sync and carried by the sibling config file.
 *
 * Authored without template literals so this `String.raw` embedding is
 * byte-exact: no backticks and no `${` may appear in the source below.
 *
 * @module provider/antigravityHookShimSource
 */

export const ANTIGRAVITY_HOOK_SHIM_DIRECTORY = "t3-context-bridge";
export const ANTIGRAVITY_HOOK_SHIM_FILENAME = "agy-hook-shim.mjs";
export const ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME = "shim.config.json";

export const antigravityHookShimSource = String.raw`#!/usr/bin/env node
/**
 * agy-hook-shim.mjs — Translates Antigravity ACP external hook payloads
 * (PreToolUse, PostToolUse, Stop) into the bridged source provider's hook
 * format (Claude Code settings.json / settings.local.json) and executes
 * matching command hooks. Self-contained: the route is precomputed into the
 * sibling shim.config.json by T3's profile sync.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHIM_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SHIM_DIR, "shim.config.json");

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function loadShimConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.hookFiles)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function expandPath(rawPath, userHome, projectDir) {
  if (!rawPath || typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (trimmed === "~") return userHome;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(userHome, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(projectDir, trimmed);
}

/**
 * Maps Antigravity toolCall({ name, args }) to Claude Code's { tool_name, tool_input, cwd }.
 */
function mapAntigravityToolToClaude(toolCall, workspaceRoot) {
  const rawName = String((toolCall && toolCall.name) ?? "");
  const args = (toolCall && toolCall.args) ?? {};
  const lower = rawName.toLowerCase();

  if (lower === "run_command" || lower === "bash" || lower === "powershell") {
    return {
      tool_name: "Bash",
      tool_input: {
        command: String(args.CommandLine ?? args.command ?? ""),
        description: String(args.toolSummary ?? args.description ?? "")
      },
      cwd: String(args.Cwd ?? args.cwd ?? workspaceRoot ?? process.cwd())
    };
  }
  if (lower === "client_create_file" || lower === "write" || lower === "write_to_file") {
    return {
      tool_name: "Write",
      tool_input: {
        file_path: String(args.target_file ?? args.file_path ?? args.TargetFile ?? ""),
        content: String(args.code_content ?? args.content ?? args.CodeContent ?? "")
      },
      cwd: workspaceRoot
    };
  }
  if (lower === "client_edit_file" || lower === "edit" || lower === "replace_file_content" || lower === "multi_replace_file_content") {
    return {
      tool_name: "Edit",
      tool_input: {
        file_path: String(args.target_file ?? args.file_path ?? args.TargetFile ?? ""),
        new_string: String(args.code_content ?? args.new_string ?? args.ReplacementContent ?? "")
      },
      cwd: workspaceRoot
    };
  }
  if (lower === "client_view_file" || lower === "view_file" || lower === "read") {
    return {
      tool_name: "Read",
      tool_input: {
        file_path: String(args.absolute_path ?? args.AbsolutePath ?? args.file_path ?? "")
      },
      cwd: workspaceRoot
    };
  }
  return {
    tool_name: rawName,
    tool_input: args,
    cwd: workspaceRoot
  };
}

function matchesTool(matcher, toolName, rawName) {
  if (!matcher || matcher === "*") return true;
  try {
    const re = new RegExp("^(?:" + matcher + ")$", "i");
    return re.test(toolName) || re.test(rawName);
  } catch {
    return false;
  }
}

/**
 * Resolves a command string when a hook script was moved between .claude/hooks and .claude/tmp.hooks.
 */
function resolveHookCommandString(command, projectDir, config) {
  let expanded = command
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, projectDir.replaceAll("\\", "/"))
    .replace(/\bnode\b/, "\"" + process.execPath.replaceAll("\\", "/") + "\"");

  // Check if referenced .mjs/.js/.py/.sh file inside .claude/hooks was moved to .claude/tmp.hooks
  const hooksDirs = (config && config.hooksDirs) ?? [".claude/hooks", ".claude/tmp.hooks"];
  expanded = expanded.replace(/(["'])([^"']*?\.claude\/hooks\/([^"'/\\]+))\1/g, (full, quote, fullRel, fileName) => {
    if (fs.existsSync(fullRel)) return full;
    for (const altDir of hooksDirs) {
      const candidate = path.join(projectDir, altDir, fileName);
      if (fs.existsSync(candidate)) {
        return quote + candidate.replaceAll("\\", "/") + quote;
      }
    }
    return full;
  });
  return expanded;
}

function collectHookGroups(config, projectDir, eventName) {
  const groups = [];
  if (!config) return groups;
  for (const rel of config.hookFiles) {
    const filePath = rel.startsWith("~")
      ? expandPath(rel, config.userHome, projectDir)
      : expandPath(rel, config.userHome, projectDir);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    const hooksObj = parsed && parsed.hooks;
    if (!hooksObj || typeof hooksObj !== "object") continue;
    const eventList = hooksObj[eventName];
    if (Array.isArray(eventList)) {
      groups.push(...eventList);
    }
  }
  return groups;
}

function main() {
  const raw = readStdinSync();
  if (!raw.trim()) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }
  let agyPayload;
  try {
    agyPayload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const config = loadShimConfig();
  if (!config || config.hookFiles.length === 0) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const workspaceRoot = Array.isArray(agyPayload.workspacePaths) && agyPayload.workspacePaths.length > 0
    ? agyPayload.workspacePaths[0]
    : process.cwd();

  const isPreToolUse = Boolean(agyPayload.toolCall);
  const isStop = Boolean(agyPayload.terminationReason);
  const eventName = isPreToolUse ? "PreToolUse" : isStop ? "Stop" : "PostToolUse";

  const groups = collectHookGroups(config, workspaceRoot, eventName);
  if (groups.length === 0) {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const mapped = isPreToolUse
    ? mapAntigravityToolToClaude(agyPayload.toolCall, workspaceRoot)
    : { tool_name: "", tool_input: {}, cwd: workspaceRoot };

  const claudeStdin = JSON.stringify({
    session_id: agyPayload.conversationId ?? "t3-session",
    transcript_path: agyPayload.transcriptPath ?? "",
    cwd: mapped.cwd,
    hook_event_name: eventName,
    tool_name: mapped.tool_name,
    tool_input: mapped.tool_input
  });

  for (const group of groups) {
    if (isPreToolUse && !matchesTool(group.matcher, mapped.tool_name, agyPayload.toolCall && agyPayload.toolCall.name)) {
      continue;
    }
    const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
    for (const handler of handlers) {
      if (!handler || handler.type !== "command" || !handler.command) continue;
      const cmd = resolveHookCommandString(handler.command, workspaceRoot, config);
      const res = spawnSync(cmd, {
        cwd: workspaceRoot,
        input: claudeStdin,
        encoding: "utf8",
        shell: true,
        timeout: (handler.timeout ?? 25) * 1000,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CLAUDE_PROJECT_DIR: workspaceRoot
        }
      });

      if (res.status === 2) {
        const reason = (res.stderr || res.stdout || "Blocked by bridged PreToolUse hook.").trim();
        process.stdout.write(JSON.stringify({
          decision: "deny",
          reason,
          allowTool: false,
          denyReason: reason
        }) + "\n");
        return;
      }

      if (res.stdout && res.stdout.trim()) {
        try {
          const outJson = JSON.parse(res.stdout.trim());
          const hookDecision = outJson.decision ?? (outJson.hookSpecificOutput && outJson.hookSpecificOutput.permissionDecision);
          if (hookDecision === "block" || hookDecision === "deny" || outJson.allowTool === false) {
            const reason = outJson.reason ?? (outJson.hookSpecificOutput && outJson.hookSpecificOutput.permissionDecisionReason) ?? outJson.denyReason ?? "Blocked by bridged hook.";
            process.stdout.write(JSON.stringify({
              decision: "deny",
              reason,
              allowTool: false,
              denyReason: reason
            }) + "\n");
            return;
          }
        } catch {}
      }
    }
  }

  process.stdout.write(JSON.stringify({ decision: "allow", allowTool: true }) + "\n");
}

main();
`;
