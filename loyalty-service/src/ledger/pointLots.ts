/**
 * Shared Point_Lot creation for Balance-increasing ledger entries (Property 17).
 *
 * `Spendable_Balance` is derived SOLELY from non-expired Point_Lot remainders
 * (Req 1.3), so any credit appended to the ledger without a matching lot is
 * permanently unspendable — the customer's history shows points they can never
 * redeem. Req 1.3a therefore requires every Balance-increasing entry to carry a
 * matching lot:
 *
 *   - signup, order, first-purchase and referral earnings → 12-month expiry
 *     (Req 2.6, 2.9, 2.10; A1);
 *   - positive admin adjustments and manual credits → 12-month expiry
 *     (Req 10.2a, 10.4);
 *   - migration entries and failed-redemption reversals → non-expiring
 *     (Req 14.4, 3.9), created by their own modules which already set
 *     `expires_at = NULL`.
 *
 * This module owns the expiring-lot path so the earning, referral and admin
 * writers share one implementation rather than duplicating the SQL and the
 * calendar arithmetic.
 *
 * SAFETY: pure DB helper — it runs on the caller's transaction client and
 * touches no external system.
 */
import type { LedgerEntry, Queryable } from "./repository.js";

/** Points expire 12 months after the earning date (A1). */
export const LOT_EXPIRY_MONTHS = 12 as const;

/**
 * Inserts a matching Point_Lot for a credit: `original_points` and
 * `remaining_points` both equal the entry's points, `earned_at` equals the
 * entry's timestamp, and `expires_at` is exactly {@link LOT_EXPIRY_MONTHS}
 * months later (or NULL for a non-expiring lot).
 */
const INSERT_POINT_LOT_SQL = `
  INSERT INTO point_lots
    (customer_id, ledger_entry_id, original_points, remaining_points, earned_at, expires_at)
  VALUES ($1, $2, $3, $3, $4, $5)
  RETURNING id
`;

/**
 * Adds a whole number of calendar months to a date, clamping the day of month
 * to the target month's last day (so e.g. 29 Feb + 12 months → 28 Feb).
 * Computed in UTC for determinism.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonthFirst = new Date(
    Date.UTC(
      year,
      month + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  // Last day of the target month = day 0 of the following month.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetMonthFirst.getUTCFullYear(), targetMonthFirst.getUTCMonth() + 1, 0),
  ).getUTCDate();
  targetMonthFirst.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return targetMonthFirst;
}

/**
 * Creates the Point_Lot backing a Balance-increasing ledger entry, expiring
 * exactly {@link LOT_EXPIRY_MONTHS} months after the entry's timestamp
 * (Property 17). MUST run on the same transaction client as the append so the
 * entry and its lot commit together.
 *
 * A non-positive entry carries no lot (a spend, clawback or expiry consumes
 * lots rather than creating one), so such an entry is ignored.
 */
export async function createExpiringPointLot(
  executor: Queryable,
  customerId: string,
  entry: LedgerEntry,
): Promise<void> {
  if (entry.points <= 0) {
    return;
  }
  const earnedAt = entry.createdAt;
  const expiresAt = addMonths(earnedAt, LOT_EXPIRY_MONTHS);
  await executor.query(INSERT_POINT_LOT_SQL, [
    customerId,
    entry.id,
    entry.points,
    earnedAt,
    expiresAt,
  ]);
}
