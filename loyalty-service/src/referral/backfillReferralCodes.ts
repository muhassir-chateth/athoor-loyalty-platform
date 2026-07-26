/**
 * Referral-code backfill for legacy members (task 36).
 *
 * WHY THIS EXISTS
 * ---------------
 * `assignReferralCode` runs on exactly one path: the `customers/create` signup
 * webhook. Every member enrolled BEFORE that wiring landed (task 25) therefore
 * has `customers.referral_code IS NULL` for ever. Found live on staging: only 2
 * of 8 enrolled customers had a code. For the other six:
 *
 *   - `GET /v1/referral` returns `referralCode: null`;
 *   - the Metafield_Cache writer correctly writes no `loyalty.referral_code`
 *     (it omits the key rather than writing an empty string);
 *   - so the dashboard shows the "Preparing your code…" placeholder added by
 *     task 34 **indefinitely**, and those members can never refer anyone.
 *
 * The placeholder is honest — there genuinely is no code — but the state it
 * describes is permanent without this backfill.
 *
 * DESIGN — reuse, do not reimplement
 * ----------------------------------
 * The generation, uniqueness and concurrency rules already exist in
 * {@link assignReferralCode} and are exercised by its own tests: it is
 * idempotent (a customer with a code keeps it), collision-safe (retries on the
 * `referral_code` unique violation), and its UPDATE is guarded
 * `WHERE referral_code IS NULL` with a re-read when another writer wins the
 * race. This module is therefore a SELECTION + ORCHESTRATION layer only. It adds
 * no code-generation logic of its own, so the backfill and the signup path can
 * never drift apart.
 *
 * SAFETY PROPERTIES
 *   - **Dry run by default.** Nothing is written unless the caller asks
 *     ({@link ReferralCodeBackfillOptions.apply}).
 *   - **Only NULL codes are touched.** The selection is
 *     `WHERE referral_code IS NULL`, and the UPDATE inside `assignReferralCode`
 *     carries the same predicate — so an existing code cannot be modified even
 *     if it appeared between the SELECT and the UPDATE.
 *   - **Per-customer transactions.** One customer's failure (an exhausted
 *     collision retry, say) neither rolls back nor blocks the others. This is
 *     deliberately unlike the M1 backfill, which is all-or-nothing because a
 *     partial ledger would be incoherent; a partially-assigned set of referral
 *     codes is perfectly coherent, and stopping the whole run over one row would
 *     just require more reruns.
 *   - **Reruns are a complete no-op.** After a successful apply no row matches
 *     the selection, so a second run scans nothing and writes nothing.
 *   - **Off-ledger.** Nothing here touches `ledger_entries`, `point_lots` or any
 *     balance. `customers.referral_code` is not a balance-bearing column, so no
 *     ledger correctness property is in scope.
 *
 * CACHE REFRESH: a newly created code must reach Shopify or the storefront's
 * server-rendered fallback keeps showing the placeholder until something else
 * happens to refresh that customer. So every CREATED code enqueues a
 * Metafield_Cache refresh (Req 13.5a-style, best-effort): a queue failure is
 * counted and reported, never thrown, because the code itself is already
 * committed and reconciliation is the safety net (Req 13.7).
 */
import type { Queryable } from "../ledger/repository.js";
import type { MetafieldCacheEnqueuer } from "../shopify/metafieldCache.js";
import { assignReferralCode, generateReferralCode } from "./referral.js";

/** Runs a unit of work inside one transaction (mirrors the earning modules). */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Members with no referral code yet, oldest first for a deterministic run. */
const SELECT_MISSING_CODES_SQL = `
  SELECT id, shopify_customer_id
    FROM customers
   WHERE referral_code IS NULL
   ORDER BY created_at, id
`;

interface MissingCodeRow {
  id: string;
  shopify_customer_id: string | number;
}

/** One customer the run would assign, or did assign, a code to. */
export interface BackfillCandidate {
  /** Local `customers.id`. */
  customerId: string;
  /** Shopify customer id, so an operator can identify the member. */
  shopifyCustomerId: string;
}

/** One code actually created by an applied run. */
export interface AssignedReferralCode extends BackfillCandidate {
  /** The code now stored on the customer row. */
  referralCode: string;
  /**
   * True when THIS run generated the code; false when a concurrent writer (the
   * signup webhook, or another backfill process) assigned it first and this run
   * merely observed theirs. Either way the customer ends up with exactly one
   * code — which is the property that actually matters.
   *
   * KNOWN IMPRECISION, stated rather than hidden: provenance is inferred by
   * checking whether the returned code is one this run offered. If two
   * concurrent runs happened to generate the IDENTICAL candidate string, the
   * loser would report `true`. With the real generator that needs a collision in
   * a 32^8 (≈1.1e12) space, and the only consequence is one redundant cache
   * refresh — which is idempotent and coalesced by `singletonKey`, so it is
   * harmless. It is reachable in tests only by injecting a deterministic
   * generator. This field is reporting metadata; never make a correctness
   * decision on it.
   */
  createdByThisRun: boolean;
  /** True iff a Metafield_Cache refresh was successfully enqueued. */
  cacheRefreshEnqueued: boolean;
}

/** A customer whose code could not be assigned; the run continues past it. */
export interface BackfillFailure extends BackfillCandidate {
  error: unknown;
}

/** The outcome of one backfill run. */
export interface ReferralCodeBackfillResult {
  mode: "dry_run" | "apply";
  /** Customers found with `referral_code IS NULL`. */
  scanned: number;
  /** In a dry run, who WOULD be assigned a code. Empty on an applied run. */
  candidates: BackfillCandidate[];
  /** Codes now present for previously-null customers (applied runs only). */
  assigned: AssignedReferralCode[];
  /** Of {@link assigned}, how many this run generated itself. */
  created: number;
  /** Of {@link assigned}, how many a concurrent writer had already set. */
  wonByConcurrentWriter: number;
  /** Customers whose assignment failed; the run continued. */
  failures: BackfillFailure[];
  /** Successful Metafield_Cache refresh enqueues. */
  cacheRefreshesEnqueued: number;
  /** Failed enqueues — the code is still committed; reconciliation repairs. */
  cacheEnqueueFailures: number;
}

/** Options for {@link runReferralCodeBackfill}. */
export interface ReferralCodeBackfillOptions {
  /** Read connection used to select the customers missing a code. */
  db: Queryable;
  /** Runs each customer's assignment in its own transaction. Required to apply. */
  transactor?: Transactor;
  /**
   * Enqueues the Metafield_Cache refresh for each CREATED code so the
   * storefront's server-rendered fallback stops showing the placeholder. Omitted
   * on a non-Shopify boot; reconciliation then converges the cache (Req 13.7).
   */
  metafieldEnqueuer?: MetafieldCacheEnqueuer;
  /**
   * WRITE SWITCH. Defaults to `false` — a dry run that reports the plan and
   * changes nothing.
   */
  apply?: boolean;
  /** Injectable code generator, so tests can force collisions/determinism. */
  generate?: () => string;
}

/**
 * Assigns a referral code to every customer that has none, and refreshes the
 * display cache for each code created.
 *
 * Dry run by default. Preserves every existing code (the selection and the
 * underlying UPDATE are both gated on `referral_code IS NULL`). Idempotent: a
 * rerun after a successful apply scans nothing and writes nothing.
 *
 * @throws if `apply` is true without a `transactor` — refusing is safer than
 *         silently degrading a requested write into a dry run.
 */
export async function runReferralCodeBackfill(
  options: ReferralCodeBackfillOptions,
): Promise<ReferralCodeBackfillResult> {
  const apply = options.apply === true;
  if (apply && !options.transactor) {
    throw new Error(
      "runReferralCodeBackfill was asked to APPLY but no transactor was supplied; " +
        "refusing to continue rather than silently performing a dry run.",
    );
  }

  const { rows } = await options.db.query<MissingCodeRow>(SELECT_MISSING_CODES_SQL);
  const candidates: BackfillCandidate[] = rows.map((row) => ({
    customerId: row.id,
    shopifyCustomerId: String(row.shopify_customer_id),
  }));

  if (!apply) {
    return {
      mode: "dry_run",
      scanned: candidates.length,
      candidates,
      assigned: [],
      created: 0,
      wonByConcurrentWriter: 0,
      failures: [],
      cacheRefreshesEnqueued: 0,
      cacheEnqueueFailures: 0,
    };
  }

  const transactor = options.transactor as Transactor;
  const generate = options.generate ?? generateReferralCode;
  const assigned: AssignedReferralCode[] = [];
  const failures: BackfillFailure[] = [];
  let cacheRefreshesEnqueued = 0;
  let cacheEnqueueFailures = 0;

  for (const candidate of candidates) {
    // Track every code THIS run offered, so the returned value tells us whether
    // we assigned it or observed a concurrent writer's. `assignReferralCode`
    // returns an existing code untouched, which is exactly the behaviour that
    // makes concurrent execution safe — but it means the return value alone
    // cannot say who won.
    const offered = new Set<string>();
    let referralCode: string;
    try {
      referralCode = await transactor.transaction((tx) =>
        assignReferralCode(tx, candidate.customerId, () => {
          const code = generate();
          offered.add(code);
          return code;
        }),
      );
    } catch (error) {
      // One customer's failure must not abort the rest.
      failures.push({ ...candidate, error });
      continue;
    }

    const createdByThisRun = offered.has(referralCode);

    // Push the new code into the Metafield_Cache so the storefront's no-JS
    // fallback stops rendering the placeholder. Best-effort: the code is already
    // committed, so a queue failure is recorded, not thrown.
    let cacheRefreshEnqueued = false;
    if (createdByThisRun && options.metafieldEnqueuer) {
      try {
        await options.metafieldEnqueuer.enqueueMetafieldCache({
          customerId: candidate.customerId,
        });
        cacheRefreshEnqueued = true;
        cacheRefreshesEnqueued += 1;
      } catch {
        cacheEnqueueFailures += 1;
      }
    }

    assigned.push({ ...candidate, referralCode, createdByThisRun, cacheRefreshEnqueued });
  }

  return {
    mode: "apply",
    scanned: candidates.length,
    candidates: [],
    assigned,
    created: assigned.filter((a) => a.createdByThisRun).length,
    wonByConcurrentWriter: assigned.filter((a) => !a.createdByThisRun).length,
    failures,
    cacheRefreshesEnqueued,
    cacheEnqueueFailures,
  };
}
