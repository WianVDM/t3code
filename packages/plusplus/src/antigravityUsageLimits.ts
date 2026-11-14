import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Provider-neutral Antigravity quota interpretation: summary/model payload
 * schemas and window construction. OAuth refresh, HTTP, caching, and the token
 * fingerprint stay in the server facade's probe.
 */

const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);

const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
export const AntigravityQuotaSummary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
export const AntigravityModels = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});

export const decodeAntigravityQuotaSummary = Schema.decodeUnknownEffect(AntigravityQuotaSummary);
export const decodeAntigravityModels = Schema.decodeUnknownEffect(AntigravityModels);

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(
  bucket: typeof Bucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <=
      60_000;
  return untouched ? undefined : bucket.resetTime;
}

export function antigravitySummaryWindows(
  summary: typeof AntigravityQuotaSummary.Type,
  requestedAt: number,
) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      // Argon is metered apart from the default Gemini buckets; keep its group name.
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : bucket.bucketId.startsWith("gemini-")
          ? "Gemini"
          : bucket.bucketId.startsWith("3p-")
            ? "Claude & GPT (shared)"
            : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        { ...bucket, resetTime: summaryResetTime(bucket, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
export function antigravityModelWindows(models: typeof AntigravityModels.Type) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family) continue;
    for (const [suffix, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}
