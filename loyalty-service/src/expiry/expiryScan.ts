/**
 * Idempotent FIFO points expiry scan (task 10.1).
 *
 * Implements the Loyalty Engine's `expireLots(asOf)` (design.md "Component 2:
 * Loyalty Engine" `expireLots`; "expireLots()" pre/postconditions; the "Data
 * Flow: Expiry (scheduled, FIFO)" sequence). The scheduler (task 10.2) will
 * call this daily; here we implement ONLY the scan itself.
 *
 * Contract (Requirements 5.2, 5.3; Property 9 "Expiry once"):
 *   - For every `point_lot` whose `expires_at <= asOf` AND `remaining_points > 0`,
 *     create EXACTLY ONE negative `expire` ledger entry whose magnitude equals
 *     that lot's `remaining_points`, and set that lot's `remaining_points` to
 *     zero (Req 5.2).
 *   - The whole scan runs inside ONE database transaction so a lot's expiry
 *     entry and its zeroing commit atomically — a lot can never be left with a
 *     recorded `expire` entry but non-zero remaining, or vice versa.
 *   - Idempotent for a given date (Req 5.3, Property 9): because the scan only
 *     ever selects lots with `remaining_points > 0` and sets them to zero, a
 *     lot that has already expired no longer matches the selection, so a repeat
 *     run for the same (or any later) `asOf` is a no-op for it. Each lot
 *     therefore contributes to AT MOST ONE `expire` entry, equal to its
 *     remainder at maturity (Property 9). No extra dedupe bookkeeping is
 *     needed — the `remaining_points > 0` guard IS the idempotency mechanism.
 *
 * Lots with `expires_at IS NULL` never expire (design "Data Models": NULL =
 * never expires — e.g. migrated legacy balances) and are excluded.
 *
 * SCOPE (task 10.1 only): this module does NOT schedule the scan, run the
 * pre-expiry notification sweep, or set lot expiry windows (all task 10.2), and
 * does NOT touch earning, redemption, referral, or reconciliation code. It
 * reuses — and never modifies — the append-only ledger repository (task 2.1)
 * and the `point_lots` table (task 1.2).
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real transaction
 * client at runtime; all logic is unit-tested against an in-memory fake
 * Transactor + Queryable, so live DB verification is deferred to deploy time.
 */
import type { QueryResultRow } from "pg";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";

/** The reason recorded on every `expire` ledger entry. */
export const EXPIRY_REASON = "point_lot_expired" as const;

/**
 * Runs a unit of work inside a single database transaction. The expiry scan
 * (select matured lots FOR UPDATE → append one negative `expire` entry per lot
 * → zero each lot's remaining) MUST be atomic; the caller supplies a transactor
 * that BEGINs, passes the transaction client, and COMMITs / ROLLBACKs. Declared
 * locally (structurally identical to the redemption/earning modules') so expiry
 * is independent of them.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** The record of a single lot that was expired by a scan. */
export interface ExpiredLot {
  /** The `point_lots.id` that matured. */
  lotId: string;
  /** The owning customer. */
  customerId: string;
  /** The lot's `remaining_points` at maturity — the magnitude of the expiry entry (> 0). */
  pointsExpired: number;
  /** The id of the negative `expire` ledger entry created for this lot. */
  ledgerEntryId: string;
}

/** The outcome of an expiry scan for a given `asOf` date. */
export interface ExpiryResult {
  /** The scan's reference instant. */
  asOf: Date;
  /** One record per lot expired by THIS run (empty on an idempotent no-op re-run). */
  expiredLots: ExpiredLot[];
  /** The number of lots expired by this run. */
  expiredLotCount: number;
  /** The total points debited by this run (sum of `pointsExpired`). */
  totalPointsExpired: number;
}

/** Dependencies for {@link runExpiryScan}. */
export interface ExpiryScanDeps {
  /** The append-only ledger repository (task 2.1) — the only ledger writer. */
  repo: LedgerRepository;
  /** Runs the scan inside one transaction. */
  transactor: Transactor;
}

/**
 * Selects the matured, still-funded lots, locked `FOR UPDATE` so a concurrent
 * redemption cannot consume from a lot mid-expiry. Ordered oldest-first for
 * deterministic processing (FIFO by `earned_at`, then physical `ctid`). A lot
 * matches when it has a concrete expiry (`expires_at IS NOT NULL`) that is on or
 * before `asOf` and still carries `remaining_points > 0` (Req 5.2). The
 * `remaining_points > 0` predicate is also the idempotency guard: an
 * already-expired lot (remaining zeroed) can never be re-selected (Req 5.3).
 */
const SELECT_MATURED_LOTS_SQL = `
  SELECT id, customer_id, remaining_points, earned_at, expires_at
  FROM point_lots
  WHERE expires_at IS NOT NULL
    AND expires_at <= $1
    AND remaining_points > 0
  ORDER BY earned_at ASC, ctid ASC
  FOR UPDATE
`;

const ZERO_LOT_SQL = `
  UPDATE point_lots
  SET remaining_points = 0
  WHERE id = $1
`;

interface MaturedLotRow extends QueryResultRow {
  id: string;
  customer_id: string;
  remaining_points: string | number;
  earned_at: Date;
  expires_at: Date | null;
}

/** Parses a BIGINT column (`pg` returns it as a string) into a safe integer. */
function parseRemaining(value: string | number, lotId: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `point_lots.remaining_points value '${value}' for lot ${lotId} is outside the safe integer range.`,
    );
  }
  return n;
}

/**
 * Expires every matured, still-funded point lot as of `asOf`, atomically and
 * idempotently (Requirements 5.2, 5.3; Property 9).
 *
 * For each lot with `expires_at <= asOf` and `remaining_points > 0`, within one
 * transaction it:
 *   1. appends EXACTLY ONE negative `expire` ledger entry equal to the lot's
 *      remainder (linked to the lot via `ledger_entries.point_lot_id`), and
 *   2. sets that lot's `remaining_points` to zero.
 *
 * Re-running for the same `asOf` (or any later date) is a no-op: a lot whose
 * remainder is already zero is not selected, so no lot is ever expired twice
 * (Req 5.3, Property 9). Returns the per-lot records plus the count and total
 * points expired by THIS run (all zero on an idempotent re-run).
 *
 * @param asOf the expiry cutoff (typically the scheduler's scan date).
 * @param deps the ledger repository and transactor.
 */
export async function runExpiryScan(asOf: Date, deps: ExpiryScanDeps): Promise<ExpiryResult> {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("runExpiryScan requires a valid asOf Date.");
  }

  const expiredLots = await deps.transactor.transaction<ExpiredLot[]>(async (tx) => {
    // Select + lock the matured, still-funded lots. The FOR UPDATE lock keeps a
    // concurrent redemption from consuming a lot we are about to expire.
    const selected = await tx.query<MaturedLotRow>(SELECT_MATURED_LOTS_SQL, [asOf]);

    const results: ExpiredLot[] = [];
    for (const row of selected.rows) {
      const remaining = parseRemaining(row.remaining_points, row.id);
      // The selection guarantees remaining > 0; guard defensively so we never
      // append a zero/positive "expire" entry (rejected by the ledger anyway).
      if (remaining <= 0) {
        continue;
      }

      // (1) Append exactly one negative expire entry equal to the remainder,
      // linked back to the lot. The repository enforces expire < 0 (Req 1.5).
      const entry: LedgerEntry = await deps.repo.append(
        {
          customerId: row.customer_id,
          entryType: "expire",
          points: -remaining,
          reason: EXPIRY_REASON,
          pointLotId: row.id,
          sourceEventId: null,
        },
        tx,
      );

      // (2) Zero the lot's remaining_points. Once zeroed the lot can never be
      // re-selected, which is exactly what makes the scan idempotent (Req 5.3).
      await tx.query(ZERO_LOT_SQL, [row.id]);

      results.push({
        lotId: row.id,
        customerId: row.customer_id,
        pointsExpired: remaining,
        ledgerEntryId: entry.id,
      });
    }

    return results;
  });

  const totalPointsExpired = expiredLots.reduce((sum, l) => sum + l.pointsExpired, 0);

  return {
    asOf,
    expiredLots,
    expiredLotCount: expiredLots.length,
    totalPointsExpired,
  };
}

/**
 * Design alias: the Loyalty Engine interface names this operation `expireLots`
 * (design.md "Component 2"). It is the same function as {@link runExpiryScan}
 * (the name used by the scheduler sequence "runExpiryScan(today)").
 */
export const expireLots = runExpiryScan;
