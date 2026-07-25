/**
 * Migration Phase M1 — ledger backfill & reconciliation (task 7.2).
 *
 * This is design.md "Migration Plan → Phase M1 — Stand up service + backfill
 * ledger (no Shopify writes)" and Requirement 14 criteria 14.4, 14.5, 14.6 and
 * 14.7. It is the SECOND step of the data-safe migration: after M0 (task 7.1)
 * has captured the authoritative, versioned backup of every customer's
 * `loyalty.*` metafields, M1 seeds the empty Postgres ledger from that backup —
 * WITHOUT touching Shopify at all.
 *
 * What it does, for each of the 8 Enrolled_Customers taken from the M0 backup,
 * inside ONE database transaction:
 *   - Req 14.4: create the local `customers` row keyed by Shopify id if needed,
 *     then append exactly ONE `entry_type='migration'` Ledger entry equal to the
 *     customer's exported points balance, and create exactly ONE matching
 *     NON-EXPIRING Point_Lot (`expires_at = NULL`, `original == remaining ==`
 *     the balance) — because no expiry has ever been tracked for legacy points
 *     (A1). The customer's tier is recomputed from their lifetime spend.
 *   - Req 14.5 (A3): the 31 Non_Enrolled_Customers are NOT created here. They
 *     are enrolled LAZILY — a `customers` row is created on their first
 *     qualifying webhook event (see `earning/order.ts` / `earning/signup.ts`),
 *     never eagerly at migration. M1 processes only the enrolled cohort.
 *   - Req 14.6: after the backfill, reconcile by asserting
 *     `SUM(ledger_entries.points) == exported balance` for every enrolled
 *     customer. On ANY mismatch the migration ABORTS and retains NO partial
 *     Ledger state — the whole transaction is rolled back — treating the backup
 *     file as authoritative for restore.
 *   - Req 14.7: if the backfill fails midway (any error before commit), the
 *     transaction rolls back so no partial `migration` entry or Point_Lot is
 *     retained; the M0 backup file is never written to and remains the restore
 *     anchor.
 *
 * ALL-OR-NOTHING: the entire cohort's backfill AND the reconciliation run in a
 * single {@link Transactor} transaction. A reconciliation mismatch or any
 * mid-way failure throws, which rolls the transaction back, so the ledger is
 * left exactly as it was before M1 began (empty, in the normal case). This is
 * what makes 14.6 and 14.7 hold by construction.
 *
 * SCOPE (task 7.2 only): this module does NOT restore metafields or repoint the
 * theme (that is rollback, task 7.3), and it does NOT read from or write to the
 * live Shopify store. Its ONLY inputs are the in-memory M0 backup and the
 * injected database boundaries.
 *
 * SAFETY: defining this module touches no live/production system. It performs
 * NO Shopify Admin API call and reads the store's data only via the M0 backup
 * object passed in. It issues SQL only when a caller passes a real transaction
 * client at runtime; all logic is unit + property tested against an in-memory
 * fake Transactor/Queryable and a sample 8-enrolled M0 backup, so verification
 * calls NO live systems. Actual execution is a gated, migration-time step run
 * against the freshly stood-up (empty) Postgres — never the live store.
 */
import { computeBalance } from "../ledger/balance.js";
import type { LedgerEntry, LedgerRepository, Queryable } from "../ledger/repository.js";
import { deriveTier, type Tier } from "../tier/tier.js";
import type { ExportedCustomer, M0Backup } from "./m0Export.js";

/** The `entry_type` recorded for every backfilled opening balance (design M1). */
export const MIGRATION_ENTRY_TYPE = "migration" as const;

/** The reason stamped on each `migration` Ledger entry, for audit/traceability. */
export const MIGRATION_REASON = "m1_backfill" as const;

/**
 * Runs a unit of work inside a single database transaction. The M1 backfill
 * (upsert customer → append migration entry → create non-expiring lot) and the
 * subsequent reconciliation MUST be atomic across the whole cohort so that a
 * mismatch or mid-way failure leaves NO partial Ledger state (Req 14.6, 14.7).
 * The caller supplies a transactor that BEGINs, passes the transaction client,
 * and COMMITs on success / ROLLBACKs when the callback throws.
 *
 * Declared locally (structurally identical to the earning/redemption modules')
 * so migration is independent of them.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** One enrolled customer's backfill outcome (part of a successful M1 result). */
export interface BackfilledCustomer {
  /** Numeric Shopify customer id the ledger row is keyed by. */
  shopifyCustomerId: number;
  /** The local `customers.id` (UUID) resolved/created for this customer. */
  customerId: string;
  /** The opening balance backfilled — equals the exported `points_balance` (Req 14.4). */
  migrationPoints: number;
  /** The tier recomputed from the customer's lifetime spend (Req 14.4). */
  tier: Tier;
  /** The lifetime spend (GBP) the tier was derived from. */
  lifetimeSpendGBP: number;
  /** The `migration` Ledger entry created, or null when this customer was already backfilled. */
  ledgerEntryId: string | null;
  /** The matching non-expiring Point_Lot created, or null when already backfilled. */
  pointLotId: string | null;
  /**
   * True when a fresh `migration` entry + lot were created this run; false when
   * a prior `migration` entry already existed and creation was skipped
   * (idempotent re-run).
   */
  created: boolean;
}

/** A reconciliation mismatch: the ledger sum did not equal the exported balance (Req 14.6). */
export interface ReconciliationMismatch {
  shopifyCustomerId: number;
  customerId: string;
  /** The exported `points_balance` the ledger was expected to sum to. */
  expectedBalance: number;
  /** The actual `SUM(ledger_entries.points)` observed for the customer. */
  actualLedgerSum: number;
}

/** Describes why a backfill was rejected before/without a reconciliation run (Req 14.7). */
export interface BackfillErrorDetail {
  reason: string;
  /** The offending Shopify id (when a specific customer caused the abort). */
  shopifyCustomerId: number | null;
}

/** The result of running M1 (a discriminated union — the caller inspects `status`). */
export type M1Result =
  | {
      status: "backfilled";
      /** Number of enrolled customers processed (should equal the enrolled cohort size). */
      processed: number;
      /** Number of customers that received a fresh `migration` entry + lot this run. */
      created: number;
      /** Number of customers skipped because they were already backfilled. */
      skipped: number;
      /** Number of non-enrolled customers deliberately left for lazy enrolment (Req 14.5). */
      nonEnrolledDeferred: number;
      /** Per-customer detail for the enrolled cohort. */
      customers: BackfilledCustomer[];
      /** Always empty on success. */
      mismatches: [];
    }
  | {
      status: "aborted_reconciliation_mismatch";
      /** The customers whose ledger sum did not match; the transaction was rolled back. */
      mismatches: ReconciliationMismatch[];
    }
  | {
      status: "aborted_backfill_error";
      /** Why the backfill aborted; the transaction was rolled back (Req 14.7). */
      detail: BackfillErrorDetail;
    };

/** Options for {@link runM1Backfill}. */
export interface M1BackfillOptions {
  /** The authoritative M0 backup produced by task 7.1 — the ONLY source of truth. */
  backup: M0Backup;
  /** The append-only ledger repository (task 2.1) — the only ledger writer. */
  repo: LedgerRepository;
  /** Runs the whole backfill + reconciliation inside one transaction. */
  transactor: Transactor;
  /** Clock for `enrolled_at`/lot `earned_at`; defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Thrown for a backfill anomaly (an enrolled record whose data cannot be
 * backfilled — e.g. a non-positive/non-integer balance or an unusable Shopify
 * id). Throwing inside the transaction rolls it back so no partial state is
 * retained (Req 14.7). Caught by {@link runM1Backfill} and reported as
 * `aborted_backfill_error`.
 */
export class M1BackfillError extends Error {
  readonly code = "m1_backfill_error";
  readonly shopifyCustomerId: number | null;
  constructor(message: string, shopifyCustomerId: number | null = null) {
    super(message);
    this.name = "M1BackfillError";
    this.shopifyCustomerId = shopifyCustomerId;
  }
}

/**
 * Thrown when reconciliation finds any customer whose `SUM(ledger)` does not
 * equal their exported balance (Req 14.6). Throwing inside the transaction
 * rolls back the ENTIRE backfill, so no partial Ledger state survives; the
 * backup remains authoritative for restore. Caught by {@link runM1Backfill} and
 * reported as `aborted_reconciliation_mismatch`.
 */
export class M1ReconciliationError extends Error {
  readonly code = "m1_reconciliation_mismatch";
  readonly mismatches: ReconciliationMismatch[];
  constructor(mismatches: ReconciliationMismatch[]) {
    super(
      `M1 reconciliation failed for ${mismatches.length} customer(s): ledger sum did not equal ` +
        `the exported balance. The migration was aborted and no partial ledger state was retained.`,
    );
    this.name = "M1ReconciliationError";
    this.mismatches = mismatches;
  }
}

const UPSERT_CUSTOMER_SQL = `
  INSERT INTO customers
    (shopify_customer_id, email, tier, lifetime_points, lifetime_spend_gbp, enrolled_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (shopify_customer_id) DO UPDATE
    SET email              = COALESCE(customers.email, EXCLUDED.email),
        tier               = EXCLUDED.tier,
        lifetime_points    = EXCLUDED.lifetime_points,
        lifetime_spend_gbp = EXCLUDED.lifetime_spend_gbp,
        enrolled_at        = COALESCE(customers.enrolled_at, EXCLUDED.enrolled_at),
        updated_at         = now()
  RETURNING id
`;

/**
 * Idempotency guard: has this customer already been backfilled with a
 * `migration` entry? Re-running M1 then skips creating a second entry/lot so the
 * "exactly one migration entry" invariant (Req 14.4) is preserved and
 * reconciliation still holds.
 */
const EXISTING_MIGRATION_SQL = `
  SELECT 1
  FROM ledger_entries
  WHERE customer_id = $1
    AND entry_type = 'migration'
  LIMIT 1
`;

/**
 * Creates the matching NON-EXPIRING Point_Lot for a backfilled balance
 * (Req 14.4): `original_points == remaining_points ==` the migrated balance,
 * `earned_at` = the entry timestamp, and `expires_at = NULL` (never expires,
 * since no expiry was ever tracked for legacy points — A1 / design M1).
 */
const INSERT_MIGRATION_LOT_SQL = `
  INSERT INTO point_lots
    (customer_id, ledger_entry_id, original_points, remaining_points, earned_at, expires_at)
  VALUES ($1, $2, $3, $3, $4, NULL)
  RETURNING id
`;

/** Returns the enrolled customers from an M0 backup (the only cohort M1 processes). */
export function enrolledCustomers(backup: M0Backup): ExportedCustomer[] {
  return backup.customers.filter((c) => c.enrolled);
}

/** Returns the non-enrolled customers — deferred to lazy enrolment, never backfilled (Req 14.5). */
export function nonEnrolledCustomers(backup: M0Backup): ExportedCustomer[] {
  return backup.customers.filter((c) => !c.enrolled);
}

/**
 * Validates and returns the positive-integer opening balance to migrate for an
 * enrolled customer (Req 14.4). The `migration` Ledger entry must be a non-zero
 * amount (append-only ledger rules); an enrolled balance is always `50 + spend`
 * so it is > 0. A missing/non-integer/non-positive balance is a data anomaly
 * that aborts the backfill (Req 14.7).
 */
export function requireMigrationBalance(
  customer: ExportedCustomer,
  shopifyCustomerId: number | null,
): number {
  const balance = customer.loyalty.pointsBalance;
  if (balance === null || !Number.isInteger(balance) || !Number.isSafeInteger(balance)) {
    throw new M1BackfillError(
      `Enrolled customer ${customer.id} has a non-integer points balance and cannot be backfilled.`,
      shopifyCustomerId,
    );
  }
  if (balance <= 0) {
    throw new M1BackfillError(
      `Enrolled customer ${customer.id} has a non-positive balance (${balance}); a migration ` +
        `entry must record a positive opening balance.`,
      shopifyCustomerId,
    );
  }
  return balance;
}

/** Parses the exported Shopify customer id (a numeric string) into a positive integer. */
export function requireShopifyCustomerId(customer: ExportedCustomer): number {
  const id = Number(customer.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new M1BackfillError(
      `Enrolled customer '${customer.id}' does not carry a usable numeric Shopify id.`,
    );
  }
  return id;
}

/**
 * Runs Migration Phase M1 (Req 14.4, 14.5, 14.6, 14.7) against the M0 backup.
 *
 * Everything below happens inside ONE transaction so the outcome is
 * all-or-nothing:
 *
 *   1. For each ENROLLED customer (Req 14.5 — non-enrolled are skipped and left
 *      for lazy enrolment):
 *        a. validate the opening balance and Shopify id (anomaly → abort);
 *        b. upsert the local `customers` row keyed by Shopify id, setting the
 *           tier recomputed from lifetime spend (Req 14.4);
 *        c. if a `migration` entry already exists, skip (idempotent re-run);
 *        d. otherwise append exactly one positive `migration` Ledger entry equal
 *           to the balance, and create exactly one matching NON-EXPIRING
 *           Point_Lot of the same value (Req 14.4).
 *   2. Reconcile: for every enrolled customer assert
 *      `SUM(ledger_entries.points) == exported balance`. Any mismatch throws
 *      {@link M1ReconciliationError}, rolling the whole transaction back so no
 *      partial state is retained (Req 14.6).
 *
 * On success returns `backfilled` with per-customer detail and counts. A
 * reconciliation mismatch returns `aborted_reconciliation_mismatch`; a backfill
 * anomaly returns `aborted_backfill_error`. In BOTH aborted cases the
 * transaction has been rolled back (no partial `migration` entry/lot survives)
 * and the M0 backup file is untouched and remains authoritative (Req 14.6,
 * 14.7). Genuinely unexpected errors (e.g. a database failure mid-backfill)
 * propagate AFTER the transaction has rolled back, likewise leaving no partial
 * state (Req 14.7).
 */
export async function runM1Backfill(options: M1BackfillOptions): Promise<M1Result> {
  const now = options.now ?? (() => new Date());
  const enrolled = enrolledCustomers(options.backup);
  const nonEnrolledDeferred = options.backup.customers.length - enrolled.length;

  try {
    const customers = await options.transactor.transaction<BackfilledCustomer[]>(async (tx) => {
      const results: BackfilledCustomer[] = [];

      // (1) Backfill each enrolled customer (Req 14.4). Non-enrolled are never
      // touched here — they enrol lazily on their first event (Req 14.5).
      for (const c of enrolled) {
        const shopifyCustomerId = requireShopifyCustomerId(c);
        const balance = requireMigrationBalance(c, shopifyCustomerId);
        const tier = deriveTier(c.lifetimeSpendGBP);

        // (1b) Create the local customers row keyed by Shopify id if needed,
        // with the tier recomputed from lifetime spend (Req 14.4).
        const upserted = await tx.query<{ id: string }>(UPSERT_CUSTOMER_SQL, [
          shopifyCustomerId,
          c.email,
          tier,
          balance,
          c.lifetimeSpendGBP,
          now(),
        ]);
        const customerRow = upserted.rows[0];
        if (!customerRow) {
          throw new M1BackfillError(
            `Failed to resolve/create a customers row for Shopify id ${shopifyCustomerId}.`,
            shopifyCustomerId,
          );
        }
        const customerId = customerRow.id;

        // (1c) Idempotency: never create a second migration entry (Req 14.4).
        const existing = await tx.query(EXISTING_MIGRATION_SQL, [customerId]);
        if ((existing.rowCount ?? existing.rows.length) > 0) {
          results.push({
            shopifyCustomerId,
            customerId,
            migrationPoints: balance,
            tier,
            lifetimeSpendGBP: c.lifetimeSpendGBP,
            ledgerEntryId: null,
            pointLotId: null,
            created: false,
          });
          continue;
        }

        // (1d) Exactly one positive `migration` Ledger entry equal to the
        // exported balance (Req 14.4). The append-only repository enforces the
        // single signed-integer append and rejects a failed append (Req 1.x).
        const entry: LedgerEntry = await options.repo.append(
          {
            customerId,
            entryType: MIGRATION_ENTRY_TYPE,
            points: balance,
            reason: MIGRATION_REASON,
            sourceEventId: null,
          },
          tx,
        );

        // ...and exactly one matching NON-EXPIRING Point_Lot (expires_at = NULL)
        // of the same value (Req 14.4).
        const lot = await tx.query<{ id: string }>(INSERT_MIGRATION_LOT_SQL, [
          customerId,
          entry.id,
          balance,
          entry.createdAt,
        ]);
        const lotRow = lot.rows[0];
        if (!lotRow) {
          throw new M1BackfillError(
            `Failed to create the matching point_lot for Shopify id ${shopifyCustomerId}.`,
            shopifyCustomerId,
          );
        }

        results.push({
          shopifyCustomerId,
          customerId,
          migrationPoints: balance,
          tier,
          lifetimeSpendGBP: c.lifetimeSpendGBP,
          ledgerEntryId: entry.id,
          pointLotId: lotRow.id,
          created: true,
        });
      }

      // (2) Reconcile: SUM(ledger) must equal the exported balance for every
      // enrolled customer, else abort and retain no partial state (Req 14.6).
      const mismatches: ReconciliationMismatch[] = [];
      for (const r of results) {
        const actualLedgerSum = await computeBalance(r.customerId, tx);
        if (actualLedgerSum !== r.migrationPoints) {
          mismatches.push({
            shopifyCustomerId: r.shopifyCustomerId,
            customerId: r.customerId,
            expectedBalance: r.migrationPoints,
            actualLedgerSum,
          });
        }
      }
      if (mismatches.length > 0) {
        // Throwing rolls the whole transaction back: no partial ledger state,
        // backup remains authoritative for restore (Req 14.6).
        throw new M1ReconciliationError(mismatches);
      }

      return results;
    });

    const created = customers.filter((c) => c.created).length;
    return {
      status: "backfilled",
      processed: customers.length,
      created,
      skipped: customers.length - created,
      nonEnrolledDeferred,
      customers,
      mismatches: [],
    };
  } catch (err) {
    // The transaction has already rolled back, so no partial `migration` entry
    // or Point_Lot survives and the backup is untouched (Req 14.6, 14.7).
    if (err instanceof M1ReconciliationError) {
      return { status: "aborted_reconciliation_mismatch", mismatches: err.mismatches };
    }
    if (err instanceof M1BackfillError) {
      return {
        status: "aborted_backfill_error",
        detail: { reason: err.message, shopifyCustomerId: err.shopifyCustomerId },
      };
    }
    // Genuinely unexpected failures propagate after rollback — the ledger is
    // left unchanged and the backup preserved (Req 14.7).
    throw err;
  }
}
