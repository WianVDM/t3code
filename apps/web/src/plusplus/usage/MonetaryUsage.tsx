import type { LimitAccount, LimitPool } from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";

import { monetaryUsageOf, monetaryUsageText } from "./monetaryUsage.logic";

/** Per-account monetary spend for one provider pool, rendered under its rate-limit windows. */
export function MonetaryUsageAccounts({
  pool,
  showEmptyLabel,
  renderAccountName,
}: {
  readonly pool: LimitPool;
  readonly showEmptyLabel: boolean;
  readonly renderAccountName: (account: LimitAccount, className: string) => ReactNode;
}) {
  const rows = pool.accounts.flatMap((account) => {
    const monetary = monetaryUsageOf(account.limits);
    return monetary ? [{ account, monetary }] : [];
  });
  if (!showEmptyLabel && rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-4">
      {showEmptyLabel ? (
        <span className="text-xs text-muted-foreground">No rate-limit windows reported</span>
      ) : null}
      {rows.map(({ account, monetary }) => (
        <span key={account.key} className="flex items-baseline justify-between gap-3 text-xs">
          {renderAccountName(account, "min-w-0 truncate font-medium text-foreground")}
          <span className="shrink-0 text-foreground tabular-nums">
            {monetaryUsageText(monetary)}
          </span>
        </span>
      ))}
    </div>
  );
}
