// Typed surface of pr-ownership-label.cjs for trusted-base consumers such as
// scripts/upstream-sync.ts. The registries (SEAM_ENTRIES, FORK_RULES) and the
// classification rules live only in the .cjs module; nothing here re-encodes
// them.

export type OwnershipCategory = "fork" | "seam" | "shared";

export interface ClassifiedPath {
  readonly path: string;
  readonly category: OwnershipCategory;
  readonly diverged: boolean;
}

export interface PathClassification {
  readonly classified: ReadonlyArray<ClassifiedPath>;
  readonly seam: ReadonlyArray<ClassifiedPath>;
  readonly fork: ReadonlyArray<ClassifiedPath>;
  readonly shared: ReadonlyArray<ClassifiedPath>;
  readonly hasDivergedSeam: boolean;
}

export function classifyPath(path: string): ClassifiedPath;

export function classifyPaths(paths: ReadonlyArray<string>): PathClassification;
