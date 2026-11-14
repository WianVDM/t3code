/**
 * Usage pricing facade: rate-table parsing, precedence, and cost splits live in
 * `@t3tools/plusplus/usagePricing`; this module preserves the original
 * `apps/server` surface for UsageService and aggregation.
 */

export {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  type ModelRate,
  parseRateTable,
  type PricedRecord,
  priceUsage,
  type PricedUsage,
  type RateTable,
  type TokenRates,
} from "@t3tools/plusplus/usagePricing";
