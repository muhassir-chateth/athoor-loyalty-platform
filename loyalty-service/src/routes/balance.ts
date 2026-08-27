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
import { requireCustomerScope } from "../auth/customerScope.js";
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
/**
 * The 60-day window §9.4 specifies for `expiringSoon`.
 *
 * Reported back to the client in the response rather than assumed by it, so the
 * copy ("150 points expire in the next 60 days") is rendered from a value the
 * server owns. A client that hardcoded 60 would silently disagree the day this
 * changes.
 */
export const EXPIRING_SOON_WINDOW_DAYS = 60;

/**
 * Points expiring inside {@link EXPIRING_SOON_WINDOW_DAYS} (Req 8.13, §9.4).
 *
 * OMITTED ENTIRELY when nothing expires in the window — never `{ points: 0 }`.
 * §9.4 calls for the same "absent rather than empty" convention the metafield
 * writer already uses for `tier_progress_gbp`, precisely so the UI can tell
 * "nothing expiring" from "unknown" (Req 4.11). A zero-valued object would
 * collapse that distinction and invite a "0 points expiring soon" banner.
 */
export interface ExpiringSoonSummary {
  /** Sum of `remaining_points` over lots expiring inside the window. */
  readonly points: number;
  /** ISO-8601 instant of the EARLIEST such expiry — the date the copy leads with. */
  readonly earliestExpiryAt: string;
  /** The window this was computed over. See {@link EXPIRING_SOON_WINDOW_DAYS}. */
  readonly windowDays: number;
}

/**
 * Per-reward eligibility, computed where the balance lives (Req 8.3, 8.6, §9.1).
 *
 * ── WHY THE SERVER DECIDES THIS ─────────────────────────────────────────────
 * §9.1 lists `spendableBalance >= reward.cost` as the LAST threshold comparison
 * still performed on the client, and removes it. `GET /v1/rewards` is public and
 * cannot know a balance, so the portal reads the catalogue from `/v1/balance`'s
 * `availableRewards` and is handed the verdict rather than computing it. Two
 * clients comparing independently is two chances to disagree with the engine
 * about what is affordable.
 *
 * `additionalPointsRequired` is `0` — not omitted — when the reward IS
 * redeemable. The field is a quantity, and a quantity that exists is clearer than
 * one whose absence the client must interpret; §9.1's table renders it as text
 * only in the not-yet-redeemable state anyway.
 */
export interface RewardEligibility {
  /** True iff the spendable balance covers this reward's cost. */
  readonly redeemable: boolean;
  /** Points still needed; `0` when {@link redeemable} is true. Never negative. */
  readonly additionalPointsRequired: number;
}

/**
 * A catalogue reward carried on the balance response, with its eligibility.
 *
 * ADDITIVE BY CONSTRUCTION: it INTERSECTS the shipped {@link Reward} rather than
 * replacing it, so every existing field keeps its name, type and meaning, and
 * anything typed against `readonly Reward[]` still compiles. `Reward.valueGBP`
 * stays a `number` — Req 20.6 forbids changing a shipped field's shape, and the
 * decimal-string representation belongs to the NEW N16 contract only. The two
 * representations coexist deliberately; `portal/types.ts` records why at length.
 */
export type AvailableReward = Reward & RewardEligibility;

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
  /**
   * Points expiring inside the window, or `undefined` when none are (Req 8.13).
   *
   * OPTIONAL so every existing {@link CustomerBalanceSource} — including the
   * in-memory one every route test uses — still satisfies the interface without
   * being touched. A required field here would have made task 10.1 a change to
   * shipped test fixtures rather than an addition.
   */
  expiringSoon?: ExpiringSoonSummary | undefined;
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
  /**
   * The rewards catalogue WITH per-reward eligibility (Req 8.5, 8.3, 8.6).
   *
   * The declared element type is narrowed from `Reward` to {@link AvailableReward},
   * which is an intersection of it — so this is additive at the wire level and
   * assignable at the type level. Nothing is removed or renamed (Req 20.6).
   */
  availableRewards: readonly AvailableReward[];
  /**
   * Points expiring inside {@link EXPIRING_SOON_WINDOW_DAYS} (Req 8.13, §9.4).
   * ABSENT — not zero-valued — when nothing expires in the window.
   */
  expiringSoon?: ExpiringSoonSummary;
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
 * Attaches eligibility to one catalogue reward (pure).
 *
 * THE ENGINE'S ARITHMETIC IS NOT TOUCHED. This reads the ALREADY-COMPUTED
 * `spendableBalance` — the projection `computeSpendableBalance` produced — and
 * compares it to the reward's own cost. It does not re-derive a balance, does not
 * consult `point_lots`, and does not decide what a redemption would cost. It
 * states a comparison the client would otherwise make (§9.1) and nothing else.
 *
 * `additionalPointsRequired` is clamped at zero rather than allowed to go
 * negative: a redeemable reward requires no additional points, and a negative
 * "points required" is a number no client should have to interpret.
 */
export function withEligibility(reward: Reward, spendableBalance: number): AvailableReward {
  const redeemable = spendableBalance >= reward.cost;
  return {
    ...reward,
    redeemable,
    additionalPointsRequired: redeemable ? 0 : reward.cost - spendableBalance,
  };
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
    availableRewards: REWARD_CATALOG.map((reward) =>
      withEligibility(reward, snapshot.spendableBalance),
    ),
  };
  // ABSENT rather than zero-valued when nothing expires in the window (§9.4).
  if (snapshot.expiringSoon !== undefined) {
    summary.expiringSoon = snapshot.expiringSoon;
  }
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

/**
 * The §9.4 window query: points expiring inside `$2` days, and the earliest such
 * expiry.
 *
 * ── WHY THIS IS ONE INDEXED QUERY AND NOT A NEW ENDPOINT ────────────────────
 * `point_lots` already carries `expires_at`, and `idx_lots_expiry` already indexes
 * `expires_at WHERE remaining_points > 0` — the exact predicate below. §9.4 notes
 * that this makes the 60-day window an additive field on a response the portal
 * already fetches rather than a second round trip.
 *
 * `expires_at > $3` excludes lots that have ALREADY expired. Those points are not
 * "expiring soon", they are gone, and `computeSpendableBalance` has already
 * excluded them from the balance — including them here would tell a customer that
 * points they no longer have are about to leave.
 *
 * OWNERSHIP: `customer_id = $1`, bound from the resolved identity.
 */
const SELECT_EXPIRING_SOON_SQL = `
  SELECT coalesce(sum(remaining_points), 0)::text AS points,
         min(expires_at)                          AS earliest_expiry_at
    FROM point_lots
   WHERE customer_id = $1
     AND remaining_points > 0
     AND expires_at IS NOT NULL
     AND expires_at >  $3
     AND expires_at <= $3::timestamptz + ($2 || ' days')::interval
`;

interface ExpiringSoonDbRow extends QueryResultRow {
  points: string | null;
  earliest_expiry_at: Date | string | null;
}

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
  constructor(
    private readonly db: Queryable,
    private readonly windowDays: number = EXPIRING_SOON_WINDOW_DAYS,
  ) {}

  /**
   * Points expiring inside the window, or `null` when none are.
   *
   * Returns `null` for a zero sum AND for a missing earliest date — both mean
   * "nothing expiring", and a summary with points but no date, or a date but no
   * points, is not a state the client has copy for.
   */
  private async loadExpiringSoon(
    customerId: string,
    asOf: Date,
  ): Promise<ExpiringSoonSummary | null> {
    const result = await this.db.query<ExpiringSoonDbRow>(SELECT_EXPIRING_SOON_SQL, [
      customerId,
      String(this.windowDays),
      asOf,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    // `sum()` over BIGINT is BIGINT, which the driver returns as a string; cast in
    // SQL so the conversion is explicit rather than driver-dependent.
    const points = Number.parseInt(row.points ?? "0", 10);
    if (!Number.isFinite(points) || points <= 0) return null;
    const earliest = row.earliest_expiry_at;
    if (earliest === null || earliest === undefined) return null;
    const earliestExpiryAt =
      earliest instanceof Date ? earliest.toISOString() : new Date(earliest).toISOString();
    if (Number.isNaN(Date.parse(earliestExpiryAt))) return null;
    return { points, earliestExpiryAt, windowDays: this.windowDays };
  }

  async load(customerId: string, asOf: Date = new Date()): Promise<CustomerBalanceSnapshot | null> {
    const result = await this.db.query<CustomerBalanceDbRow>(SELECT_CUSTOMER_BALANCE_ROW_SQL, [
      customerId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const spendableBalance = await computeSpendableBalance(customerId, this.db, asOf);
    const expiringSoon = await this.loadExpiringSoon(customerId, asOf);
    return {
      lifetimeSpendGBP: parseSpendColumn(row.lifetime_spend_gbp),
      tier: row.tier,
      spendableBalance,
      // `undefined` when nothing expires in the window, so the summary omits the
      // field entirely rather than reporting zero (§9.4).
      ...(expiringSoon ? { expiringSoon } : {}),
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
    const ctx = requireCustomerScope(req);

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
