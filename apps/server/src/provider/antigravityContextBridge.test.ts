// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ContextBridgeSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  needsAntigravityContextBridgeSync,
  syncAntigravityContextBridgeProfile,
  type AntigravityContextBridgeSyncInput,
} from "./antigravityContextBridge.ts";
import {
  ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME,
  ANTIGRAVITY_HOOK_SHIM_DIRECTORY,
  ANTIGRAVITY_HOOK_SHIM_FILENAME,
} from "./antigravityHookShimSource.ts";

const decodeContextBridge = Schema.decodeSync(ContextBridgeSettings);

const BRIDGED_SETTINGS = decodeContextBridge({
  enabled: true,
  routes: { antigravity: { skills: "claudeAgent", hooks: "claudeAgent" } },
});
const NATIVE_SETTINGS = decodeContextBridge({ enabled: false });
// Enabled, but no Antigravity skills or hooks route.
const ENABLED_WITHOUT_ANTIGRAVITY_ROUTE = decodeContextBridge({
  enabled: true,
  defaultSource: "claudeAgent",
});

let tempRoot: string;
let userHome: string;
let geminiHome: string;
let cwd: string;

function writeFixture(relativePath: string, content: string, base = tempRoot): string {
  const filePath = NodePath.join(base, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function skillFixture(root: string, directory: string, name: string): void {
  const skillPath = NodePath.join(root, directory, "SKILL.md");
  NodeFS.mkdirSync(NodePath.dirname(skillPath), { recursive: true });
  NodeFS.writeFileSync(
    skillPath,
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`,
    "utf8",
  );
}

function syncInput(contextBridge: AntigravityContextBridgeSyncInput["contextBridge"]) {
  return {
    geminiHome,
    cwd,
    userHome,
    // The symlink type argument is only honored on Windows (junction, which
    // needs no elevation); POSIX ignores it, so one literal covers both.
    platform: "win32",
    contextBridge,
    nodeExecutable: process.execPath,
  } satisfies AntigravityContextBridgeSyncInput;
}

beforeEach(() => {
  tempRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "agy-context-bridge-"),
  );
  userHome = NodePath.join(tempRoot, "home");
  geminiHome = NodePath.join(tempRoot, "profile");
  cwd = NodePath.join(tempRoot, "project");
  NodeFS.mkdirSync(cwd, { recursive: true });
  NodeFS.mkdirSync(geminiHome, { recursive: true });
});

afterEach(() => {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
});

/** Relative path listing of a directory tree, "/"-suffixed for directories. */
function snapshotTree(root: string): string[] {
  if (!NodeFS.existsSync(root)) return [];
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const full = NodePath.join(dir, entry.name);
      const relative = NodePath.relative(root, full);
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(full);
      } else {
        entries.push(relative);
      }
    }
  };
  walk(root);
  return entries;
}

describe("needsAntigravityContextBridgeSync", () => {
  it("is false with the bridge disabled or unrouted and no marker, so the profile is untouched", () => {
    writeFixture(
      NodePath.join("config", "hooks.json"),
      JSON.stringify({ "user-hooks": { enabled: true } }),
      geminiHome,
    );
    writeFixture(NodePath.join("config", "skills", "user-note.txt"), "mine", geminiHome);
    const configDir = NodePath.join(geminiHome, "config");
    const before = snapshotTree(configDir);

    expect(needsAntigravityContextBridgeSync({ geminiHome, contextBridge: NATIVE_SETTINGS })).toBe(
      false,
    );
    expect(
      needsAntigravityContextBridgeSync({
        geminiHome,
        contextBridge: ENABLED_WITHOUT_ANTIGRAVITY_ROUTE,
      }),
    ).toBe(false);
    // The gate made no writes: nothing under config was created, modified,
    // or removed.
    expect(snapshotTree(configDir)).toEqual(before);
    expect(NodeFS.readFileSync(NodePath.join(configDir, "skills", "user-note.txt"), "utf8")).toBe(
      "mine",
    );
  });

  it("is true when Antigravity has a bridged skills or hooks route", () => {
    expect(needsAntigravityContextBridgeSync({ geminiHome, contextBridge: BRIDGED_SETTINGS })).toBe(
      true,
    );
    expect(
      needsAntigravityContextBridgeSync({
        geminiHome,
        contextBridge: decodeContextBridge({
          enabled: true,
          routes: { antigravity: { skills: "default" } },
        }),
      }),
    ).toBe(true);
    expect(
      needsAntigravityContextBridgeSync({
        geminiHome,
        contextBridge: decodeContextBridge({
          enabled: true,
          routes: { antigravity: { hooks: "claudeAgent" } },
        }),
      }),
    ).toBe(true);
  });

  it("is true when a disabled bridge left its marker, so the sync still removes bridge-owned entries only", () => {
    skillFixture(NodePath.join(userHome, ".claude", "skills"), "skill-a", "skill-a");
    syncAntigravityContextBridgeProfile(syncInput(BRIDGED_SETTINGS));
    // Content the bridge did not write must survive the cleanup.
    writeFixture(NodePath.join("config", "skills", "user-note.txt"), "mine", geminiHome);

    expect(needsAntigravityContextBridgeSync({ geminiHome, contextBridge: NATIVE_SETTINGS })).toBe(
      true,
    );

    const reverted = syncAntigravityContextBridgeProfile(syncInput(NATIVE_SETTINGS));
    // The user's own entry keeps the directory; the revert reports that
    // instead of deleting user content.
    expect(reverted.warnings.some((warning) => warning.includes("non-bridge entries"))).toBe(true);
    const configSkillsDir = NodePath.join(geminiHome, "config", "skills");
    expect(NodeFS.readdirSync(configSkillsDir)).toEqual(["user-note.txt"]);
    expect(NodeFS.existsSync(NodePath.join(geminiHome, "config", "hooks.json"))).toBe(false);
    expect(
      NodeFS.existsSync(NodePath.join(geminiHome, "config", ANTIGRAVITY_HOOK_SHIM_DIRECTORY)),
    ).toBe(false);

    // Cleanup done: the gate closes again.
    expect(needsAntigravityContextBridgeSync({ geminiHome, contextBridge: NATIVE_SETTINGS })).toBe(
      false,
    );
  });
});

describe("syncAntigravityContextBridgeProfile", () => {
  it("syncs bridged skills and hooks into the profile, then reverts bridge-owned files only", () => {
    // Source (claudeAgent) and target (antigravity) skill roots both feed the
    // merge; the source wins name collisions.
    skillFixture(NodePath.join(userHome, ".claude", "skills"), "skill-a", "skill-a");
    skillFixture(
      NodePath.join(userHome, ".gemini", "config", "skills"),
      "native-skill",
      "native-skill",
    );
    skillFixture(NodePath.join(cwd, ".claude", "skills"), "project-skill", "project-skill");

    const bridged = syncAntigravityContextBridgeProfile(syncInput(BRIDGED_SETTINGS));
    expect(bridged.warnings).toEqual([]);

    const configSkillsDir = NodePath.join(geminiHome, "config", "skills");
    const entries = NodeFS.readdirSync(configSkillsDir).sort();
    expect(entries).toContain("skill-a");
    expect(entries).toContain("project-skill");
    expect(entries).toContain("native-skill");
    expect(entries).toContain(".t3-context-bridge.json");
    expect(
      NodeFS.existsSync(NodePath.join(configSkillsDir, "skill-a", "SKILL.md")),
      "skill link resolves into the source directory",
    ).toBe(true);

    const hooksFile = NodePath.join(geminiHome, "config", "hooks.json");
    const hooks = JSON.parse(NodeFS.readFileSync(hooksFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(hooks)).toEqual(["t3-context-bridge"]);
    const shimDirectory = NodePath.join(geminiHome, "config", ANTIGRAVITY_HOOK_SHIM_DIRECTORY);
    const shimPath = NodePath.join(shimDirectory, ANTIGRAVITY_HOOK_SHIM_FILENAME);
    expect(NodeFS.existsSync(shimPath)).toBe(true);
    const shimConfig = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(shimDirectory, ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME),
        "utf8",
      ),
    ) as { source: string; hookFiles: string[] };
    expect(shimConfig.source).toBe("claudeAgent");
    expect(shimConfig.hookFiles).toContain("~/.claude/settings.json");
    const bridgeHooks = hooks["t3-context-bridge"] as {
      PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
    };
    expect(bridgeHooks.PreToolUse[0]?.hooks[0]?.command).toContain(ANTIGRAVITY_HOOK_SHIM_FILENAME);

    // Content the bridge did not write survives the revert.
    writeFixture(NodePath.join("config", "skills", "user-note.txt"), "mine", geminiHome);

    const reverted = syncAntigravityContextBridgeProfile(syncInput(NATIVE_SETTINGS));
    // The user's own entry keeps the directory, so the native link is not
    // restored over it; the revert says so instead of deleting user content.
    expect(reverted.warnings.some((warning) => warning.includes("non-bridge entries"))).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(configSkillsDir, "user-note.txt"), "utf8")).toBe(
      "mine",
    );
    const afterRevert = NodeFS.readdirSync(configSkillsDir);
    expect(afterRevert).toEqual(["user-note.txt"]);
    expect(NodeFS.existsSync(hooksFile)).toBe(false);
    expect(NodeFS.existsSync(shimDirectory)).toBe(false);
  });

  it("restores the native skills link when the profile holds only bridge-owned entries", () => {
    skillFixture(NodePath.join(userHome, ".claude", "skills"), "skill-a", "skill-a");
    NodeFS.mkdirSync(NodePath.join(userHome, ".gemini", "config", "skills"), { recursive: true });

    syncAntigravityContextBridgeProfile(syncInput(BRIDGED_SETTINGS));
    const configSkillsDir = NodePath.join(geminiHome, "config", "skills");
    expect(NodeFS.lstatSync(configSkillsDir).isDirectory()).toBe(true);

    const reverted = syncAntigravityContextBridgeProfile(syncInput(NATIVE_SETTINGS));
    expect(reverted.warnings).toEqual([]);
    const lstat = NodeFS.lstatSync(configSkillsDir);
    expect(lstat.isSymbolicLink(), "native skills link is restored").toBe(true);
    expect(NodeFS.realpathSync(configSkillsDir)).toBe(
      NodeFS.realpathSync(NodePath.join(userHome, ".gemini", "config", "skills")),
    );
  });

  it("never clobbers a hooks.json the bridge did not write", () => {
    const hooksFile = writeFixture(
      NodePath.join("config", "hooks.json"),
      JSON.stringify({ "user-hooks": { enabled: true } }),
      geminiHome,
    );

    const bridged = syncAntigravityContextBridgeProfile(syncInput(BRIDGED_SETTINGS));
    expect(bridged.warnings.some((warning) => warning.includes("not bridge-owned"))).toBe(true);
    expect(JSON.parse(NodeFS.readFileSync(hooksFile, "utf8"))).toEqual({
      "user-hooks": { enabled: true },
    });

    const reverted = syncAntigravityContextBridgeProfile(syncInput(NATIVE_SETTINGS));
    expect(JSON.parse(NodeFS.readFileSync(hooksFile, "utf8"))).toEqual({
      "user-hooks": { enabled: true },
    });
    expect(reverted.warnings).toEqual([]);
  });

  it("keeps a native profile untouched", () => {
    writeFixture(
      NodePath.join("config", "hooks.json"),
      JSON.stringify({ "user-hooks": { enabled: true } }),
      geminiHome,
    );
    const result = syncAntigravityContextBridgeProfile(syncInput(NATIVE_SETTINGS));
    expect(result.warnings).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(geminiHome, "config", "hooks.json"))).toBe(true);
  });
});
