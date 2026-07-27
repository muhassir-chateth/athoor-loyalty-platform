/**
 * `GET /v1/balance` — the authenticated customer's loyalty summary (task 6.3).
 *
 * Returns, for the customer resolved by the `/v1` auth preHandler (task 6.2,
 * `req.authCtx.customerId`):
 *
 *   - the current `Spendable_Balance` (Req 1.3 projection), computed on demand
 *     from the customer's non-expired point lots via
 *     {@link computeSpendableBalance} — never read from a mutable cache;
 *   - the current tier, lifetime spend (2dp), and progress toward the next tier
 *     (or a top-tier indicator for Royal_VIP), built by {@link buildTierSummary}
 *     from the `customers.lifetime_spend_gbp` / `customers.tier` row (Req 7.5,
 *     7.6);
 *   - the available rewards (the four-entry {@link REWARD_CATALOG}) so the
 *     rewards dashboard can render balance + rewards together (Req 8.5).
 *
 * IDENTITY-SOURCE AGNOSTIC (Req 9.2/9.3): the handler only ever reads
 * `req.authCtx.customerId`, which the auth layer resolves identically whether
 * the request arrived via Shopify App Proxy (web) or a Customer Account API
 * bearer token (mobile/portal). The same local customer id therefore yields the
 * same response regardless of identity source.
 *
 * SCOPE (task 6.3 only): this module implements the balance read endpoint. It
 * does NOT implement history (task 6.4), rate limiting (task 6.5), or the
 * metafield cache writer (task 6.6). It reuses — and never modifies — the
 * spendable-balance projection (task 2.3), the tier summary (task 4.3), and the
 * reward catalog (task 5.1).
 *
 * SAFETY: defining this module touches no live/production system. The
 * Pg-backed data source issues read-only SQL only when a caller passes a real
 * Pool/PoolClient at runtime; the route logic is unit-tested against an
 * in-memory fake source, so live DB verification is deferred to deploy time.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";
import { computeSpendableBalance } from "../ledger/balance.js";
import type { Queryable } from "../ledger/repository.js";
import { REWARD_CATALOG, type Reward } from "../rewards/catalog.js";
import { buildTierSummary, type Tier, type TierRuleSet } from "../tier/tier.js";
import type { EntitlementResolver } from "../benefits/entitlementResolver.js";
import { toBenefitView, type BenefitView } from "./benefits.js";

/**
 * The persisted, tier-driving facts read from the `customers` row for a balance
 * request. `tier` is the RETAINED cached tier (may be null/legacy); the summary
 * never reports below it (Req 7.3/7.7). `lifetimeSpendGBP` drives tier
 * derivation and progress (Req 7.1/7.5).
 */
export interface CustomerBalanceRow {
  /** Cumulative lifetime spend in GBP (drives tier + progress). */
  lifetimeSpendGBP: number;
  /** The customer's retained tier, or null when not yet set (defaults to Bronze). */
  tier: string | null;
}

/**
 * A point-in-time snapshot backing a balance response: the customer's
 * tier-driving row plus the derived `Spendable_Balance`.
 */
export interface CustomerBalanceSnapshot extends CustomerBalanceRow {
  /** `SUM(point_lots.remaining_points)` over non-expired lots (Req 1.3). */
  spendableBalance: number;
}

/**
 * Loads everything `GET /v1/balance` needs for a customer: the tier-driving
 * `customers` row and the derived `Spendable_Balance`. Returns `null` when no
 * such customer exists, which the handler maps to a not-found response.
 *
 * Expressed as an injectable interface so the route is unit-testable with an
 * in-memory fake and never requires a live Postgres (mirrors the resolver /
 * ledger-repo pattern).
 */
export interface CustomerBalanceSource {
  load(customerId: string, asOf?: Date): Promise<CustomerBalanceSnapshot | null>;
}

/**
 * The `GET /v1/balance` response body (design.md → `BalanceSummary`). Carries
 * the spendable balance, the tier summary (tier, multiplier, lifetime spend,
 * progress-to-next-tier / top-tier indicator), and the available rewards.
 *
 * The `apiVersion` field is injected by the versioning plugin at serialization
 * time and is intentionally not part of this type.
 */
export interface BalanceSummary {
  /** Points currently available to redeem (Req 1.3). */
  spendableBalance: number;
  /** The customer's current (retained) tier (Req 7.5). */
  tier: Tier;
  /** The tier's earning multiplier (Req 7.4). */
  tierMultiplier: number;
  /** Cumulative lifetime spend in GBP to two decimal places (Req 7.5). */
  lifetimeSpendGBP: number;
  /** True iff the customer is at the highest tier (Royal_VIP) (Req 7.6). */
  isTopTier: boolean;
  /** The next higher tier, or null at the top tier (Req 7.6). */
  nextTier: Tier | null;
  /** The next higher tier's inclusive lower threshold in GBP, or null at the top tier. */
  nextTierThresholdGBP: number | null;
  /**
   * Remaining GBP to reach the next tier (2dp, never negative), or null at the
   * top tier — indicating no higher tier exists (Req 7.5, 7.6).
   */
  progressToNextTierGBP: number | null;
  /** The redeemable rewards catalog (Req 8.5). */
  availableRewards: readonly Reward[];
  /**
   * The Benefits the customer's current tier qualifies for (Req 18.2, task 30).
   * ADDITIVE and OPTIONAL: present only when an entitlement resolver is wired,
   * so a build without one returns exactly the previous body (Req 9.4). Resolved
   * by the existing Entitlement Resolver from the same derived tier this summary
   * reports — never recomputed here.
   */
  benefits?: readonly BenefitView[];
}

/**
 * Builds the {@link BalanceSummary} response from a loaded snapshot (pure). The
 * tier fields come from {@link buildTierSummary} (Req 7.5/7.6); the available
 * rewards are the fixed catalog (Req 8.5). Kept pure and separate from the HTTP
 * handler so it is directly unit-testable and reused unchanged across identity
 * sources.
 *
 * @param snapshot the customer's tier-driving row + derived spendable balance.
 * @param rules    tier rule set to apply (defaults to the GBP defaults).
 */
export function buildBalanceSummary(
  snapshot: CustomerBalanceSnapshot,
  rules?: TierRuleSet,
  benefits?: readonly BenefitView[],
): BalanceSummary {
  const tier = buildTierSummary(snapshot.lifetimeSpendGBP, snapshot.tier, rules);
  const summary: BalanceSummary = {
    spendableBalance: snapshot.spendableBalance,
    tier: tier.tier,
    tierMultiplier: tier.multiplier,
    lifetimeSpendGBP: tier.lifetimeSpendGBP,
    isTopTier: tier.isTopTier,
    nextTier: tier.nextTier,
    nextTierThresholdGBP: tier.nextTierThresholdGBP,
    progressToNextTierGBP: tier.progressToNextTierGBP,
    availableRewards: REWARD_CATALOG,
  };
  // Omitted entirely (not `[]`) when no resolver is wired, so the body is
  // byte-identical to the pre-task-30 response on such a build.
  if (benefits !== undefined) {
    summary.benefits = benefits;
  }
  return summary;
}

const SELECT_CUSTOMER_BALANCE_ROW_SQL = `
  SELECT lifetime_spend_gbp, tier
  FROM customers
  WHERE id = $1
  LIMIT 1
`;

interface CustomerBalanceDbRow extends QueryResultRow {
  lifetime_spend_gbp: string | number;
  tier: string | null;
}

/** Parses a NUMERIC/BIGINT column (`pg` returns NUMERIC as a string) to a finite number. */
function parseSpendColumn(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres-backed {@link CustomerBalanceSource}: reads `lifetime_spend_gbp` and
 * `tier` from the `customers` row and derives `Spendable_Balance` from the
 * non-expired point lots via {@link computeSpendableBalance}. Read-only.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing. Not used by tests or local runs
 * — an in-memory source stands in so no live Postgres is required.
 */
export class PgCustomerBalanceSource implements CustomerBalanceSource {
  constructor(private readonly db: Queryable) {}

  async load(customerId: string, asOf: Date = new Date()): Promise<CustomerBalanceSnapshot | null> {
    const result = await this.db.query<CustomerBalanceDbRow>(SELECT_CUSTOMER_BALANCE_ROW_SQL, [
      customerId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const spendableBalance = await computeSpendableBalance(customerId, this.db, asOf);
    return {
      lifetimeSpendGBP: parseSpendColumn(row.lifetime_spend_gbp),
      tier: row.tier,
      spendableBalance,
    };
  }
}

/**
 * In-memory {@link CustomerBalanceSource} backed by a `customerId → snapshot`
 * map. The default source for local runs and the vehicle for tests, so the
 * balance endpoint runs with no live Postgres. An unknown customer resolves to
 * `null` (fail closed → not-found), matching the identity/resolver pattern.
 */
export class InMemoryCustomerBalanceSource implements CustomerBalanceSource {
  private readonly byCustomerId: Map<string, CustomerBalanceSnapshot>;

  constructor(entries: Record<string, CustomerBalanceSnapshot> | Map<string, CustomerBalanceSnapshot> = {}) {
    this.byCustomerId =
      entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async load(customerId: string): Promise<CustomerBalanceSnapshot | null> {
    return this.byCustomerId.get(customerId) ?? null;
  }

  /** Test/setup helper: register a snapshot for a local customer id. */
  set(customerId: string, snapshot: CustomerBalanceSnapshot): void {
    this.byCustomerId.set(customerId, snapshot);
  }
}

/** Options accepted by {@link registerBalanceRoute}. */
export interface BalanceRouteOptions {
  /**
   * Loads the tier-driving row + derived spendable balance for a customer.
   * Defaults to an empty in-memory source so the route boots without a live
   * Postgres; it then returns a not-found response until a real source is wired.
   */
  balanceSource?: CustomerBalanceSource;
  /** Tier rule set to apply (defaults to the GBP defaults inside the tier module). */
  tierRules?: TierRuleSet;
  /**
   * OPTIONAL Entitlement Resolver (task 30, Req 18.2). When wired, the summary
   * includes the Benefits the customer's tier qualifies for — this is what makes
   * "account data includes the qualifying Benefits" true of the dashboard's own
   * read, rather than only of a separate endpoint. When absent the `benefits`
   * field is omitted and the response is unchanged.
   */
  entitlementResolver?: EntitlementResolver;
}

/**
 * Registers `GET /v1/balance` on `app`. MUST be called inside the `/v1` router
 * scope so the auth preHandler has already resolved `req.authCtx` (task 6.2)
 * before this handler runs; the handler reads only `req.authCtx.customerId`, so
 * its output is identical across App Proxy and Customer Account API identity
 * sources (Req 9.2/9.3).
 *
 * Responds `401` if auth did not attach an identity (defensive — the preHandler
 * normally rejects first), `404` when the resolved customer has no row, and
 * otherwise `200` with a {@link BalanceSummary} (Req 7.5, 7.6, 8.5).
 */
export function registerBalanceRoute(app: FastifyInstance, opts: BalanceRouteOptions = {}): void {
  const balanceSource = opts.balanceSource ?? new InMemoryCustomerBalanceSource();
  const tierRules = opts.tierRules;
  const entitlementResolver = opts.entitlementResolver;

  app.get("/balance", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      // Defensive: the auth preHandler should have rejected already (Req 9.3).
      return reply.code(401).send({
        error: "identity_resolution_failed",
        message: "Could not resolve the request to a loyalty customer identity.",
      });
    }

    const snapshot = await balanceSource.load(ctx.customerId);
    if (!snapshot) {
      return reply.code(404).send({
        error: "customer_not_found",
        message: "No loyalty customer exists for the resolved identity.",
      });
    }

    let benefits: readonly BenefitView[] | undefined;
    if (entitlementResolver) {
      try {
        const resolved = await entitlementResolver.resolveBenefits(ctx.customerId, ctx.channel);
        benefits = resolved.map(toBenefitView);
      } catch (err) {
        // The balance is the dashboard's core read and the entitlement lookup is
        // an additive extra, so a resolver failure DEGRADES the optional field
        // rather than failing the whole summary — the same fallback philosophy
        // the storefront already applies. It is logged at warn so the failure is
        // visible instead of silent; `GET /v1/benefits` surfaces the real error.
        req.log?.warn(
          { err, customerId: ctx.customerId },
          "entitlement resolution failed for the balance summary; benefits omitted from this response",
        );
      }
    }

    return buildBalanceSummary(snapshot, tierRules, benefits);
  });
}
