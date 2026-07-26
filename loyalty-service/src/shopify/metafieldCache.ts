/**
 * Metafield cache writer (task 6.6).
 *
 * This is the write side of design.md "Principle 4: Metafields as cache" and
 * the `writeMetafieldCache(customerId, snapshot)` method of "Component 3:
 * Shopify Admin Gateway". After ANY balance change the service enqueues a job
 * that writes a customer's `loyalty.*` display metafields — `points_balance`,
 * `tier`, `lifetime_points`, `lifetime_spend_gbp`, tier progress, and the
 * member's real `referral_code` (task 34) — back to
 * Shopify via the Admin API, so the existing LV-inspired Liquid dashboard keeps
 * rendering even when the live `/v1` API is briefly unavailable.
 *
 * The snapshot is DERIVED FROM THE LEDGER (Req 13.1 — the ledger is the single
 * source of truth): `points_balance` is the spendable balance summed over
 * non-expired lots, `lifetime_points` is the net ledger balance, and the tier /
 * lifetime-spend / progress come from the tier model. The metafield write is a
 * best-effort, non-authoritative cache; the service always continues serving
 * authoritative data from the ledger regardless of whether the write succeeds
 * (Req 13.5).
 *
 * Failure handling (deliberately NON-FATAL — the ledger is the truth):
 *   - Req 13.5: on a failed write, retry with exponential backoff (initial 1s,
 *     doubling, cap 60s) up to 5 attempts, and keep serving the ledger during
 *     and after the failure.
 *   - Req 15.6: if the write ultimately fails (the ≤3-retry preserve path is a
 *     configurable, smaller attempt budget), PRESERVE the last known-good
 *     metafield value (a failed write never overwrites the previous value) and
 *     RECORD the failure for reconciliation (task 12.1 recomputes the cache from
 *     the ledger and repairs drift).
 *
 * Off the request path (Req 13.2 / 15.2): the write is enqueued as a pg-boss
 * job and performed by {@link processMetafieldCacheJob} in a worker, NEVER
 * synchronously in a webhook/request handler. Because the worker runs promptly
 * after the balance change, the earned points become visible post-purchase via
 * this cache + the dashboard within 60 seconds, with NO checkout-page
 * customization (Req 15.2).
 *
 * WRITE-SIDE ONLY (Req 15.5): the metafield write happens EXCLUSIVELY from this
 * backend via the injected Admin client — never from storefront Liquid, which
 * can only READ metafields.
 *
 * SAFETY: defining this module touches no live system and calls no live Shopify
 * Admin API. The Admin API is reached only through the injected
 * {@link CustomerMetafieldClient}; all DB access goes through the injected
 * {@link Queryable}. Every path is unit-tested against a fake client + fake DB,
 * so no live Shopify Admin API is called during verification.
 */
import { computeBalance, computeSpendableBalance } from "../ledger/balance.js";
import type { Queryable } from "../ledger/repository.js";
import { buildTierSummary, normalizeTier, type Tier } from "../tier/tier.js";
import { backoffDelayMs, type BackoffParams, type Sleeper } from "./adminGateway.js";

/** The Shopify metafield namespace all loyalty display-cache fields live under. */
export const LOYALTY_METAFIELD_NAMESPACE = "loyalty" as const;

/**
 * Backoff policy for the metafield cache write (Req 13.5): 1s initial, doubling,
 * 60s cap, up to 5 attempts. Distinct from the discount-code gateway's
 * 10-attempt {@link DEFAULT_BACKOFF} because Req 13.5 caps cache writes at 5.
 */
export const METAFIELD_BACKOFF: BackoffParams = {
  initialMs: 1000,
  factor: 2,
  capMs: 60000,
  maxAttempts: 5,
} as const;

/**
 * The smaller attempt budget for the preserve-last-known-good path (Req 15.6:
 * "retry the write up to 3 times"). Callers that want the 15.6 semantics pass
 * this as `maxAttempts` to {@link MetafieldCacheWriter.write}; the default write
 * uses {@link METAFIELD_BACKOFF}'s 5-attempt budget (Req 13.5). Either way the
 * write is non-fatal and preserves last-known-good on exhaustion.
 */
export const PRESERVE_LAST_KNOWN_GOOD_MAX_ATTEMPTS = 3 as const;

/**
 * A snapshot of a customer's loyalty standing, DERIVED FROM THE LEDGER, that is
 * mirrored into the Shopify `loyalty.*` display metafields (design "CacheSnapshot").
 * Every field is reconstructable from `ledger_entries` + `point_lots`; nothing
 * here is authoritative (Req 13.1).
 */
export interface CacheSnapshot {
  /** Spendable balance (sum of non-expired lots) → `loyalty.points_balance`. */
  pointsBalance: number;
  /** Net ledger balance (SUM of ledger points) → `loyalty.lifetime_points`. */
  balance: number;
  /** Current retained tier → `loyalty.tier`. */
  tier: Tier;
  /** Cumulative lifetime spend in GBP (2dp) → `loyalty.lifetime_spend_gbp`. */
  lifetimeSpendGBP: number;
  /** Remaining GBP to the next tier, or null at the top tier → `loyalty.tier_progress_gbp`. */
  progressToNextTierGBP: number | null;
  /**
   * The member's own shareable referral code → `loyalty.referral_code`, or null
   * when the customer has not been assigned one yet (task 34).
   *
   * WHY IT IS HERE: the storefront dashboard's server-rendered fallback read this
   * metafield, found it absent on every customer, and FABRICATED a code
   * (`ATHOOR-…`) — so members were shown a code the service does not recognise
   * (audit F3). Mirroring the real code from `customers.referral_code` gives that
   * fallback a genuine value to render. Like the tier-progress field it is
   * OMITTED from the write when null, so a customer with no code yet keeps an
   * absent metafield rather than gaining an empty-string one.
   */
  referralCode: string | null;
  /** When the snapshot was computed (ISO 8601) → `loyalty.updated_at`. */
  computedAt: string;
}

/** A single Shopify metafield value to write under {@link LOYALTY_METAFIELD_NAMESPACE}. */
export interface MetafieldValue {
  namespace: string;
  key: string;
  /** Shopify metafield type, e.g. `number_integer`, `number_decimal`, `single_line_text_field`. */
  type: string;
  value: string;
}

/** The payload handed to the injected Admin client for one customer's cache write. */
export interface MetafieldWriteInput {
  /** Shopify customer GID the metafields are written to, e.g. `gid://shopify/Customer/123`. */
  customerGid: string;
  /** The `loyalty.*` metafields derived from {@link CacheSnapshot}. */
  metafields: MetafieldValue[];
}

/**
 * The injectable boundary to the Shopify Admin API for metafield writes — the
 * metafield analogue of {@link ShopifyAdminClient}. The writer depends only on
 * this interface; production supplies a GraphQL-backed implementation and tests
 * supply a fake. Implementations throw on ANY failure so the writer can retry
 * with backoff (Req 13.5); a resolved promise means the write succeeded.
 */
export interface CustomerMetafieldClient {
  writeCustomerMetafields(input: MetafieldWriteInput): Promise<void>;
}

/** A recorded metafield-write failure, for reconciliation (Req 15.6). */
export interface MetafieldWriteFailure {
  customerGid: string;
  /** The snapshot that could not be written. */
  attempted: CacheSnapshot;
  /** The last successfully-written snapshot that remains in the cache, if known. */
  lastKnownGood: CacheSnapshot | null;
  /** Number of attempts made before giving up. */
  attempts: number;
  /** The last error thrown by the client. */
  error: unknown;
}

/**
 * Sink for metafield-write failures (Req 15.6: "record the failure for
 * reconciliation"). The reconciliation job (task 12.1) recomputes the cache
 * from the ledger and repairs drift; recording here is best-effort and MUST NOT
 * throw (a failed recording must not turn a non-fatal cache miss into a fatal
 * error).
 */
export interface MetafieldFailureRecorder {
  recordFailure(failure: MetafieldWriteFailure): Promise<void>;
}

/**
 * Default recorder: keeps failures in memory for inspection/tests and never
 * throws. Production may inject a recorder that persists to a
 * reconciliation-queue table; the reconciliation job repairs the cache from the
 * ledger regardless (Req 13.7).
 */
export class InMemoryFailureRecorder implements MetafieldFailureRecorder {
  readonly failures: MetafieldWriteFailure[] = [];
  async recordFailure(failure: MetafieldWriteFailure): Promise<void> {
    this.failures.push(failure);
  }
}

/** The outcome of a single {@link MetafieldCacheWriter.write}. */
export type MetafieldWriteOutcome =
  | { status: "written"; attempts: number; snapshot: CacheSnapshot }
  | {
      status: "preserved_last_known_good";
      attempts: number;
      lastKnownGood: CacheSnapshot | null;
      error: unknown;
    };

/** Options for {@link MetafieldCacheWriter}. */
export interface MetafieldCacheWriterOptions {
  /** Backoff policy; defaults to {@link METAFIELD_BACKOFF} (Req 13.5). */
  backoff?: BackoffParams;
  /** Pauser between attempts; defaults to real `setTimeout` (overridden in tests). */
  sleep?: Sleeper;
  /** Failure sink for reconciliation (Req 15.6); defaults to an in-memory recorder. */
  recorder?: MetafieldFailureRecorder;
}

/** Options for a single {@link MetafieldCacheWriter.write} call. */
export interface MetafieldWriteOptions {
  /**
   * Attempt budget for this write. Defaults to the backoff policy's
   * `maxAttempts` (5 per Req 13.5). Pass
   * {@link PRESERVE_LAST_KNOWN_GOOD_MAX_ATTEMPTS} for the Req 15.6 ≤3-retry
   * preserve-last-known-good path.
   */
  maxAttempts?: number;
}

/** Real-time sleeper used in production. */
const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the `loyalty.*` metafields for a snapshot. Money and progress use
 * `number_decimal`; counts use `number_integer`; tier and timestamp are text.
 * The tier-progress field is OMITTED at the top tier (null progress) rather
 * than written as an empty value (Req 7.6 friendliness on the display side).
 */
export function snapshotToMetafields(snapshot: CacheSnapshot): MetafieldValue[] {
  const ns = LOYALTY_METAFIELD_NAMESPACE;
  const fields: MetafieldValue[] = [
    { namespace: ns, key: "points_balance", type: "number_integer", value: String(snapshot.pointsBalance) },
    { namespace: ns, key: "lifetime_points", type: "number_integer", value: String(snapshot.balance) },
    { namespace: ns, key: "tier", type: "single_line_text_field", value: snapshot.tier },
    {
      namespace: ns,
      key: "lifetime_spend_gbp",
      type: "number_decimal",
      value: snapshot.lifetimeSpendGBP.toFixed(2),
    },
    { namespace: ns, key: "updated_at", type: "single_line_text_field", value: snapshot.computedAt },
  ];
  if (snapshot.progressToNextTierGBP !== null) {
    fields.push({
      namespace: ns,
      key: "tier_progress_gbp",
      type: "number_decimal",
      value: snapshot.progressToNextTierGBP.toFixed(2),
    });
  }
  // The member's real referral code (task 34, audit F3). OMITTED — never written
  // as an empty string — when the customer has no code yet, so the storefront can
  // tell "no code yet" from "code available" and show a neutral placeholder
  // instead of inventing one. `referral_code` is already in
  // LOYALTY_METAFIELD_KEYS, so the M0 export/rollback treatment is unchanged.
  const referralCode = snapshot.referralCode?.trim();
  if (referralCode) {
    fields.push({
      namespace: ns,
      key: "referral_code",
      type: "single_line_text_field",
      value: referralCode,
    });
  }
  return fields;
}

/**
 * The non-fatal, retrying metafield cache writer. Wraps an injected
 * {@link CustomerMetafieldClient} with the exponential-backoff retry loop of
 * Req 13.5 and the preserve-last-known-good + record-failure behaviour of
 * Req 15.6. It NEVER throws on a write failure — the ledger stays authoritative
 * (Req 13.1 / 13.5) and the caller (worker) simply continues.
 *
 * "Last known good" is the most recent snapshot this writer successfully wrote
 * for a given customer. Because a failed Admin write leaves the existing
 * metafield untouched, that value remains in Shopify; the writer reports it so
 * callers/tests can confirm the preserved value, and records the failure so
 * reconciliation can repair the cache later (Req 15.6).
 */
export class MetafieldCacheWriter {
  private readonly client: CustomerMetafieldClient;
  private readonly backoff: BackoffParams;
  private readonly sleep: Sleeper;
  private readonly recorder: MetafieldFailureRecorder;
  /** Per-customer last successfully-written snapshot (the preserved cache value). */
  private readonly lastKnownGood = new Map<string, CacheSnapshot>();

  constructor(client: CustomerMetafieldClient, options: MetafieldCacheWriterOptions = {}) {
    this.client = client;
    this.backoff = options.backoff ?? METAFIELD_BACKOFF;
    this.sleep = options.sleep ?? realSleep;
    this.recorder = options.recorder ?? new InMemoryFailureRecorder();
  }

  /** The last snapshot successfully written for a customer, or null if none. */
  getLastKnownGood(customerGid: string): CacheSnapshot | null {
    return this.lastKnownGood.get(customerGid) ?? null;
  }

  /**
   * Writes the snapshot's `loyalty.*` metafields, retrying failed attempts with
   * exponential backoff (Req 13.5). Resolves with `written` on success or
   * `preserved_last_known_good` when the attempt budget is exhausted — in the
   * latter case the previous metafield value is preserved and the failure is
   * recorded for reconciliation (Req 15.6). NEVER rejects on a write failure.
   *
   * @param customerGid Shopify customer GID to write to.
   * @param snapshot    the ledger-derived snapshot to mirror.
   * @param options     per-call attempt budget (default: backoff `maxAttempts`).
   */
  async write(
    customerGid: string,
    snapshot: CacheSnapshot,
    options: MetafieldWriteOptions = {},
  ): Promise<MetafieldWriteOutcome> {
    const maxAttempts = options.maxAttempts ?? this.backoff.maxAttempts;
    const input: MetafieldWriteInput = { customerGid, metafields: snapshotToMetafields(snapshot) };
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.client.writeCustomerMetafields(input);
        // Success: this snapshot is now the cache's last known-good value.
        this.lastKnownGood.set(customerGid, snapshot);
        return { status: "written", attempts: attempt, snapshot };
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          // Wait out the backoff before the next attempt (Req 13.5).
          await this.sleep(backoffDelayMs(attempt, this.backoff));
        }
      }
    }

    // Exhausted (Req 13.5 / 15.6): NON-FATAL. The prior metafield value is
    // preserved (a failed write never overwrote it); record for reconciliation.
    const preserved = this.lastKnownGood.get(customerGid) ?? null;
    await this.recorder.recordFailure({
      customerGid,
      attempted: snapshot,
      lastKnownGood: preserved,
      attempts: maxAttempts,
      error: lastError,
    });
    return {
      status: "preserved_last_known_good",
      attempts: maxAttempts,
      lastKnownGood: preserved,
      error: lastError,
    };
  }
}

/** Builds the Shopify customer GID a cache write targets. */
export function customerGid(shopifyCustomerId: string | number): string {
  return `gid://shopify/Customer/${shopifyCustomerId}`;
}

/** Parses a NUMERIC(12,2) column (`pg` returns it as a string) into a finite number. */
function toMoney(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface CustomerCacheRow {
  shopify_customer_id: string | number;
  tier: string | null;
  lifetime_spend_gbp: string | number | null;
  referral_code: string | null;
}

const LOAD_CUSTOMER_SQL = `
  SELECT shopify_customer_id, tier, lifetime_spend_gbp, referral_code
  FROM customers
  WHERE id = $1
  LIMIT 1
`;

/**
 * Derives a {@link CacheSnapshot} for a customer STRICTLY FROM THE LEDGER + tier
 * model (Req 13.1): `pointsBalance` from non-expired lots, `balance` from the
 * signed ledger sum, and tier/lifetime-spend/progress from the tier summary.
 * Reads the customer's Shopify id so the caller can target the metafield write.
 *
 * @param customerId the local `customers.id`.
 * @param db         Pool/PoolClient to read on.
 * @param asOf       reference instant for expiry (defaults to now).
 * @returns the snapshot and the resolved Shopify customer id, or null if the
 *          customer row does not exist.
 */
export async function deriveCacheSnapshot(
  customerId: string,
  db: Queryable,
  asOf: Date = new Date(),
): Promise<{ shopifyCustomerId: string | number; snapshot: CacheSnapshot } | null> {
  const loaded = await db.query<CustomerCacheRow>(LOAD_CUSTOMER_SQL, [customerId]);
  const row = loaded.rows[0];
  if (!row) {
    return null;
  }

  const [balance, pointsBalance] = await Promise.all([
    computeBalance(customerId, db),
    computeSpendableBalance(customerId, db, asOf),
  ]);

  const lifetimeSpendGBP = toMoney(row.lifetime_spend_gbp);
  const summary = buildTierSummary(lifetimeSpendGBP, normalizeTier(row.tier));

  const snapshot: CacheSnapshot = {
    pointsBalance,
    balance,
    tier: summary.tier,
    lifetimeSpendGBP: summary.lifetimeSpendGBP,
    progressToNextTierGBP: summary.progressToNextTierGBP,
    // The authoritative code from `customers.referral_code` (task 34). Null when
    // unassigned, so nothing is written rather than an empty code.
    referralCode: row.referral_code?.trim() ? row.referral_code.trim() : null,
    computedAt: asOf.toISOString(),
  };

  return { shopifyCustomerId: row.shopify_customer_id, snapshot };
}

/* -------------------------------------------------------------------------- */
/* Job queue: enqueue after any balance change; process off the request path. */
/* -------------------------------------------------------------------------- */

/** The queue name the metafield cache write job is published/consumed on. */
export const METAFIELD_CACHE_JOB = "writeMetafieldCache" as const;

/** The `writeMetafieldCache` job payload — just the customer whose cache to refresh. */
export interface MetafieldCacheJob {
  customerId: string;
}

/**
 * Enqueue contract. Called after ANY balance change (signup/order earning,
 * redemption spend, clawback, expiry, adjustment, migration) so the cache is
 * refreshed off the request path (Req 13.2 / 15.2). Implementations MUST return
 * quickly and MUST NOT call the Admin API inline.
 */
export interface MetafieldCacheEnqueuer {
  enqueueMetafieldCache(job: MetafieldCacheJob): Promise<void>;
}

/**
 * The subset of pg-boss this enqueuer relies on (declared structurally so the
 * real `PgBoss` satisfies it without a hard type import).
 */
export interface JobPublisher {
  send(queue: string, data: object, options?: object): Promise<string | null>;
}

/**
 * pg-boss-backed enqueuer. Publishes one cache-refresh job per balance change,
 * keyed by `customerId` via `singletonKey` so rapid successive changes collapse
 * to a single pending refresh (the worker always writes the LATEST ledger-derived
 * snapshot, so coalescing loses nothing).
 */
export class PgBossMetafieldCacheEnqueuer implements MetafieldCacheEnqueuer {
  constructor(private readonly boss: JobPublisher) {}

  async enqueueMetafieldCache(job: MetafieldCacheJob): Promise<void> {
    await this.boss.send(METAFIELD_CACHE_JOB, { ...job }, { singletonKey: job.customerId });
  }
}

/**
 * In-memory enqueuer — the default when no queue is injected and the enqueuer
 * used by tests. Records enqueued jobs so tests can assert a cache refresh was
 * scheduled off the request path (and that no Admin API was called inline).
 */
export class RecordingMetafieldCacheEnqueuer implements MetafieldCacheEnqueuer {
  readonly jobs: MetafieldCacheJob[] = [];
  async enqueueMetafieldCache(job: MetafieldCacheJob): Promise<void> {
    this.jobs.push(job);
  }
}

/** Dependencies for {@link processMetafieldCacheJob}. */
export interface MetafieldCacheDeps {
  /** The non-fatal, retrying cache writer (backed by an injectable Admin client). */
  writer: MetafieldCacheWriter;
  /** Read connection for loading the customer + deriving the snapshot from the ledger. */
  db: Queryable;
  /** Reference instant for expiry when deriving the snapshot (defaults to now). */
  now?: () => Date;
}

/** The outcome of processing a `writeMetafieldCache` job. */
export type MetafieldCacheJobOutcome =
  | { status: "skipped_unknown_customer"; customerId: string }
  | { status: "written"; customerId: string; attempts: number; snapshot: CacheSnapshot }
  | {
      status: "preserved_last_known_good";
      customerId: string;
      attempts: number;
      lastKnownGood: CacheSnapshot | null;
    };

/**
 * Processes one `writeMetafieldCache` job (Requirements 13.1, 13.5, 15.2, 15.5,
 * 15.6). Derives the customer's snapshot from the ledger and writes it via the
 * {@link MetafieldCacheWriter}. The whole thing is non-fatal: an unknown
 * customer is skipped and a failed write preserves the last known-good value —
 * the ledger remains the authoritative source either way (Req 13.1 / 13.5).
 * NEVER calls the Admin API synchronously in a request handler — only here, in
 * the worker.
 */
export async function processMetafieldCacheJob(
  customerId: string,
  deps: MetafieldCacheDeps,
): Promise<MetafieldCacheJobOutcome> {
  const asOf = deps.now ? deps.now() : new Date();
  const derived = await deriveCacheSnapshot(customerId, deps.db, asOf);
  if (!derived) {
    // No such customer (e.g. a lazily-enrolled customer not yet created) —
    // nothing to cache. Non-fatal; the ledger is still authoritative.
    return { status: "skipped_unknown_customer", customerId };
  }

  const outcome = await deps.writer.write(customerGid(derived.shopifyCustomerId), derived.snapshot);
  if (outcome.status === "written") {
    return { status: "written", customerId, attempts: outcome.attempts, snapshot: outcome.snapshot };
  }
  return {
    status: "preserved_last_known_good",
    customerId,
    attempts: outcome.attempts,
    lastKnownGood: outcome.lastKnownGood,
  };
}

/**
 * A minimal structural view of the job queue's consumer side (pg-boss `work`),
 * declared locally so wiring the worker does not hard-couple to pg-boss types.
 */
export interface MetafieldCacheJobConsumer {
  work(
    name: string,
    handler: (jobs: Array<{ data: MetafieldCacheJob }>) => Promise<void>,
  ): Promise<string>;
}

/**
 * Registers the worker on the job queue. Each delivered job is processed by
 * {@link processMetafieldCacheJob}. Because the write is non-fatal by design,
 * the handler does not throw on a failed cache write — the failure is recorded
 * for reconciliation and the ledger keeps serving authoritative data.
 */
export async function registerMetafieldCacheWorker(
  consumer: MetafieldCacheJobConsumer,
  deps: MetafieldCacheDeps,
  queueName: string = METAFIELD_CACHE_JOB,
): Promise<string> {
  return consumer.work(queueName, async (jobs) => {
    for (const job of jobs) {
      await processMetafieldCacheJob(job.data.customerId, deps);
    }
  });
}
