/**
 * Claude usage facade: rate-limit interpretation lives in
 * `@t3tools/plusplus/claudeUsageLimits` against structural payload types that
 * the agent SDK's `get_usage` and rate-limit events satisfy.
 */

export {
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  type ClaudeScopedLimitNames,
  makeClaudeScopedLimitNames,
  recordClaudeUsageResponse,
} from "@t3tools/plusplus/claudeUsageLimits";
