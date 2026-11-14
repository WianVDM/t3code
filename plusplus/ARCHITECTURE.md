# T3 Code ++ architecture: thin seams over upstream

Evidence: main 2f15f3ee03, last merged upstream 322f6544df, benchmark upstream ade473018d.

## Model

Upstream T3 Code stays almost byte-identical in the fork. ++ code, tests, docs and release tooling live in ++-owned paths. Where ++ must change upstream behaviour, the upstream file carries the smallest possible hook (one import plus one call, mount or config line), and the ++ side does the work. Every hook is listed in a seam registry with a fingerprint of the upstream region it depends on. On every upstream merge a report says which upstream regions changed under which ++ features, so the maintainer either adapts the ++ code or drops the ++ change because upstream now does the same thing. Upstream-to-fork syncs stay real merges through `scripts/upstream-sync.ts`. Nothing is ever sent to upstream.

## Ownership

A path is **upstream-owned** when it exists at the registry's `upstreamRef` (the last merged upstream commit). Every other path is **++-owned**. Git answers this at check time, so there is no path-ownership list to maintain. If upstream later adds a file at a ++ path, the merge shows an add/add conflict and the ++ file is renamed.

## Rules for upstream-owned files

Allowed, each with a registry entry:

| Mechanism   | What it is                                                                                      | When                                                                                                                         |
| :---------- | :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `hook`      | One added import plus one added call, argument, spread or return wrap. Upstream lines untouched | Default for code                                                                                                             |
| `mount`     | One typed ++ JSX mount (#82) or one sidecar field (#80)                                         | Web UI and contracts                                                                                                         |
| `config`    | One entry in a manifest or config (workspace, tsconfig path, knip entry, pointer line in a doc) | Wiring only                                                                                                                  |
| `override`  | Replace one upstream statement or expression with a ++ call                                     | Only when an addition cannot do it. `reason` says why. Includes in-place bug fixes, which are dropped once upstream fixes it |
| `swap`      | Build-time alias that resolves an upstream module to a ++ module                                | Only when a whole module must differ. The alias line is its own `config` seam                                                |
| `generated` | File produced by a command (`agentContextBudget.json`)                                          | Never hand-merged: take upstream, regenerate                                                                                 |
| `legacy`    | Fork delta that predates the registry, recorded by size only                                    | Bootstrap only. May shrink, never grow                                                                                       |

Never:

- Delete, move or rename an upstream file or symbol. Disable it instead (workflows: repository setting, zero diff).
- Replace an upstream body with a re-export, or copy an upstream body into a ++ file. Import it and wrap it.
- Append ++ tests to an upstream test file.
- Rewrite an upstream doc, page or workflow. Restore it and keep the ++ version in a ++-owned sibling.
- Reformat, reorder or rename upstream lines around a hook.
- Fix an upstream bug without first checking upstream main for a fix. If one exists, take it.

## Where ++ things go

| Kind                                                     | Path                                                                               |
| :------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| Shared runtime, contract extensions, provider logic      | `packages/plusplus/src/`                                                           |
| Server, desktop, mobile code                             | `apps/server/src/plusplus/`, and `apps/{desktop,mobile}/src/plusplus/` when needed |
| Web UI                                                   | `apps/web/src/plusplus/` (typed mounts)                                            |
| Assets                                                   | `assets/fork/`                                                                     |
| Tests of ++ modules                                      | Beside the module, in the ++ path                                                  |
| Tests of ++ behaviour reached through an upstream module | Sibling `<module>.plusplus.test.ts` beside the upstream module                     |
| Rule doc, registry, sync history                         | `plusplus/ARCHITECTURE.md`, `plusplus/seams.json`, `plusplus/sync-history.json`    |
| ++ user and maintainer docs                              | `plusplus/docs/` (install, FAQ, release runbook)                                   |
| ++ workflows                                             | `.github/workflows/plusplus-*.yml` (GitHub requires that directory)                |
| ++ tooling                                               | New files in `scripts/`. Existing fork scripts keep their names                    |

Dependency direction: ++ code imports upstream packages freely. Upstream code imports ++ only through a registered seam.

## Seam registry: `plusplus/seams.json`

JSON so workflow `.cjs` scripts and TS tools read it without a build. One schema, validated with Effect Schema in `scripts/seamRegistry.ts`. Values below are illustrative.

```json
{
  "version": 1,
  "upstreamRef": "322f6544dfad0a3c8a0c8cbecf2c7f7874b14268",
  "features": { "context-bridge": { "title": "Context bridge", "issue": 35 } },
  "files": {
    "apps/server/src/provider/ClaudeProvider.ts": {
      "delta": [10, 2],
      "seams": [
        {
          "id": "context-bridge.claude-skills",
          "feature": "context-bridge",
          "mechanism": "override",
          "anchor": { "symbol": "checkClaudeProviderStatus", "text": "discoverClaudeSkills(" },
          "reason": "Skill discovery needs the ++ context bridge settings.",
          "fingerprint": "sha256:3f9c0a1b7d2e4c56"
        }
      ]
    },
    "apps/server/src/terminal/Manager.test.ts": { "delta": [155, 1], "legacy": true }
  },
  "siblings": [
    {
      "feature": "release",
      "upstream": "docs/operations/release.md",
      "plusplus": "plusplus/docs/release.md",
      "fingerprint": "sha256:9a0e5c…"
    }
  ]
}
```

- `delta` is `[added, removed]` from `git diff --numstat <upstreamRef> HEAD -- <path>`: the fork's whole footprint in that file.
- A binary file has no line counts in numstat and records `[0, 0]`.
- `legacy: true` entries carry only `delta`. The bootstrap writes one per upstream file the fork already changes (324 modified and 28 deleted today) and they convert to anchored seams feature by feature.
- `swap` seams add `"target": "<++ module>"`; their anchor is `{ "file": true }`.

### Anchors and fingerprints

The fingerprint covers only the upstream region the hook depends on, so unrelated upstream edits elsewhere in the file do not flag it. It is computed from upstream's text at `upstreamRef`, never from the fork's file.

| Anchor            | Region located at a given upstream commit                                                                                                                                                                                                                                                                                                                                                                                                                |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symbol`          | TS/TSX parsed with the repo's TypeScript. Dotted name (`UsageOverview`, `Foo.bar`) resolves a top-level declaration, then members. Region = the declaration's text without leading comments. When an `export const X` and an `export type X` share the name, the value declaration is the match; two values (overloads) are `ambiguous`                                                                                                                  |
| `symbol` + `text` | The one line inside that symbol whose trimmed text contains `text`, plus 2 lines either side. Use this inside large functions and components                                                                                                                                                                                                                                                                                                             |
| `text`            | Same, searched in the whole file (Markdown, YAML, shell)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `key`             | Dotted key path in JSON or YAML (`scripts.knip:check`, `jobs.release`). Region = the serialized JSON value, or for YAML the key line plus its indented block and any block sequence at the key's own indent. JSON paths split on `.`, so a key that contains a dot cannot be anchored (`missing`), and a duplicated JSON key resolves to its last value. YAML support covers block mappings only; flow mappings, anchors and aliases locate as `missing` |
| `file`            | Whole file (swaps, siblings, whole-file seams such as `.github/SECURITY.md`)                                                                                                                                                                                                                                                                                                                                                                             |

Normalize (LF endings, trailing whitespace stripped, outer blank lines dropped), hash with SHA-256, store the first 16 hex chars. Not found gives `missing`; more than one match gives `ambiguous`. Both fail `node scripts/seamRegistry.ts check` and block the sync refresh until the anchor is fixed.

## Per-merge report

`scripts/upstream-sync.ts` builds it for any upstream ref U: in the daily dry run (job summary and artifact) and in the sync PR hotspot comment. Grouped by ++ feature, each seam and sibling shows its state (`same`, `changed`, `missing`, `ambiguous`, `file-deleted`, comparing the region at `upstreamRef` with U), whether `git merge-tree` reports a conflict on its path, and for `changed`, upstream's diff of that region with the prompt "adapt ++ or drop the ++ change".

Then: legacy files U touches (by path, with conflict flag), conflict paths and hunks outside the registry, and fork deltas with no entry (should be none). The dry run is report-only: drift is information, and it fails only when the report cannot be computed. A registry refresh that would fail in `verify` (a lost anchor, an unregistered fork delta) is listed under its own heading and does not stop the test lanes.

After the sync PR resolves conflicts, `verify` stages the refresh (and refuses while an anchor or a fork delta cannot be refreshed) and `finish` re-runs it and commits the merge. The refresh sets `upstreamRef` to the merged commit, recomputes every fingerprint and delta, and appends paths, hunks and affected features to `plusplus/sync-history.json`. The `seams.json` diff in the sync PR is the record of what was adapted or dropped.

## PR guard

`scripts/check-fork-boundaries.ts` (CI job `Fork Boundaries`) compares the PR head's registry and tree with the base. Policy and the checker itself come from the base; the head's registry is only decoded as JSON, so head code never runs. The job is advisory (`continue-on-error`, outside `Check`) until the first designated sync PR passes it; then it becomes required. A PR that edits `ci.yml` runs its own copy of the job, so the guard catches honest mistakes and makes registry growth reviewable, but is not a gate against that edit. For each PR except designated upstream-sync PRs (#50):

0. The head registry's `upstreamRef` must equal the base's. Only a sync merge moves it.
1. A changed upstream-owned path with no `files` entry fails, and so does an entry whose file no longer differs from upstream.
2. A file whose numstat delta exceeds its recorded `delta` fails, unless the PR raises the entry.
3. A deleted or renamed upstream-owned path fails.
4. Anchors of touched entries and siblings must resolve at `upstreamRef` with matching fingerprints. Untouched entries are not re-checked.
5. The check summary lists every entry the PR adds or raises, so each new seam is a visible maintainer decision.

A designated sync PR skips checks 0-5 and instead runs the whole-registry check of `node scripts/seamRegistry.ts check` on its head. The exemption comes from the `changes` job's `upstream_sync` and `sync_designation_error` outputs plus the `sync` job's result, never from labels, title or branch. `vp run check:changed` runs the same checker on the working tree, without the exemption.

## Existing machinery

| Thing                                                                                    | Fate                                                                                                                                                                       |
| :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The retired path inventory and its validator (+test)                                     | Gone. `conflictHistory` moved to `plusplus/sync-history.json`; `exceptions` became `reason` text on legacy entries. Path categories are replaced by the git ownership rule |
| `scripts/check-fork-boundaries.ts`                                                       | Enforces the PR guard above. Anchors come from `seamRegistry.ts`, so it parses no TypeScript itself                                                                        |
| `scripts/upstream-sync.ts`, dry-run and sync-PR workflows                                | Keep. Report section replaces `classifyPath` from `pr-ownership-label.cjs`; `finish` gains the refresh                                                                     |
| `.github/scripts/pr-ownership-label.cjs`                                                 | Keep the labels; derive "touches upstream" from the git rule and features from the registry; delete its 33-entry seam list                                                 |
| `packages/plusplus`, `apps/web/src/plusplus`, #80 sidecar, #82 mounts, `forkIdentity.ts` | Keep. They are the ++ side of the seams                                                                                                                                    |

## Current conflict classes (benchmark ade473018d)

| Class                                                                                                        | Handling                                                                                                                                                                                                                   |
| :----------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code hooks: `ClaudeProvider.ts`, `UsagePage.tsx`, `mcpInjection.ts`, `contracts/settings.ts`, `package.json` | Anchored entries at bootstrap. Shrink toward one hook line when next touched; resolve by taking upstream and re-applying the hook                                                                                          |
| #71: `shared/usageLimits.ts`, Cursor `usageLimits.ts` (+test)                                                | Restore upstream text verbatim. `packages/plusplus` imports and wraps the upstream functions, drops its copies, and consumers that need ++ results switch one import each (registered seams). Pilot for the registry (#94) |
| `cli/pair.ts`, `scripts/cli.ts`                                                                              | Adopt upstream's resolver with one ++ hook for the command name; restore the publish command (#95)                                                                                                                         |
| ++ tests in upstream test files (4 conflicting, 106 files in total)                                          | Move to `*.plusplus.test.ts` siblings; restore the upstream file (#91)                                                                                                                                                     |
| Convergent fixes: `ClaudeAdapterV2.test.ts`, `check-changed.test.ts`                                         | Take upstream at merge; drop the fork fix                                                                                                                                                                                  |
| Docs and marketing                                                                                           | Restore upstream; ++ notes in `plusplus/docs/`; optional one pointer line as a `config` seam (#92)                                                                                                                         |
| Release pipeline and runbook                                                                                 | Restore upstream, disable by setting; ++ pipeline in `.github/workflows/plusplus-release.yml`, runbook in `plusplus/docs/release.md`, registered as siblings (#93)                                                         |
| Other workflows with fork edits (`ci.yml` +210/-87)                                                          | Legacy entries. Move ++ jobs to `plusplus-ci.yml` when they next conflict                                                                                                                                                  |
| Generated (`agentContextBudget.json`)                                                                        | `generated` entry; regenerate after merge                                                                                                                                                                                  |
| Deleted upstream files (`.macroscope/ignore.md` and 27 more)                                                 | Restore at merge or in a cleanup; disable instead of delete                                                                                                                                                                |

## Where this doc lives

`plusplus/ARCHITECTURE.md`, beside the registry. `AGENTS.md` gets one pointer line (a registered `config` seam) from #46: "This is the T3 Code ++ fork. Before editing a file that exists upstream, read `plusplus/ARCHITECTURE.md`." `CONTRIBUTING.md` gets the same pointer.

## Non-goals

- Rebasing, patch stacks, merge drivers (`merge=ours`), or a build-time overlay for everything.
- Sending fixes or issues upstream.
- Conflict-count targets. The report records numbers per release; it does not gate on them.
- Rewriting legacy seams in one sweep. They shrink when touched or when their feature migrates.
- Token-efficiency work (#72 to #78) and the guidance file (#46); both follow these rules.
