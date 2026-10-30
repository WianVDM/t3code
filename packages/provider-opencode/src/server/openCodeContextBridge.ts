// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ContextBridgeSettings } from "@t3tools/contracts";
import {
  resolveBridgedSkillRoots,
  type BridgedSkillRoots,
} from "@t3tools/provider-core/server/contextBridge";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";

export const OPENCODE_PROVIDER = "opencode";

export const BRIDGE_SKILLS_MARKER = ".t3-context-bridge.json";

export interface BridgedSkill {
  readonly name: string;
  readonly dir: string;
}

export function parseSkillFrontmatterName(contents: string, fallbackName: string): string {
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

export function readOwnedSkillNames(skillsDir: string): string[] {
  try {
    const markerFile = NodePath.join(skillsDir, BRIDGE_SKILLS_MARKER);
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(markerFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const owned = Reflect.get(parsed, "owned");
    return Array.isArray(owned)
      ? owned.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
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

export function collectSkillsFromRoots(roots: readonly string[]): BridgedSkill[] {
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

export function syncSkillsToDir(
  targetDir: string,
  skills: readonly BridgedSkill[],
  warnings: string[],
): string[] {
  try {
    const targetStat = NodeFS.lstatSync(targetDir);
    if (targetStat.isSymbolicLink() || targetStat.isDirectory() === false) {
      warnings.push(`context-bridge: '${targetDir}' is a link or non-directory; skipped sync.`);
      return [];
    }
  } catch {}
  NodeFS.mkdirSync(targetDir, { recursive: true });

  const wantedNames = new Set(skills.map((s) => s.name));
  const previouslyOwned = new Set(readOwnedSkillNames(targetDir));

  for (const prev of previouslyOwned) {
    if (!wantedNames.has(prev)) {
      removeLinkOrDir(NodePath.join(targetDir, prev));
    }
  }

  const owned: string[] = [];
  for (const skill of skills) {
    const destination = NodePath.join(targetDir, skill.name);
    let destinationExists = false;
    try {
      destinationExists =
        NodeFS.existsSync(destination) ||
        NodeFS.lstatSync(destination, { throwIfNoEntry: false }) !== undefined;
    } catch {}

    if (destinationExists) {
      if (!previouslyOwned.has(skill.name)) {
        warnings.push(
          `context-bridge: '${destination}' is not bridge-owned; skipped skill '${skill.name}'.`,
        );
        continue;
      }
      removeLinkOrDir(destination);
    }

    try {
      // Copy with dereference: OpenCode would resolve symlinks into the bridge
      // source tree, which may be absent on other machines.
      NodeFS.cpSync(skill.dir, destination, { recursive: true, dereference: true });
      owned.push(skill.name);
    } catch (error) {
      // A partial destination is unowned (absent from the marker), so neither
      // the next sync nor revert would remove it.
      removeLinkOrDir(destination);
      warnings.push(`context-bridge: could not copy skill '${skill.name}': ${String(error)}`);
    }
  }

  const markerFile = NodePath.join(targetDir, BRIDGE_SKILLS_MARKER);
  if (owned.length > 0) {
    try {
      NodeFS.writeFileSync(markerFile, JSON.stringify({ owned }, null, 2) + "\n", "utf8");
    } catch {}
  } else {
    try {
      NodeFS.unlinkSync(markerFile);
    } catch {}
  }

  return owned;
}

export function revertOwnedSkills(targetDir: string): void {
  const previouslyOwned = readOwnedSkillNames(targetDir);
  for (const name of previouslyOwned) {
    removeLinkOrDir(NodePath.join(targetDir, name));
  }
  try {
    NodeFS.unlinkSync(NodePath.join(targetDir, BRIDGE_SKILLS_MARKER));
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
 * Syncs bridged skills into OpenCode's native discovery roots:
 * `~/.config/opencode/skills` (user level) and `.opencode/skills` (project
 * level), copied recursively with a `.t3-context-bridge.json` ownership marker.
 *
 * User-owned files are never overwritten. On revert (route set to "native",
 * bridge disabled, or source equals target), only bridge-owned skills are removed.
 */
export function syncBridgedOpenCodeSkills(
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
    revertOwnedSkills(globalTargetDir);
    if (projectTargetDir) revertOwnedSkills(projectTargetDir);
    return { synchronizedGlobal: [], synchronizedProject: [], warnings };
  }

  const globalSkills = collectSkillsFromRoots(roots.global);
  const synchronizedGlobal = syncSkillsToDir(globalTargetDir, globalSkills, warnings);

  let synchronizedProject: string[] = [];
  if (projectTargetDir) {
    const projectSkills = collectSkillsFromRoots(roots.project);
    synchronizedProject = syncSkillsToDir(projectTargetDir, projectSkills, warnings);
  }

  return {
    synchronizedGlobal,
    synchronizedProject,
    warnings,
  };
}

export const skillsNamed = (text: string, known: ReadonlySet<string>): string[] => [
  ...new Set(
    [...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) =>
      known.has(match[2] ?? "") ? [match[2]!] : [],
    ),
  ),
];

export const scanBridgedSkillRoots = (roots: BridgedSkillRoots): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const root of [...roots.global, ...roots.project]) {
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const contents = NodeFS.readFileSync(NodePath.join(root, entry.name, "SKILL.md"), "utf8");
        names.add(parseSkillFrontmatterName(contents, entry.name));
      } catch {}
    }
  }
  return names;
};

export const bridgedSkillNames = (input: {
  readonly settings: ContextBridgeSettings;
  readonly cwd: string | undefined;
  readonly userHome: string;
}): ReadonlySet<string> => {
  const roots = resolveBridgedSkillRoots({
    settings: input.settings,
    targetDriver: OPENCODE_PROVIDER,
    cwd: input.cwd,
    userHome: input.userHome,
  });
  return roots === null ? new Set() : scanBridgedSkillRoots(roots);
};
