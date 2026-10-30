// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ContextBridgeSettings } from "@t3tools/contracts";

/**
 * Context bridge: lets one provider harness run with another provider's
 * instruction files and skill roots. The catalog below is the behavioural
 * spec this module follows.
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
  /**
   * Pi's agent dir (PI_CODING_AGENT_DIR) when it differs from the default
   * `~/.pi/agent` under `userHome`. Only target-native instruction/skill
   * paths expand against it. Pi loads its globals from the agent dir, so a
   * bridged source file Pi already reads natively must dedupe against that
   * location. Source expansion, imports, and ancestor walks keep using
   * `userHome`/`cwd`.
   */
  readonly nativeHome?: string | undefined;
}

const BLOCK_MARKER = "<!-- t3-context-bridge -->";

export type BridgedInstructionTier = "global" | "project" | "local";

export type BridgedInstructionSkipReason =
  | "native-path"
  | "native-content"
  | "duplicate-path"
  | "duplicate-content";

export interface BridgedInstructionFile {
  readonly path: string;
  readonly tier: BridgedInstructionTier;
  readonly status: "injected" | "skipped";
  readonly reason?: BridgedInstructionSkipReason;
}

/**
 * The resolved instruction route for one target driver: the rendered block
 * plus every source file that exists, marked injected or skipped-and-why.
 * Targets that inject at runtime (pi) embed this so the harness can report
 * exactly what the bridge did.
 */
export interface BridgedInstructionsResolution {
  readonly source: string;
  readonly block: string;
  readonly files: readonly BridgedInstructionFile[];
}

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

const PI_AGENT_HOME_PREFIX = "~/.pi/agent";

/** Whether a catalog path is anchored at Pi's default agent home. */
function isPiAgentHomePath(trimmed: string): boolean {
  return (
    trimmed === PI_AGENT_HOME_PREFIX ||
    trimmed.startsWith(`${PI_AGENT_HOME_PREFIX}/`) ||
    trimmed.startsWith(`${PI_AGENT_HOME_PREFIX}\\`)
  );
}

function expandTargetNativePath(
  rawPath: string,
  cwd: string | undefined,
  userHome: string,
  nativeHome: string | undefined,
): string | null {
  const trimmed = rawPath.trim();
  if (nativeHome !== undefined && isPiAgentHomePath(trimmed)) {
    return NodePath.join(nativeHome, trimmed.slice(PI_AGENT_HOME_PREFIX.length));
  }
  return expandPath(rawPath, cwd, userHome);
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
    const stat = NodeFS.statSync(filePath);
    if (!stat.isFile()) return null;
    const content = NodeFS.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    if (!content.trim()) return null;
    let realPath = NodePath.resolve(filePath);
    try {
      realPath = NodeFS.realpathSync.native(filePath);
    } catch {}
    return { path: filePath, realPath, content: content.trimEnd() };
  } catch {
    return null;
  }
}

type InstructionTier = "global" | "project" | "local";

// Claude-style `@path` import: a line whose only content is the pointer.
const IMPORT_LINE = /^[ \t]*@(\S+)[ \t]*\r?$/;

/**
 * Inlines `@path` import lines, resolved relative to the containing file.
 * Non-Claude targets cannot resolve these pointers themselves, so a bridged
 * file must arrive with them already expanded. `stack` holds the real paths
 * of the files currently being expanded, which makes nested imports terminate
 * and cycles leave the offending line untouched. Unreadable or empty targets
 * also leave the line as-is.
 */
function expandImports(content: string, filePath: string, stack: ReadonlySet<string>): string {
  return content
    .split("\n")
    .map((line) => {
      const match = IMPORT_LINE.exec(line);
      if (!match) return line;
      const target = NodePath.resolve(NodePath.dirname(filePath), match[1]!);
      const read = readCandidate(target);
      if (!read) return line;
      const key = read.realPath.toLowerCase();
      if (stack.has(key)) return line;
      return expandImports(read.content, read.realPath, new Set([...stack, key]));
    })
    .join("\n");
}

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
    for (const dir of ancestorChain(cwd)) {
      for (const rel of sourceSpec.projectInstructions) {
        const expanded = expandPath(rel, dir, userHome);
        if (expanded) specs.push({ path: expanded, tier: "project" });
      }
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
 * Resolves the bridged instruction route for a target driver with per-file
 * outcomes. Returns null when no instructions route applies; otherwise `block`
 * is the rendered `<project_context>` block ("" when every file was skipped)
 * and `files` lists each existing source file as injected or skipped-and-why.
 */
export function resolveBridgedInstructions(
  input: ContextBridgeInput,
): BridgedInstructionsResolution | null {
  const { settings, targetDriver, cwd, userHome, nativeHome } = input;
  const source = resolveContextBridgeSource(settings, targetDriver, "instructions");
  if (!source) return null;
  const sourceSpec = CONTEXT_BRIDGE_CATALOG[source];
  const targetSpec = CONTEXT_BRIDGE_CATALOG[targetDriver];
  if (!sourceSpec || !targetSpec) return null;

  const nativeRealPaths = new Set<string>();
  const nativeContents = new Set<string>();
  // Native harnesses walk up from the cwd, so a relative native entry
  // resolves at every ancestor directory, not just the cwd itself.
  const nativeDirs = cwd ? ancestorChain(cwd) : [undefined];
  for (const rel of targetSpec.nativelyLoadedInstructions) {
    for (const dir of nativeDirs) {
      const expanded = expandTargetNativePath(rel, dir, userHome, nativeHome);
      if (!expanded) continue;
      const read = readCandidate(expanded);
      if (read) {
        nativeRealPaths.add(read.realPath.toLowerCase());
        nativeContents.add(read.content);
      }
    }
  }

  const seenRealPaths = new Set<string>();
  const seenContents = new Set<string>();
  const files: BridgedInstructionFile[] = [];
  const injected: (ReadCandidate & InstructionSpec)[] = [];

  for (const spec of collectSourceInstructionSpecs(sourceSpec, cwd, userHome)) {
    const read = readCandidate(spec.path);
    if (!read) continue;
    const expanded: ReadCandidate = {
      ...read,
      content: expandImports(read.content, read.realPath, new Set([read.realPath.toLowerCase()])),
    };
    const normalizedRealPath = read.realPath.toLowerCase();
    let reason: BridgedInstructionSkipReason | undefined;
    // A native path whose `@path` imports expanded to new content must still
    // be injected: the target harness reads the raw file and would never see
    // the inlined bodies. Only an unchanged file is truly already loaded.
    const importExpansionChangedContent = expanded.content !== read.content;
    if (seenRealPaths.has(normalizedRealPath)) reason = "duplicate-path";
    else if (nativeRealPaths.has(normalizedRealPath) && !importExpansionChangedContent)
      reason = "native-path";
    else if (seenContents.has(expanded.content)) reason = "duplicate-content";
    else if (nativeContents.has(expanded.content)) reason = "native-content";
    if (reason !== undefined) {
      files.push({ path: read.path, tier: spec.tier, status: "skipped", reason });
      continue;
    }
    seenRealPaths.add(normalizedRealPath);
    seenContents.add(expanded.content);
    files.push({ path: read.path, tier: spec.tier, status: "injected" });
    injected.push({ ...expanded, tier: spec.tier });
  }

  if (injected.length === 0) return { source, block: "", files };

  const sections: string[] = [];
  const globals = injected.filter((file) => file.tier === "global");
  const projects = injected.filter((file) => file.tier === "project");
  const locals = injected.filter((file) => file.tier === "local");

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

  const block = `${BLOCK_MARKER}\n<project_context source="${source}" target="${targetDriver}">\n\n${sections.join("\n\n")}\n\n</project_context>`;
  return { source, block, files };
}

/**
 * Builds the bridged `<project_context>` block for a target driver, with
 * global < project < local precedence. Returns "" when no bridging applies.
 * Files the target harness loads natively and byte-identical duplicates are
 * skipped; missing files are ignored.
 */
export function buildBridgedInstructions(input: ContextBridgeInput): string {
  return resolveBridgedInstructions(input)?.block ?? "";
}

export interface BridgedSkillRoots {
  readonly global: string[];
  readonly project: string[];
}

/**
 * Resolves the source provider's skill directories for a target driver.
 * Returns null when skills are native for the target; the caller then uses
 * only the target's own roots. Roots the target already loads natively (for
 * example `~/.claude/skills` when pi is the target) are filtered out so a
 * bridged skill never registers twice. A custom `nativeHome` means the
 * target's global discovery moved (pi's PI_CODING_AGENT_DIR), so among the
 * global roots only paths under the remapped `~/.pi/agent` prefix still
 * count as native; roots anchored at the plain user home no longer are.
 * Project-native roots (`.pi/skills`, `.agents/skills`) stay native at every
 * cwd ancestor: pi discovers them through the ancestor chain whether or not
 * its agent dir moved.
 */
export function resolveBridgedSkillRoots(input: ContextBridgeInput): BridgedSkillRoots | null {
  const { settings, targetDriver, cwd, userHome, nativeHome } = input;
  const source = resolveContextBridgeSource(settings, targetDriver, "skills");
  if (!source) return null;
  const sourceSpec = CONTEXT_BRIDGE_CATALOG[source];
  const targetSpec = CONTEXT_BRIDGE_CATALOG[targetDriver];
  if (!sourceSpec || !targetSpec) return null;
  // The nativeHome remap/filter applies only to pi's global roots under
  // `~/.pi/agent`; project-native roots stay in the set at every cwd
  // ancestor so a bridged root on the same directory never registers twice.
  const globalNativeRels =
    nativeHome === undefined
      ? targetSpec.globalSkills
      : targetSpec.globalSkills.filter((rel) => isPiAgentHomePath(rel.trim()));
  const nativeRoots = new Set(
    [
      ...globalNativeRels.map((rel) => expandTargetNativePath(rel, cwd, userHome, nativeHome)),
      ...(cwd ? ancestorChain(cwd) : []).flatMap((dir) =>
        targetSpec.projectSkills.map((rel) =>
          expandTargetNativePath(rel, dir, userHome, nativeHome),
        ),
      ),
    ]
      .filter((path): path is string => path !== null)
      .map((path) => NodePath.normalize(path).toLowerCase()),
  );
  const expandRoots = (rels: readonly string[]) =>
    rels.flatMap((rel) => {
      const expanded = expandPath(rel, cwd, userHome);
      return expanded !== null && !nativeRoots.has(NodePath.normalize(expanded).toLowerCase())
        ? [expanded]
        : [];
    });
  const global = expandRoots(sourceSpec.globalSkills);
  const project = cwd ? expandRoots(sourceSpec.projectSkills) : [];
  return { global, project };
}
