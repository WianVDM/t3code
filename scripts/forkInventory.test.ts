// @effect-diagnostics nodeBuiltinImport:off - reads the recorded inventory file once, synchronously.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  buildBaselineEntries,
  ForkInventory,
  ForkInventoryEntry,
  ForkInventoryException,
  FORK_INVENTORY_PATH,
  parseNameStatusZ,
  reproduceBaseline,
  validateForkInventory,
} from "./forkInventory.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

const decodeForkInventory = Schema.decodeUnknownSync(ForkInventory);

const loadRecordedInventory = (): ForkInventory =>
  decodeForkInventory(
    JSON.parse(NodeFS.readFileSync(NodePath.join(REPO_ROOT, FORK_INVENTORY_PATH), "utf8")),
  );

type Mutable<T> =
  T extends ReadonlyArray<infer U>
    ? Array<Mutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

const minimalInventory = (): Mutable<ForkInventory> => ({
  version: 1,
  issue: "https://github.com/WianVDM/t3code/issues/33",
  baseline: {
    forkRef: "f".repeat(40),
    upstreamRef: "a".repeat(40),
    mergeBase: "b".repeat(40),
    counts: {
      total: 2,
      plusplusOwned: 1,
      upstreamOwned: 1,
      integrationSeam: 0,
      sharedModified: 0,
      renamed: 0,
    },
  },
  plusplusOwnedRoots: [],
  conflictHistory: [],
  exceptions: [],
  entries: [
    { id: "OWN-001", category: "plusplus-owned", change: "added", path: "docs/fork.md" },
    { id: "DEL-001", category: "upstream-owned", change: "deleted", path: "scripts/old.ts" },
  ],
});

const NAME_STATUS_FIXTURE = [
  "A\0docs/fork.md",
  "A\0config/tool.json",
  "D\0scripts/old.ts",
  "M\0apps/web/src/main.tsx",
  "M\0README.md",
  "R057\0meta/app.xml\0meta/fork-app.xml",
].join("\0");

describe("parseNameStatusZ", () => {
  it("parses NUL-separated records including renames", () => {
    assert.deepStrictEqual(parseNameStatusZ(`${NAME_STATUS_FIXTURE}\0`), [
      { status: "A", path: "docs/fork.md" },
      { status: "A", path: "config/tool.json" },
      { status: "D", path: "scripts/old.ts" },
      { status: "M", path: "apps/web/src/main.tsx" },
      { status: "M", path: "README.md" },
      { status: "R", path: "meta/fork-app.xml", upstreamPath: "meta/app.xml" },
    ]);
  });
});

describe("buildBaselineEntries", () => {
  it("assigns stable sequential ids sorted by path within each category", () => {
    const entries = buildBaselineEntries(parseNameStatusZ(NAME_STATUS_FIXTURE));
    assert.deepStrictEqual(entries, [
      { id: "OWN-001", category: "plusplus-owned", change: "added", path: "config/tool.json" },
      { id: "OWN-002", category: "plusplus-owned", change: "added", path: "docs/fork.md" },
      { id: "DEL-001", category: "upstream-owned", change: "deleted", path: "scripts/old.ts" },
      { id: "SEAM-001", category: "integration-seam", change: "modified", path: "README.md" },
      {
        id: "SEAM-002",
        category: "integration-seam",
        change: "modified",
        path: "apps/web/src/main.tsx",
      },
      {
        id: "SEAM-003",
        category: "integration-seam",
        change: "renamed",
        path: "meta/fork-app.xml",
        upstreamPath: "meta/app.xml",
      },
    ]);
  });

  it("is deterministic across runs", () => {
    const records = parseNameStatusZ(NAME_STATUS_FIXTURE);
    assert.deepStrictEqual(
      buildBaselineEntries(records),
      buildBaselineEntries([...records].reverse()),
    );
  });
});

describe("validateForkInventory", () => {
  it("accepts a minimal consistent inventory", () => {
    assert.deepStrictEqual(validateForkInventory(minimalInventory()), []);
  });

  it("rejects duplicate ids and paths classified more than once", () => {
    const inventory = minimalInventory();
    inventory.entries.push({
      id: "OWN-001",
      category: "plusplus-owned",
      change: "added",
      path: "scripts/old.ts",
    });
    inventory.baseline.counts.total = 3;
    inventory.baseline.counts.plusplusOwned = 2;
    const issues = validateForkInventory(inventory);
    assert.isTrue(issues.includes("OWN-001: duplicate entry id"));
    assert.isTrue(
      issues.some((issue) => issue.includes("path scripts/old.ts is also classified by DEL-001")),
    );
  });

  it("rejects non-sequential ids", () => {
    const inventory = minimalInventory();
    inventory.entries[0] = {
      id: "OWN-002",
      category: "plusplus-owned",
      change: "added",
      path: "docs/fork.md",
    };
    assert.isTrue(validateForkInventory(inventory).includes("missing sequential id OWN-001"));
  });

  it("rejects malformed ids", () => {
    const inventory = minimalInventory();
    inventory.entries[0] = {
      id: "OWN-1",
      category: "plusplus-owned",
      change: "added",
      path: "docs/fork.md",
    };
    assert.isTrue(
      validateForkInventory(inventory).includes("OWN-1: id must match OWN|DEL|SEAM-###"),
    );
  });

  it("rejects category, change, and prefix mismatches", () => {
    const inventory = minimalInventory();
    inventory.entries[0] = {
      id: "OWN-001",
      category: "plusplus-owned",
      change: "deleted",
      path: "docs/fork.md",
    };
    inventory.entries[1] = {
      id: "DEL-001",
      category: "integration-seam",
      change: "deleted",
      path: "scripts/old.ts",
    };
    const issues = validateForkInventory(inventory);
    assert.isTrue(issues.some((issue) => issue.startsWith("OWN-001: change deleted")));
    assert.isTrue(
      issues.some((issue) =>
        issue.includes("category integration-seam does not match id prefix DEL"),
      ),
    );
  });

  it("rejects a renamed entry without upstreamPath and a stray upstreamPath", () => {
    const inventory = minimalInventory();
    inventory.entries.push({
      id: "SEAM-001",
      category: "integration-seam",
      change: "renamed",
      path: "meta/fork.xml",
    });
    inventory.entries.push({
      id: "SEAM-002",
      category: "integration-seam",
      change: "modified",
      path: "meta/other.xml",
      upstreamPath: "meta/source.xml",
    });
    inventory.baseline.counts.total = 4;
    inventory.baseline.counts.integrationSeam = 2;
    inventory.baseline.counts.renamed = 1;
    const issues = validateForkInventory(inventory);
    assert.isTrue(issues.includes("SEAM-001: renamed entry is missing upstreamPath"));
    assert.isTrue(issues.includes("SEAM-002: upstreamPath is only valid on renamed entries"));
  });

  it("rejects recorded counts that disagree with the entries", () => {
    const inventory = minimalInventory();
    inventory.baseline.counts.total = 99;
    assert.isTrue(
      validateForkInventory(inventory).includes("baseline count total is 99, entries give 2"),
    );
  });

  it("rejects malformed baseline refs", () => {
    const inventory = minimalInventory();
    inventory.baseline.forkRef = "not-a-sha";
    assert.isTrue(
      validateForkInventory(inventory).includes(
        "baseline forkRef is not a full lowercase commit sha",
      ),
    );
  });

  it("rejects exception references that do not resolve or skip their task", () => {
    const inventory = minimalInventory();
    inventory.exceptions = [
      { id: "EXC-01", appliesTo: ["A5"], rationale: "missing task", entryIds: ["DEL-001"] },
      { id: "EXC-02", appliesTo: ["A2"], rationale: "unknown entry", entryIds: ["DEL-999"] },
      { id: "EXC-03", appliesTo: ["A2"], rationale: "wrong category", entryIds: ["OWN-001"] },
      { id: "EXC-03", appliesTo: ["A2"], rationale: "duplicate", entryIds: ["DEL-001"] },
    ];
    const issues = validateForkInventory(inventory);
    assert.isTrue(
      issues.includes("EXC-01: references deleted entry DEL-001 without applying to A2"),
    );
    assert.isTrue(issues.includes("EXC-02: references unknown entry DEL-999"));
    assert.isTrue(
      issues.includes("EXC-03: exceptions must not reference plusplus-owned entry OWN-001"),
    );
    assert.isTrue(issues.includes("EXC-03: duplicate exception id"));
  });

  it("rejects a seam exception that applies to neither A5 nor A7", () => {
    const inventory = minimalInventory();
    inventory.entries.push({
      id: "SEAM-001",
      category: "integration-seam",
      change: "modified",
      path: "apps/web/src/main.tsx",
    });
    inventory.baseline.counts.total = 3;
    inventory.baseline.counts.integrationSeam = 1;
    inventory.baseline.counts.sharedModified = 1;
    inventory.exceptions = [
      { id: "EXC-01", appliesTo: ["A2"], rationale: "wrong task", entryIds: ["SEAM-001"] },
    ];
    assert.isTrue(
      validateForkInventory(inventory).includes(
        "EXC-01: references seam entry SEAM-001 without applying to A5 or A7",
      ),
    );
  });

  it("rejects an owned root that contains non-fork paths or nothing at all", () => {
    const inventory = minimalInventory();
    inventory.plusplusOwnedRoots = ["docs", "empty"];
    inventory.entries.push({
      id: "SEAM-001",
      category: "integration-seam",
      change: "modified",
      path: "docs/upstream.md",
    });
    inventory.baseline.counts.total = 3;
    inventory.baseline.counts.integrationSeam = 1;
    inventory.baseline.counts.sharedModified = 1;
    const issues = validateForkInventory(inventory);
    assert.isTrue(
      issues.includes("plusplusOwnedRoots: docs contains non-fork path docs/upstream.md"),
    );
    assert.isTrue(issues.includes("plusplusOwnedRoots: empty contains no plusplus-owned entry"));
  });

  it("rejects malformed conflict history entries", () => {
    const inventory = minimalInventory();
    inventory.conflictHistory = [{ commit: "shortsha", subject: " ", conflictedFiles: [] }];
    const issues = validateForkInventory(inventory);
    assert.isTrue(issues.includes("conflictHistory: shortsha is not a full lowercase commit sha"));
    assert.isTrue(issues.includes("conflictHistory: shortsha has no subject"));
    assert.isTrue(issues.includes("conflictHistory: shortsha lists no conflicted files"));
  });
});

describe("recorded fork inventory", () => {
  it("decodes, validates clean, and matches the issue #33 baseline", () => {
    const inventory = loadRecordedInventory();
    assert.deepStrictEqual(validateForkInventory(inventory), []);
    assert.strictEqual(inventory.baseline.counts.total, 363);
    assert.strictEqual(inventory.baseline.counts.plusplusOwned, 65);
    assert.strictEqual(inventory.baseline.counts.upstreamOwned, 53);
    assert.strictEqual(inventory.baseline.counts.integrationSeam, 245);
    assert.strictEqual(inventory.baseline.counts.sharedModified, 244);
    assert.strictEqual(inventory.baseline.counts.renamed, 1);
    assert.strictEqual(new Set(inventory.entries.map((entry) => entry.id)).size, 363);
    assert.isTrue(inventory.exceptions.length > 0);
    const deletedWithException = new Set(
      inventory.exceptions.flatMap((exception: ForkInventoryException) => exception.entryIds),
    );
    assert.isTrue(
      inventory.entries.some(
        (entry: ForkInventoryEntry) =>
          entry.category === "upstream-owned" && deletedWithException.has(entry.id),
      ),
    );
  });
});

describe("reproduceBaseline", () => {
  it.live("re-derives the recorded 363-path inventory from the pinned refs", () =>
    Effect.gen(function* () {
      const inventory = loadRecordedInventory();
      const reproduction = yield* reproduceBaseline(REPO_ROOT, inventory);
      assert.deepStrictEqual(reproduction.issues, []);
      assert.strictEqual(reproduction.entries.length, 363);
      assert.strictEqual(
        reproduction.entries.filter((entry) => entry.change === "modified").length,
        244,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
