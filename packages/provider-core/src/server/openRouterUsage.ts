import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  openRouterKeyData,
  openRouterUsageAccount,
  type OpenRouterUsageInput,
} from "@t3tools/plusplus/openRouterUsage";

/**
 * OpenRouter usage facade: payload interpretation lives in
 * `@t3tools/plusplus/openRouterUsage`; this module owns the HTTP probe.
 */

export type { OpenRouterUsageInput };

const KEY_URL = "https://openrouter.ai/api/v1/key";
const PROBE_TIMEOUT = "10 seconds";

/**
 * The key only ever leaves this function as the bearer token; transport errors can
 * quote the request, so failures fold into a probeFailed account, never callers or logs.
 */
export const readOpenRouterUsageAccount = Effect.fn("readOpenRouterUsageAccount")(function* (
  input: OpenRouterUsageInput,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const data = yield* Effect.gen(function* () {
    const response = yield* httpClient.execute(
      HttpClientRequest.get(KEY_URL).pipe(HttpClientRequest.bearerToken(input.credential.key)),
    );
    if (response.status < 200 || response.status >= 300) return undefined;
    const body = yield* response.json;
    return openRouterKeyData(body);
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    // Stalled or malformed probes fold into the existing probeFailed account, with no retry.
    Effect.orElseSucceed(() => undefined),
  );
  return openRouterUsageAccount(input, data);
});
