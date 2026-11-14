// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { ContextBridgeSettings } from "@t3tools/contracts";

import {
  CONTEXT_BRIDGE_CATALOG,
  expandPath,
  resolveBridgedSkillRoots,
  resolveContextBridgeSource,
} from "./contextBridge.ts";

/**
 * Antigravity context-bridge profile-sync planning: reconciles the private profile
 * (`GEMINI_HOME`) with the current routes through `AntigravityBridgeIo`; the hook-shim
 * payload arrives from the apps/server facade. Only files the bridge wrote are removed.
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

/** Hook-shim files the apps/server facade owns; the planner only writes them through. */
export interface AntigravityHookShimFiles {
  readonly directory: string;
  readonly filename: string;
  readonly configFilename: string;
  readonly source: string;
}

/** Sync IO ports; throwing methods mirror their `node:fs` counterparts. */
export interface AntigravityBridgeIo {
  exists(path: string): boolean;
  /** `lstatSync` kind; "missing" when the path does not exist. */
  lstatKind(path: string): "symlink" | "directory" | "other" | "missing";
  /** `statSync().isDirectory()`; false when missing or unreadable. */
  isDirectory(path: string): boolean;
  /** UTF-8 content, or null when missing or unreadable. */
  readUtf8(path: string): string | null;
  writeUtf8(path: string, data: string): void;
  /** Recursive `mkdirSync`. */
  makeDirectory(path: string): void;
  unlink(path: string): void;
  /** Recursive, forced `rmSync`. */
  removeRecursive(path: string): void;
  /** Non-recursive `rmdirSync`. */
  removeDirectory(path: string): void;
  /** `readdirSync(withFileTypes)` shaped entries; throws when unreadable. */
  listDirectory(path: string): { name: string; isDirectory: boolean; isSymbolicLink: boolean }[];
  /** Recursive, dereferencing `cpSync`. */
  copyDirectoryDereferenced(source: string, destination: string): void;
  symlink(target: string, path: string, type: "junction" | "dir"): void;
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

function removeLinkOrDir(io: AntigravityBridgeIo, targetPath: string): void {
  try {
    const kind = io.lstatKind(targetPath);
    if (kind === "symlink") {
      io.unlink(targetPath);
    } else if (kind === "directory") {
      io.removeRecursive(targetPath);
    } else if (kind === "other") {
      io.unlink(targetPath);
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
function resolveMergedSkills(
  io: AntigravityBridgeIo,
  input: {
    readonly settings: ContextBridgeSettings;
    readonly cwd: string | undefined;
    readonly userHome: string;
  },
): BridgedSkill[] {
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
    let entries: { name: string; isDirectory: boolean; isSymbolicLink: boolean }[];
    try {
      entries = io.listDirectory(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const skillDir = NodePath.join(root, entry.name);
      let isDirectory = entry.isDirectory;
      if (!isDirectory && entry.isSymbolicLink) {
        isDirectory = io.isDirectory(skillDir);
      }
      if (!isDirectory) continue;
      const contents = io.readUtf8(NodePath.join(skillDir, "SKILL.md"));
      if (contents === null) continue;
      const name = parseSkillFrontmatterName(contents, entry.name);
      if (!name || skillsByName.has(name)) continue;
      skillsByName.set(name, { name, dir: skillDir });
    }
  }
  return [...skillsByName.values()];
}

function readOwnedSkillNames(io: AntigravityBridgeIo, configSkillsDir: string): string[] {
  const contents = io.readUtf8(NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER));
  if (contents === null) return [];
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) return [];
    const owned = Reflect.get(parsed, "owned");
    return Array.isArray(owned)
      ? owned.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

function isBridgeOwnedHooksFile(io: AntigravityBridgeIo, hooksFile: string): boolean {
  const contents = io.readUtf8(hooksFile);
  if (contents === null) return false;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) return false;
    const keys = Object.keys(parsed);
    return keys.length === 1 && keys[0] === BRIDGE_HOOKS_KEY;
  } catch {
    return false;
  }
}

function syncBridgedSkills(
  io: AntigravityBridgeIo,
  configSkillsDir: string,
  skills: readonly BridgedSkill[],
  warnings: string[],
): void {
  try {
    if (io.lstatKind(configSkillsDir) === "symlink") {
      io.unlink(configSkillsDir);
    }
  } catch {}
  io.makeDirectory(configSkillsDir);

  const wantedNames = new Set(skills.map((skill) => skill.name));
  for (const previouslyOwned of readOwnedSkillNames(io, configSkillsDir)) {
    if (!wantedNames.has(previouslyOwned)) {
      removeLinkOrDir(io, NodePath.join(configSkillsDir, previouslyOwned));
    }
  }

  const owned: string[] = [];
  for (const skill of skills) {
    const destination = NodePath.join(configSkillsDir, skill.name);
    if (io.lstatKind(destination) !== "missing") {
      // A bridge-owned entry is replaced; anything else is the user's own
      // content and stays, shadowing the copy for this sync.
      if (readOwnedSkillNames(io, configSkillsDir).includes(skill.name)) {
        removeLinkOrDir(io, destination);
      } else {
        warnings.push(
          `context-bridge: '${destination}' is not bridge-owned; skipped skill '${skill.name}'.`,
        );
        continue;
      }
    }
    // Always a real copied directory, never a symlink: Antigravity's
    // lstat-based loader does not follow plain symlinks, and junction
    // fallbacks made behavior platform-dependent.
    try {
      io.copyDirectoryDereferenced(skill.dir, destination);
    } catch (error) {
      warnings.push(`context-bridge: could not copy skill '${skill.name}': ${String(error)}`);
      continue;
    }
    owned.push(skill.name);
  }
  io.writeUtf8(
    NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER),
    JSON.stringify({ owned }, null, 2) + "\n",
  );
}

function revertBridgedSkills(
  io: AntigravityBridgeIo,
  configSkillsDir: string,
  nativeTarget: string,
  platform: NodeJS.Platform,
  warnings: string[],
): void {
  const kind = io.lstatKind(configSkillsDir);
  if (kind === "missing") return;
  const isRealDirectory = kind === "directory";
  if (!isRealDirectory) return;
  // Without a marker nothing here is bridge-written, but an empty owned list
  // still needs cleanup so a fully removed sync restores the native link.
  if (!io.exists(NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER))) return;
  const owned = readOwnedSkillNames(io, configSkillsDir);
  for (const name of owned) {
    removeLinkOrDir(io, NodePath.join(configSkillsDir, name));
  }
  removeLinkOrDir(io, NodePath.join(configSkillsDir, BRIDGE_SKILLS_MARKER));
  try {
    if (io.listDirectory(configSkillsDir).length > 0) {
      warnings.push(
        `context-bridge: '${configSkillsDir}' keeps non-bridge entries; the native skills link was not restored.`,
      );
      return;
    }
    io.removeDirectory(configSkillsDir);
  } catch (error) {
    warnings.push(`context-bridge: could not clear '${configSkillsDir}': ${String(error)}`);
    return;
  }
  try {
    if (io.exists(nativeTarget)) {
      io.symlink(nativeTarget, configSkillsDir, platform === "win32" ? "junction" : "dir");
    }
  } catch (error) {
    warnings.push(`context-bridge: could not restore the native skills link: ${String(error)}`);
  }
}

function writeBridgedHooks(input: {
  readonly io: AntigravityBridgeIo;
  readonly shim: AntigravityHookShimFiles;
  readonly configDir: string;
  readonly source: string;
  readonly userHome: string;
  readonly nodeExecutable: string;
  readonly platform: NodeJS.Platform;
  readonly warnings: string[];
}): void {
  const { io, shim } = input;
  const hookSource = CONTEXT_BRIDGE_HOOK_SOURCES[input.source];
  const shimDirectory = NodePath.join(input.configDir, shim.directory);
  io.makeDirectory(shimDirectory);
  const shimPath = NodePath.join(shimDirectory, shim.filename);
  io.writeUtf8(shimPath, shim.source);
  io.writeUtf8(
    NodePath.join(shimDirectory, shim.configFilename),
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
  );

  const hooksFile = NodePath.join(input.configDir, "hooks.json");
  if (io.exists(hooksFile) && !isBridgeOwnedHooksFile(io, hooksFile)) {
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
  io.writeUtf8(hooksFile, JSON.stringify(hooksConfig, null, 2) + "\n");
}

function revertBridgedHooks(
  io: AntigravityBridgeIo,
  configDir: string,
  shimDirectory: string,
  warnings: string[],
): void {
  const hooksFile = NodePath.join(configDir, "hooks.json");
  try {
    if (io.exists(hooksFile) && isBridgeOwnedHooksFile(io, hooksFile)) {
      io.unlink(hooksFile);
    }
  } catch (error) {
    warnings.push(`context-bridge: could not remove '${hooksFile}': ${String(error)}`);
  }
  try {
    if (io.exists(shimDirectory)) {
      io.removeRecursive(shimDirectory);
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
 * A bridged skills or hooks route always syncs. Otherwise the gate stays closed and the
 * profile keeps what stock T3 Code left, unless a previous bridge run left an ownership
 * record (the skills marker, a bridge-owned `hooks.json`, or the hook shim directory), in
 * which case the sync still runs so turning the bridge off cleans up what it wrote.
 */
export function needsAntigravityContextBridgeSync(
  io: AntigravityBridgeIo,
  shimDirectory: string,
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
    if (io.exists(NodePath.join(configDir, "skills", BRIDGE_SKILLS_MARKER))) return true;
    if (isBridgeOwnedHooksFile(io, NodePath.join(configDir, "hooks.json"))) return true;
    return io.exists(NodePath.join(configDir, shimDirectory));
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
  io: AntigravityBridgeIo,
  shim: AntigravityHookShimFiles,
  input: AntigravityContextBridgeSyncInput,
): AntigravityContextBridgeSyncResult {
  const warnings: string[] = [];
  try {
    const geminiHome = NodePath.resolve(input.geminiHome);
    const configDir = NodePath.join(geminiHome, "config");
    const configSkillsDir = NodePath.join(configDir, "skills");
    const cliSkillsDir = NodePath.join(geminiHome, "antigravity-cli", "skills");
    const shimDirectory = NodePath.join(configDir, shim.directory);

    const skillsSource = resolveContextBridgeSource(input.contextBridge, "antigravity", "skills");
    if (skillsSource !== null) {
      const skills = resolveMergedSkills(io, {
        settings: input.contextBridge,
        cwd: input.cwd,
        userHome: input.userHome,
      });
      syncBridgedSkills(io, configSkillsDir, skills, warnings);
    } else {
      revertBridgedSkills(
        io,
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
      if (!io.exists(cliSkillsDir)) {
        removeLinkOrDir(io, cliSkillsDir);
        io.makeDirectory(cliSkillsDir);
      }
    } catch (error) {
      warnings.push(`context-bridge: could not prepare '${cliSkillsDir}': ${String(error)}`);
    }

    const hooksSource = resolveContextBridgeSource(input.contextBridge, "antigravity", "hooks");
    if (hooksSource !== null) {
      io.makeDirectory(configDir);
      writeBridgedHooks({
        io,
        shim,
        configDir,
        source: hooksSource,
        userHome: input.userHome,
        nodeExecutable: input.nodeExecutable,
        platform: input.platform,
        warnings,
      });
    } else {
      revertBridgedHooks(io, configDir, shimDirectory, warnings);
    }
  } catch (error) {
    warnings.push(`context-bridge: profile sync failed: ${String(error)}`);
  }
  return { warnings };
}
