// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ContextBridgeSettings } from "@t3tools/contracts";
import {
  CONTEXT_BRIDGE_CATALOG,
  resolveBridgedSkillRoots,
  resolveContextBridgeSource,
} from "@t3tools/provider-core/server/contextBridge";

import {
  ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME,
  ANTIGRAVITY_HOOK_SHIM_DIRECTORY,
  ANTIGRAVITY_HOOK_SHIM_FILENAME,
  antigravityHookShimSource,
} from "./antigravityHookShimSource.ts";

/**
 * Antigravity context bridge profile sync. Runs before each ACP runtime
 * spawns and reconciles the private profile
 * (`GEMINI_HOME`) with the current routes: bridged skills are copied into
 * `config/skills`, a bridged hooks route installs the hook shim and
 * `hooks.json`, and a native route restores exactly what T3 would have
 * created without the bridge.
 *
 * Only files the bridge wrote are ever removed. Skill copies it created are
 * recorded in a marker file inside `config/skills`; a `hooks.json` is
 * bridge-owned only when its sole top-level key is `t3-context-bridge`.
 * Anything else at those paths is the user's own content and is left alone.
 *
 * Everything is best effort and synchronous (the prototype's shape): the
 * caller logs the returned warnings and continues; a sync failure must never
 * cost the session.
 *
 * @module provider/antigravityContextBridge
 */

export interface AntigravityContextBridgeSyncInput {
  /** The private profile directory (`GEMINI_HOME`). */
  readonly geminiHome: string;
  /** The session workspace, for project-level skills and hook files. */
  readonly cwd: string | undefined;
  /** Home the agent expands `~` against. */
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  readonly contextBridge: ContextBridgeSettings;
  /** Node binary the hooks.json command launches the shim with. */
  readonly nodeExecutable: string;
}

export interface AntigravityContextBridgeSyncResult {
  readonly warnings: string[];
}

/**
 * Hook settings files per bridge source. Only sources with command hooks are
 * worth shim-translating; the prototype's catalog lists hook files for
 * `claudeAgent` alone.
 */
const CONTEXT_BRIDGE_HOOK_SOURCES: Readonly<
  Record<string, { readonly hookFiles: readonly string[]; readonly hooksDirs: readonly string[] }>
> = {
  claudeAgent: {
    hookFiles: ["~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"],
    hooksDirs: [".claude/hooks", ".claude/tmp.hooks"],
  },
};

/** Marker inside `config/skills` recording which entries the bridge wrote. */
const BRIDGE_SKILLS_MARKER = ".t3-context-bridge.json";

const BRIDGE_HOOKS_KEY = "t3-context-bridge";

function expandPath(rawPath: string, cwd: string | undefined, userHome: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return userHome;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.join(userHome, trimmed.slice(2));
  }
  if (NodePath.isAbsolute(trimmed)) return NodePath.normalize(trimmed);
  return cwd ? NodePath.resolve(cwd, trimmed) : null;
}

function removeLinkOrDir(targetPath: string): void {
  try {
    const lstat = NodeFS.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) {
      NodeFS.unlinkSync(targetPath);
    } else if (lstat.isDirectory()) {
      NodeFS.rmSync(targetPath, { recursive: true, force: true });
    } else {
      NodeFS.unlinkSync(targetPath);
    }
  } catch {}
}

interface BridgedSkill {
  readonly name: string;
  readonly dir: string;
}

function parseSkillFrontmatterName(contents: string, fallbackName: string): string {
  const normalized = contents.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return fallbackName;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return fallbackName;
  for (const rawLine of normalized.slice(3, end).split(/\r?\n/)) {
    const match = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match && match[1] === "name") {
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return fallbackName;
}

/**
 * The prototype's `resolveSkills` merge: the source provider's roots first
 * (global, then project), then the target's own roots, one entry per
 * SKILL.md, first hit for a name wins. Target roots stay in the merge so
 * native Antigravity skills survive bridging unless the source shadows them.
 */
function resolveMergedSkills(input: {
  readonly settings: ContextBridgeSettings;
  readonly cwd: string | undefined;
  readonly userHome: string;
}): BridgedSkill[] {
  const sourceRoots = resolveBridgedSkillRoots({
    settings: input.settings,
    targetDriver: "antigravity",
    cwd: input.cwd,
    userHome: input.userHome,
  });
  if (sourceRoots === null) return [];
  const targetSpec = CONTEXT_BRIDGE_CATALOG["antigravity"];
  if (!targetSpec) return [];
  const targetGlobal = targetSpec.globalSkills.flatMap((rel) => {
    const expanded = expandPath(rel, input.cwd, input.userHome);
    return expanded ? [expanded] : [];
  });
  const targetProject = input.cwd
    ? targetSpec.projectSkills.flatMap((rel) => {
        const expanded = expandPath(rel, input.cwd, input.userHome);
        return expanded ? [expanded] : [];
      })
    : [];
  const roots = [...sourceRoots.global, ...sourceRoots.project, ...targetGlobal, ...targetProject];

  const skillsByName = new Map<string, BridgedSkill>();
  for (const root of roots) {
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const skillDir = NodePath.join(root, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = NodeFS.statSync(skillDir).isDirectory();
        } catch {}
      }
      if (!isDirectory) continue;
      let contents: string;
      try {
        contents = NodeFS.readFileSync(NodePath.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const name = parseSkillFrontmatterName(contents, entry.name);
      if (!name || skillsByName.has(name)) continue;
      skillsByName.set(name, { name, dir: skillDir });
    }
  }
  return [...skillsByName.values()];
}

function readOwnedSkillNames(configSkillsDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return [];
    const owned = Reflect.get(parsed, "owned");
    return Array.isArray(owned)
      ? owned.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

function isBridgeOwnedHooksFile(hooksFile: string): boolean {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(hooksFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const keys = Object.keys(parsed);
    return keys.length === 1 && keys[0] === BRIDGE_HOOKS_KEY;
  } catch {
    return false;
  }
}

function syncBridgedSkills(
  configSkillsDir: string,
  skills: readonly BridgedSkill[],
  warnings: string[],
): void {
  try {
    if (NodeFS.lstatSync(configSkillsDir).isSymbolicLink()) {
      NodeFS.unlinkSync(configSkillsDir);
    }
  } catch {}
  NodeFS.mkdirSync(configSkillsDir, { recursive: true });

  const wantedNames = new Set(skills.map((skill) => skill.name));
  for (const previouslyOwned of readOwnedSkillNames(configSkillsDir)) {
    if (!wantedNames.has(previouslyOwned)) {
      removeLinkOrDir(NodePath.join(configSkillsDir, previouslyOwned));
    }
  }

  const owned: string[] = [];
  for (const skill of skills) {
    const destination = NodePath.join(configSkillsDir, skill.name);
    try {
      NodeFS.lstatSync(destination);
      // A bridge-owned entry is replaced; anything else is the user's own
      // content and stays, shadowing the copy for this sync.
      if (readOwnedSkillNames(configSkillsDir).includes(skill.name)) {
        removeLinkOrDir(destination);
      } else {
        warnings.push(
          `context-bridge: '${destination}' is not bridge-owned; skipped skill '${skill.name}'.`,
        );
        continue;
      }
    } catch {}
    // Always a real copied directory, never a symlink: Antigravity's
    // lstat-based loader does not follow plain symlinks, and junction
    // fallbacks made behavior platform-dependent.
    try {
      NodeFS.cpSync(skill.dir, destination, { recursive: true, dereference: true });
    } catch (error) {
      warnings.push(`context-bridge: could not copy skill '${skill.name}': ${String(error)}`);
      continue;
    }
    owned.push(skill.name);
  }
  NodeFS.writeFileSync(
    NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER),
    JSON.stringify({ owned }, null, 2) + "\n",
    "utf8",
  );
}

function revertBridgedSkills(
  configSkillsDir: string,
  nativeTarget: string,
  platform: NodeJS.Platform,
  warnings: string[],
): void {
  let isRealDirectory = false;
  try {
    const lstat = NodeFS.lstatSync(configSkillsDir);
    isRealDirectory = lstat.isDirectory() && !lstat.isSymbolicLink();
  } catch {
    return;
  }
  if (!isRealDirectory) return;
  // Without a marker nothing here is bridge-written, but an empty owned list
  // still needs cleanup so a fully removed sync restores the native link.
  if (!NodeFS.existsSync(NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER))) return;
  const owned = readOwnedSkillNames(configSkillsDir);
  for (const name of owned) {
    removeLinkOrDir(NodePath.join(configSkillsDir, name));
  }
  removeLinkOrDir(NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER));
  try {
    if (NodeFS.readdirSync(configSkillsDir).length > 0) {
      warnings.push(
        `context-bridge: '${configSkillsDir}' keeps non-bridge entries; the native skills link was not restored.`,
      );
      return;
    }
    NodeFS.rmdirSync(configSkillsDir);
  } catch (error) {
    warnings.push(`context-bridge: could not clear '${configSkillsDir}': ${String(error)}`);
    return;
  }
  try {
    if (NodeFS.existsSync(nativeTarget)) {
      NodeFS.symlinkSync(nativeTarget, configSkillsDir, platform === "win32" ? "junction" : "dir");
    }
  } catch (error) {
    warnings.push(`context-bridge: could not restore the native skills link: ${String(error)}`);
  }
}

function writeBridgedHooks(input: {
  readonly configDir: string;
  readonly shimDirectory: string;
  readonly source: string;
  readonly userHome: string;
  readonly nodeExecutable: string;
  readonly platform: NodeJS.Platform;
  readonly warnings: string[];
}): void {
  const hookSource = CONTEXT_BRIDGE_HOOK_SOURCES[input.source];
  NodeFS.mkdirSync(input.shimDirectory, { recursive: true });
  const shimPath = NodePath.join(input.shimDirectory, ANTIGRAVITY_HOOK_SHIM_FILENAME);
  NodeFS.writeFileSync(shimPath, antigravityHookShimSource, "utf8");
  NodeFS.writeFileSync(
    NodePath.join(input.shimDirectory, ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME),
    JSON.stringify(
      {
        source: input.source,
        hookFiles: hookSource?.hookFiles ?? [],
        hooksDirs: hookSource?.hooksDirs ?? [".claude/hooks", ".claude/tmp.hooks"],
        userHome: input.userHome,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const hooksFile = NodePath.join(input.configDir, "hooks.json");
  if (NodeFS.existsSync(hooksFile) && !isBridgeOwnedHooksFile(hooksFile)) {
    input.warnings.push(
      `context-bridge: '${hooksFile}' is not bridge-owned; bridged hooks were not installed.`,
    );
    return;
  }
  const nodeExecutable =
    input.platform === "win32" ? input.nodeExecutable.replaceAll("\\", "/") : input.nodeExecutable;
  const command = `"${nodeExecutable}" "${shimPath.replaceAll("\\", "/")}"`;
  const hookEntry = { type: "command", command, timeout: 30 };
  const hooksConfig = {
    [BRIDGE_HOOKS_KEY]: {
      enabled: true,
      PreToolUse: [{ matcher: "*", hooks: [hookEntry] }],
      PostToolUse: [{ matcher: "*", hooks: [hookEntry] }],
      Stop: [hookEntry],
    },
  };
  NodeFS.writeFileSync(hooksFile, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
}

function revertBridgedHooks(configDir: string, shimDirectory: string, warnings: string[]): void {
  const hooksFile = NodePath.join(configDir, "hooks.json");
  try {
    if (NodeFS.existsSync(hooksFile) && isBridgeOwnedHooksFile(hooksFile)) {
      NodeFS.unlinkSync(hooksFile);
    }
  } catch (error) {
    warnings.push(`context-bridge: could not remove '${hooksFile}': ${String(error)}`);
  }
  try {
    if (NodeFS.existsSync(shimDirectory)) {
      NodeFS.rmSync(shimDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    warnings.push(`context-bridge: could not remove '${shimDirectory}': ${String(error)}`);
  }
}

export interface AntigravityContextBridgeSyncGateInput {
  /** The private profile directory (`GEMINI_HOME`). */
  readonly geminiHome: string;
  readonly contextBridge: ContextBridgeSettings;
}

/**
 * Whether the profile needs a sync pass at all. A bridged skills or hooks
 * route always syncs. Otherwise the gate stays closed and the profile keeps
 * exactly what stock T3 Code left, unless a previous bridge run left one of
 * its ownership records (the skills marker, a bridge-owned `hooks.json`, or
 * the hook shim directory), in which case the sync still runs so turning the
 * bridge off cleans up what it wrote.
 */
export function needsAntigravityContextBridgeSync(
  input: AntigravityContextBridgeSyncGateInput,
): boolean {
  if (
    resolveContextBridgeSource(input.contextBridge, "antigravity", "skills") !== null ||
    resolveContextBridgeSource(input.contextBridge, "antigravity", "hooks") !== null
  ) {
    return true;
  }
  try {
    const configDir = NodePath.join(NodePath.resolve(input.geminiHome), "config");
    if (NodeFS.existsSync(NodePath.join(configDir, "skills", BRIDGE_SKILLS_MARKER))) return true;
    if (isBridgeOwnedHooksFile(NodePath.join(configDir, "hooks.json"))) return true;
    return NodeFS.existsSync(NodePath.join(configDir, ANTIGRAVITY_HOOK_SHIM_DIRECTORY));
  } catch {
    // An unreadable profile must not turn a disabled bridge into a writer.
    return false;
  }
}

/**
 * Reconciles the private Antigravity profile with the current context bridge
 * routes. Never throws: every failure lands in `warnings` and the profile is
 * left as usable as the failure allowed.
 */
export function syncAntigravityContextBridgeProfile(
  input: AntigravityContextBridgeSyncInput,
): AntigravityContextBridgeSyncResult {
  const warnings: string[] = [];
  try {
    const geminiHome = NodePath.resolve(input.geminiHome);
    const configDir = NodePath.join(geminiHome, "config");
    const configSkillsDir = NodePath.join(configDir, "skills");
    const cliSkillsDir = NodePath.join(geminiHome, "antigravity-cli", "skills");
    const shimDirectory = NodePath.join(configDir, ANTIGRAVITY_HOOK_SHIM_DIRECTORY);

    const skillsSource = resolveContextBridgeSource(input.contextBridge, "antigravity", "skills");
    if (skillsSource !== null) {
      const skills = resolveMergedSkills({
        settings: input.contextBridge,
        cwd: input.cwd,
        userHome: input.userHome,
      });
      syncBridgedSkills(configSkillsDir, skills, warnings);
    } else {
      revertBridgedSkills(
        configSkillsDir,
        NodePath.join(input.userHome, ".gemini", "config", "skills"),
        input.platform,
        warnings,
      );
    }

    // The CLI skills link dangles when the user has no
    // ~/.gemini/antigravity-cli/skills; give the profile a real folder so the
    // agent's scan of GEMINI_HOME does not follow a dead link.
    try {
      if (!NodeFS.existsSync(cliSkillsDir)) {
        removeLinkOrDir(cliSkillsDir);
        NodeFS.mkdirSync(cliSkillsDir, { recursive: true });
      }
    } catch (error) {
      warnings.push(`context-bridge: could not prepare '${cliSkillsDir}': ${String(error)}`);
    }

    const hooksSource = resolveContextBridgeSource(input.contextBridge, "antigravity", "hooks");
    if (hooksSource !== null) {
      NodeFS.mkdirSync(configDir, { recursive: true });
      writeBridgedHooks({
        configDir,
        shimDirectory,
        source: hooksSource,
        userHome: input.userHome,
        nodeExecutable: input.nodeExecutable,
        platform: input.platform,
        warnings,
      });
    } else {
      revertBridgedHooks(configDir, shimDirectory, warnings);
    }
  } catch (error) {
    warnings.push(`context-bridge: profile sync failed: ${String(error)}`);
  }
  return { warnings };
}
