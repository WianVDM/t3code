import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolvePreviousReleaseTag } from "./resolve-previous-release-tag.ts";

it.effect("selects the latest earlier stable tag and ignores nightlies", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("stable", "v1.2.0", [
      "v1.1.0",
      "v1.1.1-nightly.20260619.1",
      "v1.1.2",
      "v1.2.0",
    ]);

    assert.equal(previous, "v1.1.2");
  }),
);

it.effect("orders plusplus releases as the upstream base plus an incrementing revision", () =>
  Effect.gen(function* () {
    // Within one upstream base the ++ revision supersedes the base tag, so the
    // previous release of a second revision is the first revision, not the base.
    const second = yield* resolvePreviousReleaseTag("stable", "v0.1.5-plusplus.2", [
      "v0.1.5",
      "v0.1.5-plusplus.1",
      "v0.1.5-plusplus.2",
    ]);
    assert.equal(second, "v0.1.5-plusplus.1");

    // The first ++ release of a base compares against that base's tag.
    const first = yield* resolvePreviousReleaseTag("stable", "v0.1.5-plusplus.1", [
      "v0.1.4-plusplus.3",
      "v0.1.5",
    ]);
    assert.equal(first, "v0.1.5");
  }),
);

it.effect("rolls over to a new upstream base before earlier plusplus revisions", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("stable", "v0.1.6-plusplus.1", [
      "v0.1.5-plusplus.1",
      "v0.1.5-plusplus.2",
    ]);
    assert.equal(previous, "v0.1.5-plusplus.2");

    const withNightlies = yield* resolvePreviousReleaseTag("stable", "v0.1.6-plusplus.1", [
      "v0.1.6-nightly.20261030.1",
      "v0.1.5-plusplus.2",
    ]);
    assert.equal(withNightlies, "v0.1.5-plusplus.2");
  }),
);

it.effect("accepts legacy nightly tags when selecting the previous nightly", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("nightly", "v1.2.0-nightly.20260620.2", [
      "nightly-v1.2.0-nightly.20260620.1",
      "v1.1.0-nightly.20260619.9",
    ]);

    assert.equal(previous, "nightly-v1.2.0-nightly.20260620.1");
  }),
);

it.effect("keeps preview tags in their own series", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("preview", "v1.2.0-preview.20260620.2", [
      "v1.2.0-nightly.20260620.3",
      "v1.2.0-preview.20260620.1",
      "v1.1.9",
    ]);
    assert.equal(previous, "v1.2.0-preview.20260620.1");

    const stable = yield* resolvePreviousReleaseTag("stable", "v1.2.0", [
      "v1.1.9",
      "v1.2.0-preview.20260620.1",
    ]);
    assert.equal(stable, "v1.1.9");
  }),
);
