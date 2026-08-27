/**
 * Referral attribution endpoints (task 25) — `GET /v1/referral`, `POST /v1/referral`.
 *
 * WHY THESE EXIST
 * ---------------
 * The referral engine (`referral/referral.ts`) was fully implemented and
 * unit-tested but had NO production call site, so Req 2.9/2.10 could never fire:
 * nothing ever told the service that a new member arrived via someone's code.
 *
 * Shopify's `customers/create` payload carries no referral field, so the
 * attribution has to arrive from the storefront. These endpoints are that seam,
 * and they reuse the EXISTING security model rather than adding a new one:
 *
 *   - both are mounted inside the `/v1` scope, so the App Proxy signature is
 *     verified and the request is resolved to a local `customers.id` before any
 *     handler runs (Req 9.2/9.3, 11.3/11.4). A caller cannot claim on behalf of
 *     another customer, because the customer id comes from the verified
 *     `logged_in_customer_id`, never from the request body;
 *   - `POST` is state-changing, so the scope-level idempotency plugin requires an
 *     `Idempotency-Key` and replays a repeated key within the 24h window
 *     (Req 9.6/9.7).
 *
 * ELIGIBILITY, and why claiming is separate from the signup webhook: attribution
 * arrives when the friend submits the code, which is necessarily after their
 * Shopify account exists. The engine's own guards then decide the outcome —
 * self-referral is refused (Req 11.8, Property 12), a second claim is a no-op,
 * and an unknown code resolves to no referrer. A claim is additionally refused
 * once the friend has any prior paid purchase, so a long-standing customer
 * cannot retro-attribute themselves to a referrer (the spirit of Req 11.9).
 *
 * LEDGER SAFETY: the +150 award is performed by the existing engine inside one
 * transaction, which appends exactly one `earn_referral` entry with its matching
 * 12-month lot (Property 17). This module adds no earning logic of its own.
 */
import { requireCustomerScope } from "../auth/customerScope.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LedgerRepository, Queryable } from "../ledger/repository.js";
import {
  recordReferralOnSignup,
  resolveReferrerByCode,
  REFERRAL_PURCHASE_POINTS,
  REFERRAL_PURCHASE_REASON,
  REFERRAL_SIGNUP_POINTS,
  REFERRAL_SIGNUP_REASON,
  type ReferralSignupOutcome,
} from "../referral/referral.js";
import type { MetafieldCacheEnqueuer } from "../shopify/metafieldCache.js";
import {
  createRedemptionRateLimiter,
  type RedemptionRateLimiterOptions,
} from "../plugins/rateLimit.js";

/**
 * Fallback domain for `shareUrl`, matching `config.ts`'s own default for
 * `SHOPIFY_SHOP_DOMAIN`. Overridable per registration — see `shareDomain`.
 */
const DEFAULT_SHARE_DOMAIN = "myathoorlondon.myshopify.com";

/** Runs a unit of work inside one transaction (mirrors the earning modules). */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Body of `POST /v1/referral`: the code the friend was given. */
const CLAIM_BODY_SCHEMA = z
  .object({
    referralCode: z.string().min(1).max(64),
  })
  .strip();

/** A customer's own referral state, returned by `GET /v1/referral`. */
const SELF_SQL = `
  SELECT c.referral_code,
         c.referred_by IS NOT NULL AS was_referred,
         (SELECT count(*)::int FROM referrals r
           WHERE r.referrer_id = c.id AND r.signup_rewarded) AS signup_rewards,
         (SELECT count(*)::int FROM referrals r
           WHERE r.referrer_id = c.id AND r.purchase_rewarded) AS purchase_rewards
    FROM customers c
   WHERE c.id = $1
`;

/** Has this customer ever had a paid-order earning? Gates a late claim. */
const HAS_PAID_PURCHASE_SQL = `
  SELECT 1 FROM ledger_entries
   WHERE customer_id = $1 AND entry_type = 'earn_order'
   LIMIT 1
`;

/* ========================================================================== *
 * Task 11.1 — the additive referral fields (design §10.2, Req 10.9/10.16/21.7)
 * ========================================================================== */

/**
 * The two Referral_Reward_Stages, as identifiers.
 *
 * `key` and `qualification` are IDENTIFIERS, NOT SENTENCES (Req 21.7, Property 10).
 * The client maps them to copy through §18.9, which is what lets the wording change
 * without a service deploy and lets a future mobile client use its own.
 *
 * The point values are read from the ENGINE's own constants, not restated here. A
 * second copy of "150" would be a second source of truth for the programme's value,
 * free to disagree with what the engine actually awards — and the disagreement
 * would be invisible until a customer compared the two.
 */
export const REFERRAL_STAGES = [
  {
    key: "friend_signup",
    qualification: "friend_account_created",
    reason: REFERRAL_SIGNUP_REASON,
    currentRewardPoints: REFERRAL_SIGNUP_POINTS,
  },
  {
    key: "friend_first_purchase",
    qualification: "friend_first_paid_order",
    reason: REFERRAL_PURCHASE_REASON,
    currentRewardPoints: REFERRAL_PURCHASE_POINTS,
  },
] as const;

/** Server-derived stage state. `pending` wins when work is outstanding. */
export type ReferralStageState = "awarded" | "pending" | "none";

/** One stage in the `GET /v1/referral` response. */
export interface ReferralStageView {
  readonly key: string;
  readonly qualification: string;
  /** Today's configured award. Follows a configuration change. */
  readonly currentRewardPoints: number;
  /** What was ACTUALLY paid, summed from the ledger. Immune to a configuration change. */
  readonly creditedPoints: number;
  readonly awardedCount: number;
  readonly pendingCount: number;
  readonly state: ReferralStageState;
}

/** Programme totals. See the definitions in §10.2 — the words are ambiguous otherwise. */
export interface ReferralTotals {
  /** Rows where `signup_rewarded`: a friend who joined and for whom stage 1 paid. */
  readonly successful: number;
  /** Rows where `signup_rewarded AND NOT purchase_rewarded`: stage 2 still owed. */
  readonly pending: number;
  /** SUM of all `earn_referral` ledger points. Historical. */
  readonly creditedPoints: number;
}

/**
 * Derives a stage's state server-side (Req 10.9).
 *
 * PENDING TAKES PRECEDENCE over awarded, and that ordering is the whole content of
 * this function. §10.2's own example shows stage 2 with `awardedCount: 1,
 * pendingCount: 1` and `state: "pending"` — because what the customer needs to see
 * is the outstanding opportunity, not the past success. Deriving it here rather
 * than letting the client compare counts keeps threshold logic out of the browser,
 * the same principle §9.1 applies to reward eligibility.
 */
export function deriveStageState(awardedCount: number, pendingCount: number): ReferralStageState {
  if (pendingCount > 0) return "pending";
  if (awardedCount > 0) return "awarded";
  return "none";
}

/**
 * Builds the share URL server-side (Req 10.11, 10.13).
 *
 * BUILT HERE, NOT IN A THEME ASSET, so the link format can change without a theme
 * deployment — that is §10.3's stated reason.
 *
 * ── A DISCREPANCY WORTH RECORDING RATHER THAN GUESSING ──────────────────────
 * §10.2's example shows `https://myathoorlondon.com/?ref=…` — the customer-facing
 * primary domain. The only shop domain this service holds is
 * `config.shopify.shopDomain`, which is `myathoorlondon.myshopify.com`; the primary
 * domain is a Shopify setting the backend is never told. A `myshopify.com` link
 * WORKS (Shopify redirects it to the primary domain), but it is not the link the
 * design pictures.
 *
 * Rather than invent an environment variable or hardcode a second domain, the
 * domain is INJECTABLE and defaults to the configured shop domain. Production can
 * pass the primary domain the day it wants to without a code change, and until then
 * the link is functional and honest. Flagged for the owner rather than silently
 * decided.
 */
export function buildShareUrl(domain: string, referralCode: string): string {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/?ref=${encodeURIComponent(referralCode)}`;
}

/**
 * Per-stage counts and credited points, plus the programme totals.
 *
 * ── WHY `creditedPoints` COMES FROM THE LEDGER ──────────────────────────────
 * Req 10.16 wants an awarded stage to show the points ACTUALLY credited, and Req
 * 10.13 allows the configured amount to change. Those are two different numbers, so
 * the response carries both: `currentRewardPoints` from the engine's constants and
 * `creditedPoints` from `ledger_entries`. §9.6 notes that reading history from the
 * append-only ledger is what makes this hold WITHOUT any extra mechanism — a
 * configuration change cannot rewrite history because history is a different query.
 *
 * OWNERSHIP: every subquery carries `customer_id = $1` / `referrer_id = $1`, bound
 * from the resolved scope. The two stage reasons are BOUND as `$2`/`$3` rather than
 * interpolated: they are compile-time constants so there is no injection risk, but
 * `${...}` inside SQL is the exact pattern `scopedQuery.ts` refuses outright, and a
 * codebase that forbids it in one layer should not model it in another. The `referrals` rows are reached by `referrer_id` only,
 * so no referred person's row is ever projected — which is how Req 10.7 (no name,
 * email or identifier of the referred person) is satisfied structurally rather than
 * by remembering to omit columns.
 */
const REFERRAL_ADDITIONS_SQL = `
  SELECT (SELECT count(*)::int FROM referrals r
           WHERE r.referrer_id = $1 AND r.signup_rewarded)                        AS signup_awarded,
         (SELECT count(*)::int FROM referrals r
           WHERE r.referrer_id = $1 AND NOT r.signup_rewarded)                     AS signup_pending,
         (SELECT count(*)::int FROM referrals r
           WHERE r.referrer_id = $1 AND r.purchase_rewarded)                       AS purchase_awarded,
         (SELECT count(*)::int FROM referrals r
           WHERE r.referrer_id = $1 AND r.signup_rewarded AND NOT r.purchase_rewarded)
                                                                                   AS purchase_pending,
         (SELECT coalesce(sum(points), 0)::text FROM ledger_entries l
           WHERE l.customer_id = $1 AND l.entry_type = 'earn_referral'
             AND l.reason = $2)                                                AS signup_credited,
         (SELECT coalesce(sum(points), 0)::text FROM ledger_entries l
           WHERE l.customer_id = $1 AND l.entry_type = 'earn_referral'
             AND l.reason = $3)                                                AS purchase_credited,
         (SELECT coalesce(sum(points), 0)::text FROM ledger_entries l
           WHERE l.customer_id = $1 AND l.entry_type = 'earn_referral')            AS total_credited
`;

interface ReferralAdditionsRow {
  signup_awarded: number;
  signup_pending: number;
  purchase_awarded: number;
  purchase_pending: number;
  signup_credited: string | null;
  purchase_credited: string | null;
  total_credited: string | null;
}

/** `sum()` over BIGINT arrives as a string; cast in SQL, parse explicitly here. */
function parsePoints(raw: string | null): number {
  const n = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

interface SelfRow {
  referral_code: string | null;
  was_referred: boolean;
  signup_rewards: number;
  purchase_rewards: number;
}

export interface ReferralRoutesOptions {
  repo: LedgerRepository;
  transactor: Transactor;
  db: Queryable;
  /**
   * OPTIONAL metafield-cache enqueuer (task 35, Req 13.5a): every committed
   * balance change refreshes the customer's `loyalty.*` display cache off the
   * request path. A rewarded claim credits the REFERRER +150 — a different
   * customer from the claimant — so no other path's refresh covers them, and the
   * referrer's cached balance previously stayed stale (audit F4).
   *
   * Left undefined on a non-Shopify boot (no Admin token → no metafield-cache
   * worker to consume the job); the claim then behaves exactly as before and the
   * periodic reconciliation job is the cache safety net (Req 13.7).
   */
  metafieldEnqueuer?: MetafieldCacheEnqueuer;
  /**
   * Domain used to build `shareUrl`. Defaults to the configured shop domain.
   *
   * INJECTABLE because §10.2's example shows the customer-facing primary domain
   * (`myathoorlondon.com`) while the only domain this service is told is
   * `myathoorlondon.myshopify.com`. A myshopify link works — Shopify redirects it —
   * but it is not the link the design pictures, so production can pass the primary
   * domain without a code change rather than have one hardcoded here.
   */
  shareDomain?: string;
  /** Overrides N/A limiter for `POST /v1/referral`; a test injects a fake clock. */
  referralRateLimit?: RedemptionRateLimiterOptions;
}

/** `POST /v1/referral` rate limit: 5 per hour per customer (task 11.1, §23). */
export const REFERRAL_CLAIM_RATE_LIMIT_MAX_REQUESTS = 5 as const;
export const REFERRAL_CLAIM_RATE_LIMIT_WINDOW_MS = 3_600_000 as const;

/**
 * Registers the referral endpoints on the `/v1` scope. Requires the Pg-backed
 * dependencies; when they are absent the caller simply does not register the
 * routes, so tests and local runs are unaffected.
 */
/**
 * Post-commit, best-effort Metafield_Cache refresh for the credited REFERRER
 * (task 35, Req 13.5a). Deliberately OUTSIDE the transaction and outside
 * `referral.ts`: enqueuing from inside the transaction could schedule a refresh
 * for an award that then rolled back. A queue failure is logged and swallowed —
 * the ledger is authoritative and already committed.
 */
async function enqueueReferrerCacheRefresh(
  req: FastifyRequest,
  opts: ReferralRoutesOptions,
  referrerId: string,
): Promise<void> {
  if (!opts.metafieldEnqueuer) {
    return;
  }
  try {
    await opts.metafieldEnqueuer.enqueueMetafieldCache({ customerId: referrerId });
  } catch (err) {
    req.log?.warn(
      { err, referrerId },
      "referral reward committed but the metafield-cache refresh could not be enqueued; " +
        "reconciliation will repair the display cache",
    );
  }
}

export function registerReferralRoutes(
  app: FastifyInstance,
  opts: ReferralRoutesOptions,
): void {
  const shareDomain = opts.shareDomain ?? DEFAULT_SHARE_DOMAIN;
  // ROUTE-LEVEL, never a `/v1` scope hook (task 10.4). A scope-level limiter would
  // make reading a balance consume a referral claim’s allowance, and would run
  // before the auth preHandler had resolved an identity to key on.
  const referralRateLimiter = createRedemptionRateLimiter({
    maxRequests: REFERRAL_CLAIM_RATE_LIMIT_MAX_REQUESTS,
    windowMs: REFERRAL_CLAIM_RATE_LIMIT_WINDOW_MS,
    subject: "referral claim",
    ...(opts.referralRateLimit ?? {}),
  });
  const { repo, transactor, db } = opts;

  // GET /v1/referral — the member's own code and how it has performed. Read-only.
  app.get("/referral", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const { rows } = await db.query<SelfRow>(SELF_SQL, [ctx.customerId]);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: "customer_not_found" });
    }

    // ── THE ADDITIVE BLOCK (task 11.1) ──────────────────────────────────────
    // One extra query, all subqueries scoped to `$1`. The two stage reasons are
    // bound, not interpolated.
    const additions = await db.query<ReferralAdditionsRow>(REFERRAL_ADDITIONS_SQL, [
      ctx.customerId,
      REFERRAL_SIGNUP_REASON,
      REFERRAL_PURCHASE_REASON,
    ]);
    const a = additions.rows[0];

    const counts: Record<string, { awarded: number; pending: number; credited: number }> = {
      [REFERRAL_SIGNUP_REASON]: {
        awarded: a?.signup_awarded ?? 0,
        pending: a?.signup_pending ?? 0,
        credited: parsePoints(a?.signup_credited ?? null),
      },
      [REFERRAL_PURCHASE_REASON]: {
        awarded: a?.purchase_awarded ?? 0,
        pending: a?.purchase_pending ?? 0,
        credited: parsePoints(a?.purchase_credited ?? null),
      },
    };

    const stages: ReferralStageView[] = REFERRAL_STAGES.map((stage) => {
      const c = counts[stage.reason] ?? { awarded: 0, pending: 0, credited: 0 };
      return {
        key: stage.key,
        qualification: stage.qualification,
        // From CONFIGURATION — today's value, follows a programme change (Req 10.13).
        currentRewardPoints: stage.currentRewardPoints,
        // From the LEDGER — what was actually paid, immune to a programme change
        // (Req 10.16, §9.6). Two different numbers, deliberately both present.
        creditedPoints: c.credited,
        awardedCount: c.awarded,
        pendingCount: c.pending,
        state: deriveStageState(c.awarded, c.pending),
      };
    });

    const totals: ReferralTotals = {
      // `successful` is the existing `referredSignups` value under a clearer name;
      // the original field stays for compatibility (Req 20.6).
      successful: row.signup_rewards,
      // A friend who joined but has not yet made a qualifying first purchase.
      pending: a?.purchase_pending ?? 0,
      creditedPoints: parsePoints(a?.total_credited ?? null),
    };

    return {
      referralCode: row.referral_code,
      // Built server-side so the link format is not a theme literal (Req 10.11/10.13).
      // `null` when the customer has no code yet — there is nothing to share, and a
      // URL ending `?ref=` would be a broken link presented as a working one.
      shareUrl:
        row.referral_code === null ? null : buildShareUrl(shareDomain, row.referral_code),
      wasReferred: row.was_referred,
      // How many friends this member has brought in, by stage. EXISTING — verbatim.
      referredSignups: row.signup_rewards,
      referredFirstPurchases: row.purchase_rewards,
      totals,
      stages,
    };
  });

  // POST /v1/referral — the friend submits the code they were given. Awards the
  // referrer +150 (Req 2.9) via the existing engine, inside one transaction.
  app.post(
    "/referral",
    { preHandler: [referralRateLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const parsed = CLAIM_BODY_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "A referralCode of 1 to 64 characters is required.",
      });
    }
    const referralCode = parsed.data.referralCode.trim();

    // A member who has already bought cannot retro-attribute themselves to a
    // referrer; the reward is for bringing in NEW customers (spirit of Req 11.9).
    const prior = await db.query(HAS_PAID_PURCHASE_SQL, [ctx.customerId]);
    if ((prior.rowCount ?? prior.rows.length) > 0) {
      return reply.code(409).send({
        error: "referral_not_eligible",
        message:
          "A referral code cannot be applied after a paid purchase has already been made on this account.",
      });
    }

    const outcome = await transactor.transaction<ReferralSignupOutcome>(async (tx) => {
      // Resolve the code to a referrer INSIDE the transaction so the engine's
      // self-referral and duplicate guards see a consistent snapshot.
      const referrerId = await resolveReferrerByCode(tx, referralCode);
      return recordReferralOnSignup(
        repo,
        {
          referredCustomerId: ctx.customerId,
          referrerId,
          sourceEventId: null,
        },
        tx,
      );
    });

    switch (outcome.status) {
      case "rewarded":
        // The transaction has COMMITTED, so refresh the display cache for the
        // customer whose balance actually moved: the REFERRER (task 35,
        // Req 13.5a). The claiming friend earned nothing here, so nothing is
        // enqueued for them. Best-effort — the +150 and its lot are already
        // durable, so a queue failure must never turn a successful credit into a
        // failed response; reconciliation repairs the cache later (Req 13.7).
        await enqueueReferrerCacheRefresh(req, opts, outcome.referrerId);
        return reply.code(200).send({ status: "rewarded", referralCode });
      case "already_rewarded":
        // Idempotent at the data layer: this exact claim was already recorded and
        // the named referrer really was credited.
        return reply.code(200).send({ status: "already_rewarded", referralCode });
      case "already_claimed":
        // Task 40: the member has already accepted a DIFFERENT referrer's code,
        // and a customer gets exactly one. Distinct from `already_rewarded`,
        // which would wrongly imply this code's owner had been credited. The
        // existing referrer's identity is NOT disclosed — the claimant has no
        // business learning which other member holds their attribution.
        return reply.code(409).send({
          error: "referral_already_claimed",
          message: "A referral code has already been applied to this account.",
        });
      case "self_referral_rejected":
        // Req 11.8 / Property 12: no row, no earning, no balance change.
        return reply.code(409).send({
          error: "self_referral_rejected",
          message: "A customer cannot refer themselves.",
        });
      case "no_referrer":
        return reply.code(404).send({
          error: "unknown_referral_code",
          message: "That referral code does not match any member.",
        });
    }
  });
}
