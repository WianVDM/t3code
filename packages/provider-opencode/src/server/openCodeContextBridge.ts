// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import type { ContextBridgeSettings } from "@t3tools/contracts";
import type { BridgedSkillRoots } from "@t3tools/provider-core/server/contextBridge";
import * as PlusPlusOpenCode from "@t3tools/plusplus/openCodeContextBridge";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";

/**
 * OpenCode context-bridge facade: the skill-sync planning lives in
 * `@t3tools/plusplus/openCodeContextBridge`; this module supplies the
 * synchronous `node:fs` IO port, preserves the one-argument APIs, and keeps
 * `skillsNamed`, which depends on the shared composer pattern.
 */

export {
  type BridgedSkill,
  type SyncBridgedOpenCodeSkillsInput,
  type SyncBridgedOpenCodeSkillsResult,
} from "@t3tools/plusplus/openCodeContextBridge";

const nodeBridgeIo: PlusPlusOpenCode.OpenCodeBridgeIo = {
  listDirectory: (path) =>
    NodeFS.readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  isDirectory: (path) => {
    try {
      return NodeFS.statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  lstatKind: (path) => {
    try {
      const stats = NodeFS.lstatSync(path);
      if (stats.isSymbolicLink()) return "symlink";
      return stats.isDirectory() ? "directory" : "other";
    } catch {
      return "missing";
    }
  },
  exists: (path) => {
    try {
      return (
        NodeFS.existsSync(path) || NodeFS.lstatSync(path, { throwIfNoEntry: false }) !== undefined
      );
    } catch {
      return false;
    }
  },
  readUtf8: (path) => {
    try {
      return NodeFS.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeUtf8: (path, data) => NodeFS.writeFileSync(path, data, "utf8"),
  makeDirectory: (path) => {
    NodeFS.mkdirSync(path, { recursive: true });
  },
  unlink: (path) => NodeFS.unlinkSync(path),
  removeRecursive: (path) => NodeFS.rmSync(path, { recursive: true, force: true }),
  copyDirectoryDereferenced: (source, destination) =>
    NodeFS.cpSync(source, destination, { recursive: true, dereference: true }),
};

/**
 * Syncs bridged skills into OpenCode's skill roots with an ownership marker.
 * User-owned files are never overwritten; revert removes only bridge-owned skills.
 */
export function syncBridgedOpenCodeSkills(
  input: PlusPlusOpenCode.SyncBridgedOpenCodeSkillsInput,
): PlusPlusOpenCode.SyncBridgedOpenCodeSkillsResult {
  return PlusPlusOpenCode.syncBridgedOpenCodeSkills(nodeBridgeIo, input);
}

export const skillsNamed = (text: string, known: ReadonlySet<string>): string[] => [
  ...new Set(
    [...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) =>
      known.has(match[2] ?? "") ? [match[2]!] : [],
    ),
  ),
];

export const scanBridgedSkillRoots = (roots: BridgedSkillRoots): ReadonlySet<string> =>
  PlusPlusOpenCode.scanBridgedSkillRoots(nodeBridgeIo, roots);

export const bridgedSkillNames = (input: {
  readonly settings: ContextBridgeSettings;
  readonly cwd: string | undefined;
  readonly userHome: string;
}): ReadonlySet<string> => PlusPlusOpenCode.bridgedSkillNames(nodeBridgeIo, input);
