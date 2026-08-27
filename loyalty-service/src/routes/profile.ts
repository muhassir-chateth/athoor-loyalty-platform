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
import { requireCustomerScope } from "../auth/customerScope.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  FragranceProfileService,
  InMemoryFragranceProfileDataSource,
  type FragranceProfileDataSource,
} from "../profile/fragranceProfile.js";
import { markPortalVisit } from "../profile/portalVisit.js";
import {
  getWishlist,
  listFavourites,
  reconcileWishlist,
  setFavourite,
  InvalidPreferenceInputError,
} from "../profile/favouritesWishlist.js";
import { RecentlyViewedValidationError } from "../profile/recentlyViewed.js";
import {
  deriveInferredSignal,
  EMPTY_PRODUCT_TAXONOMY,
  orderMonthsFromPurchaseInstants,
  type InferredSignal,
  type ProductTaxonomy,
} from "../profile/inferred.js";
import {
  WISHLIST_RECONCILE_SCHEMA,
  WISHLIST_RECONCILE_INVALID_REQUEST_MESSAGE,
  type WishlistReconcileResponse,
} from "../profile/wishlistReconcileContract.js";
import type { Queryable } from "../ledger/repository.js";
import { z } from "zod";

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

/**
 * The preference WRITES and their paired reads (task 31, Req 17.2/17.4).
 *
 * Expressed as an interface so the routes are unit-testable with an in-memory
 * fake, and so the production implementation is a thin delegation to the
 * EXISTING `profile/favouritesWishlist.ts` functions rather than a second copy
 * of the rules. Nothing here validates a product id or performs a union — those
 * belong to that module and stay there.
 */
export interface ProfilePreferenceStore {
  /** Mark (`on`) or unmark a favourite; idempotent (Req 17.2). */
  setFavourite(customerId: string, productId: string, on: boolean): Promise<void>;
  /** The customer's current favourites, ordered by product id (Req 17.2). */
  listFavourites(customerId: string): Promise<string[]>;
  /** The authoritative account-level wishlist (A14). */
  getWishlist(customerId: string): Promise<string[]>;
  /** UNION the device-local list into the account wishlist and return the merged set (Req 17.4). */
  reconcileWishlist(customerId: string, deviceLocalProductIds: string[]): Promise<string[]>;
}

/** Records an off-ledger product view; sampling/rate-limiting lives in the store (Req 17.5). */
export interface RecentlyViewedRecorder {
  recordView(customerId: string, productId: string): Promise<void>;
}

/**
 * Postgres-backed {@link ProfilePreferenceStore}. Pure delegation to the task
 * 14.2 implementations — every guard, the `ON CONFLICT DO NOTHING` idempotence
 * and the union semantics are theirs. Writes only `customer_favourites` /
 * `customer_wishlist`, never `ledger_entries` (Req 17.3, Property 13).
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at runtime.
 */
export class PgProfilePreferenceStore implements ProfilePreferenceStore {
  constructor(private readonly db: Queryable) {}

  async setFavourite(customerId: string, productId: string, on: boolean): Promise<void> {
    await setFavourite(this.db, customerId, productId, on);
  }

  async listFavourites(customerId: string): Promise<string[]> {
    return listFavourites(this.db, customerId);
  }

  async getWishlist(customerId: string): Promise<string[]> {
    return getWishlist(this.db, customerId);
  }

  async reconcileWishlist(customerId: string, deviceLocalProductIds: string[]): Promise<string[]> {
    return reconcileWishlist(this.db, customerId, deviceLocalProductIds);
  }
}

/** Body of `PUT /v1/profile/favourites/:id`: which way to set the flag. */
const FAVOURITE_BODY_SCHEMA = z.object({ on: z.boolean() }).strip();

/*
 * `POST /v1/profile/wishlist/reconcile`'s body schema is NOT declared here. It
 * lives in `profile/wishlistReconcileContract.ts`, imported above, together with
 * the request/response TypeScript types the storefront shares — so the client
 * and the server can no longer drift into two different contracts the way they
 * did in defect W2 (design §8.1). That module also records why `deviceLocal` is
 * the canonical field name and why the client is the side that changed.
 */

/** Body of `POST /v1/profile/recently-viewed`: one viewed product. */
const RECENTLY_VIEWED_SCHEMA = z.object({ productId: z.string().min(1) }).strip();

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
  /**
   * Backs the preference WRITES and their paired reads (task 31, Req 17.2/17.4).
   * Production wires {@link PgProfilePreferenceStore}. When ABSENT the favourite
   * and wishlist routes are not registered at all, so a build without it keeps
   * its existing route surface rather than accepting writes that go nowhere.
   */
  preferenceStore?: ProfilePreferenceStore;
  /**
   * Backs `POST /v1/profile/recently-viewed` (task 31, Req 17.5). Production
   * wires the existing `RecentlyViewedStore`, which owns the sampling and the
   * retention window. Absent → the route is not registered.
   */
  recentlyViewedRecorder?: RecentlyViewedRecorder;
  /**
   * The server-owned product→family/note mapping behind the additive `inferred`
   * block on `GET /v1/profile` (task 13.3, §12.3).
   *
   * Absent → {@link EMPTY_PRODUCT_TAXONOMY}, so `inferred` is present but
   * concludes nothing. That is a truthful "no mapping is loaded", not a failure:
   * Req 12.7 requires an empty category to render as empty and never as an error,
   * and §12.6 gives the client the empty-state presentation for it. The route is
   * never gated on this, because gating it would REMOVE a field from a shipped
   * response depending on configuration.
   */
  productTaxonomy?: ProductTaxonomy;
}

/**
 * `GET /v1/profile` with the additive `inferred` block (task 13.3).
 *
 * ── ADDITIVE, AND THAT IS ENFORCED BY THE TYPE ──────────────────────────────
 * An intersection rather than a redeclaration, so every field of `FragranceProfile`
 * survives by construction and this type cannot drift from it. Requirement 20.6
 * forbids removing or reshaping a shipped field, and `profile.inferred.test.ts`
 * asserts the seven original keys are all still present with their original shapes.
 */
export type ProfileWithInferred = Awaited<
  ReturnType<FragranceProfileService["getFragranceProfile"]>
> & {
  readonly inferred: InferredSignal;
};

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
  const productTaxonomy = opts.productTaxonomy ?? EMPTY_PRODUCT_TAXONOMY;

  // Portal-visit state (task 14.6, Req 16.1/16.2). A state-changing POST, so the
  // scope-level idempotency plugin requires an `Idempotency-Key`; the private-
  // client portal sends a fresh key per page load. Returns `{ firstVisit }`:
  // true on the customer's first recorded visit (portal shows the first-visit
  // welcome), false thereafter (portal omits the welcome). Off-ledger — never
  // touches the customer's Balance (Req 17.3).
  app.post("/profile/visit", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const { firstVisit } = await portalVisitRecorder.record(ctx.customerId);
    return { firstVisit } satisfies PortalVisitResponse;
  });

  app.get("/profile", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    // Only the requesting customer's id is ever passed to the composition (Req 17.10).
    const profile = await service.getFragranceProfile(ctx.customerId);

    // ── The additive `inferred` block (task 13.3, §12.8) ───────────────────
    //
    // DERIVED FROM WHAT THE COMPOSITION ALREADY READ. No extra query, no extra
    // round trip, and — decisively — no new data source: §12.3's input list is
    // exactly purchases, wishlist, recently viewed and favourites, and the profile
    // has all four in hand. Adding a second read path for the same rows would
    // create two answers to "what has this customer touched".
    //
    // It also means this block cannot see anything the profile could not: the
    // inputs are already scoped to the verified identity by the composition.
    const inferred = deriveInferredSignal(
      {
        purchasedProductIds: profile.purchasedFragrances.map((p) => p.productId),
        wishlistProductIds: profile.wishlist,
        favouriteProductIds: profile.favourites,
        recentlyViewedProductIds: profile.recentlyViewed.map((r) => r.productId),
        // A lower bound on the order count — see `InferredInputs.orderMonths`.
        // `firstPurchasedAt` rather than `lastPurchasedAt`: repurchasing a bottle
        // must not move an order's month, and the first instant of a product is
        // the one that corresponds to an order that actually happened.
        orderMonths: orderMonthsFromPurchaseInstants(
          profile.purchasedFragrances.map((p) => p.firstPurchasedAt),
        ),
      },
      productTaxonomy,
    );

    // Spread FIRST so no key here can shadow a shipped one; `inferred` is the only
    // addition, and a collision would be a compile error rather than a silent
    // overwrite because `FragranceProfile` has no `inferred` field.
    return { ...profile, inferred } satisfies ProfileWithInferred;
  });

  app.get("/profile/journey", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const milestones = await service.getJourneyTimeline(ctx.customerId);
    // Wrap the array so the versioning plugin can inject the version field.
    return { milestones };
  });

  app.get("/profile/suggestions", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);
    // Behind the SAME stable interface as the profile payload's field (A11), so
    // richer logic can replace the engine without changing this contract.
    const profile = await service.getFragranceProfile(ctx.customerId);
    return { suggestions: profile.suggestions };
  });

  /* ------------------------ preference writes (task 31) ------------------------ */
  /*
   * Reachability-audit finding 3: `GET /v1/profile` returned `favourites`,
   * `wishlist` and `recentlyViewed`, and NOTHING could write any of them —
   * `setFavourite`, `reconcileWishlist` and `RecentlyViewedStore` had no
   * production call site. These are those call sites, following the design route
   * table exactly.
   *
   * Every one is OFF-LEDGER (Req 17.3, Property 13): they touch only
   * `customer_favourites`, `customer_wishlist` and `customer_recently_viewed`.
   * All are state-changing, so the scope-level idempotency plugin requires an
   * `Idempotency-Key`, per-customer scoped since task 38. Validation belongs to
   * the underlying modules; the routes translate their typed errors to HTTP.
   */

  /** Maps a preference module's validation error to 400; returns false otherwise. */
  const replyInvalidInput = (reply: FastifyReply, err: unknown): boolean => {
    if (err instanceof InvalidPreferenceInputError || err instanceof RecentlyViewedValidationError) {
      reply.code(400).send({ error: err.code, message: err.message });
      return true;
    }
    return false;
  };

  const preferenceStore = opts.preferenceStore;
  if (preferenceStore) {
    app.get("/profile/favourites", async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCustomerScope(req);
      return { favourites: await preferenceStore.listFavourites(ctx.customerId) };
    });

    // PUT, not POST/DELETE: the design route table defines a single idempotent
    // set-or-unset (`(ctx, on: boolean) => void`), which matches the underlying
    // `setFavourite` contract — marking an already-favourited product and
    // unmarking one that is not favourited are both no-ops.
    app.put("/profile/favourites/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCustomerScope(req);
      const params = z.object({ id: z.string().min(1) }).strip().safeParse(req.params);
      const body = FAVOURITE_BODY_SCHEMA.safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "A product id in the path and a body of { on: boolean } are required.",
        });
      }
      try {
        await preferenceStore.setFavourite(ctx.customerId, params.data.id, body.data.on);
      } catch (err) {
        if (replyInvalidInput(reply, err)) return reply;
        throw err;
      }
      // Echo the resulting set so the caller needs no follow-up read.
      return {
        productId: params.data.id,
        on: body.data.on,
        favourites: await preferenceStore.listFavourites(ctx.customerId),
      };
    });

    app.get("/profile/wishlist", async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCustomerScope(req);
      return { wishlist: await preferenceStore.getWishlist(ctx.customerId) };
    });

    // A14 / Req 17.4: the device-local `shopify-wishlist` entries are merged as a
    // UNION into the account-level wishlist, which is authoritative thereafter.
    // The CLIENT supplies the device-local list because it lives in
    // localStorage — the server cannot read it, so "on authentication" means
    // "the storefront calls this once the member is authenticated".
    app.post("/profile/wishlist/reconcile", async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCustomerScope(req);
      const parsed = WISHLIST_RECONCILE_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: WISHLIST_RECONCILE_INVALID_REQUEST_MESSAGE,
        });
      }
      try {
        // Nothing is deleted: reconciliation only ever ADDS, so a member who
        // signs in on a new device cannot lose account-level entries.
        //
        // OWNERSHIP: the customer id comes from `ctx` (the auth preHandler's
        // resolved identity) and from nowhere else. No body, query, header or
        // cookie value can redirect this merge into another customer's wishlist
        // (design §4.3 Rule 1, §4.5 rows 1/2/8).
        const wishlist = await preferenceStore.reconcileWishlist(
          ctx.customerId,
          parsed.data.deviceLocal,
        );
        return { wishlist } satisfies WishlistReconcileResponse;
      } catch (err) {
        if (replyInvalidInput(reply, err)) return reply;
        throw err;
      }
    });
  }

  const recentlyViewedRecorder = opts.recentlyViewedRecorder;
  if (recentlyViewedRecorder) {
    app.post("/profile/recently-viewed", async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCustomerScope(req);
      const parsed = RECENTLY_VIEWED_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "A body of { productId: string } is required.",
        });
      }
      try {
        await recentlyViewedRecorder.recordView(ctx.customerId, parsed.data.productId);
      } catch (err) {
        if (replyInvalidInput(reply, err)) return reply;
        throw err;
      }
      // `accepted`, deliberately not `recorded`: the store SAMPLES repeat views
      // of the same product within its minimum interval, so an accepted request
      // does not promise a row was written this time (Req 17.5). Claiming
      // otherwise would be a lie the client could not detect.
      return { accepted: true };
    });
  }
}
