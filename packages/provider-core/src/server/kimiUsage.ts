import type {
  ProviderDriverKind,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  kimiProbeFailedLimits,
  kimiUsageResponseToLimits,
} from "@t3tools/plusplus/kimiUsageLimits";
import { makeUnavailableUsageLimits } from "@t3tools/plusplus/usageLimits";

/**
 * Kimi Code hub-usage facade: payload parsing lives in
 * `@t3tools/plusplus/kimiUsageLimits`; this module owns the HTTP probe.
 */

export interface KimiUsageInput {
  readonly driver: ProviderDriverKind;
  readonly credential: { readonly provider: string; readonly key: string };
  readonly checkedAt: string;
}

const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usage";
const PROBE_TIMEOUT = "10 seconds";

function kimiUsageAccount(
  input: KimiUsageInput,
  usageLimits: ServerProviderUsageLimits,
): UsageLimitSourceAccount {
  return {
    id: input.credential.provider,
    driver: input.driver,
    plan: "Kimi Code",
    usageLimits,
  };
}

export const readKimiCodeUsageAccount = Effect.fn("readKimiCodeUsageAccount")(function* (
  input: KimiUsageInput,
) {
  const token = input.credential.key.trim();
  if (token.length === 0) {
    return kimiUsageAccount(
      input,
      makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "unsupported" }),
    );
  }
  const usageLimits = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const usagesResponse = yield* client.execute(
      HttpClientRequest.get(KIMI_USAGES_URL).pipe(HttpClientRequest.bearerToken(token)),
    );
    // Older deployments only expose the singular endpoint; no other status retries.
    const response =
      usagesResponse.status === 404
        ? yield* client.execute(
            HttpClientRequest.get(KIMI_USAGE_URL).pipe(HttpClientRequest.bearerToken(token)),
          )
        : usagesResponse;
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return kimiUsageResponseToLimits(body, input.checkedAt);
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    // Failed requests carry the credential; the fallback message is the only one surfaced.
    Effect.orElseSucceed(() => kimiProbeFailedLimits(input.checkedAt)),
  );
  return kimiUsageAccount(input, usageLimits);
});
