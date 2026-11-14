import { formatUsd } from "@t3tools/shared/usageFormat";
import { readMonetaryUsage, type LimitAccount } from "@t3tools/shared/usageLimits";

export type MonetaryUsage = NonNullable<LimitAccount["limits"]["monetaryUsage"]>;

export function monetaryUsageOf(limits: LimitAccount["limits"]): MonetaryUsage | null {
  const monetary = readMonetaryUsage(limits);
  if (!monetary) return null;
  const { usedUsd, remainingUsd, limitUsd } = monetary;
  return usedUsd === undefined && remainingUsd === undefined && limitUsd === undefined
    ? null
    : monetary;
}

export function monetaryUsageText(monetary: MonetaryUsage): string {
  return [
    monetary.usedUsd !== undefined ? `${formatUsd(monetary.usedUsd)} used` : null,
    monetary.remainingUsd !== undefined ? `${formatUsd(monetary.remainingUsd)} left` : null,
    monetary.limitUsd !== undefined ? `${formatUsd(monetary.limitUsd)} limit` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
