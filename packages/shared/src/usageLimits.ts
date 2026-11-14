/**
 * Usage-limits facade: provider-neutral logic lives in `@t3tools/plusplus`;
 * this module preserves the original `@t3tools/shared/usageLimits` surface.
 */

export { CURSOR_USAGE_WINDOWS } from "@t3tools/plusplus/cursorUsageLimits";

export {
  elapsedShare,
  exhaustedUsageWindow,
  formatDuration,
  formatResetsIn,
  type LimitPace,
  limitsNotice,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  resolveNewThreadModelSelection,
} from "@t3tools/plusplus/usageLimits";

export {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_USAGE_URL,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  collectProviderUsageLimits,
  cursorUsageWindowDetails,
  displayLimitWindows,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  type LimitPresentations,
  sameUsageLimitCommandCoverage,
  USAGE_LIMITS_COMMAND,
  usesChatGptSharing,
  withUsageLimitsCommands,
} from "@t3tools/plusplus/usageReporting";
