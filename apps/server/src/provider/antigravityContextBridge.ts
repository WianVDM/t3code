// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as PlusPlusAntigravity from "@t3tools/plusplus/antigravityContextBridge";

import {
  ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME,
  ANTIGRAVITY_HOOK_SHIM_DIRECTORY,
  ANTIGRAVITY_HOOK_SHIM_FILENAME,
  antigravityHookShimSource,
} from "./antigravityHookShimSource.ts";

/**
 * Antigravity context bridge facade: profile-sync planning lives in
 * `@t3tools/plusplus/antigravityContextBridge`; this module supplies the synchronous
 * `node:fs` IO port and the hook-shim payload.
 *
 * @module provider/antigravityContextBridge
 */

export {
  type AntigravityContextBridgeSyncGateInput,
  type AntigravityContextBridgeSyncInput,
  type AntigravityContextBridgeSyncResult,
} from "@t3tools/plusplus/antigravityContextBridge";

const nodeBridgeIo: PlusPlusAntigravity.AntigravityBridgeIo = {
  exists: (path) => NodeFS.existsSync(path),
  lstatKind: (path) => {
    try {
      const stats = NodeFS.lstatSync(path);
      if (stats.isSymbolicLink()) return "symlink";
      return stats.isDirectory() ? "directory" : "other";
    } catch {
      return "missing";
    }
  },
  isDirectory: (path) => {
    try {
      return NodeFS.statSync(path).isDirectory();
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
  removeDirectory: (path) => NodeFS.rmdirSync(path),
  listDirectory: (path) =>
    NodeFS.readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  copyDirectoryDereferenced: (source, destination) =>
    NodeFS.cpSync(source, destination, { recursive: true, dereference: true }),
  symlink: (target, path, type) => NodeFS.symlinkSync(target, path, type),
};

const hookShimFiles: PlusPlusAntigravity.AntigravityHookShimFiles = {
  directory: ANTIGRAVITY_HOOK_SHIM_DIRECTORY,
  filename: ANTIGRAVITY_HOOK_SHIM_FILENAME,
  configFilename: ANTIGRAVITY_HOOK_SHIM_CONFIG_FILENAME,
  source: antigravityHookShimSource,
};

/**
 * A bridged skills or hooks route always syncs. Otherwise the gate stays closed and the
 * profile keeps what stock T3 Code left, unless a previous bridge run left an ownership
 * record (the skills marker, a bridge-owned `hooks.json`, or the hook shim directory), in
 * which case the sync still runs so turning the bridge off cleans up what it wrote.
 */
export function needsAntigravityContextBridgeSync(
  input: PlusPlusAntigravity.AntigravityContextBridgeSyncGateInput,
): boolean {
  return PlusPlusAntigravity.needsAntigravityContextBridgeSync(
    nodeBridgeIo,
    ANTIGRAVITY_HOOK_SHIM_DIRECTORY,
    input,
  );
}

/**
 * Reconciles the private Antigravity profile with the current context bridge
 * routes. Never throws: every failure lands in `warnings` and the profile is
 * left as usable as the failure allowed.
 */
export function syncAntigravityContextBridgeProfile(
  input: PlusPlusAntigravity.AntigravityContextBridgeSyncInput,
): PlusPlusAntigravity.AntigravityContextBridgeSyncResult {
  return PlusPlusAntigravity.syncAntigravityContextBridgeProfile(
    nodeBridgeIo,
    hookShimFiles,
    input,
  );
}
