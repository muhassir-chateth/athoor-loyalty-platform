/**
 * VIP benefit endpoints (task 30) — `GET /v1/benefits`,
 * `POST /v1/benefits/:key/request`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Reachability-audit finding 2 (HIGH): the entitlement model was fully
 * implemented and unit-tested under tasks 15.1/15.2, but `DbEntitlementResolver`
 * was never constructed and no route exposed a benefit — so Requirement 18 could
 * not fire in the running service. Exactly the failure mode that has recurred in
 * this codebase: a complete component with no production call site. This module
 * is that call site, and it is the ONLY new code the task needs.
 *
 * NO DUPLICATED BUSINESS LOGIC. Every decision is delegated to the existing
 * {@link EntitlementResolver}:
 *   - which benefits a customer qualifies for (Req 18.2) — `resolveBenefits`;
 *   - the tier gate `tier(c) >= benefit.minQualifyingTier` (Req 18.3, Property
 *     14) — inside the resolver, which itself delegates ordering to the tier
 *     module and derives the tier from the live `customers` row exactly as
 *     `GET /v1/balance` does, so the two can never disagree;
 *   - recording a booking only when the benefit is enabled (Req 18.5), and
 *     denying an unqualified invocation with the required tier and no state
 *     change (Req 18.6).
 * This module maps the resolver's existing typed errors to HTTP and does nothing
 * else. It computes no tier, ranks nothing, and reads no table directly.
 *
 * SECURITY MODEL, reused rather than reinvented: both routes mount inside the
 * `/v1` scope, so the App Proxy signature is verified and the request is
 * resolved to a local `customers.id` before any handler runs (Req 9.2/9.3,
 * 11.3/11.4). The customer id comes from `req.authCtx` — never from the path or
 * body — so a caller cannot request a benefit on another member's behalf. The
 * POST is state-changing, so the scope-level idempotency plugin requires an
 * `Idempotency-Key` and replays a repeated key within the 24 h window
 * (Req 9.6/9.7), scoped per customer since task 38.
 *
 * CHANNEL: the attributed channel from `req.authCtx.channel` is passed through,
 * so an app-exclusive benefit (`config.appExclusive`) is granted only on the
 * `app` channel (Req 19.3/19.4, Property 15). That gating already existed in the
 * resolver and had no caller; passing the channel is what activates it.
 *
 * OFF-LEDGER: a benefit request writes one `benefit_requests` row. Nothing here
 * touches `ledger_entries`, a point lot, or any balance (Property 13's spirit).
 *
 * ADDITIVE (Req 9.4, 18.7): two new endpoints. No existing endpoint or field
 * changes, and a new benefit type needs only a `benefits` row — no code change
 * here, because nothing in this module names a specific benefit.
 */
import { requireCustomerScope } from "../auth/customerScope.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BenefitChannelNotAllowedError,
  BenefitDisabledError,
  BenefitNotFoundError,
  BenefitNotQualifiedError,
  CustomerNotFoundError,
  EntitlementValidationError,
  type Benefit,
  type EntitlementResolver,
} from "../benefits/entitlementResolver.js";

/** Path params of `POST /v1/benefits/:key/request`. */
const BENEFIT_KEY_PARAMS = z.object({ key: z.string().min(1).max(64) }).strip();

/** Options accepted by {@link registerBenefitRoutes}. */
export interface BenefitRouteOptions {
  /**
   * The production entitlement resolver (`DbEntitlementResolver` at deploy
   * time). REQUIRED: the routes are registered only when it is supplied, so a
   * build without it keeps its existing route surface rather than serving a
   * benefits endpoint that silently answers for nobody.
   */
  entitlementResolver: EntitlementResolver;
}

/**
 * The benefit as returned over `/v1`. Mirrors the resolver's {@link Benefit}
 * one-for-one — no reshaping, so a configuration-only benefit addition needs no
 * change here (Req 18.7).
 */
export interface BenefitView {
  key: string;
  name: string;
  minQualifyingTier: string;
  config: Record<string, unknown>;
  active: boolean;
  appExclusive: boolean;
}

/** Presents a resolved benefit over HTTP. Pure. */
export function toBenefitView(benefit: Benefit): BenefitView {
  return {
    key: benefit.key,
    name: benefit.name,
    minQualifyingTier: benefit.minQualifyingTier,
    config: benefit.config,
    active: benefit.active,
    appExclusive: benefit.appExclusive,
  };
}

/**
 * Maps the resolver's typed errors onto HTTP. Returns `null` for anything
 * unrecognised so the caller rethrows rather than inventing a status.
 */
export function benefitErrorResponse(
  err: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof BenefitNotQualifiedError) {
    // Req 18.6: deny, no state change, and REPORT THE REQUIRED TIER so the
    // member learns what would qualify them. `currentTier` is their own tier.
    return {
      status: 403,
      body: {
        error: err.code,
        message: err.message,
        requiredTier: err.requiredTier,
        currentTier: err.currentTier,
      },
    };
  }
  if (err instanceof BenefitChannelNotAllowedError) {
    // Req 19.4: app-exclusive benefit invoked off the `app` channel.
    return {
      status: 403,
      body: { error: err.code, message: err.message, requiredChannel: err.requiredChannel },
    };
  }
  if (err instanceof BenefitDisabledError) {
    // Req 18.5: the member qualifies, but the perk is not switched on. All six
    // seeded Royal_VIP perks ship `active = false` per A13, so this is the
    // EXPECTED answer today for a qualifying member — not an error condition.
    return { status: 409, body: { error: err.code, message: err.message } };
  }
  if (err instanceof BenefitNotFoundError) {
    return { status: 404, body: { error: err.code, message: err.message } };
  }
  if (err instanceof CustomerNotFoundError) {
    // Deliberately does NOT echo the customer id the error carries.
    return {
      status: 404,
      body: {
        error: err.code,
        message: "No loyalty customer exists for the resolved identity.",
      },
    };
  }
  if (err instanceof EntitlementValidationError) {
    return { status: 400, body: { error: err.code, message: err.message } };
  }
  return null;
}

/**
 * Registers the benefit endpoints on the `/v1` scope. MUST be called inside that
 * scope so auth has resolved `req.authCtx` first.
 *
 *   - `GET  /v1/benefits`              → `{ benefits: BenefitView[] }` (Req 18.2)
 *   - `POST /v1/benefits/:key/request` → the recorded request (Req 18.5)
 *
 * The GET is read-only and returns `[]` — never an error — for a member who
 * qualifies for nothing, matching the empty-category convention of the profile
 * endpoints (Req 17.9).
 */
export function registerBenefitRoutes(app: FastifyInstance, opts: BenefitRouteOptions): void {
  const resolver = opts.entitlementResolver;

  app.get("/benefits", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    try {
      const benefits = await resolver.resolveBenefits(ctx.customerId, ctx.channel);
      return { benefits: benefits.map(toBenefitView) };
    } catch (err) {
      const mapped = benefitErrorResponse(err);
      if (mapped) {
        return reply.code(mapped.status).send(mapped.body);
      }
      throw err;
    }
  });

  app.post("/benefits/:key/request", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const parsed = BENEFIT_KEY_PARAMS.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "A benefit key of 1 to 64 characters is required in the path.",
      });
    }

    try {
      const recorded = await resolver.requestBenefit(ctx.customerId, parsed.data.key, ctx.channel);
      // 200 for consistency with every other state-changing `/v1` POST
      // (redeem, referral, profile/visit), which the idempotency plugin caches
      // and replays identically.
      return reply.code(200).send({
        id: recorded.id,
        benefitKey: recorded.benefitKey,
        status: recorded.status,
        requestedAt: recorded.requestedAt,
      });
    } catch (err) {
      const mapped = benefitErrorResponse(err);
      if (mapped) {
        return reply.code(mapped.status).send(mapped.body);
      }
      throw err;
    }
  });
}
