import { FORK_HOST, FORK_REPOSITORY } from "@t3tools/plusplus/forkRepository";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SourceControlBuiltInDrivers from "../sourceControl/builtInDrivers.ts";

const ACCESS_TTL = Duration.hours(1);
const NO_ACCESS_TTL = Duration.minutes(10);
const CACHE_KEY = "fork-push-access";

export class UpstreamMergeAccess extends Context.Service<
  UpstreamMergeAccess,
  { readonly check: Effect.Effect<boolean> }
>()("t3/plusplus/UpstreamMergeAccess") {}

/** @public */
export const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;
  const lookup = Effect.fn("UpstreamMergeAccess.lookup")(
    function* () {
      const canPush = drivers.find(({ driver }) => driver.kind === "github")?.instance
        .canPushRepository;
      return canPush === undefined ? false : yield* canPush(FORK_HOST, FORK_REPOSITORY);
    },
    Effect.orElseSucceed(() => false),
  );
  const cache = yield* Cache.makeWith(lookup, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value ? ACCESS_TTL : NO_ACCESS_TTL),
  });

  const check = Effect.fn("UpstreamMergeAccess.check")(function* () {
    return yield* Cache.get(cache, CACHE_KEY);
  });
  return UpstreamMergeAccess.of({ check: Effect.suspend(check) });
});

export const layer = Layer.effect(UpstreamMergeAccess, make);
