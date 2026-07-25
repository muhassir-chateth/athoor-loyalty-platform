/**
 * `GET /v1/profile` and `GET /v1/profile/journey` — the authenticated
 * customer's Fragrance_Profile and Fragrance_Journey_Timeline (task 14.5).
 *
 * Surfaces the composition built in `profile/fragranceProfile.ts` over the
 * versioned `/v1` API (design.md route table: `GET /v1/profile` →
 * `FragranceProfile`, `GET /v1/profile/journey` → `JourneyMilestone[]`). For
 * the customer resolved by the `/v1` auth preHandler (task 6.2,
 * `req.authCtx.customerId`) it returns:
 *
 *   - `GET /v1/profile`: purchased fragrances (from paid Shopify orders),
 *     favourites, wishlist, recently-viewed, suggestions, and the journey
 *     timeline (Req 17.1, 17.2, 17.4, 17.5, 17.6, 17.8, 17.10);
 *   - `GET /v1/profile/journey`: only the chronological journey milestones —
 *     first purchase, favourites added, tier changes (Req 17.8).
 *
 * EMPTY, NOT ERROR (Req 17.9): a customer with no data receives a profile whose
 * categories are empty arrays (and an empty journey), never an error status.
 *
 * IDENTITY-SOURCE AGNOSTIC / OWN-DATA-ONLY (Req 17.10, 9.2/9.3): the handler
 * reads only `req.authCtx.customerId`, resolved identically for App Proxy (web)
 * and Customer Account API (mobile/portal) requests, and passes that single id
 * to the composition — so only the requesting customer's data is returned.
 *
 * The `journey` array is wrapped in an object (`{ milestones: [...] }`) for the
 * journey endpoint so the versioning plugin can inject the version field into
 * the JSON payload (it injects into objects, not bare arrays), consistent with
 * how `/v1/rewards` wraps its array.
 *
 * SAFETY: defining this module touches no live/production system. The default
 * data source is in-memory (empty); a Pg/Shopify-backed source is injected at
 * deploy time. Route logic is unit-tested with an in-memory source, so no live
 * Shopify or Postgres is required during verification.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  FragranceProfileService,
  InMemoryFragranceProfileDataSource,
  type FragranceProfileDataSource,
} from "../profile/fragranceProfile.js";
import { markPortalVisit } from "../profile/portalVisit.js";
import type { Queryable } from "../ledger/repository.js";

/**
 * The `POST /v1/profile/visit` response contract (design.md → `{ firstVisit }`).
 * `firstVisit` drives the private-client portal's first-visit welcome vs
 * returning-member experience (task 16.1, Req 16.1/16.2).
 */
export interface PortalVisitResponse {
  /** True iff this was the customer's first recorded portal visit (Req 16.1). */
  firstVisit: boolean;
}

/**
 * Records a portal visit and reports whether it was the customer's first
 * (task 14.6). Expressed as an injectable interface so the route is
 * unit-testable with an in-memory fake and boots without a live Postgres
 * (mirrors the balance/profile source pattern).
 */
export interface PortalVisitRecorder {
  record(customerId: string): Promise<PortalVisitResponse>;
}

/**
 * In-memory {@link PortalVisitRecorder} — the default for local runs and tests.
 * Tracks which customers have been seen so the first `record` for a customer
 * reports `firstVisit === true` and every later call reports `false`, matching
 * the persisted `portal_visits` semantics without a live database.
 */
export class InMemoryPortalVisitRecorder implements PortalVisitRecorder {
  private readonly visited: Set<string>;

  constructor(alreadyVisited: Iterable<string> = []) {
    this.visited = new Set(alreadyVisited);
  }

  async record(customerId: string): Promise<PortalVisitResponse> {
    const firstVisit = !this.visited.has(customerId);
    this.visited.add(customerId);
    return { firstVisit };
  }
}

/**
 * Postgres-backed {@link PortalVisitRecorder}: delegates to the atomic
 * off-ledger upsert in {@link markPortalVisit} (task 14.6). Writes ONLY to
 * `portal_visits` and never to `ledger_entries` (Req 17.3 / Property 13).
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing.
 */
export class PgPortalVisitRecorder implements PortalVisitRecorder {
  constructor(private readonly db: Queryable) {}

  async record(customerId: string): Promise<PortalVisitResponse> {
    const result = await markPortalVisit(customerId, this.db);
    return { firstVisit: result.firstVisit };
  }
}

/** Options accepted by {@link registerProfileRoutes}. */
export interface ProfileRouteOptions {
  /**
   * Supplies the Fragrance_Profile data (Shopify order data + Loyalty_Service
   * preference data). Defaults to an empty in-memory source so the routes boot
   * without live Shopify/Postgres; they then return empty profiles (Req 17.9)
   * until a real source is wired.
   */
  fragranceProfileDataSource?: FragranceProfileDataSource;
  /**
   * Records portal visits for `POST /v1/profile/visit` (task 14.6), driving the
   * private-client first-visit vs returning-member experience (task 16.1,
   * Req 16.1/16.2). Defaults to an in-memory recorder so the route boots
   * without a live Postgres; a {@link PgPortalVisitRecorder} is injected at
   * deploy time.
   */
  portalVisitRecorder?: PortalVisitRecorder;
}

/**
 * Registers `GET /v1/profile` and `GET /v1/profile/journey` on `app`. MUST be
 * called inside the `/v1` router scope so the auth preHandler has already
 * resolved `req.authCtx` (task 6.2) before these handlers run.
 *
 * Responds `401` if auth did not attach an identity (defensive — the preHandler
 * normally rejects first), and otherwise `200` with the composed profile /
 * journey (empty categories for a customer with no data, Req 17.9).
 */
export function registerProfileRoutes(app: FastifyInstance, opts: ProfileRouteOptions = {}): void {
  const dataSource = opts.fragranceProfileDataSource ?? new InMemoryFragranceProfileDataSource();
  const service = new FragranceProfileService(dataSource);
  const portalVisitRecorder = opts.portalVisitRecorder ?? new InMemoryPortalVisitRecorder();

  // Portal-visit state (task 14.6, Req 16.1/16.2). A state-changing POST, so the
  // scope-level idempotency plugin requires an `Idempotency-Key`; the private-
  // client portal sends a fresh key per page load. Returns `{ firstVisit }`:
  // true on the customer's first recorded visit (portal shows the first-visit
  // welcome), false thereafter (portal omits the welcome). Off-ledger — never
  // touches the customer's Balance (Req 17.3).
  app.post("/profile/visit", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      return reply.code(401).send({
        error: "identity_resolution_failed",
        message: "Could not resolve the request to a loyalty customer identity.",
      });
    }

    const { firstVisit } = await portalVisitRecorder.record(ctx.customerId);
    return { firstVisit } satisfies PortalVisitResponse;
  });

  app.get("/profile", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      // Defensive: the auth preHandler should have rejected already (Req 9.3).
      return reply.code(401).send({
        error: "identity_resolution_failed",
        message: "Could not resolve the request to a loyalty customer identity.",
      });
    }

    // Only the requesting customer's id is ever passed to the composition (Req 17.10).
    return service.getFragranceProfile(ctx.customerId);
  });

  app.get("/profile/journey", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) {
      return reply.code(401).send({
        error: "identity_resolution_failed",
        message: "Could not resolve the request to a loyalty customer identity.",
      });
    }

    const milestones = await service.getJourneyTimeline(ctx.customerId);
    // Wrap the array so the versioning plugin can inject the version field.
    return { milestones };
  });
}
