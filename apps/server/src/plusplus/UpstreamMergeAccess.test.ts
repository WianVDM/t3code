import { expect, it } from "@effect/vitest";
import { definition } from "@t3tools/source-control-github/shared/definition";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as SourceControlBuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as UpstreamMergeAccess from "./UpstreamMergeAccess.ts";

type CanPush = NonNullable<SourceControlDriverInstance["canPushRepository"]>;

function testLayer(canPushRepository?: CanPush) {
  const instance = { canPushRepository } as SourceControlDriverInstance;
  const drivers = Layer.succeed(SourceControlBuiltInDrivers.SourceControlDrivers, [
    { driver: { kind: definition.kind, definition }, instance },
  ]);
  return Layer.effect(UpstreamMergeAccess.UpstreamMergeAccess, UpstreamMergeAccess.make).pipe(
    Layer.provide(drivers),
    Layer.provideMerge(TestClock.layer()),
  );
}

it.effect("returns the GitHub driver's answer for the fixed fork", () => {
  const canPush = vi.fn<CanPush>().mockReturnValue(Effect.succeed(true));
  return Effect.gen(function* () {
    const access = yield* UpstreamMergeAccess.UpstreamMergeAccess;
    expect(yield* access.check).toBe(true);
    expect(canPush).toHaveBeenCalledWith("github.com", "WianVDM/t3code");
  }).pipe(Effect.provide(testLayer(canPush)));
});

it.effect("returns false without a GitHub push capability", () =>
  Effect.gen(function* () {
    const access = yield* UpstreamMergeAccess.UpstreamMergeAccess;
    expect(yield* access.check).toBe(false);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("checks GitHub once while a true result is cached", () => {
  const canPush = vi.fn<CanPush>().mockReturnValue(Effect.succeed(true));
  return Effect.gen(function* () {
    const access = yield* UpstreamMergeAccess.UpstreamMergeAccess;
    expect(yield* access.check).toBe(true);
    expect(yield* access.check).toBe(true);
    yield* TestClock.adjust("59 minutes");
    expect(yield* access.check).toBe(true);
    expect(canPush).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust("1 minute");
    expect(yield* access.check).toBe(true);
    expect(canPush).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(testLayer(canPush)));
});

it.effect("expires a false result after ten minutes", () => {
  const canPush = vi
    .fn<CanPush>()
    .mockReturnValueOnce(Effect.succeed(false))
    .mockReturnValueOnce(Effect.succeed(true));
  return Effect.gen(function* () {
    const access = yield* UpstreamMergeAccess.UpstreamMergeAccess;
    expect(yield* access.check).toBe(false);
    expect(yield* access.check).toBe(false);
    yield* TestClock.adjust("9 minutes");
    expect(yield* access.check).toBe(false);
    expect(canPush).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust("1 minute");
    expect(yield* access.check).toBe(true);
    expect(canPush).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(testLayer(canPush)));
});
