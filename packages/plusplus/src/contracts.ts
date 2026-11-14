/**
 * Typed ++ sidecars for the optional `plusplus` carrier on upstream contract structs.
 * Sidecar-first reads, legacy fallback; dual-writes limited to EXC-09 in `config/fork-inventory.json`.
 * All future ++ data is sidecar-only.
 */
import {
  ContextBridgeRoute,
  ContextBridgeSettings,
  ServerProviderMonetaryUsage,
  type ServerProvider,
  type ServerProviderUsageLimits,
  TrimmedNonEmptyString,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Strict stored shape: no decoding defaults, so partial or malformed areas fall back to legacy. */
export const ContextBridgeSidecarSettings = Schema.Struct({
  enabled: Schema.Boolean,
  defaultSource: Schema.String,
  routes: Schema.Record(Schema.String, ContextBridgeRoute),
});
export type ContextBridgeSidecarSettings = typeof ContextBridgeSidecarSettings.Type;

export const ContextBridgeSidecarPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  defaultSource: Schema.optionalKey(Schema.String),
  routes: Schema.optionalKey(Schema.Record(Schema.String, ContextBridgeRoute)),
});
export type ContextBridgeSidecarPatch = typeof ContextBridgeSidecarPatch.Type;

/** Empty monetary usage, empty usage accounts, and empty route maps are authoritative. */
export const MonetaryUsageSidecar = ServerProviderMonetaryUsage;
export const UsageAccountsSidecar = Schema.Array(UsageLimitSourceAccount);
export const StartedAtSidecar = TrimmedNonEmptyString;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSidecarArea<S extends Schema.Top>(
  schema: S,
  plusplus: unknown,
  key: string,
): Schema.Schema.Type<S> | undefined {
  if (!isPlainRecord(plusplus)) return undefined;
  const value = plusplus[key];
  if (value === undefined) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(schema as never)(value) as Option.Option<Schema.Schema.Type<S>>,
  );
}

function withArea(plusplus: unknown, key: string, value: unknown): Record<string, unknown> {
  return { ...(isPlainRecord(plusplus) ? plusplus : {}), [key]: value };
}

function withoutArea(plusplus: unknown, key: string): Record<string, unknown> | undefined {
  if (!isPlainRecord(plusplus)) return undefined;
  const { [key]: _dropped, ...rest } = plusplus;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export interface ContextBridgeSettingsLike {
  readonly contextBridge?: ContextBridgeSettings | undefined;
  readonly plusplus?: unknown;
}

const DEFAULT_CONTEXT_BRIDGE_SETTINGS: ContextBridgeSettings = Schema.decodeSync(
  ContextBridgeSettings,
)({});

export function readContextBridgeSettings(
  settings: ContextBridgeSettingsLike,
): ContextBridgeSettings {
  return (
    decodeSidecarArea(ContextBridgeSidecarSettings, settings.plusplus, "contextBridge") ??
    settings.contextBridge ??
    DEFAULT_CONTEXT_BRIDGE_SETTINGS
  );
}

export interface PendingBackgroundTaskStartedAtLike {
  readonly startedAt?: string | undefined;
  readonly plusplus?: unknown;
}

export function readPendingBackgroundTaskStartedAt(
  task: PendingBackgroundTaskStartedAtLike,
): string | undefined {
  return decodeSidecarArea(StartedAtSidecar, task.plusplus, "startedAt") ?? task.startedAt;
}

export interface MonetaryUsageLimitsLike {
  readonly monetaryUsage?: ServerProviderMonetaryUsage | undefined;
  readonly plusplus?: unknown;
}

export function readMonetaryUsage(
  limits: MonetaryUsageLimitsLike,
): ServerProviderMonetaryUsage | undefined {
  return (
    decodeSidecarArea(MonetaryUsageSidecar, limits.plusplus, "monetaryUsage") ??
    limits.monetaryUsage
  );
}

export interface UsageAccountsProviderLike {
  readonly usageAccounts?: ReadonlyArray<UsageLimitSourceAccount> | undefined;
  readonly plusplus?: unknown;
}

export function readUsageAccounts(
  provider: UsageAccountsProviderLike,
): ReadonlyArray<UsageLimitSourceAccount> | undefined {
  return (
    decodeSidecarArea(UsageAccountsSidecar, provider.plusplus, "usageAccounts") ??
    provider.usageAccounts
  );
}

/** Dual-write fields for freshly built pending background tasks; both stay absent when unknown. */
export function pendingBackgroundTaskStartedAtFields(startedAt: string | undefined): {
  readonly startedAt?: string;
  readonly plusplus?: { readonly startedAt: string };
} {
  if (startedAt === undefined) return {};
  return { startedAt, plusplus: { startedAt } };
}

/** Dual-write fields for freshly built provider snapshots; an empty array is authoritative. */
export function usageAccountsFields(accounts: ReadonlyArray<UsageLimitSourceAccount> | undefined): {
  readonly usageAccounts?: ReadonlyArray<UsageLimitSourceAccount>;
  readonly plusplus?: { readonly usageAccounts: ReadonlyArray<UsageLimitSourceAccount> };
} {
  if (accounts === undefined) return {};
  return { usageAccounts: accounts, plusplus: { usageAccounts: accounts } };
}

export function withMonetaryUsage(
  limits: ServerProviderUsageLimits,
  monetary: ServerProviderMonetaryUsage | undefined,
): ServerProviderUsageLimits {
  const { monetaryUsage: _legacy, plusplus: _carrier, ...rest } = limits;
  const plusplus =
    monetary === undefined
      ? withoutArea(limits.plusplus, "monetaryUsage")
      : withArea(limits.plusplus, "monetaryUsage", monetary);
  return {
    ...rest,
    ...(monetary === undefined ? {} : { monetaryUsage: monetary }),
    ...(plusplus === undefined ? {} : { plusplus }),
  };
}

/** Stamps the sidecar mirror of an account's released monetary usage, preserving other areas. */
export function withUsageAccountSidecars(
  account: UsageLimitSourceAccount,
): UsageLimitSourceAccount {
  return {
    ...account,
    usageLimits: withMonetaryUsage(account.usageLimits, readMonetaryUsage(account.usageLimits)),
  };
}

export function withUsageAccounts(
  provider: ServerProvider,
  accounts: ReadonlyArray<UsageLimitSourceAccount> | undefined,
): ServerProvider {
  const { usageAccounts: _legacy, plusplus: _carrier, ...rest } = provider;
  const plusplus =
    accounts === undefined
      ? withoutArea(provider.plusplus, "usageAccounts")
      : withArea(provider.plusplus, "usageAccounts", accounts);
  return {
    ...rest,
    ...(accounts === undefined ? {} : { usageAccounts: accounts }),
    ...(plusplus === undefined ? {} : { plusplus }),
  } as ServerProvider;
}

export interface ContextBridgeSettingsPatchLike {
  readonly contextBridge?:
    | {
        readonly enabled?: boolean | undefined;
        readonly defaultSource?: string | undefined;
        readonly routes?: Record<string, ContextBridgeRoute> | undefined;
      }
    | undefined;
  readonly plusplus?: unknown;
}

/**
 * Resolves a settings patch against the sidecar-first current settings:
 * enabled/defaultSource merge, routes replace wholesale. A valid sidecar patch
 * area wins over the legacy patch fields. `null` means the patch touches
 * neither representation.
 */
export function mergeContextBridgeSettingsPatch(
  current: ContextBridgeSettingsLike,
  patch: ContextBridgeSettingsPatchLike,
): ContextBridgeSettings | null {
  const area =
    decodeSidecarArea(ContextBridgeSidecarPatch, patch.plusplus, "contextBridge") ??
    patch.contextBridge;
  if (area === undefined) return null;
  const base = readContextBridgeSettings(current);
  return {
    enabled: area.enabled ?? base.enabled,
    defaultSource: area.defaultSource ?? base.defaultSource,
    routes: area.routes ?? base.routes,
  };
}

/** Shallow carrier merge where the patch record wins; `undefined` keeps output sparse. */
export function mergeSidecarCarriers(
  current: unknown,
  patch: unknown,
): Record<string, unknown> | undefined {
  const merged = {
    ...(isPlainRecord(current) ? current : {}),
    ...(isPlainRecord(patch) ? patch : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
