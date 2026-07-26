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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LedgerRepository, Queryable } from "../ledger/repository.js";
import {
  recordReferralOnSignup,
  resolveReferrerByCode,
  type ReferralSignupOutcome,
} from "../referral/referral.js";

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
}

/**
 * Registers the referral endpoints on the `/v1` scope. Requires the Pg-backed
 * dependencies; when they are absent the caller simply does not register the
 * routes, so tests and local runs are unaffected.
 */
export function registerReferralRoutes(
  app: FastifyInstance,
  opts: ReferralRoutesOptions,
): void {
  const { repo, transactor, db } = opts;

  // GET /v1/referral — the member's own code and how it has performed. Read-only.
  app.get("/referral", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      // Unreachable: the scope-level auth preHandler rejects first. Defensive.
      return reply.code(401).send({ error: "identity_resolution_failed" });
    }

    const { rows } = await db.query<SelfRow>(SELF_SQL, [ctx.customerId]);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: "customer_not_found" });
    }

    return {
      referralCode: row.referral_code,
      wasReferred: row.was_referred,
      // How many friends this member has brought in, by stage.
      referredSignups: row.signup_rewards,
      referredFirstPurchases: row.purchase_rewards,
    };
  });

  // POST /v1/referral — the friend submits the code they were given. Awards the
  // referrer +150 (Req 2.9) via the existing engine, inside one transaction.
  app.post("/referral", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      return reply.code(401).send({ error: "identity_resolution_failed" });
    }

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
        return reply.code(200).send({ status: "rewarded", referralCode });
      case "already_rewarded":
        // Idempotent at the data layer: the claim was already recorded.
        return reply.code(200).send({ status: "already_rewarded", referralCode });
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
