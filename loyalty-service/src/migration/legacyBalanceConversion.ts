/**
 * ONE-TIME legacy point-balance conversion for the historical migration.
 *
 * THE RULE (owner decision, 2026-08-22)
 * ------------------------------------
 * > Positive fractional legacy point balances are rounded UPWARD to the next
 * > whole point during migration, so migration never reduces a customer's
 * > previously represented loyalty value. Future earning remains governed by the
 * > current integer-point engine.
 *
 * WHY ROUNDING UP RATHER THAN FLOORING. The legacy storefront earned
 * `50 + spend` WITHOUT flooring, so pence were carried as fractional points. Our
 * ledger stores integer points only. Flooring would silently confiscate a
 * benefit the customer could already see on their dashboard — e.g. production
 * customer …4995 holds `83.75` against £33.75 of real spend, and flooring would
 * hand them 83. Rounding up hands them 84 and treats the extra 0.25 as a
 * declared, auditable one-time migration adjustment.
 *
 * SCOPE — READ THIS BEFORE REUSING ANYTHING HERE
 * ----------------------------------------------
 * This module applies to LEGACY CONVERSION ONLY. It must never be reachable from
 * the earning path. Future orders earn `floor(subtotal × tierMultiplier)` exactly
 * as they do today; nothing in this file changes that, and no earning module
 * imports it. The ledger is NOT being redesigned to hold decimals — the decimal
 * exists only in the legacy metafield being read, and is resolved to an integer
 * here, once, at migration time.
 *
 * SAFETY: pure arithmetic. No I/O, no database, no Shopify call. It decides a
 * number; it writes nothing.
 */
// The legacy earning rate, imported rather than restated: the refund
// normalisation below must use the SAME £1 = 1 point rate the balance formula
// uses, or the two would drift.
import { EARN_RATE_PER_GBP } from "./m0Export.js";

/** The outcome of converting one legacy balance into ledger integer points. */
export type LegacyBalanceConversion =
  | {
      ok: true;
      /** The integer points to migrate into the ledger. */
      integerPoints: number;
      /** The legacy value this came from, unchanged. */
      legacyBalance: number;
      /**
       * `integerPoints - legacyBalance` — the one-time migration adjustment, in
       * points. `0` for an already-whole balance; `> 0` and `< 1` when rounded up.
       * Recorded so the uplift is auditable rather than invisible.
       */
      adjustment: number;
      /** Which branch of the rule applied. */
      rule: "exact" | "rounded_up";
    }
  | {
      ok: false;
      /** Why no conversion could be decided; the operator must resolve it. */
      reason: string;
    };

/**
 * Converts a legacy fractional point balance into the integer points to migrate.
 *
 *   `50`     → `{ integerPoints: 50, adjustment: 0,    rule: "exact" }`
 *   `83.75`  → `{ integerPoints: 84, adjustment: 0.25, rule: "rounded_up" }`
 *   `55.99`  → `{ integerPoints: 56, adjustment: 0.01, rule: "rounded_up" }`
 *   `0`      → `{ integerPoints: 0,  adjustment: 0,    rule: "exact" }`
 *
 * Refuses, rather than guessing, on a non-finite or negative input: a negative
 * legacy balance has never been observed and would mean the legacy data is
 * misunderstood, which is an operator decision and not something to round.
 */
export function convertLegacyBalanceToPoints(legacyBalance: number): LegacyBalanceConversion {
  if (typeof legacyBalance !== "number" || !Number.isFinite(legacyBalance)) {
    return {
      ok: false,
      reason: `Legacy balance ${String(legacyBalance)} is not a finite number; it cannot be converted and must be resolved by an operator.`,
    };
  }

  if (legacyBalance < 0) {
    return {
      ok: false,
      reason: `Legacy balance ${legacyBalance} is negative. Negative legacy balances have never been observed in production; converting one would encode a misunderstanding of the legacy data, so it must be resolved by an operator.`,
    };
  }

  if (Number.isInteger(legacyBalance)) {
    return { ok: true, integerPoints: legacyBalance, legacyBalance, adjustment: 0, rule: "exact" };
  }

  const integerPoints = Math.ceil(legacyBalance);
  // Compute the adjustment in a fixed decimal space: 84 - 83.75 in binary
  // floating point is 0.25000000000000355..., and an audit figure should read
  // 0.25. Two decimal places is exact for legacy values derived from GBP pence.
  const adjustment = Number((integerPoints - legacyBalance).toFixed(2));

  return { ok: true, integerPoints, legacyBalance, adjustment, rule: "rounded_up" };
}

/* ===========================================================================
 * LEGACY REFUND NORMALISATION (owner decision, 2026-08-22)
 * ===========================================================================
 *
 * THE SECOND RULE. Rounding up is correct for a fractional balance the customer
 * legitimately RETAINED. It is wrong for a fractional balance that exists only
 * because the legacy system counted spend that was later refunded.
 *
 * > Points attributable exclusively to fully refunded spend are excluded during
 * > migration. Removing them is a legacy REFUND NORMALISATION, not ordinary
 * > fractional rounding.
 *
 * WHY THE TWO RULES MUST BE COMPOSED, NOT CHOSEN BETWEEN. The legacy formula was
 * `50 + spend`, un-floored AND without deducting refunds. So a legacy balance can
 * carry both a legitimate fraction and a refunded component at once. Applying
 * only one rule would be wrong in either order of arrival. So the resolver
 * ALWAYS does both, in this order:
 *
 *   1. Subtract the points legacy granted for spend that was later refunded.
 *      The current engine claws back refunds (`refunds/create` → clawback), so
 *      keeping them would migrate points the live rules would already have
 *      removed.
 *   2. Round any remaining fraction UP, so migration never reduces the value the
 *      customer legitimately retained.
 *
 * Worked against the two REAL production customers:
 *
 *   …4995  legacy 83.75, retained £33.75, refunded £0.00
 *          → step 1: 83.75 - 0    = 83.75   (nothing refunded)
 *          → step 2: ceil(83.75)  = 84      rule `rounded_up`
 *
 *   …4627  legacy 55.99, retained £0.00,  refunded £5.99
 *          → step 1: 55.99 - 5.99 = 50.00   (order #1006 paid then fully refunded)
 *          → step 2: already whole = 50      rule `refund_normalised`
 *
 * Both owner decisions therefore fall out of ONE rule rather than two special
 * cases keyed to two customer ids, which is what stops them drifting.
 *
 * SCOPE: one-time legacy conversion only. Future earning is unchanged —
 * `floor(subtotal × tierMultiplier)` at order time, with the existing refund
 * clawback handling refunds thereafter.
 */

/** Which rule(s) produced the migrated integer balance. */
export type LegacyMigrationRule =
  /** Already whole, nothing refunded — migrated unchanged. */
  | "exact"
  /** A legitimately retained fraction, rounded upward (customer-safe). */
  | "rounded_up"
  /** A refunded component was removed; what remained was already whole. */
  | "refund_normalised"
  /** A refunded component was removed AND the remainder was rounded upward. */
  | "refund_normalised_and_rounded_up";

/** The spend context needed to tell retained value from refunded value. */
export interface LegacySpendContext {
  /** The legacy `points_balance` metafield value, already parsed to a number. */
  legacyBalance: number;
  /** Lifetime GBP spend the customer RETAINED (refunds excluded). */
  retainedSpendGBP: number;
  /** GBP spend that was later fully refunded, which legacy still counted. */
  refundedSpendGBP: number;
}

/** The resolved migration treatment for one customer. */
export type LegacyMigrationResolution =
  | {
      ok: true;
      /** The integer points to migrate. */
      integerPoints: number;
      /** The legacy value before any normalisation. */
      legacyBalance: number;
      /** Points removed because the spend behind them was refunded. */
      refundedPointsRemoved: number;
      /** Points added by rounding the retained remainder upward. */
      roundingAdjustment: number;
      rule: LegacyMigrationRule;
      /** Lifetime spend to preserve, which excludes refunded spend. */
      retainedSpendGBP: number;
    }
  | { ok: false; reason: string };

/**
 * Resolves the one-time migrated balance for a legacy customer by composing
 * refund normalisation with customer-safe upward rounding.
 *
 * Refuses rather than guessing when the inputs are not coherent — for example a
 * refunded component larger than the whole legacy balance, which would mean the
 * legacy data is misunderstood and is an operator decision, not an arithmetic
 * one.
 */
export function resolveLegacyMigrationBalance(
  context: LegacySpendContext,
): LegacyMigrationResolution {
  const { legacyBalance, retainedSpendGBP, refundedSpendGBP } = context;

  for (const [label, value] of [
    ["legacyBalance", legacyBalance],
    ["retainedSpendGBP", retainedSpendGBP],
    ["refundedSpendGBP", refundedSpendGBP],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: `${label} is not a finite number (${String(value)}).` };
    }
    if (value < 0) {
      return { ok: false, reason: `${label} is negative (${value}); the legacy data is not understood.` };
    }
  }

  // Step 1 — remove the points legacy granted for spend that was refunded. The
  // legacy rate was £1 = 1 point, the same EARN_RATE_PER_GBP the formula uses.
  const refundedPoints = Number((refundedSpendGBP * EARN_RATE_PER_GBP).toFixed(2));
  const normalised = Number((legacyBalance - refundedPoints).toFixed(2));

  if (normalised < 0) {
    return {
      ok: false,
      reason:
        `Removing the refunded component (${refundedPoints} points for £${refundedSpendGBP}) from a ` +
        `legacy balance of ${legacyBalance} leaves ${normalised}, which is negative. The legacy data ` +
        `is misunderstood and must be resolved by an operator.`,
    };
  }

  // Step 2 — round any remaining fraction upward so migration never reduces the
  // value the customer legitimately retained.
  const converted = convertLegacyBalanceToPoints(normalised);
  if (!converted.ok) {
    return { ok: false, reason: converted.reason };
  }

  const refundedPointsRemoved = refundedPoints;
  const roundingAdjustment = converted.adjustment;

  let rule: LegacyMigrationRule;
  if (refundedPointsRemoved > 0 && roundingAdjustment > 0) {
    rule = "refund_normalised_and_rounded_up";
  } else if (refundedPointsRemoved > 0) {
    rule = "refund_normalised";
  } else if (roundingAdjustment > 0) {
    rule = "rounded_up";
  } else {
    rule = "exact";
  }

  return {
    ok: true,
    integerPoints: converted.integerPoints,
    legacyBalance,
    refundedPointsRemoved,
    roundingAdjustment,
    rule,
    // Preserved separately, in money, and deliberately EXCLUDING refunded spend:
    // lifetime spend drives tier, and a refunded order should not hold a tier up.
    retainedSpendGBP,
  };
}

/** One-line audit note for a resolution. Carries no customer identifier. */
export function describeLegacyMigration(resolution: LegacyMigrationResolution): string {
  if (!resolution.ok) {
    return `NO MIGRATION: ${resolution.reason}`;
  }
  const parts = [`legacy ${resolution.legacyBalance} → ${resolution.integerPoints} points`];
  if (resolution.refundedPointsRemoved > 0) {
    parts.push(`refund normalisation −${resolution.refundedPointsRemoved}`);
  }
  if (resolution.roundingAdjustment > 0) {
    parts.push(`customer-safe rounding +${resolution.roundingAdjustment}`);
  }
  parts.push(`retained spend £${resolution.retainedSpendGBP.toFixed(2)}`);
  return `${parts.join("; ")} [${resolution.rule}]`;
}

/**
 * Human-readable one-line audit note for a conversion, for the migration
 * manifest. Contains no customer identifier — the caller pairs it with a masked
 * id — so it is safe to log.
 */
export function describeLegacyConversion(conversion: LegacyBalanceConversion): string {
  if (!conversion.ok) {
    return `NO CONVERSION: ${conversion.reason}`;
  }
  if (conversion.rule === "exact") {
    return `legacy ${conversion.legacyBalance} → ${conversion.integerPoints} points (exact, no adjustment)`;
  }
  return (
    `legacy ${conversion.legacyBalance} → ${conversion.integerPoints} points ` +
    `(rounded up, one-time migration adjustment +${conversion.adjustment})`
  );
}
