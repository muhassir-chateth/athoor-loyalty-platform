/**
 * Admin management router (task 17.1, Requirements 10.1–10.4, 10.8, 10.9,
 * 15.3, 15.4).
 *
 * An encapsulated Fastify plugin mounted under `/v1/admin`. Because it is a
 * SEPARATE scope from the consumer `/v1` router, the customer-identity
 * preHandler (which gates customer endpoints) does NOT apply here; instead this
 * scope installs the ADMIN-auth preHandler ({@link registerAdminAuth}) so every
 * admin route is denied without an authenticated admin role, performing no data
 * change (Req 10.1). The root versioning hooks still apply, so admin responses
 * carry the API version identifier like every other response.
 *
 * Endpoints:
 *   - POST /v1/admin/adjustments  — manual signed point adjustment (Req 10.2/10.3)
 *   - POST /v1/admin/credits      — manual credit for a non-automatable action
 *                                   (Req 10.4/10.8)
 *   - GET  /v1/admin/customers/:customerId/ledger — a customer's complete
 *                                   ledger/history, most-recent-first, with
 *                                   type, amount, reason, acting party,
 *                                   timestamp (task 17.2, Req 10.5)
 *   - GET  /v1/admin/fraud-review — referrals + redemptions with status,
 *                                   customer id, amount, timestamp (Req 10.6)
 *   - POST /v1/admin/operations/migration       — run migration, returns
 *                                   {processed, failed} (Req 10.7/10.9)
 *   - POST /v1/admin/operations/reconciliation  — run reconciliation, returns
 *                                   {processed, failed} (Req 10.7/10.9)
 *   - GET  /v1/admin/analytics    — loyalty-program analytics for a selectable
 *                                   date range from hourly-refreshed cached
 *                                   aggregates (task 17.3, Req 20)
 *
 * The adjustment/credit endpoints create exactly one `adjust` ledger entry AND
 * one immutable audit record (Req 10.9), delegating to the injected
 * {@link AdminAdjustmentService}. The read endpoints (task 17.2) read via
 * injected sources, and the operation endpoints run via an injected operations
 * service — all defaulting to functional in-memory implementations so the
 * surface boots without live infra.
 *
 * SAFETY: registering this plugin touches no live/production system; the
 * default service is in-memory.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerAdminAuth, type AdminAuthenticator, type AdminCtx } from "./adminAuth.js";
import {
  InMemoryAdminAdjustmentService,
  toAdjustmentResponse,
  type AdminAdjustmentService,
} from "./adjustmentService.js";
import {
  InvalidActionError,
  InvalidAmountError,
  InvalidReasonError,
  REASON_MAX_LENGTH,
} from "./adjustments.js";
import {
  InMemoryAdminCustomerLedgerSource,
  buildAdminCustomerLedgerView,
  type AdminCustomerLedgerSource,
} from "./customerView.js";
import {
  InMemoryFraudReviewSource,
  buildFraudReviewView,
  type FraudReviewSource,
} from "./fraudReview.js";
import {
  InMemoryAdminOperationsService,
  MigrationNotEnabledError,
  ReconciliationUnavailableError,
  toAdminOperationResponse,
  type AdminOperationsService,
} from "./operations.js";
import {
  createInMemoryAnalyticsService,
  type AnalyticsService,
} from "./analyticsService.js";
import { InvalidDateRangeError, type DateRange } from "./analytics.js";
import {
  BENEFIT_REQUEST_TRANSITIONS,
  BenefitRequestInvalidTransitionError,
  BenefitRequestNotFoundError,
  type BenefitRequestService,
} from "./benefitRequests.js";

export interface AdminRouterOptions {
  /**
   * Verifies admin bearer tokens (Req 10.1). Defaults inside
   * {@link registerAdminAuth} to a fail-closed verifier, so the admin surface
   * denies all access until a real authenticator is wired.
   */
  adminAuthenticator?: AdminAuthenticator;
  /**
   * Performs the manual adjustment / manual credit (Req 10.2–10.4). Defaults to
   * a functional in-memory service so the endpoints work without live Postgres;
   * production injects a ledger + audit backed service.
   */
  adjustmentService?: AdminAdjustmentService;
  /**
   * Loads a customer's complete ledger for the admin customer view (task 17.2,
   * Req 10.5). Defaults to an empty in-memory source so the endpoint boots
   * without live Postgres; production injects a Pg-backed source.
   */
  customerLedgerSource?: AdminCustomerLedgerSource;
  /**
   * Loads referrals + redemptions for the fraud-review view (task 17.2,
   * Req 10.6). Defaults to an empty in-memory source; production injects a
   * Pg-backed source.
   */
  fraudReviewSource?: FraudReviewSource;
  /**
   * Runs migration/reconciliation operations and records the audit trail
   * (task 17.2, Req 10.7/10.9). Defaults to a functional in-memory service
   * returning zero counts; production injects a service wrapping the real jobs.
   */
  operationsService?: AdminOperationsService;
  /**
   * Computes Admin_Analytics from the hourly-refreshed cached aggregates
   * (task 17.3, Req 20). Defaults to a functional in-memory service so the
   * endpoint works without live infra (returning empty-safe metrics until a
   * materialized-view data source is wired).
   */
  analyticsService?: AnalyticsService;
  /**
   * The benefit-request fulfilment workflow (task 41, Req 18.5/10.5/10.9).
   * Production injects a service over `benefit_requests` + the audit trail. When
   * ABSENT the benefit-request endpoints are not registered, so a build without
   * it keeps its existing route surface — rather than showing an operator an
   * empty queue that could be mistaken for "no work waiting".
   */
  benefitRequestService?: BenefitRequestService;
}

/** Request body for POST /v1/admin/benefit-requests/:id/transition (task 41). */
const BenefitRequestTransitionSchema = z
  .object({
    status: z.enum(BENEFIT_REQUEST_TRANSITIONS),
    /** Optional free-text context, recorded on the audit record. */
    reason: z.string().min(1).max(500).optional(),
  })
  .strip();

/** Query params for GET /v1/admin/analytics (Req 20.2, 20.4, 20.5). */
const AnalyticsQuerySchema = z
  .object({
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
  })
  // Either supply BOTH bounds or NEITHER; a lone bound is ambiguous.
  .refine((q) => (q.start === undefined) === (q.end === undefined), {
    message: "supply both 'start' and 'end', or neither to apply the default range",
  });

/** Request body for POST /v1/admin/adjustments (Req 10.2). */
const AdjustmentBodySchema = z.object({
  customerId: z.string().min(1, "customerId is required"),
  points: z
    .number()
    .int("points must be an integer")
    .refine((n) => n !== 0, "points must be a non-zero signed integer"),
  // Reason is validated for 1–500 chars by the core (single source of truth);
  // here we only require a string so a wrong type is a clean 400.
  reason: z.string(),
});

/** Request body for POST /v1/admin/credits (Req 10.4). */
const ManualCreditBodySchema = z.object({
  customerId: z.string().min(1, "customerId is required"),
  points: z.number().int("points must be an integer").positive("a credit must be positive"),
  action: z.string().min(1, "action is required"),
  reason: z.string(),
});

/** Map a known domain error to its HTTP status + body; rethrow the rest. */
function replyForKnownError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof InvalidReasonError) {
    return reply.code(400).send({ error: err.code, message: err.message });
  }
  if (err instanceof InvalidAmountError) {
    return reply.code(400).send({ error: err.code, message: err.message });
  }
  if (err instanceof InvalidActionError) {
    return reply.code(400).send({ error: err.code, message: err.message });
  }
  return null;
}

/** Format a zod error into a compact 400 body. */
function sendValidationError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: "invalid_request",
    message: error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "),
  });
}

/**
 * Register the admin management router. MUST be registered as its own plugin
 * (with the `/v1/admin` prefix) so the admin-auth preHandler — not the customer
 * one — guards it.
 */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouterOptions = {}): Promise<void> {
  // Deny any admin tool access without an authenticated admin role (Req 10.1).
  registerAdminAuth(app, { authenticator: opts.adminAuthenticator });

  const service = opts.adjustmentService ?? new InMemoryAdminAdjustmentService();
  const customerLedgerSource =
    opts.customerLedgerSource ?? new InMemoryAdminCustomerLedgerSource();
  const fraudReviewSource = opts.fraudReviewSource ?? new InMemoryFraudReviewSource();
  const benefitRequestService = opts.benefitRequestService;
  const operationsService = opts.operationsService ?? new InMemoryAdminOperationsService();
  const analyticsService = opts.analyticsService ?? createInMemoryAnalyticsService();

  // POST /v1/admin/adjustments — manual signed point adjustment (Req 10.2/10.3).
  app.post("/adjustments", async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = req.adminCtx as AdminCtx; // guaranteed by the admin-auth preHandler
    const parsed = AdjustmentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }
    try {
      const result = await service.adjust(
        {
          customerId: parsed.data.customerId,
          points: parsed.data.points,
          reason: parsed.data.reason,
        },
        admin,
      );
      return reply.code(201).send(toAdjustmentResponse(result));
    } catch (err) {
      const handled = replyForKnownError(reply, err);
      if (handled) {
        return handled;
      }
      throw err;
    }
  });

  // POST /v1/admin/credits — manual credit for a non-automatable action
  // (Req 10.4/10.8). Points are only ever awarded for such actions here.
  app.post("/credits", async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = req.adminCtx as AdminCtx;
    const parsed = ManualCreditBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }
    try {
      const result = await service.credit(
        {
          customerId: parsed.data.customerId,
          points: parsed.data.points,
          action: parsed.data.action,
          reason: parsed.data.reason,
        },
        admin,
      );
      return reply.code(201).send(toAdjustmentResponse(result));
    } catch (err) {
      const handled = replyForKnownError(reply, err);
      if (handled) {
        return handled;
      }
      throw err;
    }
  });

  // GET /v1/admin/customers/:customerId/ledger — a customer's COMPLETE ledger
  // and transaction history, most-recent-first, each entry carrying its type,
  // point amount, reason, acting party, and timestamp (task 17.2, Req 10.5).
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/ledger",
    async (req, reply: FastifyReply) => {
      const customerId = (req.params.customerId ?? "").trim();
      if (customerId.length === 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "A customer id is required.",
        });
      }
      const rawEntries = await customerLedgerSource.loadLedger(customerId);
      return buildAdminCustomerLedgerView(customerId, rawEntries);
    },
  );

  // GET /v1/admin/fraud-review — referrals and redemptions with, for each item,
  // its status, associated customer id, point/credit amount, and timestamp
  // (task 17.2, Req 10.6).
  app.get("/fraud-review", async () => {
    const [referrals, redemptions] = await Promise.all([
      fraudReviewSource.listReferrals(),
      fraudReviewSource.listRedemptions(),
    ]);
    return buildFraudReviewView(referrals, redemptions);
  });

  // Benefit-request fulfilment (task 41, Req 18.5/10.5/10.9). Registered only
  // when the service is wired: an unwired build must not present an empty queue
  // that reads as "nothing waiting" when the truth is "nothing is connected".
  if (benefitRequestService) {
    // GET /v1/admin/benefit-requests — the work queue (open, oldest first) and
    // the record of what was done (closed, most recent first).
    app.get("/benefit-requests", async () => benefitRequestService.view());

    // POST /v1/admin/benefit-requests/:id/transition — advance one request.
    // Idempotent: re-applying the status a request already holds succeeds and
    // changes nothing. A terminal request cannot be moved to a different status.
    app.post<{ Params: { id: string } }>(
      "/benefit-requests/:id/transition",
      async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const admin = req.adminCtx as AdminCtx;
        const parsed = BenefitRequestTransitionSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_request",
            message:
              `A body of { status } is required, where status is one of: ` +
              `${BENEFIT_REQUEST_TRANSITIONS.join(", ")}. An optional reason of up to 500 characters may be supplied.`,
          });
        }
        try {
          const result = await benefitRequestService.transition(
            req.params.id,
            parsed.data.status,
            admin.adminUserId,
            parsed.data.reason,
          );
          return reply.code(200).send(result);
        } catch (err) {
          if (err instanceof BenefitRequestNotFoundError) {
            return reply.code(404).send({ error: err.code, message: err.message });
          }
          if (err instanceof BenefitRequestInvalidTransitionError) {
            // 409: the request exists, the transition is simply not legal from
            // where it stands. `from`/`to` are echoed so the operator sees why.
            return reply.code(409).send({
              error: err.code,
              message: err.message,
              from: err.from,
              to: err.to,
            });
          }
          throw err;
        }
      },
    );
  }

  // POST /v1/admin/operations/migration — the M0–M2 data cutover is NOT
  // exposed over HTTP (Req 10.7a): it depends on the M0 metafield export as its
  // rollback anchor and is run deliberately by an operator. A wired production
  // service refuses with {@link MigrationNotEnabledError} → 501, which is safer
  // and clearer than reporting a misleading `processed: 0`. Local/in-memory
  // services still return their configured counts, so existing behaviour and
  // tests are unchanged.
  app.post("/operations/migration", async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = req.adminCtx as AdminCtx;
    try {
      const result = await operationsService.runMigration(admin);
      return reply.code(200).send(toAdminOperationResponse(result));
    } catch (err) {
      if (err instanceof MigrationNotEnabledError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // POST /v1/admin/operations/reconciliation — run reconciliation and return
  // the {processed, failed} completion result, recording the audit trail
  // (task 17.2, Req 10.7/10.9).
  app.post("/operations/reconciliation", async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = req.adminCtx as AdminCtx;
    try {
      const result = await operationsService.runReconciliation(admin);
      return reply.code(200).send(toAdminOperationResponse(result));
    } catch (err) {
      if (err instanceof ReconciliationUnavailableError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // GET /v1/admin/analytics — loyalty-program analytics for a selectable date
  // range, derived solely from the ledger + Shopify order data via the hourly-
  // refreshed cached aggregates (task 17.3, Req 20). The admin-auth preHandler
  // above guarantees only an authenticated admin reaches this handler
  // (Req 20.1). Omitting the range applies + reports the default (Req 20.5); an
  // end-before-start range is rejected (Req 20.4); the response carries the
  // `computedAt` refresh timestamp (Req 20.6).
  app.get("/analytics", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = AnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }
    const range: DateRange | undefined =
      parsed.data.start !== undefined && parsed.data.end !== undefined
        ? { start: parsed.data.start, end: parsed.data.end }
        : undefined;
    try {
      const result = await analyticsService.getOverview(range);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof InvalidDateRangeError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}

export { REASON_MAX_LENGTH };
