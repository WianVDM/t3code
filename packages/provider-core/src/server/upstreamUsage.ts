import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Upstream usage facade: provider-neutral probing lives in
 * `@t3tools/plusplus/upstreamUsage`; credential discovery from host auth files
 * stays here because it reads the filesystem.
 */

export {
  probeUpstreamUsage,
  type StoredUpstreamCredential,
  type UpstreamUsageReader,
  type UpstreamUsageReaderContext,
} from "@t3tools/plusplus/upstreamUsage";

import type { StoredUpstreamCredential } from "@t3tools/plusplus/upstreamUsage";

// Secrets stay in the returned credential and are never logged or embedded in errors.
const UpstreamAuthEntry = Schema.Struct({
  type: Schema.Literals(["api_key", "api"]),
  key: Schema.optional(Schema.String),
});
const UpstreamAuthFile = Schema.Record(Schema.String, Schema.Unknown);
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(UpstreamAuthFile));
const decodeAuthEntry = Schema.decodeUnknownOption(UpstreamAuthEntry);

export const discoverUpstreamCredentials = Effect.fn("discoverUpstreamCredentials")(function* (
  authPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(authPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
  );
  const authFile = yield* decodeAuthFile(contents);
  const credentials: StoredUpstreamCredential[] = [];
  for (const [providerId, stored] of Object.entries(authFile)) {
    const entry = decodeAuthEntry(stored);
    if (Option.isNone(entry)) continue;
    const trimmedId = providerId.trim();
    if (!trimmedId) continue;
    const secret = entry.value.key?.trim();
    credentials.push({
      providerId: trimmedId,
      authType: entry.value.type,
      ...(secret ? { secret } : {}),
    });
  }
  return credentials;
});
