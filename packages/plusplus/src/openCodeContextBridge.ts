// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { ContextBridgeSettings } from "@t3tools/contracts";

import { resolveBridgedSkillRoots, type BridgedSkillRoots } from "./contextBridge.ts";

/**
 * OpenCode context-bridge skill sync planning. Filesystem access goes through
 * `OpenCodeBridgeIo`; the provider-opencode facade supplies the `node:fs`
 * implementation and keeps the shared-pattern helper (`skillsNamed`).
 */

const OPENCODE_PROVIDER = "opencode";

const BRIDGE_SKILLS_MARKER = ".t3-context-bridge.json";

export interface BridgedSkill {
  readonly name: string;
  readonly dir: string;
}

export type BridgePathKind = "symlink" | "directory" | "other" | "missing";

export interface BridgeDirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/** Sync IO ports; methods mirror their `node:fs` counterparts, including throwing. */
export interface OpenCodeBridgeIo {
  /** `readdirSync(withFileTypes)` shaped entries; throws when unreadable. */
  listDirectory(path: string): BridgeDirectoryEntry[];
  /** `statSync().isDirectory()`; false when missing or unreadable. */
  isDirectory(path: string): boolean;
  /** `lstatSync` kind; "missing" when the path does not exist. */
  lstatKind(path: string): BridgePathKind;
  /** `existsSync` or an `lstat` that tolerates broken symlinks. */
  exists(path: string): boolean;
  /** UTF-8 content, or null when missing or unreadable. */
  readUtf8(path: string): string | null;
  writeUtf8(path: string, data: string): void;
  /** Recursive `mkdirSync`. */
  makeDirectory(path: string): void;
  unlink(path: string): void;
  /** Recursive, forced `rmSync`. */
  removeRecursive(path: string): void;
  /** Recursive, dereferencing `cpSync`. */
  copyDirectoryDereferenced(source: string, destination: string): void;
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

function readOwnedSkillNames(io: OpenCodeBridgeIo, skillsDir: string): string[] {
  const contents = io.readUtf8(NodePath.join(skillsDir, BRIDGE_SKILLS_MARKER));
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

function removeLinkOrDir(io: OpenCodeBridgeIo, targetPath: string): void {
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

function collectSkillsFromRoots(io: OpenCodeBridgeIo, roots: readonly string[]): BridgedSkill[] {
  const skillsByName = new Map<string, BridgedSkill>();
  for (const root of roots) {
    let entries: BridgeDirectoryEntry[];
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

function syncSkillsToDir(
  io: OpenCodeBridgeIo,
  targetDir: string,
  skills: readonly BridgedSkill[],
  warnings: string[],
): string[] {
  const targetKind = io.lstatKind(targetDir);
  if (targetKind === "symlink" || targetKind === "other") {
    warnings.push(`context-bridge: '${targetDir}' is a link or non-directory; skipped sync.`);
    return [];
  }
  io.makeDirectory(targetDir);

  const wantedNames = new Set(skills.map((s) => s.name));
  const previouslyOwned = new Set(readOwnedSkillNames(io, targetDir));

  for (const prev of previouslyOwned) {
    if (!wantedNames.has(prev)) {
      removeLinkOrDir(io, NodePath.join(targetDir, prev));
    }
  }

  const owned: string[] = [];
  for (const skill of skills) {
    const destination = NodePath.join(targetDir, skill.name);
    const destinationExists = io.exists(destination);

    if (destinationExists) {
      if (!previouslyOwned.has(skill.name)) {
        warnings.push(
          `context-bridge: '${destination}' is not bridge-owned; skipped skill '${skill.name}'.`,
        );
        continue;
      }
      removeLinkOrDir(io, destination);
    }

    try {
      // Copy with dereference: OpenCode would resolve symlinks into the bridge
      // source tree, which may be absent on other machines.
      io.copyDirectoryDereferenced(skill.dir, destination);
      owned.push(skill.name);
    } catch (error) {
      // A partial destination is unowned (absent from the marker), so neither
      // the next sync nor revert would remove it.
      removeLinkOrDir(io, destination);
      warnings.push(`context-bridge: could not copy skill '${skill.name}': ${String(error)}`);
    }
  }

  const markerFile = NodePath.join(targetDir, BRIDGE_SKILLS_MARKER);
  if (owned.length > 0) {
    try {
      io.writeUtf8(markerFile, JSON.stringify({ owned }, null, 2) + "\n");
    } catch {}
  } else {
    try {
      io.unlink(markerFile);
    } catch {}
  }

  return owned;
}

function revertOwnedSkills(io: OpenCodeBridgeIo, targetDir: string): void {
  const previouslyOwned = readOwnedSkillNames(io, targetDir);
  for (const name of previouslyOwned) {
    removeLinkOrDir(io, NodePath.join(targetDir, name));
  }
  try {
    io.unlink(NodePath.join(targetDir, BRIDGE_SKILLS_MARKER));
  } catch {}
}

export interface SyncBridgedOpenCodeSkillsInput {
  readonly settings: ContextBridgeSettings;
  readonly cwd: string | undefined;
  readonly userHome: string;
}

export interface SyncBridgedOpenCodeSkillsResult {
  readonly synchronizedGlobal: readonly string[];
  readonly synchronizedProject: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Syncs bridged skills into OpenCode's skill roots with an ownership marker.
 * User-owned files are never overwritten; revert removes only bridge-owned skills.
 */
export function syncBridgedOpenCodeSkills(
  io: OpenCodeBridgeIo,
  input: SyncBridgedOpenCodeSkillsInput,
): SyncBridgedOpenCodeSkillsResult {
  const warnings: string[] = [];
  const globalTargetDir = NodePath.join(input.userHome, ".config", "opencode", "skills");
  const projectTargetDir = input.cwd ? NodePath.join(input.cwd, ".opencode", "skills") : undefined;

  const roots = resolveBridgedSkillRoots({
    settings: input.settings,
    targetDriver: OPENCODE_PROVIDER,
    cwd: input.cwd,
    userHome: input.userHome,
  });

  if (roots === null) {
    revertOwnedSkills(io, globalTargetDir);
    if (projectTargetDir) revertOwnedSkills(io, projectTargetDir);
    return { synchronizedGlobal: [], synchronizedProject: [], warnings };
  }

  const globalSkills = collectSkillsFromRoots(io, roots.global);
  const synchronizedGlobal = syncSkillsToDir(io, globalTargetDir, globalSkills, warnings);

  let synchronizedProject: string[] = [];
  if (projectTargetDir) {
    const projectSkills = collectSkillsFromRoots(io, roots.project);
    synchronizedProject = syncSkillsToDir(io, projectTargetDir, projectSkills, warnings);
  }

  return {
    synchronizedGlobal,
    synchronizedProject,
    warnings,
  };
}

export const scanBridgedSkillRoots = (
  io: OpenCodeBridgeIo,
  roots: BridgedSkillRoots,
): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const root of [...roots.global, ...roots.project]) {
    let entries: BridgeDirectoryEntry[];
    try {
      entries = io.listDirectory(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory && !entry.isSymbolicLink) continue;
      const contents = io.readUtf8(NodePath.join(root, entry.name, "SKILL.md"));
      if (contents === null) continue;
      names.add(parseSkillFrontmatterName(contents, entry.name));
    }
  }
  return names;
};

export const bridgedSkillNames = (
  io: OpenCodeBridgeIo,
  input: {
    readonly settings: ContextBridgeSettings;
    readonly cwd: string | undefined;
    readonly userHome: string;
  },
): ReadonlySet<string> => {
  const roots = resolveBridgedSkillRoots({
    settings: input.settings,
    targetDriver: OPENCODE_PROVIDER,
    cwd: input.cwd,
    userHome: input.userHome,
  });
  return roots === null ? new Set() : scanBridgedSkillRoots(io, roots);
};
