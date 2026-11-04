/**
 * Per-turn ContextBridgeSettings access and shared Effect wrappers. The host is explicit
 * because turn/session contexts do not provide ProviderHost. Resolution never fails a
 * turn: a read error or defect logs a warning and yields no bridged context.
 *
 * @module provider-core/server/contextBridgeRuntime
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  buildBridgedInstructions,
  resolveBridgedInstructions,
  resolveBridgedSkillRoots,
  type BridgedInstructionsResolution,
  type BridgedSkillRoots,
} from "./contextBridge.ts";
import type { ProviderHost } from "./ProviderHost.ts";

/**
 * The current ContextBridgeSettings, or `undefined` when the settings read
 * fails. Callers treat `undefined` as "nothing bridged".
 */
export const currentContextBridgeSettings = Effect.fn(
  "ContextBridgeRuntime.currentContextBridgeSettings",
)(function* (host: ProviderHost["Service"]) {
  return yield* host.settings.get.pipe(
    Effect.map((settings) => settings.contextBridge),
    Effect.catchCause((cause) =>
      Effect.logWarning("context-bridge.settings-read-failed", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );
});

/**
 * The bridged `<project_context>` block for one turn ("" when nothing
 * applies). `targetDriver` is the adapter's own driver kind; `cwd` is the
 * turn's working directory.
 */
export const bridgedInstructionsForTurn = Effect.fn(
  "ContextBridgeRuntime.bridgedInstructionsForTurn",
)(function* (input: {
  readonly host: ProviderHost["Service"];
  readonly targetDriver: string;
  readonly cwd: string | null | undefined;
}) {
  const settings = yield* currentContextBridgeSettings(input.host);
  if (settings === undefined) return "";
  const userHome = yield* HostProcess.HomeDirectory;
  return yield* Effect.sync(() =>
    buildBridgedInstructions({
      settings,
      targetDriver: input.targetDriver,
      cwd: input.cwd ?? undefined,
      userHome,
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("context-bridge.instructions-resolve-failed", {
        targetDriver: input.targetDriver,
        cause,
      }).pipe(Effect.as("")),
    ),
  );
});

/**
 * Windows compares paths case-insensitively, and resolve() trims trailing
 * separators and dots.
 */
function sameLocation(a: string, b: string): boolean {
  return NodePath.resolve(a).toLowerCase() === NodePath.resolve(b).toLowerCase();
}

/**
 * Pi resolves its agent paths against PI_CODING_AGENT_DIR, falling back to HOME. Report
 * `nativeHome` only when one deviates from the server home; an agent dir that merely
 * restates `userHome/.pi/agent` is not a move, so it stays undefined and the default
 * expansion/filter behavior applies.
 */
function derivePiNativeHome(
  environment: NodeJS.ProcessEnv | undefined,
  userHome: string,
): string | undefined {
  const defaultAgentDir = NodePath.join(userHome, ".pi", "agent");
  const agentDir = environment?.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return sameLocation(agentDir, defaultAgentDir) ? undefined : agentDir;
  const home = environment?.HOME?.trim();
  if (home && !sameLocation(home, userHome)) return NodePath.join(home, ".pi", "agent");
  return undefined;
}

export interface BridgedContextForTurn {
  readonly instructions: BridgedInstructionsResolution | null;
  readonly skillRoots: BridgedSkillRoots | null;
}

/**
 * Each route (instructions, skills) resolves independently so one failing route never
 * suppresses the other, and a settings read failure yields two nulls. Targets that
 * inject outside the prompt stream (pi) need the per-file outcomes, not just the block.
 */
export const bridgedContextForTurn = Effect.fn("ContextBridgeRuntime.bridgedContextForTurn")(
  function* (input: {
    readonly host: ProviderHost["Service"];
    readonly targetDriver: string;
    readonly cwd: string | null | undefined;
    /**
     * Launch environment for the provider process. Pi resolves its globals against
     * PI_CODING_AGENT_DIR (default ~/.pi/agent), so the bridge dedupes against that
     * directory instead of the process home; other providers keep the default.
     */
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const settings = yield* currentContextBridgeSettings(input.host);
    if (settings === undefined) return { instructions: null, skillRoots: null };
    const userHome = yield* HostProcess.HomeDirectory;
    const nativeHome =
      input.targetDriver === "pi" ? derivePiNativeHome(input.environment, userHome) : undefined;
    const resolve = <A>(
      feature: "instructions" | "skills",
      run: () => A,
    ): Effect.Effect<A | null> =>
      Effect.sync(run).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`context-bridge.${feature}-resolve-failed`, {
            targetDriver: input.targetDriver,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    const bridgeInput = {
      settings,
      targetDriver: input.targetDriver,
      cwd: input.cwd ?? undefined,
      userHome,
      ...(nativeHome === undefined ? {} : { nativeHome }),
    };
    const instructions = yield* resolve("instructions", () =>
      resolveBridgedInstructions(bridgeInput),
    );
    const skillRoots = yield* resolve("skills", () => resolveBridgedSkillRoots(bridgeInput));
    return { instructions, skillRoots };
  },
);

interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

/**
 * YAML, because names and descriptions carry inline comments, quoted scalars, and
 * folded or literal blocks. `schemaYaml` is the same parser the native claude scanner
 * runs, so bridged and native metadata cannot drift.
 */
const decodeFrontmatterYaml = Schema.decodeUnknownOption(fromYaml(Schema.Unknown));

/**
 * A malformed or empty `name` falls back to the directory name, matching what
 * the provider's own scanner still invokes. No frontmatter at all is the same
 * fallback.
 */
function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const normalized = contents.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return {};
  const parsed = Option.getOrNull(decodeFrontmatterYaml(normalized.slice(3, end)));
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function readBridgedSkill(
  root: string,
  entryName: string,
  scope: string,
): ServerProviderSkill | null {
  const skillDir = NodePath.join(root, entryName);
  let skillPath: string;
  let contents: string;
  try {
    if (!NodeFS.statSync(skillDir).isDirectory()) return null;
    skillPath = NodePath.join(skillDir, "SKILL.md");
    contents = NodeFS.readFileSync(skillPath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = parseSkillFrontmatter(contents);
  const name = frontmatter.name ?? entryName.trim();
  if (!name) return null;
  return {
    name,
    path: skillPath,
    enabled: true,
    scope,
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
  };
}

/** Immediate `SKILL.md` children of a root only; nested trees belong to the provider. */
function scanBridgedSkillRoot(root: string, scope: string): ServerProviderSkill[] {
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: ServerProviderSkill[] = [];
  for (const entry of [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const skill = readBridgedSkill(root, entry.name, scope);
    if (skill !== null) skills.push(skill);
  }
  return skills;
}

/** Case-insensitive, with a case-sensitive tiebreak so the order is total. */
function compareSkillNames(left: ServerProviderSkill, right: ServerProviderSkill): number {
  const leftKey = left.name.toLowerCase();
  const rightKey = right.name.toLowerCase();
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * Read-only. Bridged global and project compete case-insensitively, first name wins, because
 * provider skill roots are often case-insensitive; a bridged entry removes only the natives it
 * claims, so spellings differing just by case both survive. Native, disabled, self-routed, or
 * read-failure settings return `nativeSkills` unchanged.
 */
export const mergeBridgedSkillsForSnapshot = Effect.fn(
  "ContextBridgeRuntime.mergeBridgedSkillsForSnapshot",
)(function* (input: {
  readonly host: ProviderHost["Service"];
  readonly targetDriver: string;
  readonly cwd: string | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeSkills: ReadonlyArray<ServerProviderSkill>;
}) {
  const settings = yield* currentContextBridgeSettings(input.host);
  if (settings === undefined) return input.nativeSkills;
  const userHome = yield* HostProcess.HomeDirectory;
  const nativeHome =
    input.targetDriver === "pi" ? derivePiNativeHome(input.environment, userHome) : undefined;
  return yield* Effect.sync(() => {
    const roots = resolveBridgedSkillRoots({
      settings,
      targetDriver: input.targetDriver,
      cwd: input.cwd ?? undefined,
      userHome,
      ...(nativeHome === undefined ? {} : { nativeHome }),
    });
    if (roots === null) return input.nativeSkills;
    const merged: ServerProviderSkill[] = [];
    const claimed = new Set<string>();
    for (const skill of [
      ...roots.global.flatMap((root) => scanBridgedSkillRoot(root, "user")),
      ...roots.project.flatMap((root) => scanBridgedSkillRoot(root, "project")),
    ]) {
      const key = skill.name.toLowerCase();
      if (claimed.has(key)) continue;
      claimed.add(key);
      merged.push(skill);
    }
    for (const skill of input.nativeSkills) {
      if (claimed.has(skill.name.toLowerCase())) continue;
      merged.push(skill);
    }
    return merged.sort(compareSkillNames);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("context-bridge.skills-merge-failed", {
        targetDriver: input.targetDriver,
        cause,
      }).pipe(Effect.as(input.nativeSkills)),
    ),
  );
});
