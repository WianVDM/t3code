import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  KIMI_PROBE_FAILED_MESSAGE,
  kimiUsageResponseToLimits as parseKimiUsageResponse,
} from "@t3tools/plusplus/kimiUsageLimits";
import { makeUnavailableUsageLimits } from "@t3tools/plusplus/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Pi Kimi Code usage facade: payload parsing lives in
 * `@t3tools/plusplus/kimiUsageLimits`; this module owns credential discovery
 * and the HTTP probe. Pi keeps raw `limit_*` keys as window ids.
 */

const AuthFile = Schema.Record(Schema.String, Schema.Unknown);
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const KimiCredential = Schema.Struct({
  type: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
});
const decodeKimiCredential = Schema.decodeUnknownOption(KimiCredential);

const KIMI_CREDENTIAL_KEY = "kimi-coding";
const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usage";
const DEFAULT_PROBE_ERROR_MESSAGE = KIMI_PROBE_FAILED_MESSAGE;
const PROBE_TIMEOUT = "10 seconds";

export function kimiUsageResponseToLimits(
  response: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  return parseKimiUsageResponse(response, checkedAt, {
    genericLimitWindowId: (key) => key,
  });
}

const readKimiCredential = Effect.fn("readKimiCredential")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  const dir = path.resolve(
    agentDir ? expandHomePath(agentDir, home) : path.join(home, ".pi", "agent"),
  );
  const authPath = path.join(dir, "auth.json");
  const contents = yield* fileSystem.readFileString(authPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
  );
  const decoded = yield* decodeAuthFile(contents);
  const rawEntry = decoded[KIMI_CREDENTIAL_KEY];
  const credential = decodeKimiCredential(rawEntry);
  if (
    Option.isSome(credential) &&
    credential.value.type === "api_key" &&
    typeof credential.value.key === "string" &&
    credential.value.key.trim().length > 0
  ) {
    return { key: credential.value.key.trim() };
  }
  return undefined;
});

export const readKimiCodeAccount = Effect.fn("readKimiCodeAccount")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: DEFAULT_PROBE_ERROR_MESSAGE,
  });
  const credential = yield* Effect.option(
    readKimiCredential(environment).pipe(Effect.timeout(PROBE_TIMEOUT)),
  );
  if (Option.isNone(credential)) return { usageLimits: probeFailed };

  const token = credential.value?.key?.trim();
  if (!token) {
    return { usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }) };
  }

  const usageLimits = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const initialResponse = yield* client.execute(
      HttpClientRequest.get(KIMI_USAGES_URL).pipe(HttpClientRequest.bearerToken(token)),
    );
    // Certain endpoints use singular /usage; retry before reporting failure.
    const response =
      initialResponse.status === 404
        ? yield* client.execute(
            HttpClientRequest.get(KIMI_USAGE_URL).pipe(HttpClientRequest.bearerToken(token)),
          )
        : initialResponse;
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return kimiUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => probeFailed),
  );

  return { usageLimits };
});
