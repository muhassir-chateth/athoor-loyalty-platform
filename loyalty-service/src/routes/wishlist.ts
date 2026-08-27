/**
 * `PUT /v1/profile/wishlist/:productId` (N5) — the wishlist's single write
 * authority (spec task 9.1, design §6.3 N5, §8.4, Req 7.1/7.3/7.9/7.10, 8.7).
 *
 * ── WHY THIS ENDPOINT IS THE WHOLE POINT OF §8 ──────────────────────────────
 * Before it, the wishlist had no removal path at all: `POST
 * /v1/profile/wishlist/reconcile` only ever ADDS (by design, Req 17.4), and the
 * storefront's `dt_wishlist.js` mutated `localStorage` alone. So "remove" existed
 * on the device and nowhere else, and §8.4 rule 5 — "removal is authoritative in
 * one place, on the server" — was, in the design's own words, "conditionally
 * false". This route makes it unconditionally true.
 *
 * ── THE TOMBSTONE, AND WHY IT LIVES WITH THIS ROUTE ─────────────────────────
 * `localStorage['shopify-wishlist']` is NEVER cleared — the owner's decision of
 * record (§8.4 rule 3), and the safer half of a real trade-off, because clearing
 * it is irreversible on that device. The consequence was that the add-only union
 * could not tell "never merged" from "explicitly removed", so a removal was undone
 * by the next reconcile — every PAGE LOAD, not merely every session.
 *
 * `on:false` therefore writes `customer_wishlist_removals` as well as deleting the
 * row, and `reconcileWishlist` excludes anything recorded there. The schema and the
 * logic that honours it land together, which is why task 9.1 owns both halves
 * rather than inheriting a table from task 6.
 *
 * `on:true` CLEARS the tombstone, because an explicit add is a newer statement of
 * intent than an older removal. Without that a removed product could never be saved
 * again — the add would be silently reverted on the next merge.
 *
 * ── THE CAP IS CHECKED ON THE ADD PATH ONLY ─────────────────────────────────
 * `409 wishlist_limit_reached` at 500 items (§6.3 N5). A REMOVAL is never capped:
 * refusing to let a customer at their limit delete something would trap them, and
 * the removal is the very thing that would bring them back under it. Nor is a
 * REPEAT add capped once the product is already saved, because that add changes
 * nothing — capping it would make an idempotent no-op fail at the boundary.
 *
 * ── IDEMPOTENCY IS INHERITED, NOT RE-IMPLEMENTED ────────────────────────────
 * `registerIdempotency` installs a `/v1`-wide preHandler over every state-changing
 * method, so a PUT without a valid `Idempotency-Key` is refused with `400
 * invalid_idempotency_key` before this handler runs, and a repeat within the 24 h
 * window is replayed verbatim. A second mechanism here would give two answers to
 * one question.
 *
 * SAFETY: writes only `customer_wishlist` and `customer_wishlist_removals`, both
 * through the scope-typed repository. Nothing here reads or writes the ledger, so
 * no path through it can move a balance (Req 17.3, §9.5).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import type { Queryable } from "../ledger/repository.js";
import {
  countWishlistItems,
  readWishlist,
  setWishlistItem,
} from "../portal/repository/customerOwned.js";
import { InvalidPreferenceInputError } from "../profile/favouritesWishlist.js";
import { createRedemptionRateLimiter } from "../plugins/rateLimit.js";
import { PORTAL_WISHLIST_MAX_ITEMS, type PortalWishlistSetResponse } from "../portal/types.js";

/** N5's rate limit: 60 requests per minute per customer (§6.3 N5, §23). */
export const WISHLIST_RATE_LIMIT_MAX_REQUESTS = 60 as const;
export const WISHLIST_RATE_LIMIT_WINDOW_MS = 60_000 as const;

/** Outcome of parsing the N5 body. */
export type WishlistBodyParseResult = { ok: true; on: boolean } | { ok: false; message: string };

/**
 * Parses `{ on: boolean }`.
 *
 * STRICTLY BOOLEAN. `"true"`, `1` and `null` are refused rather than coerced: this
 * is the endpoint that decides whether a customer's saved product survives, and a
 * truthiness rule would make `on: "false"` — a string, which is truthy — ADD the
 * product the customer asked to remove.
 */
export function parseWishlistBody(body: unknown): WishlistBodyParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "A body of { on: boolean } is required." };
  }
  const { on } = body as { on?: unknown };
  if (typeof on !== "boolean") {
    return { ok: false, message: "A body of { on: boolean } is required." };
  }
  return { ok: true, on };
}

/** What the N5 route needs. Scope-typed throughout — no `customerId: string`. */
export interface WishlistWriteStore {
  read(scope: CustomerScope): Promise<string[]>;
  count(scope: CustomerScope): Promise<number>;
  set(scope: CustomerScope, productId: string, on: boolean): Promise<boolean>;
}

/** Postgres-backed store: pure delegation to the scope-typed repository. */
export class PgWishlistWriteStore implements WishlistWriteStore {
  constructor(private readonly db: Queryable) {}
  read(scope: CustomerScope): Promise<string[]> {
    return readWishlist(this.db, scope);
  }
  count(scope: CustomerScope): Promise<number> {
    return countWishlistItems(this.db, scope);
  }
  set(scope: CustomerScope, productId: string, on: boolean): Promise<boolean> {
    return setWishlistItem(this.db, scope, productId, on);
  }
}

/**
 * Raised when no wishlist store is wired.
 *
 * REFUSES rather than letting the route go unregistered. An absent route answers
 * `404`, which a client reads as "that product is not on your wishlist" — the exact
 * false statement this endpoint exists to make impossible. A loud failure is the
 * honest answer to "this build cannot record removals".
 */
export class WishlistStoreUnconfiguredError extends Error {
  readonly code = "wishlist_store_unconfigured" as const;
  constructor() {
    super("No wishlist store is configured for this build.");
    this.name = "WishlistStoreUnconfiguredError";
  }
}

/** The DEFAULT store: refuses. See {@link WishlistStoreUnconfiguredError}. */
export class UnconfiguredWishlistWriteStore implements WishlistWriteStore {
  async read(): Promise<string[]> {
    throw new WishlistStoreUnconfiguredError();
  }
  async count(): Promise<number> {
    throw new WishlistStoreUnconfiguredError();
  }
  async set(): Promise<boolean> {
    throw new WishlistStoreUnconfiguredError();
  }
}

/** Options accepted by {@link registerWishlistWriteRoute}. */
export interface WishlistRouteOptions {
  /** Defaults to {@link UnconfiguredWishlistWriteStore}, which refuses loudly. */
  wishlistStore?: WishlistWriteStore;
  /** Overrides the rate limiter; a test injects a fake clock and a shared store. */
  wishlistRateLimiter?: preHandlerAsyncHookHandler;
}

/**
 * Registers `PUT /v1/profile/wishlist/:productId`. MUST be called inside the `/v1`
 * router scope so auth and idempotency have already run.
 */
export function registerWishlistWriteRoute(
  app: FastifyInstance,
  opts: WishlistRouteOptions = {},
): void {
  // REGISTERED UNCONDITIONALLY. The route census drives every `/v1` route through
  // three unauthorised scenarios, and a route that disappears when a dependency is
  // absent would silently leave that sweep — so absence becomes a refusing store
  // rather than a missing route.
  const store = opts.wishlistStore ?? new UnconfiguredWishlistWriteStore();

  const rateLimiter =
    opts.wishlistRateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: WISHLIST_RATE_LIMIT_MAX_REQUESTS,
      windowMs: WISHLIST_RATE_LIMIT_WINDOW_MS,
      subject: "wishlist",
    });

  app.put<{ Params: { productId: string }; Body: unknown }>(
    "/profile/wishlist/:productId",
    { preHandler: [rateLimiter] },
    async (req, reply: FastifyReply) => {
      // Identity FIRST, so a stranger cannot learn which product ids are well-formed.
      const scope = requireCustomerScope(req);

      const parsed = parseWishlistBody(req.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.message });
      }

      const productId = req.params.productId;

      try {
        // THE CAP, on the add path only, and only when the product is not already
        // saved. Checked BEFORE the write so a refusal changes nothing.
        if (parsed.on) {
          const current = await store.read(scope);
          if (!current.includes(normaliseForComparison(productId)) ) {
            const count = await store.count(scope);
            if (count >= PORTAL_WISHLIST_MAX_ITEMS) {
              return reply.code(409).send({
                error: "wishlist_limit_reached",
                message: `A wishlist may hold at most ${PORTAL_WISHLIST_MAX_ITEMS} products.`,
              });
            }
          }
        }

        await store.set(scope, productId, parsed.on);

        // Echo the resulting set so the client needs no follow-up read (§6.3 N5).
        return {
          productId: normaliseForComparison(productId),
          on: parsed.on,
          wishlist: await store.read(scope),
        } satisfies PortalWishlistSetResponse;
      } catch (err) {
        if (err instanceof InvalidPreferenceInputError) {
          // A malformed or untrusted product id never reaches a statement — the
          // normaliser refuses it first. The message names no value.
          return reply.code(400).send({
            error: "invalid_request",
            message: "The product id must be a positive integer.",
          });
        }
        throw err;
      }
    },
  );
}

/**
 * Normalises a product id for comparison and for the echoed response, using the
 * SAME rule the repository writes with.
 *
 * Exists so the cap's "is it already saved?" check and the stored row agree about
 * leading zeros. If the check used the raw path value while the write used the
 * normalised one, `"0001"` would look absent, pass the cap, and then collapse onto
 * the existing `"1"` row — letting a customer at the limit believe they had added a
 * 501st product. Throws for a malformed id, which the handler maps to `400`.
 */
function normaliseForComparison(productId: string): string {
  const trimmed = typeof productId === "string" ? productId.trim() : "";
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidPreferenceInputError("productId must be a positive integer id.");
  }
  const value = BigInt(trimmed);
  if (value <= 0n) {
    throw new InvalidPreferenceInputError("productId must be greater than zero.");
  }
  return value.toString();
}
