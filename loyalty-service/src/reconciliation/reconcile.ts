/**
 * Reconciliation job (task 12.1).
 *
 * Implements design.md "Backup & recovery" → "A reconciliation job periodically
 * recomputes cached balances/tiers from the ledger and repairs drift (including
 * metafield cache)" and design "Component 5: Scheduler" ("optional metafield
 * cache reconciliation"). This is the drift-repair half of Requirement 1.7 and
 * Requirement 13.7.
 *
 * Contract (Requirements 1.7, 13.7):
 *   - Runs on a schedule at least once every 24 hours (Req 13.7). This module
 *     provides the callable job plus a way to register it on a scheduler; the
 *     cadence is expressed as {@link RECONCILIATION_SCHEDULE} (doc/config). It
 *     is NOT wired to a live scheduler here.
 *   - Recomputes the cached `customers.lifetime_points`, `customers.tier`, and
 *     `point_lots.remaining_points` SOLELY from the ledger and OVERWRITES any
 *     cached value that differs from the recomputed value (Req 1.7).
 *   - Refreshes the Metafield_Cache from the ledger so the Shopify display
 *     metafields match the ledger too (Req 13.7). This reuses the existing
 *     metafield cache writer (task 6.6) unchanged.
 *
 * How each cache is recomputed FROM THE LEDGER:
 *   - `lifetime_points` = net signed ledger sum, via {@link computeBalance}
 *     (Req 1.2 / Property 1). Pure ledger.
 *   - `remaining_points` per lot = the lot's `original_points` less everything
 *     the ledger records as consumed from it, reconstructed by REPLAYING the
 *     ledger debits (spend / clawback / expire) with the same FIFO + expiry
 *     semantics the live engine uses (see {@link reconstructLotRemainders}).
 *     This reuses {@link planFifoConsumption} from the balance module unchanged.
 *   - `tier` = a pure function of cumulative lifetime GBP spend via the tier
 *     rules ({@link deriveTier}). `customers.lifetime_spend_gbp` is the
 *     authoritative spend input (it is itself derived from the customer's paid
 *     Shopify orders — the source of truth for spend, Req 7.1); tier is the
 *     canonical mapping of that spend and is overwritten when the cache differs.
 *     Because lifetime spend is cumulative and non-decreasing in normal
 *     operation, the recomputed tier never sits below a legitimately retained
 *     tier (Req 7.3), so repairing to the derived tier is consistent with tier
 *     monotonicity.
 *
 * The authoritative cache repairs run inside ONE transaction per customer so a
 * customer's `lifetime_points`, `tier`, and lot remainders converge atomically.
 * The Metafield_Cache refresh happens AFTER commit via the injected, non-fatal
 * {@link MetafieldCacheWriter} — a failed Shopify write never fails the
 * reconciliation (the ledger stays authoritative, Req 13.1/13.5).
 *
 * SCOPE (task 12.1 only): this module does NOT implement backup/PITR
 * verification (task 12.2). It REUSES — and never modifies — the balance
 * projections + FIFO planner (task 2.3), the tier model (task 4.3), and the
 * metafield cache writer (task 6.6).
 *
 * SAFETY: defining this module touches no live/production system and calls no
 * Shopify Admin API. It issues SQL only when a caller passes a real transaction
 * client / pool at runtime, and reaches Shopify only through the injected
 * metafield writer. All logic is unit-tested against an in-memory fake
 * Queryable + fake metafield writer, so no live system is touched during
 * verification.
 */
import { computeBalance, planFifoConsumption, type FifoLot } from "../ledger/balance.js";
import type { Queryable } from "../ledger/repository.js";
import {
  processMetafieldCacheJob,
  type MetafieldCacheJobOutcome,
  type MetafieldCacheWriter,
} from "../shopify/metafieldCache.js";
import { DEFAULT_TIER_RULES, deriveTier, normalizeTier, type Tier, type TierRuleSet } from "../tier/tier.js";

/**
 * Runs a unit of work inside a single database transaction. The per-customer
 * cache repair (recompute from ledger → overwrite diverging caches) MUST be
 * atomic; the caller supplies a transactor that BEGINs, passes the transaction
 * client, and COMMITs / ROLLBACKs. Declared locally (structurally identical to
 * the expiry/redemption modules') so reconciliation is independent of them.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** A recomputed-vs-cached comparison for a single scalar cache field. */
export interface FieldRepair<T> {
  /** The value currently stored in the cache. */
  cached: T;
  /** The value recomputed from the ledger. */
  recomputed: T;
  /** True iff the cache differed and was overwritten with the recomputed value. */
  repaired: boolean;
}

/** A recomputed-vs-cached comparison for one lot's `remaining_points`. */
export interface LotRepair {
  lotId: string;
  cached: number;
  recomputed: number;
  repaired: boolean;
}

/** The result of reconciling a single customer. */
export type CustomerReconciliation =
  | { status: "skipped_unknown_customer"; customerId: string }
  | {
      status: "reconciled";
      customerId: string;
      /** `customers.lifetime_points` recompute (net ledger sum). */
      lifetimePoints: FieldRepair<number>;
      /** `customers.tier` recompute (derived from lifetime spend). */
      tier: FieldRepair<Tier>;
      /** Per-lot `remaining_points` recompute (ledger replay). */
      lots: LotRepair[];
      /** True iff ANY authoritative cache (points / tier / a lot) was overwritten. */
      dbRepaired: boolean;
      /** Outcome of refreshing the Metafield_Cache from the ledger (Req 13.7). */
      metafield: MetafieldCacheJobOutcome;
    };

/** Dependencies for the reconciliation job. */
export interface ReconcileDeps {
  /** Read connection used for listing customers and the post-commit cache refresh. */
  db: Queryable;
  /** Runs the per-customer cache repair inside one transaction. */
  transactor: Transactor;
  /** The non-fatal metafield cache writer (task 6.6), reused unchanged (Req 13.7). */
  metafieldWriter: MetafieldCacheWriter;
  /** Tier rule set (defaults to the GBP defaults); lets config-driven rules layer in later. */
  rules?: TierRuleSet;
  /** Clock injection for the reconciliation instant (defaults to `new Date()`). */
  now?: () => Date;
  /**
   * Called when the pass finds positive ledger entries with no backing lot
   * (Property 17 / Req 1.3a), so the violation is ESCALATED rather than merely
   * returned. Production wires this to the service logger at error level; the
   * result field alone would be silent, because the scheduled job discards its
   * return value. Never called with an empty list.
   */
  onUnbackedCredits?: (unbacked: readonly UnbackedCredit[]) => void;
}

/**
 * A positive ledger entry with NO backing `point_lots` row — a Property 17
 * violation (Req 1.3a).
 *
 * WHY THIS EXISTS: `Spendable_Balance` derives solely from non-expired lot
 * remainders (Req 1.3), so a credit with no lot shows in the member's history and
 * can never be redeemed. `reconstructLotRemainders` recomputes the remainders of
 * lots that EXIST; it cannot notice one that is absent. That left this class of
 * damage completely undetectable at runtime — and it did in fact happen: two real
 * lots were destroyed on staging by a rehearsal cleanup that matched lots by
 * value instead of by id, and the 200 unredeemable points went unnoticed across
 * two subsequent tasks until a dashboard audit happened to compare Balance with
 * Spendable_Balance by hand. See `docs/ops/dashboard-audit.md` §3.1.
 */
export interface UnbackedCredit {
  /** The offending `ledger_entries.id`. */
  ledgerEntryId: string;
  /** The owning `customers.id`. */
  customerId: string;
  /** The Shopify customer id, so an operator can identify the member. */
  shopifyCustomerId: string;
  /** The entry type, e.g. `earn_signup`, `earn_referral`. */
  entryType: string;
  /** The credited points that are currently unspendable (> 0). */
  points: number;
  /** The entry's reason, for triage. */
  reason: string;
  /** When the credit was appended. */
  createdAt: Date;
}

/** The result of a full reconciliation run. */
export interface ReconciliationResult {
  /** The run's reference instant. */
  asOf: Date;
  /** Number of customers processed. */
  processed: number;
  /** Number of customers whose authoritative caches had drift repaired. */
  repaired: number;
  /** Per-customer reconciliation records. */
  customers: CustomerReconciliation[];
  /**
   * Positive ledger entries with no backing lot (Property 17 / Req 1.3a).
   * DETECTED, never repaired: creating a lot increases a member's spendable
   * balance, which must be a reviewed operator action
   * (`scripts/backfill-missing-point-lots.mjs`), not a silent side effect of a
   * nightly cache sweep. Empty on a healthy ledger.
   */
  unbackedCredits: UnbackedCredit[];
}

/* -------------------------------------------------------------------------- */
/* Column parsing helpers (`pg` returns BIGINT / NUMERIC as strings).         */
/* -------------------------------------------------------------------------- */

function parseIntegerColumn(value: string | number | null, column: string): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Column '${column}' value '${value}' is outside the safe integer range.`);
  }
  return n;
}

function toMoney(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* SQL                                                                         */
/* -------------------------------------------------------------------------- */

const LIST_CUSTOMER_IDS_SQL = `SELECT id FROM customers ORDER BY created_at ASC, id ASC`;

const LOAD_CUSTOMER_SQL = `
  SELECT id, tier, lifetime_points, lifetime_spend_gbp
  FROM customers
  WHERE id = $1
  LIMIT 1
`;

const LOAD_LOTS_SQL = `
  SELECT id, original_points, remaining_points, earned_at, expires_at
  FROM point_lots
  WHERE customer_id = $1
  ORDER BY earned_at ASC, ctid ASC
`;

const LOAD_DEBITS_SQL = `
  SELECT entry_type, points, point_lot_id, created_at
  FROM ledger_entries
  WHERE customer_id = $1 AND points < 0
  ORDER BY created_at ASC, id ASC
`;

const UPDATE_CUSTOMER_CACHE_SQL = `
  UPDATE customers
  SET tier = $1, lifetime_points = $2, updated_at = now()
  WHERE id = $3
`;

const UPDATE_LOT_REMAINING_SQL = `
  UPDATE point_lots
  SET remaining_points = $1
  WHERE id = $2
`;

/* -------------------------------------------------------------------------- */
/* Ledger replay: reconstruct lot remainders solely from the ledger.          */
/* -------------------------------------------------------------------------- */

interface LotRow {
  id: string;
  original_points: string | number;
  remaining_points: string | number;
  earned_at: Date;
  expires_at: Date | null;
}

interface DebitRow {
  entry_type: string;
  points: string | number;
  point_lot_id: string | null;
  created_at: Date;
}

/** A lot's evolving state during the ledger replay. */
interface LotState {
  id: string;
  originalPoints: number;
  cachedRemaining: number;
  earnedAt: Date;
  expiresAt: Date | null;
  /** Ascending creation order (earned_at, then physical row order) — FIFO tie-break. */
  creationOrder: number;
  /** The remaining reconstructed by replaying the ledger. */
  recomputedRemaining: number;
}

/** The reconstructed remainder for one lot, alongside its cached value. */
export interface ReconstructedLot {
  id: string;
  originalPoints: number;
  cachedRemaining: number;
  recomputedRemaining: number;
}

/**
 * Reconstructs each of a customer's `point_lots.remaining_points` SOLELY from
 * the ledger (Req 1.7), by replaying the ledger's debit entries against the
 * lots with the same FIFO + expiry semantics the live engine uses:
 *
 *   - every lot starts at its `original_points`;
 *   - an `expire` debit linked to a specific lot (the expiry scan always links
 *     `point_lot_id`, task 10.1) reduces THAT lot by the entry's magnitude
 *     (its remainder at maturity);
 *   - every other debit (a redemption `spend`, a `clawback`, or an unlinked
 *     debit) consumes lots FIFO — oldest `earned_at` first, then creation order
 *     — over the lots that are non-expired as of the debit's timestamp and
 *     still carry a positive reconstructed remainder, exactly mirroring
 *     {@link consumeLotsFifo} (Req 5.6). The FIFO planning is delegated to
 *     {@link planFifoConsumption} (reused unchanged).
 *
 * Processing the debits in chronological order means a lot already zeroed by an
 * earlier expiry/consumption is naturally skipped later, so the reconstruction
 * matches the live decrement history. `remaining` is a decrement-only cache
 * that this replay reproduces from the immutable ledger.
 *
 * @param customerId the customer whose lots to reconstruct.
 * @param executor   Pool/PoolClient to read on (pass the reconciliation tx).
 * @returns one {@link ReconstructedLot} per lot, in FIFO order.
 */
export async function reconstructLotRemainders(
  customerId: string,
  executor: Queryable,
): Promise<ReconstructedLot[]> {
  const [lotsResult, debitsResult] = await Promise.all([
    executor.query<LotRow>(LOAD_LOTS_SQL, [customerId]),
    executor.query<DebitRow>(LOAD_DEBITS_SQL, [customerId]),
  ]);

  const states: LotState[] = lotsResult.rows.map((row, index) => {
    const originalPoints = parseIntegerColumn(row.original_points, "original_points");
    return {
      id: row.id,
      originalPoints,
      cachedRemaining: parseIntegerColumn(row.remaining_points, "remaining_points"),
      earnedAt: row.earned_at,
      expiresAt: row.expires_at,
      creationOrder: index,
      recomputedRemaining: originalPoints,
    };
  });

  const byId = new Map<string, LotState>(states.map((s) => [s.id, s]));

  for (const debit of debitsResult.rows) {
    const signed = parseIntegerColumn(debit.points, "points");
    // Ledger debits are strictly negative (Req 1.5); the amount consumed is the
    // magnitude. Guard defensively against a non-negative row.
    const amount = signed < 0 ? -signed : 0;
    if (amount === 0) {
      continue;
    }

    if (debit.entry_type === "expire" && debit.point_lot_id !== null) {
      // Expiry zeroes a specific lot's remainder at maturity: reduce that lot.
      const target = byId.get(debit.point_lot_id);
      if (target) {
        target.recomputedRemaining = Math.max(0, target.recomputedRemaining - amount);
        continue;
      }
      // Fall through to FIFO if the linked lot is unknown (should not happen).
    }

    // FIFO consumption over non-expired, still-funded lots as of the debit time.
    const eligible: FifoLot[] = states
      .filter(
        (s) =>
          s.recomputedRemaining > 0 &&
          (s.expiresAt === null || s.expiresAt.getTime() > debit.created_at.getTime()),
      )
      .map((s) => ({
        id: s.id,
        remainingPoints: s.recomputedRemaining,
        earnedAt: s.earnedAt,
        expiresAt: s.expiresAt,
        creationOrder: s.creationOrder,
      }));

    const plan = planFifoConsumption(eligible, amount);
    for (const allocation of plan.allocations) {
      const target = byId.get(allocation.lotId);
      if (target) {
        target.recomputedRemaining -= allocation.take;
      }
    }
    // Any shortfall (debit exceeds reconstructable lots) leaves nothing more to
    // decrement; the ledger is still authoritative for the balance.
  }

  return states.map((s) => ({
    id: s.id,
    originalPoints: s.originalPoints,
    cachedRemaining: s.cachedRemaining,
    recomputedRemaining: s.recomputedRemaining,
  }));
}

/* -------------------------------------------------------------------------- */
/* Per-customer reconciliation.                                                */
/* -------------------------------------------------------------------------- */

interface CustomerRow {
  id: string;
  tier: string | null;
  lifetime_points: string | number;
  lifetime_spend_gbp: string | number | null;
}

/**
 * Reconciles a single customer (Requirements 1.7, 13.7): recomputes the cached
 * `lifetime_points`, `tier`, and every lot's `remaining_points` from the ledger
 * and overwrites any that diverge, then refreshes the Metafield_Cache from the
 * ledger. Authoritative cache repairs commit atomically in one transaction; the
 * metafield refresh runs after commit and is non-fatal.
 *
 * When every cache already matches the ledger this is a no-op on the
 * authoritative caches (`dbRepaired === false`, no `customers`/`point_lots`
 * UPDATE issued); the Metafield_Cache is still refreshed to converge Shopify.
 *
 * @param customerId the local `customers.id` to reconcile.
 * @param deps       DB, transactor, metafield writer, and optional rules/clock.
 */
export async function reconcileCustomer(
  customerId: string,
  deps: ReconcileDeps,
): Promise<CustomerReconciliation> {
  const rules = deps.rules ?? DEFAULT_TIER_RULES;

  const repair = await deps.transactor.transaction(async (tx) => {
    const loaded = await tx.query<CustomerRow>(LOAD_CUSTOMER_SQL, [customerId]);
    const row = loaded.rows[0];
    if (!row) {
      return null;
    }

    // (1) Recompute the authoritative values SOLELY from the ledger.
    const recomputedPoints = await computeBalance(customerId, tx);
    const cachedPoints = parseIntegerColumn(row.lifetime_points, "lifetime_points");

    const lifetimeSpendGBP = toMoney(row.lifetime_spend_gbp);
    const cachedTier = normalizeTier(row.tier);
    const recomputedTier = deriveTier(lifetimeSpendGBP, rules);

    const reconstructed = await reconstructLotRemainders(customerId, tx);

    // (2) Determine drift.
    const pointsRepaired = cachedPoints !== recomputedPoints;
    const tierRepaired = cachedTier !== recomputedTier;
    const lots: LotRepair[] = reconstructed.map((l) => ({
      lotId: l.id,
      cached: l.cachedRemaining,
      recomputed: l.recomputedRemaining,
      repaired: l.cachedRemaining !== l.recomputedRemaining,
    }));
    const driftedLots = lots.filter((l) => l.repaired);
    const dbRepaired = pointsRepaired || tierRepaired || driftedLots.length > 0;

    // (3) Overwrite ONLY diverging caches (Req 1.7). When the customer scalar
    // caches drift we rewrite both to their recomputed values (rewriting a
    // matching value to itself is harmless).
    if (pointsRepaired || tierRepaired) {
      await tx.query(UPDATE_CUSTOMER_CACHE_SQL, [recomputedTier, recomputedPoints, customerId]);
    }
    for (const lot of driftedLots) {
      await tx.query(UPDATE_LOT_REMAINING_SQL, [lot.recomputed, lot.lotId]);
    }

    return {
      lifetimePoints: { cached: cachedPoints, recomputed: recomputedPoints, repaired: pointsRepaired },
      tier: { cached: cachedTier, recomputed: recomputedTier, repaired: tierRepaired },
      lots,
      dbRepaired,
    };
  });

  if (!repair) {
    return { status: "skipped_unknown_customer", customerId };
  }

  // (4) Refresh the Metafield_Cache from the ledger (Req 13.7). Reuses the
  // task-6.6 writer/worker unchanged; non-fatal by design.
  const metafield = await processMetafieldCacheJob(customerId, {
    writer: deps.metafieldWriter,
    db: deps.db,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    status: "reconciled",
    customerId,
    lifetimePoints: repair.lifetimePoints,
    tier: repair.tier,
    lots: repair.lots,
    dbRepaired: repair.dbRepaired,
    metafield,
  };
}

/**
 * Runs a full reconciliation pass (Requirements 1.7, 13.7): reconciles every
 * customer (or a supplied subset) and returns per-customer records plus the
 * processed / repaired counts. This is the callable job the scheduler invokes
 * at least once every 24 hours.
 *
 * @param deps    DB, transactor, metafield writer, and optional rules/clock.
 * @param options optionally restrict to specific `customerIds` (defaults to all).
 */
const UNBACKED_CREDITS_SQL = `
  SELECT l.id,
         l.customer_id,
         c.shopify_customer_id,
         l.entry_type,
         l.points,
         l.reason,
         l.created_at
    FROM ledger_entries l
    JOIN customers c ON c.id = l.customer_id
   WHERE l.points > 0
     AND NOT EXISTS (SELECT 1 FROM point_lots p WHERE p.ledger_entry_id = l.id)
   ORDER BY l.created_at
`;

interface UnbackedCreditRow {
  id: string;
  customer_id: string;
  shopify_customer_id: string | number;
  entry_type: string;
  points: string | number;
  reason: string;
  created_at: Date;
}

/**
 * Detects positive ledger entries with no backing Point_Lot — Property 17 /
 * Req 1.3a violations that make credited points permanently unredeemable.
 *
 * READ-ONLY and repair-free by design. It answers "is every credit spendable?",
 * which nothing else asked at runtime: the per-customer pass repairs cached
 * totals and lot REMAINDERS, so a missing lot reconciles as clean and the gap
 * between Balance and Spendable_Balance stays invisible. Remediation is the
 * separate, idempotent, dry-run-by-default operator script, because inserting a
 * lot hands a member spendable points and should never happen unreviewed.
 *
 * Scoped to `customerIds` when supplied, so an admin-triggered reconciliation for
 * one customer reports only that customer's violations.
 */
export async function detectUnbackedCredits(
  db: Queryable,
  customerIds?: readonly string[],
): Promise<UnbackedCredit[]> {
  const result = await db.query<UnbackedCreditRow>(UNBACKED_CREDITS_SQL);
  const scope = customerIds ? new Set(customerIds) : null;

  return result.rows
    .filter((row) => scope === null || scope.has(row.customer_id))
    .map((row) => ({
      ledgerEntryId: row.id,
      customerId: row.customer_id,
      shopifyCustomerId: String(row.shopify_customer_id),
      entryType: row.entry_type,
      points: parseIntegerColumn(row.points, "ledger_entries.points"),
      reason: row.reason,
      createdAt: row.created_at,
    }));
}

export async function runReconciliation(
  deps: ReconcileDeps,
  options: { customerIds?: readonly string[] } = {},
): Promise<ReconciliationResult> {
  const asOf = deps.now ? deps.now() : new Date();

  let ids: string[];
  if (options.customerIds) {
    ids = [...options.customerIds];
  } else {
    const listed = await deps.db.query<{ id: string }>(LIST_CUSTOMER_IDS_SQL);
    ids = listed.rows.map((r) => r.id);
  }

  const customers: CustomerReconciliation[] = [];
  let repaired = 0;
  for (const id of ids) {
    const result = await reconcileCustomer(id, deps);
    customers.push(result);
    if (result.status === "reconciled" && result.dbRepaired) {
      repaired += 1;
    }
  }

  // Property 17 watchdog (Req 1.3a). Detection only — see detectUnbackedCredits.
  // Deliberately non-fatal: a failure here must not fail a reconciliation pass
  // that has already repaired real cache drift, so an empty list is reported and
  // the next run tries again. The gap it closes was invisible for two tasks.
  let unbackedCredits: UnbackedCredit[] = [];
  try {
    unbackedCredits = await detectUnbackedCredits(deps.db, options.customerIds);
    if (unbackedCredits.length > 0) {
      // Escalate. The scheduled job throws its return value away, so without
      // this the detection would be as silent as the bug it exists to catch.
      // Best-effort: a throwing callback must not fail the reconciliation.
      try {
        deps.onUnbackedCredits?.(unbackedCredits);
      } catch {
        // Reporting must never break repair.
      }
    }
  } catch {
    unbackedCredits = [];
  }

  return { asOf, processed: customers.length, repaired, customers, unbackedCredits };
}

/* -------------------------------------------------------------------------- */
/* Scheduler registration (config/doc only — not wired to a live scheduler).   */
/* -------------------------------------------------------------------------- */

/** The queue/job name the reconciliation pass is scheduled under. */
export const RECONCILIATION_JOB = "reconcileCaches" as const;

/**
 * The maximum allowed gap between reconciliation runs (Req 13.7: "at least once
 * every 24 hours"). The default cadence runs well within this bound.
 */
export const RECONCILIATION_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The default cadence: daily at 03:00 (a quiet hour), comfortably satisfying
 * the "at least every 24 hours" requirement (Req 13.7).
 */
export const RECONCILIATION_CRON = "0 3 * * *" as const;

/** Declarative schedule config for the reconciliation job (Req 13.7). */
export interface ReconciliationSchedule {
  jobName: string;
  /** Cron expression for the run cadence. */
  cron: string;
  /** Upper bound on the interval between runs, in ms (Req 13.7). */
  maxIntervalMs: number;
}

/** The default reconciliation schedule (doc/config; not wired to a live scheduler). */
export const RECONCILIATION_SCHEDULE: ReconciliationSchedule = {
  jobName: RECONCILIATION_JOB,
  cron: RECONCILIATION_CRON,
  maxIntervalMs: RECONCILIATION_MAX_INTERVAL_MS,
};

/**
 * A minimal structural view of a recurring scheduler (satisfied by e.g. pg-boss
 * `schedule(name, cron, data, options)`), declared locally so registering the
 * job does not hard-couple reconciliation to any concrete scheduler.
 */
export interface RecurringScheduler {
  schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void> | void;
}

/**
 * Registers the reconciliation pass on a scheduler so it runs at least every
 * 24 hours (Req 13.7). The registered handler simply invokes
 * {@link runReconciliation}. This wires a callable job to a scheduler
 * abstraction; production supplies a real recurring scheduler at deploy time —
 * no live scheduler is engaged by calling this in a test/registration context.
 *
 * @returns the {@link ReconciliationSchedule} that was registered.
 */
export async function registerReconciliationJob(
  scheduler: RecurringScheduler,
  deps: ReconcileDeps,
  schedule: ReconciliationSchedule = RECONCILIATION_SCHEDULE,
): Promise<ReconciliationSchedule> {
  await scheduler.schedule(schedule.jobName, schedule.cron, async () => {
    await runReconciliation(deps);
  });
  return schedule;
}
