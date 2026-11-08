// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as PlusPlusContextBridge from "@t3tools/plusplus/contextBridge";

/**
 * Context bridge facade: provider-neutral logic lives in `@t3tools/plusplus/contextBridge`;
 * this module supplies the synchronous `node:fs` IO port because call sites (adapter prompt
 * assembly, `buildRuntimeInstructions`) are synchronous.
 */

export {
  CONTEXT_BRIDGE_CATALOG,
  resolveContextBridgeSource,
  type BridgedInstructionFile,
  type BridgedInstructionSkipReason,
  type BridgedInstructionsResolution,
  type BridgedInstructionTier,
  type BridgedSkillRoots,
  type ContextBridgeCatalogEntry,
  type ContextBridgeFeature,
  type ContextBridgeInput,
} from "@t3tools/plusplus/contextBridge";

const nodeFileIo: PlusPlusContextBridge.ContextBridgeFileIo = {
  isFile: (path) => {
    try {
      return NodeFS.statSync(path).isFile();
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
  realpathNative: (path) => {
    try {
      return NodeFS.realpathSync.native(path);
    } catch {
      return null;
    }
  },
};

/**
 * Resolves the bridged instruction route for a target driver with per-file
 * outcomes. Returns null when no instructions route applies.
 */
export function resolveBridgedInstructions(
  input: PlusPlusContextBridge.ContextBridgeInput,
): PlusPlusContextBridge.BridgedInstructionsResolution | null {
  return PlusPlusContextBridge.resolveBridgedInstructions(nodeFileIo, input);
}

/**
 * Builds the bridged `<project_context>` block for a target driver, with
 * global < project < local precedence. Returns "" when no bridging applies.
 */
export function buildBridgedInstructions(input: PlusPlusContextBridge.ContextBridgeInput): string {
  return PlusPlusContextBridge.buildBridgedInstructions(nodeFileIo, input);
}

/**
 * Resolves the source provider's skill directories for a target driver, or
 * null when skills are native.
 */
export function resolveBridgedSkillRoots(
  input: PlusPlusContextBridge.ContextBridgeInput,
): PlusPlusContextBridge.BridgedSkillRoots | null {
  return PlusPlusContextBridge.resolveBridgedSkillRoots(input);
}
