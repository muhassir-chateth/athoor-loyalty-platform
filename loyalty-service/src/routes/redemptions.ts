/**
 * `GET /v1/redemptions` (N16) — the customer's issued discount codes with value
 * and status (spec task 10.2, design §6.3 N16, §9.2, Req 8.8, 9.6).
 *
 * ── WHY THIS EXISTS WHEN `/v1/history` ALREADY SHOWS SPENDS ─────────────────
 * §9.2 states it plainly: "`/v1/history` alone cannot state the code's value or
 * status". A `spend` ledger entry records that points left the balance and names
 * the reward id as its `reason` — it does not carry the discount code, the GBP
 * value that code is worth, or whether the code was ever successfully minted. A
 * customer looking for "the £15 code I redeemed on Tuesday" needs all three.
 *
 * ── `code` IS NULL IN TWO STATES, AND NEITHER IS AN ERROR ───────────────────
 * While `status` is `pending_code` the code does not exist yet: minting happens
 * off the request path through pg-boss, so a redemption is legitimately confirmed
 * before its code appears. After `voided` the code exists but must not be shown.
 * A null `code` therefore means "no code to show" — never a failure — which is
 * what lets the client present a pending redemption as the confirmed state it is
 * rather than inventing an error.
 *
 * ── MONEY IS A DECIMAL STRING HERE, AND A NUMBER ON `/v1/rewards` ───────────
 * That divergence is deliberate and is NOT to be tidied up. `redemptions.value_gbp`
 * is `NUMERIC(8,2)` and `pg` returns NUMERIC as a STRING precisely so the driver
 * never rounds; §6.2 requires the new N-series money fields to be decimal strings,
 * and emitting the column unchanged is the zero-conversion, zero-loss path. The
 * shipped `Reward.valueGBP` stays a `number` because Req 20.6 forbids changing a
 * shipped field's shape. `portal/types.ts` records the full argument. The cost is
 * that one quantity has two representations on two endpoints; the alternative is
 * breaking a live contract, which is worse.
 *
 * ── OWNERSHIP ──────────────────────────────────────────────────────────────
 * `WHERE r.customer_id = $1`, bound from the resolved scope. The discount code is
 * reached by joining `discount_codes.redemption_id`, so a code can only ever be
 * read through a redemption that already belongs to the caller — there is no path
 * that selects a code by its own id.
 *
 * SAFETY: read-only. No mutation, no ledger write, nothing stored.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import type { Queryable } from "../ledger/repository.js";
import {
  PORTAL_REDEMPTIONS_PAGE_SIZE,
  type MoneyGBP,
  type PortalRedemption,
  type PortalRedemptionStatus,
  type PortalRedemptionsResponse,
} from "../portal/types.js";

/** The statuses in which a code must not be returned, whatever the join found. */
const CODE_WITHHELD_STATUSES: ReadonlySet<string> = new Set(["pending_code", "voided"]);

/** Statuses the `redemptions.status` column documents. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "pending_code",
  "issued",
  "failed",
  "voided",
]);

/**
 * Newest first, at most one page.
 *
 * `ORDER BY created_at DESC, id DESC` — the tiebreaker matters: two redemptions
 * can share a `created_at` to the microsecond under a retry, and an unstable sort
 * would let the same row appear on two pages or on neither. `id` is the primary
 * key, so the order is total.
 *
 * The code is LEFT JOINed: a `pending_code` redemption has no `discount_codes`
 * row yet, and an inner join would silently drop exactly the redemptions the
 * client most needs to render as pending.
 */
const SELECT_REDEMPTIONS_SQL = `
  SELECT r.id,
         r.reward_id,
         r.points_spent::text  AS points_spent,
         r.value_gbp::text     AS value_gbp,
         r.status,
         c.code                AS code,
         r.created_at
    FROM redemptions r
    LEFT JOIN discount_codes c ON c.redemption_id = r.id
   WHERE r.customer_id = $1
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT $2
`;

interface RedemptionDbRow extends QueryResultRow {
  id: string;
  reward_id: string;
  points_spent: string | null;
  value_gbp: string | null;
  status: string;
  code: string | null;
  created_at: Date | string;
}

/** Normalises a NUMERIC(8,2) column to the 2-dp decimal string §6.2 requires. */
export function toMoneyGBP(raw: string | number | null | undefined): MoneyGBP {
  if (raw === null || raw === undefined || raw === "") return "0.00";
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return "0.00";
  // `toFixed(2)` rather than emitting the column verbatim: `NUMERIC(8,2)` is
  // already 2-dp, but a driver or a future column change that yielded `"15"` or
  // `"15.5"` would break the closed `MONEY_GBP_PATTERN` the boundary tests assert.
  const fixed = n.toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

/**
 * Projects one row onto the N16 contract.
 *
 * WITHHOLDS THE CODE STRUCTURALLY. The status check happens here, in the
 * projection, rather than in the SQL — so a future caller that reuses this
 * function cannot obtain a `voided` code by writing its own query. Belt and
 * braces would be a `CASE` in SQL too; the projection is the one place every
 * response passes through, so it is the right single home.
 */
export function projectRedemption(row: RedemptionDbRow): PortalRedemption {
  const status: PortalRedemptionStatus = KNOWN_STATUSES.has(row.status)
    ? (row.status as PortalRedemptionStatus)
    : // An unrecognised status is reported as `failed` rather than passed through.
      // `PortalRedemptionStatus` is a CLOSED union the client maps to copy; an
      // unmapped value would render as a neutral error state anyway, and inventing
      // a new member here would break that map silently.
      "failed";

  const points = Number.parseInt(row.points_spent ?? "0", 10);
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString();

  return {
    id: row.id,
    rewardId: row.reward_id,
    pointsSpent: Number.isFinite(points) ? points : 0,
    valueGBP: toMoneyGBP(row.value_gbp),
    status,
    code: CODE_WITHHELD_STATUSES.has(status) ? null : (row.code ?? null),
    createdAt,
  };
}

/** Loads the caller's redemptions. Scope-typed — no `customerId: string`. */
export interface PortalRedemptionSource {
  list(scope: CustomerScope, pageSize: number): Promise<PortalRedemptionsResponse>;
}

/** Postgres-backed source. Read-only. */
export class PgPortalRedemptionSource implements PortalRedemptionSource {
  constructor(private readonly db: Queryable) {}

  async list(scope: CustomerScope, pageSize: number): Promise<PortalRedemptionsResponse> {
    const result = await this.db.query<RedemptionDbRow>(SELECT_REDEMPTIONS_SQL, [
      scope.customerId,
      pageSize,
    ]);
    return { redemptions: result.rows.map(projectRedemption) };
  }
}

/**
 * In-memory source for tests and local runs.
 *
 * Returns an EMPTY LIST for an unknown customer, and that is fail-closed here
 * rather than a falsehood: "you have redeemed nothing" is true of a customer this
 * service has no redemptions for. Contrast `/v1/orders`, where an empty list would
 * have contradicted the customer's own receipts — which is why that endpoint
 * refuses instead.
 */
export class InMemoryPortalRedemptionSource implements PortalRedemptionSource {
  private readonly byCustomerId = new Map<string, readonly PortalRedemption[]>();

  set(localCustomerId: string, redemptions: readonly PortalRedemption[]): void {
    this.byCustomerId.set(localCustomerId, redemptions);
  }

  async list(scope: CustomerScope, pageSize: number): Promise<PortalRedemptionsResponse> {
    const all = this.byCustomerId.get(scope.customerId) ?? [];
    return { redemptions: all.slice(0, pageSize) };
  }
}

/** Options accepted by {@link registerRedemptionsRoute}. */
export interface RedemptionsRouteOptions {
  /** Defaults to an empty in-memory source, so the route boots with no Postgres. */
  redemptionSource?: PortalRedemptionSource;
}

/**
 * Registers `GET /v1/redemptions`. MUST be called inside the `/v1` router scope so
 * the auth preHandler has resolved the identity first.
 */
export function registerRedemptionsRoute(
  app: FastifyInstance,
  opts: RedemptionsRouteOptions = {},
): void {
  const source = opts.redemptionSource ?? new InMemoryPortalRedemptionSource();

  app.get("/redemptions", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);
    void reply;
    // Page size is FIXED, not a query parameter. §6.3 N16 states the page size and
    // names no paging mechanism, so accepting a `pageSize` here would invent
    // contract the design does not specify. `portal/types.ts` records that task
    // 10.2 settles how the client reaches page two, and whatever it chooses is
    // additive (Req 20.6) — so the honest move now is to serve one page and add
    // nothing speculative.
    return source.list(scope, PORTAL_REDEMPTIONS_PAGE_SIZE);
  });
}
