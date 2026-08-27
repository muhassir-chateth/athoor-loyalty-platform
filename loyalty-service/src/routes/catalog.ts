/**
 * `GET /v1/catalog/products` (N4) — current catalogue facts for a set of product
 * ids (spec task 8.4, design §6.3 N4, §7.5, Req 7.4/7.6, 18.5/18.6).
 *
 * This is the enrichment behind the wishlist: the Wishlist_Record holds product
 * IDS and nothing else (Req 7.1), so every price, image and availability state a
 * wishlist row renders comes from here, read at request time. That is why Req 7.4
 * says "as read from Shopify at request time" — a cached price on a wishlist is a
 * price that can be wrong in the customer's favour or against it.
 *
 * ── THIS ROUTE IS NOT CUSTOMER-SCOPED, AND SAYS SO OUT LOUD ──────────────────
 * Products are global. There is no per-customer filtering to apply, and inventing
 * one would be theatre. What IS enforced is that the caller is an authenticated
 * customer: {@link requireCustomerScope} is called for its REJECTION, not for its
 * value, because an unauthenticated endpoint backed by a Shopify Admin token is a
 * free catalogue-scraping proxy. The scope is deliberately not passed to the read —
 * see `portal/repository/catalog.ts` on the second security class.
 *
 * ── WHY MORE THAN 50 IDS IS A 400 AND NOT A CAP ──────────────────────────────
 * §7.3 caps an oversized `pageSize` rather than rejecting it, and it would be
 * tempting to be consistent. It would also be wrong. A page size is a WINDOW: a
 * caller asking for 100 orders and receiving 20 has been served, and `pageInfo`
 * tells it there is more. A set of ids is not a window — silently dropping ids 51+
 * would answer a question the client did not ask, and the dropped ids would not
 * appear in `products` OR in `missing`, because they were never queried. A
 * wishlist row for a dropped id would then render with no data and no remove
 * control, which is exactly the stranded-row failure `missing` exists to prevent
 * (Req 7.6). So the client is told to split its request.
 *
 * `PortalErrorCode` is a closed union with no catalogue-specific member, so this
 * is `invalid_request` — the honest code, and one the client's copy map already
 * covers.
 *
 * SAFETY: read-only. No Postgres access at all, no mutation, and nothing stored —
 * §6.3 N4 calls this data non-authoritative and it is cached in process only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireCustomerScope } from "../auth/customerScope.js";
import { readCatalogProducts, type CatalogReadDeps } from "../portal/repository/catalog.js";
import { UnreadableUpstreamValueError } from "../portal/repository/orders.js";
import { UnscopedShopifyQueryError } from "../portal/repository/shopifyScope.js";
import {
  AdminThrottleExhaustedError,
  ShopifyThrottleError,
} from "../shopify/adminGateway.js";
import { ShopifyAdminRequestError } from "../shopify/graphqlClient.js";
import {
  CoalescingTtlCache,
  DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
  DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
  DEFAULT_SHOPIFY_READ_TTL_MS,
  ShopifyReadTimeoutError,
  type CoalescingCacheOptions,
} from "../shopify/coalescingCache.js";
import { PORTAL_CATALOG_MAX_IDS, type PortalCatalogResponse } from "../portal/types.js";

/** The form each `ids` entry must take. Numeric only — the GID is built server-side. */
export const CATALOG_PRODUCT_ID_PATTERN = /^\d{1,20}$/;

/** Outcome of parsing `?ids=`. */
export type CatalogQueryParseResult =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

type RawQueryValue = string | string[] | undefined;

/**
 * Parses `?ids=1,2,3` (also accepting a repeated `ids` parameter).
 *
 * De-duplicates while PRESERVING the caller's order, so `missing` comes back in a
 * sequence the client can align with its own list. The cap is applied to the
 * de-duplicated set: a client that repeats one id 60 times asked about one
 * product, and refusing that would be pedantry.
 */
export function parseCatalogQuery(query: Record<string, RawQueryValue>): CatalogQueryParseResult {
  const raw = query.ids;
  const parts: string[] = [];
  for (const value of Array.isArray(raw) ? raw : [raw]) {
    if (typeof value !== "string") continue;
    for (const piece of value.split(",")) {
      const trimmed = piece.trim();
      if (trimmed !== "") parts.push(trimmed);
    }
  }

  if (parts.length === 0) {
    return { ok: false, message: "The 'ids' parameter is required and must name at least one product." };
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!CATALOG_PRODUCT_ID_PATTERN.test(part)) {
      // No id is echoed back: a malformed value can be anything a caller typed,
      // and reflecting it into a response body is how a reflected-content defect
      // starts.
      return { ok: false, message: "Every 'ids' value must be a numeric product id." };
    }
    if (seen.has(part)) continue;
    seen.add(part);
    ids.push(part);
  }

  if (ids.length > PORTAL_CATALOG_MAX_IDS) {
    return {
      ok: false,
      message: `At most ${PORTAL_CATALOG_MAX_IDS} product ids may be requested at once.`,
    };
  }

  return { ok: true, ids };
}

/* ========================================================================== *
 * The source
 * ========================================================================== */

/**
 * Loads catalogue facts. Injectable so the route is unit-testable with no live
 * Shopify.
 *
 * Takes no {@link CustomerScope}, and that absence is the contract: a catalogue
 * source that accepted one would invite a future author to filter global data by
 * customer, which is either a no-op or a bug.
 */
export interface PortalCatalogSource {
  listProducts(numericProductIds: readonly string[]): Promise<PortalCatalogResponse>;
}

/** The Shopify-backed source. */
export class ShopifyPortalCatalogSource implements PortalCatalogSource {
  constructor(private readonly deps: CatalogReadDeps) {}

  listProducts(numericProductIds: readonly string[]): Promise<PortalCatalogResponse> {
    return readCatalogProducts(this.deps, numericProductIds);
  }
}

/** Options for {@link CachingPortalCatalogSource}. */
export type CachingPortalCatalogSourceOptions = Pick<
  CoalescingCacheOptions,
  "ttlMs" | "timeoutMs" | "maxEntries" | "now" | "onFailure"
>;

/**
 * The 60 s in-process TTL §6.3 N4 specifies, over the shared
 * {@link CoalescingTtlCache}.
 *
 * KEYED ON THE EXACT ID SET, in the order asked. Two different sets are two
 * different questions, and serving one the other's answer would drop or invent
 * products. The wishlist calls this with the same set on every page load, which is
 * the case the TTL actually collapses.
 */
export class CachingPortalCatalogSource implements PortalCatalogSource {
  private readonly cache: CoalescingTtlCache<PortalCatalogResponse>;

  constructor(
    private readonly inner: PortalCatalogSource,
    options: CachingPortalCatalogSourceOptions = {},
  ) {
    this.cache = new CoalescingTtlCache<PortalCatalogResponse>({
      ttlMs: options.ttlMs ?? DEFAULT_SHOPIFY_READ_TTL_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
      maxEntries: options.maxEntries ?? DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onFailure ? { onFailure: options.onFailure } : {}),
      label: "catalog products read",
    });
  }

  listProducts(numericProductIds: readonly string[]): Promise<PortalCatalogResponse> {
    const key = numericProductIds.join(",");
    return this.cache.read(key, () => this.inner.listProducts(numericProductIds));
  }
}

/**
 * Raised when no catalogue source is wired.
 *
 * REFUSES rather than answering `{ products: [], missing: [...] }`. That body is
 * not "we cannot answer" — it says every one of these products has been deleted,
 * which would have the wishlist invite the customer to clear their entire list.
 * Same argument as `PortalOrderSourceUnconfiguredError`, applied to the other
 * false statement available on this path.
 */
export class PortalCatalogSourceUnconfiguredError extends Error {
  readonly code = "portal_catalog_source_unconfigured" as const;

  constructor() {
    super("No Shopify-backed catalogue source is configured for this build.");
    this.name = "PortalCatalogSourceUnconfiguredError";
  }
}

/** The DEFAULT source: refuses. See {@link PortalCatalogSourceUnconfiguredError}. */
export class UnconfiguredPortalCatalogSource implements PortalCatalogSource {
  async listProducts(): Promise<PortalCatalogResponse> {
    throw new PortalCatalogSourceUnconfiguredError();
  }
}

/** In-memory source for tests and local runs. Deliberately not the default. */
export class InMemoryPortalCatalogSource implements PortalCatalogSource {
  constructor(private readonly byId: Map<string, PortalCatalogResponse["products"][number]> = new Map()) {}

  set(product: PortalCatalogResponse["products"][number]): void {
    this.byId.set(product.productId, product);
  }

  async listProducts(numericProductIds: readonly string[]): Promise<PortalCatalogResponse> {
    const products: PortalCatalogResponse["products"][number][] = [];
    const missing: string[] = [];
    for (const id of numericProductIds) {
      const found = this.byId.get(id);
      if (found) products.push(found);
      else missing.push(id);
    }
    return { products, missing };
  }
}

/* ========================================================================== *
 * The route
 * ========================================================================== */

/** Options accepted by {@link registerCatalogRoutes}. */
export interface CatalogRouteOptions {
  catalogSource?: PortalCatalogSource;
}

const UPSTREAM_UNAVAILABLE_BODY = {
  error: "upstream_unavailable",
  message: "Product details could not be loaded from the store just now.",
} as const;

/**
 * Whether a thrown value is a genuine upstream failure.
 *
 * An ALLOWLIST, for the reason `routes/orders.ts` sets out at length: a denylist
 * would dress a `TypeError` in the projection as a degraded upstream and the
 * client would render a handled-looking state over a real defect.
 *
 * {@link UnscopedShopifyQueryError} is deliberately ABSENT. On this path it means
 * the catalogue document failed {@link assertGlobalCatalogueQuery} — i.e. a
 * document that could reach customer-owned data was about to be sent. That is the
 * most security-relevant failure this route has, and it must be a loud 500, never
 * a reassuring 502.
 */
function isUpstreamFailure(err: unknown): boolean {
  return (
    err instanceof ShopifyAdminRequestError ||
    err instanceof ShopifyThrottleError ||
    err instanceof AdminThrottleExhaustedError ||
    err instanceof ShopifyReadTimeoutError ||
    err instanceof UnreadableUpstreamValueError ||
    err instanceof PortalCatalogSourceUnconfiguredError
  );
}

/**
 * Registers `GET /v1/catalog/products`. MUST be called inside the `/v1` router
 * scope so the auth preHandler has run.
 */
export function registerCatalogRoutes(
  app: FastifyInstance,
  opts: CatalogRouteOptions = {},
): void {
  const catalogSource = opts.catalogSource ?? new UnconfiguredPortalCatalogSource();

  app.get("/catalog/products", async (req: FastifyRequest, reply: FastifyReply) => {
    // Called for its REJECTION, not its value — see the header. An authenticated
    // caller only; the result is not filtered by customer because the data is not
    // customer-owned.
    requireCustomerScope(req);

    const parsed = parseCatalogQuery((req.query ?? {}) as Record<string, RawQueryValue>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.message });
    }

    try {
      return await catalogSource.listProducts(parsed.ids);
    } catch (err) {
      if (!isUpstreamFailure(err)) throw err;
      req.log.warn(
        {
          errorCode: "upstream_unavailable",
          upstream: "shopify",
          route: req.routeOptions?.url ?? "/v1/catalog/products",
        },
        "catalogue read could not reach Shopify",
      );
      return reply.code(502).send(UPSTREAM_UNAVAILABLE_BODY);
    }
  });
}
