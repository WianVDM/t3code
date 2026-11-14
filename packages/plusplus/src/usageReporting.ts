import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
  type UsageLimitsReport,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { readUsageAccounts } from "./contracts.ts";
import { cursorUsageWindowRank } from "./cursorUsageLimits.ts";
import type { LimitPace } from "./usageLimits.ts";
import {
  WINDOW_KIND_ORDER,
  elapsedShare,
  isFresherRead,
  limitsNotice,
  paceOfShares,
  resetMillis,
} from "./usageLimits.ts";

/**
 * Provider-neutral usage aggregation and presentation: multi-environment
 * account merging, notices, quota pools, external links, /usage-limits command
 * coverage, and the agent-facing usage report.
 */

export { cursorUsageWindowDetails } from "./cursorUsageLimits.ts";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** A ChatGPT Business admin caps plan use in other apps; only the admin can raise it. */
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE =
  "subscription_sharing_workplace_individual_usage_limit_exceeded";
/** OpenAI's partner guidelines fix this wording; the user sends it to their admin themselves. */
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

function providersWithLimits(providers: readonly ServerProvider[]): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      (provider.usageLimits !== undefined || (readUsageAccounts(provider)?.length ?? 0) > 0),
  );
}

interface ExternalUsageLink {
  readonly label: string;
  readonly url: string;
  readonly message: string | undefined;
  readonly accounts: readonly string[];
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<string, ExternalUsageLink>();
  const add = (
    external: { readonly label: string; readonly url: string } | undefined,
    message: string | undefined,
    account: string,
  ) => {
    if (!external) return;
    links.set(external.url, {
      ...external,
      message,
      accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
    });
  };
  for (const presentation of presentations.values()) {
    const on = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.auth.status !== "authenticated") continue;
      const name = provider.displayName ?? provider.instanceId;
      add(
        provider.usageLimits?.externalUsage,
        provider.usageLimits?.unavailable?.message,
        `${name} on ${on}`,
      );
      // Upstream accounts (e.g. OpenRouter) repeat the same destination on every entry.
      for (const account of readUsageAccounts(provider) ?? []) {
        const accountName = account.email?.trim() || accountIdLabel(account.id);
        add(
          account.usageLimits.externalUsage,
          account.usageLimits.unavailable?.message,
          `${name} · ${accountName} on ${on}`,
        );
      }
    }
  }
  return [...links.values()];
}

// Upstream account ids are credential file names, so the `.json` suffix is not part of the name.
function accountIdLabel(id: string): string {
  return id.replace(/\.json$/i, "");
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const planSources = new Map<string, LimitAccount>();
  const preferFreshest = (
    tracked: Map<string, LimitAccount>,
    key: string,
    candidate: LimitAccount | null,
  ) => {
    if (!candidate) return;
    const previous = tracked.get(key);
    if (!previous || isFresherRead(candidate.limits.checkedAt, previous.limits.checkedAt)) {
      tracked.set(key, candidate);
    }
  };
  const merge = (key: string, next: LimitAccount) => {
    // Prefer hub redemption: it also clears the routing cooldown.
    // The displayed balance still follows the freshest read.
    preferFreshest(hubRedeems, key, next.redeem && "sourceId" in next.redeem.input ? next : null);
    preferFreshest(creditSources, key, next.limits.resetCredits ? next : null);
    preferFreshest(planSources, key, next.plan ? next : null);
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = isFresherRead(next.limits.checkedAt, previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const creditSource = creditSources.get(key);
    // A hub e-mail names the account better than the driver's default instance name.
    const hubEmail = [previous, next].some(
      (account) => account.environments.length === 0 && account.email,
    );
    const displayName = previous.displayName ?? next.displayName;
    accounts.set(key, {
      ...previous,
      displayName:
        hubEmail &&
        displayName?.toLowerCase() === PROVIDER_DISPLAY_NAMES[previous.driver]?.toLowerCase()
          ? null
          : displayName,
      plan: planSources.get(key)?.plan ?? previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? []).flatMap((provider) =>
        provider.enabled ? [nativeReport(provider), ...(readUsageAccounts(provider) ?? [])] : [],
      ),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits && limitsNotice(provider.usageLimits) === null) {
        merge(resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`, {
          key: `${environmentId}:${provider.instanceId}`,
          driver: provider.driver,
          displayName: provider.displayName?.trim() || null,
          email: provider.auth.email,
          plan: provider.auth.label,
          accentColor: provider.accentColor,
          environments: [{ environmentId, label }],
          sourceLabel: null,
          redeem: { environmentId, input: { instanceId: provider.instanceId } },
          limits: provider.usageLimits,
        });
      }
      for (const account of readUsageAccounts(provider) ?? []) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const key = `${environmentId}:${provider.instanceId}:${account.id}`;
        merge(resolveKey(account) ?? key, {
          key,
          driver: account.driver,
          displayName: account.email ? null : accountIdLabel(account.id),
          email: account.email,
          plan: account.plan,
          accentColor: provider.accentColor,
          environments: [{ environmentId, label }],
          sourceLabel: null,
          redeem: null,
          limits: account.usageLimits,
        });
      }
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const key = `${source.id}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(resolveKey(account) ?? key, {
          key,
          driver: account.driver,
          displayName: account.email ? null : accountIdLabel(account.id),
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices = new Set<string>();
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const name = provider.displayName?.trim() || String(provider.driver);
      if (provider.usageLimits && provider.usageLimits.unavailable?.reason !== "unsupported") {
        const notice = limitsNotice(provider.usageLimits);
        if (notice) notices.add(`${label(environmentLabel, name)}: ${notice}`);
      }
      // A failed upstream account is dropped from the account list, so a notice is its only report.
      for (const account of readUsageAccounts(provider) ?? []) {
        if (account.usageLimits.unavailable?.reason === "unsupported") continue;
        const notice = limitsNotice(account.usageLimits);
        if (!notice) continue;
        const accountName = account.email?.trim() || accountIdLabel(account.id);
        notices.add(`${label(environmentLabel, `${name} · ${accountName}`)}: ${notice}`);
      }
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.add(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
    }
  }
  return [...notices];
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hasBothPools = hasAuto && hasApi;
  return pool.windows
    .filter((window) => !hasBothPools || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? resetMillis(poolMember(account, window, now).window) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number) {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.usedPercent >= 100 &&
            (account.driver === "claudeAgent"
              ? window.id === "seven_day"
              : account.driver === "codex" && window.kind === "weekly"),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot say when blocked quota becomes usable.
  if (
    weeklyReset !== null &&
    sessionReset !== null &&
    weeklyReset > cutoff &&
    sessionReset > cutoff
  ) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    const usedPercent = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    // A window with no reset clock adds spend but no elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, t) => sum + t.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.refillPercent / members.length),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  return providers.map((provider) => {
    if (!hasProviderUsageLimits(provider.driver, providers, sources)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (provider.driver !== selected.driver || !provider.usageLimits) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = resolveKey(nativeReport(provider)) ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        isFresherRead(snapshot.limits.checkedAt, previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit || isFresherRead(snapshot.limits.checkedAt, previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        isFresherRead(hubCredits.account.usageLimits.checkedAt, credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
  }
  for (const provider of providersWithLimits(providers)) {
    if (provider.driver !== selected.driver) continue;
    const providerLabel = provider.displayName?.trim() || String(provider.instanceId);
    for (const account of readUsageAccounts(provider) ?? []) {
      if (limitsNotice(account.usageLimits) !== null) continue;
      accounts.push({
        id: `${provider.instanceId}:${account.id}`,
        driver: account.driver,
        label: `${providerLabel} · ${account.id}`,
        sourceLabel: providerLabel,
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
        limits: account.usageLimits,
      });
    }
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${accountIdLabel(account.id)}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
