// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import type { ContextBridgeSettings } from "@t3tools/contracts";

/**
 * Context bridge: lets one provider harness run with another provider's
 * instruction files and skill roots. The catalog below is the native port of
 * the prototype monkey-patch (`~/.t3/context-bridge/bridge.mjs`); it is the
 * behavioural spec this module follows.
 *
 * File reads use synchronous `node:fs` because the call sites (adapter prompt
 * assembly, `buildRuntimeInstructions`) are synchronous; routing them through
 * Effect's FileSystem would force those signatures to change.
 */

export interface ContextBridgeCatalogEntry {
  /** User-level instruction files; `~` expands to the user home. */
  readonly globalInstructions: readonly string[];
  /** User-level local-override instruction files (highest precedence tier). */
  readonly globalLocalInstructions: readonly string[];
  /** Project instruction files, relative to the thread's cwd. */
  readonly projectInstructions: readonly string[];
  /**
   * Project local-override files, relative to the cwd and every ancestor
   * directory of it.
   */
  readonly localInstructions: readonly string[];
  /** User-level skill directories; `~` expands to the user home. */
  readonly globalSkills: readonly string[];
  /** Project skill directories, relative to the thread's cwd. */
  readonly projectSkills: readonly string[];
  /**
   * Instruction files the harness already loads by itself (`~`- or
   * cwd-relative). Bridged files matching one of these by path or by
   * byte-identical content are skipped so nothing is injected twice.
   */
  readonly nativelyLoadedInstructions: readonly string[];
}

export const CONTEXT_BRIDGE_CATALOG: Readonly<Record<string, ContextBridgeCatalogEntry>> = {
  claudeAgent: {
    globalInstructions: ["~/.claude/CLAUDE.md"],
    globalLocalInstructions: ["~/.claude/CLAUDE.local.md"],
    projectInstructions: ["CLAUDE.md", ".claude/CLAUDE.md"],
    localInstructions: ["CLAUDE.local.md", ".claude/CLAUDE.local.md"],
    globalSkills: ["~/.claude/skills"],
    projectSkills: [".claude/skills"],
    nativelyLoadedInstructions: [
      "~/.claude/CLAUDE.md",
      "~/.claude/CLAUDE.local.md",
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      "CLAUDE.local.md",
      ".claude/CLAUDE.local.md",
    ],
  },
  pi: {
    globalInstructions: ["~/.pi/agent/AGENTS.md", "~/.pi/agent/CLAUDE.md"],
    globalLocalInstructions: ["~/.pi/agent/AGENTS.local.md", "~/.pi/agent/CLAUDE.local.md"],
    projectInstructions: ["AGENTS.md", "CLAUDE.md"],
    localInstructions: ["AGENTS.local.md", "CLAUDE.local.md"],
    globalSkills: ["~/.pi/agent/skills", "~/.claude/skills"],
    projectSkills: [".pi/skills", ".agents/skills"],
    nativelyLoadedInstructions: [
      "~/.pi/agent/AGENTS.md",
      "~/.pi/agent/CLAUDE.md",
      "AGENTS.md",
      "CLAUDE.md",
      "AGENTS.local.md",
      "CLAUDE.local.md",
    ],
  },
  antigravity: {
    globalInstructions: ["~/.gemini/GEMINI.md"],
    globalLocalInstructions: ["~/.gemini/GEMINI.local.md"],
    projectInstructions: ["GEMINI.md", ".gemini/GEMINI.md", "AGENTS.md"],
    localInstructions: ["GEMINI.local.md", "AGENTS.local.md"],
    globalSkills: ["~/.gemini/config/skills", "~/.gemini/antigravity-cli/skills"],
    projectSkills: [".gemini/skills", ".agents/skills", ".agent/skills"],
    nativelyLoadedInstructions: [],
  },
  opencode: {
    globalInstructions: ["~/.config/opencode/AGENTS.md"],
    globalLocalInstructions: ["~/.config/opencode/AGENTS.local.md"],
    projectInstructions: ["AGENTS.md", "CLAUDE.md"],
    localInstructions: ["AGENTS.local.md", "CLAUDE.local.md"],
    globalSkills: ["~/.config/opencode/skills"],
    projectSkills: [".opencode/skills", ".agents/skills"],
    nativelyLoadedInstructions: [
      "~/.config/opencode/AGENTS.md",
      "AGENTS.md",
      "CLAUDE.md",
      "AGENTS.local.md",
      "CLAUDE.local.md",
    ],
  },
  codex: {
    globalInstructions: ["~/.codex/AGENTS.md"],
    globalLocalInstructions: ["~/.codex/AGENTS.override.md", "~/.codex/AGENTS.local.md"],
    projectInstructions: ["AGENTS.md"],
    localInstructions: ["AGENTS.override.md", "AGENTS.local.md"],
    globalSkills: ["~/.codex/skills"],
    projectSkills: [".codex/skills", ".agents/skills"],
    nativelyLoadedInstructions: ["~/.codex/AGENTS.md", "AGENTS.md"],
  },
  cursor: {
    globalInstructions: ["~/.cursor/AGENTS.md"],
    globalLocalInstructions: ["~/.cursor/AGENTS.local.md"],
    projectInstructions: ["AGENTS.md", ".cursorrules"],
    localInstructions: ["AGENTS.local.md", "CLAUDE.local.md"],
    globalSkills: ["~/.cursor/skills"],
    projectSkills: [".cursor/skills", ".agents/skills"],
    nativelyLoadedInstructions: ["~/.cursor/AGENTS.md", "AGENTS.md", ".cursorrules"],
  },
  grok: {
    globalInstructions: [],
    globalLocalInstructions: [],
    projectInstructions: [],
    localInstructions: [],
    globalSkills: [],
    projectSkills: [],
    nativelyLoadedInstructions: [],
  },
  muse: {
    globalInstructions: [],
    globalLocalInstructions: [],
    projectInstructions: [],
    localInstructions: [],
    globalSkills: [],
    projectSkills: [],
    nativelyLoadedInstructions: [],
  },
};

export type ContextBridgeFeature = "instructions" | "skills" | "hooks";

export interface ContextBridgeInput {
  readonly settings: ContextBridgeSettings;
  readonly targetDriver: string;
  readonly cwd: string | undefined;
  readonly userHome: string;
}

const BLOCK_MARKER = "<!-- t3-context-bridge -->";

/**
 * Resolves which driver kind supplies `feature` context for `targetDriver`.
 * Returns null when bridging is disabled, the route is native, either driver
 * is unknown to the catalog, or the source equals the target.
 */
export function resolveContextBridgeSource(
  settings: ContextBridgeSettings,
  targetDriver: string,
  feature: ContextBridgeFeature,
): string | null {
  if (!settings.enabled) return null;
  if (!CONTEXT_BRIDGE_CATALOG[targetDriver]) return null;
  const routeTarget = settings.routes[targetDriver]?.[feature] ?? "native";
  if (routeTarget === "native") return null;
  const source = routeTarget === "default" ? settings.defaultSource : routeTarget;
  if (source === targetDriver) return null;
  if (!CONTEXT_BRIDGE_CATALOG[source]) return null;
  return source;
}

/** `~` expands against `userHome`; relative paths resolve against `cwd`. */
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

/** Directories from the filesystem root down to `cwd`, root first. */
function ancestorChain(cwd: string): string[] {
  const dirs: string[] = [];
  let current = NodePath.resolve(cwd);
  while (true) {
    dirs.unshift(current);
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

interface ReadCandidate {
  readonly path: string;
  readonly realPath: string;
  readonly content: string;
}

function readCandidate(filePath: string): ReadCandidate | null {
  try {
    const stat = NodeFs.statSync(filePath);
    if (!stat.isFile()) return null;
    const content = NodeFs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    if (!content.trim()) return null;
    let realPath = NodePath.resolve(filePath);
    try {
      realPath = NodeFs.realpathSync.native(filePath);
    } catch {}
    return { path: filePath, realPath, content: content.trimEnd() };
  } catch {
    return null;
  }
}

type InstructionTier = "global" | "project" | "local";

interface InstructionSpec {
  readonly path: string;
  readonly tier: InstructionTier;
}

function collectSourceInstructionSpecs(
  sourceSpec: ContextBridgeCatalogEntry,
  cwd: string | undefined,
  userHome: string,
): InstructionSpec[] {
  const specs: InstructionSpec[] = [];
  for (const rel of sourceSpec.globalInstructions) {
    const expanded = expandPath(rel, cwd, userHome);
    if (expanded) specs.push({ path: expanded, tier: "global" });
  }
  for (const rel of sourceSpec.globalLocalInstructions) {
    const expanded = expandPath(rel, cwd, userHome);
    if (expanded) specs.push({ path: expanded, tier: "local" });
  }
  if (cwd) {
    for (const rel of sourceSpec.projectInstructions) {
      const expanded = expandPath(rel, cwd, userHome);
      if (expanded) specs.push({ path: expanded, tier: "project" });
    }
    for (const dir of ancestorChain(cwd)) {
      for (const rel of sourceSpec.localInstructions) {
        const expanded = expandPath(rel, dir, userHome);
        if (expanded) specs.push({ path: expanded, tier: "local" });
      }
    }
  }
  return specs;
}

function renderTier(
  tierFiles: readonly (ReadCandidate & InstructionSpec)[],
  source: string,
): string {
  return tierFiles
    .map(
      (file) =>
        `<project_instructions path="${file.path}" tier="${file.tier}" source="${source}">\n${file.content}\n</project_instructions>`,
    )
    .join("\n\n");
}

/**
 * Builds the bridged `<project_context>` block for a target driver, with
 * global < project < local precedence. Returns "" when no bridging applies.
 * Files the target harness loads natively and byte-identical duplicates are
 * skipped; missing files are ignored.
 */
export function buildBridgedInstructions(input: ContextBridgeInput): string {
  const { settings, targetDriver, cwd, userHome } = input;
  const source = resolveContextBridgeSource(settings, targetDriver, "instructions");
  if (!source) return "";
  const sourceSpec = CONTEXT_BRIDGE_CATALOG[source];
  const targetSpec = CONTEXT_BRIDGE_CATALOG[targetDriver];
  if (!sourceSpec || !targetSpec) return "";

  const nativeRealPaths = new Set<string>();
  const nativeContents = new Set<string>();
  for (const rel of targetSpec.nativelyLoadedInstructions) {
    const expanded = expandPath(rel, cwd, userHome);
    if (!expanded) continue;
    const read = readCandidate(expanded);
    if (read) {
      nativeRealPaths.add(read.realPath.toLowerCase());
      nativeContents.add(read.content);
    }
  }

  const seenRealPaths = new Set<string>();
  const seenContents = new Set<string>();
  const files: (ReadCandidate & InstructionSpec)[] = [];

  for (const spec of collectSourceInstructionSpecs(sourceSpec, cwd, userHome)) {
    const read = readCandidate(spec.path);
    if (!read) continue;
    const normalizedRealPath = read.realPath.toLowerCase();
    if (seenRealPaths.has(normalizedRealPath)) continue;
    if (nativeRealPaths.has(normalizedRealPath)) continue;
    if (seenContents.has(read.content) || nativeContents.has(read.content)) continue;
    seenRealPaths.add(normalizedRealPath);
    seenContents.add(read.content);
    files.push({ ...read, tier: spec.tier });
  }

  if (files.length === 0) return "";

  const sections: string[] = [];
  const globals = files.filter((file) => file.tier === "global");
  const projects = files.filter((file) => file.tier === "project");
  const locals = files.filter((file) => file.tier === "local");

  if (globals.length > 0) {
    sections.push(
      "Global user instructions bridged by T3 Context Bridge (weakest tier — overridden by project and local instructions below):\n\n" +
        renderTier(globals, source),
    );
  }
  if (projects.length > 0) {
    sections.push(
      "Project instructions bridged by T3 Context Bridge (override global instructions above):\n\n" +
        renderTier(projects, source),
    );
  }
  if (locals.length > 0) {
    sections.push(
      "Local override instructions (*.local.md) bridged by T3 Context Bridge (highest precedence — override both global and project instructions above where they conflict):\n\n" +
        renderTier(locals, source),
    );
  }

  return `${BLOCK_MARKER}\n<project_context source="${source}" target="${targetDriver}">\n\n${sections.join("\n\n")}\n\n</project_context>`;
}

export interface BridgedSkillRoots {
  readonly global: string[];
  readonly project: string[];
}

/**
 * Resolves the source provider's skill directories for a target driver.
 * Returns null when skills are native for the target; the caller then uses
 * only the target's own roots.
 */
export function resolveBridgedSkillRoots(input: ContextBridgeInput): BridgedSkillRoots | null {
  const { settings, targetDriver, cwd, userHome } = input;
  const source = resolveContextBridgeSource(settings, targetDriver, "skills");
  if (!source) return null;
  const sourceSpec = CONTEXT_BRIDGE_CATALOG[source];
  if (!sourceSpec) return null;
  const global = sourceSpec.globalSkills.flatMap((rel) => {
    const expanded = expandPath(rel, cwd, userHome);
    return expanded ? [expanded] : [];
  });
  const project = cwd
    ? sourceSpec.projectSkills.flatMap((rel) => {
        const expanded = expandPath(rel, cwd, userHome);
        return expanded ? [expanded] : [];
      })
    : [];
  return { global, project };
}
