import type {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";

import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./usageLimits.ts";

/**
 * Provider-neutral OpenRouter key-usage interpretation. The HTTP probe and its
 * timeout stay in the provider-core facade, which passes the decoded body here.
 */

const OPENROUTER_ACTIVITY_URL = "https://openrouter.ai/activity";
const OPENROUTER_PROBE_FAILED_MESSAGE = "OpenRouter could not read this account's usage.";

export interface OpenRouterUsageInput {
  readonly driver: ProviderDriverKind;
  readonly credential: {
    readonly provider: string;
    readonly key: string;
  };
  readonly checkedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenRouter reports these as numbers or null. */
function usd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Extracts the key payload from a raw `/api/v1/key` response body. */
export function openRouterKeyData(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body.data) ? body.data : undefined;
}

/**
 * Builds the account for a decoded key payload; `undefined` (a non-2xx status,
 * a stalled probe, or a malformed body) folds into the probeFailed account.
 */
export function openRouterUsageAccount(
  input: OpenRouterUsageInput,
  data: Record<string, unknown> | undefined,
): UsageLimitSourceAccount {
  if (data === undefined) {
    return {
      id: input.credential.provider,
      driver: input.driver,
      usageLimits: makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "probeFailed",
        message: OPENROUTER_PROBE_FAILED_MESSAGE,
      }),
    };
  }
  const usage = usd(data.usage);
  const limit = usd(data.limit);
  const remaining = usd(data.limit_remaining);
  const windows: ReadonlyArray<ServerProviderUsageWindow> =
    limit !== undefined && limit > 0
      ? [
          {
            id: "credit_limit",
            kind: "other",
            label: "OpenRouter credit limit",
            usedPercent: clampPercent(((usage ?? 0) / limit) * 100),
          },
        ]
      : [];
  return {
    id: input.credential.provider,
    driver: input.driver,
    plan:
      data.is_free_tier === true
        ? "OpenRouter Free Tier"
        : data.is_free_tier === false
          ? "OpenRouter Pay as you go"
          : "OpenRouter",
    usageLimits: {
      ...makeUsageLimits({ checkedAt: input.checkedAt, windows }),
      monetaryUsage: {
        ...(usage !== undefined ? { usedUsd: usage } : {}),
        ...(remaining !== undefined ? { remainingUsd: remaining } : {}),
        ...(limit !== undefined ? { limitUsd: limit } : {}),
      },
      externalUsage: { label: "OpenRouter activity", url: OPENROUTER_ACTIVITY_URL },
    },
  };
}
