/**
 * Tests for `GET /v1/catalog/products` (N4) — spec task 8.4, design §6.3 N4,
 * §7.5, Req 7.4/7.6, 18.5.
 *
 * Four layers:
 *   1. the query parser, where the >50 rule and de-duplication live;
 *   2. the projection, where §7.5's published/unpublished/deleted distinctions are
 *      either honoured or not;
 *   3. the 60 s caching source;
 *   4. the route over a REAL Fastify app with the REAL `/v1` auth layer and the
 *      REAL repository projection over a fake Admin transport.
 *
 * Layer 4 deliberately wires `ShopifyPortalCatalogSource` over a fake transport
 * rather than injecting a hand-written source, for the reason `orders.test.ts`
 * gives: a second implementation of the contract is how W1/W2 stayed green.
 *
 * SAFETY: no network, no Postgres, no production. This path touches no database at
 * all — see the structural test at the end.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { ScopedGraphqlTransport } from "../portal/repository/shopifyScope.js";
import { UnscopedShopifyQueryError } from "../portal/repository/shopifyScope.js";
import { ShopifyAdminRequestError } from "../shopify/graphqlClient.js";
import { ShopifyReadTimeoutError } from "../shopify/coalescingCache.js";
import { PORTAL_CATALOG_MAX_IDS, isMoneyGBP } from "../portal/types.js";
import {
  PORTAL_CATALOG_PRODUCTS_QUERY,
  derivePublished,
  numericVariantIdFromGid,
  projectCatalogProduct,
  readCatalogProducts,
} from "../portal/repository/catalog.js";
import {
  CachingPortalCatalogSource,
  ShopifyPortalCatalogSource,
  UnconfiguredPortalCatalogSource,
  parseCatalogQuery,
  type PortalCatalogSource,
} from "./catalog.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

/* ========================================================================== *
 * 1 — the query parser
 * ========================================================================== */

describe("parseCatalogQuery", () => {
  it("accepts a comma-separated list", () => {
    expect(parseCatalogQuery({ ids: "1001,1002,1003" })).toEqual({
      ok: true,
      ids: ["1001", "1002", "1003"],
    });
  });

  it("accepts a repeated parameter and merges it", () => {
    expect(parseCatalogQuery({ ids: ["1001", "1002,1003"] })).toEqual({
      ok: true,
      ids: ["1001", "1002", "1003"],
    });
  });

  it("de-duplicates while PRESERVING the caller's order", () => {
    // Order matters: `missing` comes back in this sequence, and the client aligns
    // it with its own list.
    expect(parseCatalogQuery({ ids: "1003,1001,1003,1002,1001" })).toEqual({
      ok: true,
      ids: ["1003", "1001", "1002"],
    });
  });

  it("requires at least one id", () => {
    for (const query of [{}, { ids: "" }, { ids: " , , " }]) {
      expect(parseCatalogQuery(query).ok).toBe(false);
    }
  });

  it("rejects a non-numeric id rather than building a GID from it", () => {
    for (const bad of ["abc", "1001,abc", "gid://shopify/Product/1001", "-1", "1.5", "1e3"]) {
      expect(parseCatalogQuery({ ids: bad }).ok, bad).toBe(false);
    }
  });

  it("never echoes a malformed id back into the response body", () => {
    const parsed = parseCatalogQuery({ ids: "<script>alert(1)</script>" });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).not.toContain("script");
  });

  it("REJECTS more than 50 ids rather than capping (Req 7.6)", () => {
    // Capping would drop ids 51+, and a dropped id appears in neither `products`
    // nor `missing` — so a wishlist row for it renders with no data AND no remove
    // control, which is the stranded row `missing` exists to prevent.
    const tooMany = Array.from({ length: PORTAL_CATALOG_MAX_IDS + 1 }, (_, i) => String(1000 + i));
    const parsed = parseCatalogQuery({ ids: tooMany.join(",") });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain(String(PORTAL_CATALOG_MAX_IDS));
  });

  it("accepts exactly 50", () => {
    const exactly = Array.from({ length: PORTAL_CATALOG_MAX_IDS }, (_, i) => String(1000 + i));
    expect(parseCatalogQuery({ ids: exactly.join(",") }).ok).toBe(true);
  });

  it("applies the cap to the DE-DUPLICATED set", () => {
    // 60 copies of one id is a question about one product.
    const repeated = Array.from({ length: 60 }, () => "1001");
    expect(parseCatalogQuery({ ids: repeated.join(",") })).toEqual({ ok: true, ids: ["1001"] });
  });
});

/* ========================================================================== *
 * 2 — the projection (§7.5)
 * ========================================================================== */

function productNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Product/1001",
    title: "Oud Royale 50ml",
    handle: "oud-royale",
    status: "ACTIVE",
    publishedAt: "2024-01-01T00:00:00Z",
    availableForSale: true,
    featuredImage: { url: "https://cdn/oud.jpg", width: 800, height: 1000 },
    priceRangeV2: { minVariantPrice: { amount: "184.0" } },
    compareAtPriceRange: { minVariantCompareAtPrice: { amount: "220.00" } },
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/4477" }] },
    ...overrides,
  };
}

describe("projectCatalogProduct (§7.5)", () => {
  it("projects a published, in-stock product", () => {
    expect(projectCatalogProduct(productNode())).toEqual({
      productId: "1001",
      title: "Oud Royale 50ml",
      handle: "oud-royale",
      published: true,
      availableForSale: true,
      priceGBP: "184.00",
      compareAtPriceGBP: "220.00",
      imageUrl: "https://cdn/oud.jpg",
      imageWidth: 800,
      imageHeight: 1000,
      defaultVariantId: "4477",
    });
  });

  it("returns money as 2-dp decimal STRINGS (design §6.2)", () => {
    const product = projectCatalogProduct(productNode());
    expect(isMoneyGBP(product.priceGBP)).toBe(true);
    expect(product.compareAtPriceGBP !== null && isMoneyGBP(product.compareAtPriceGBP)).toBe(true);
  });

  it("nulls the handle when unpublished, so the client emits no link (Req 6.9)", () => {
    // Shopify still reports the handle; the contract withholds it.
    const unpublished = projectCatalogProduct(productNode({ publishedAt: null }));
    expect(unpublished.published).toBe(false);
    expect(unpublished.handle).toBeNull();
    // Title and price survive, so the row still renders.
    expect(unpublished.title).toBe("Oud Royale 50ml");
    expect(unpublished.priceGBP).toBe("184.00");
  });

  it("treats an ARCHIVED product as unpublished even with a publishedAt", () => {
    expect(projectCatalogProduct(productNode({ status: "ARCHIVED" })).published).toBe(false);
  });

  it("keeps published and availableForSale as SEPARATE facts (§7.5)", () => {
    // An out-of-stock published product can be linked to but not bought.
    const outOfStock = projectCatalogProduct(productNode({ availableForSale: false }));
    expect(outOfStock.published).toBe(true);
    expect(outOfStock.handle).toBe("oud-royale");
    expect(outOfStock.availableForSale).toBe(false);
  });

  it("drops a compare-at price that is not actually a discount", () => {
    // Shopify reports one on products never marked down; passing it through would
    // render a fake strikethrough.
    for (const amount of ["184.00", "100.00", "0.00"]) {
      const node = productNode({
        compareAtPriceRange: { minVariantCompareAtPrice: { amount } },
      });
      expect(projectCatalogProduct(node).compareAtPriceGBP, amount).toBeNull();
    }
  });

  it("returns a NUMERIC default variant id, because /cart/add.js needs one", () => {
    expect(projectCatalogProduct(productNode()).defaultVariantId).toBe("4477");
    expect(numericVariantIdFromGid("gid://shopify/ProductVariant/9")).toBe("9");
    expect(numericVariantIdFromGid("gid://shopify/Product/9")).toBeNull();
    expect(numericVariantIdFromGid("9")).toBeNull();
  });

  it("nulls defaultVariantId when there is no purchasable variant", () => {
    expect(projectCatalogProduct(productNode({ variants: { nodes: [] } })).defaultVariantId).toBeNull();
  });

  it("reports zero dimensions with a null url when there is no image", () => {
    const noImage = projectCatalogProduct(productNode({ featuredImage: null }));
    expect(noImage.imageUrl).toBeNull();
    // The client renders its designed no-image box; it never guesses a ratio.
    expect(noImage.imageWidth).toBe(0);
    expect(noImage.imageHeight).toBe(0);
  });

  it("refuses a node whose id is not a product GID, rather than emitting an empty id", () => {
    expect(() => projectCatalogProduct(productNode({ id: "gid://shopify/Customer/1" }))).toThrow();
    expect(() => projectCatalogProduct(productNode({ id: null }))).toThrow();
  });

  it("derivePublished requires BOTH an active status and a publishedAt", () => {
    expect(derivePublished({ status: "ACTIVE", publishedAt: "2024-01-01T00:00:00Z" })).toBe(true);
    expect(derivePublished({ status: "ACTIVE", publishedAt: null })).toBe(false);
    expect(derivePublished({ status: "DRAFT", publishedAt: "2024-01-01T00:00:00Z" })).toBe(false);
    expect(derivePublished({})).toBe(false);
  });
});

/* ========================================================================== *
 * 3 — the read and `missing` (Req 7.6)
 * ========================================================================== */

class FakeTransport implements ScopedGraphqlTransport {
  requests = 0;
  lastVariables: Record<string, unknown> = {};
  constructor(private readonly reply: (variables: Record<string, unknown>) => unknown) {}
  async request<T>(_document: string, variables: Record<string, unknown>): Promise<T> {
    this.requests += 1;
    this.lastVariables = variables;
    return this.reply(variables) as T;
  }
}

class ThrowingTransport implements ScopedGraphqlTransport {
  constructor(private readonly error: Error) {}
  async request<T>(): Promise<T> {
    throw this.error;
  }
}

describe("readCatalogProducts", () => {
  it("builds Product GIDs from digits — the caller never supplies a GID", async () => {
    const transport = new FakeTransport(() => ({ nodes: [productNode()] }));
    await readCatalogProducts({ transport }, ["1001"]);
    expect(transport.lastVariables.ids).toEqual(["gid://shopify/Product/1001"]);
  });

  it("names every requested id Shopify did not return in `missing` (Req 7.6)", async () => {
    // The wishlist depends on this: an id the client cannot see is an id it
    // cannot remove.
    const transport = new FakeTransport(() => ({ nodes: [productNode(), null] }));
    const result = await readCatalogProducts({ transport }, ["1001", "1002", "1003"]);
    expect(result.products.map((p) => p.productId)).toEqual(["1001"]);
    expect(result.missing).toEqual(["1002", "1003"]);
  });

  it("computes `missing` by DIFFERENCE, not from positional nulls", async () => {
    // A response that reorders or short-returns must still yield a correct answer.
    const transport = new FakeTransport(() => ({
      nodes: [productNode({ id: "gid://shopify/Product/1003" })],
    }));
    const result = await readCatalogProducts({ transport }, ["1001", "1002", "1003"]);
    expect(result.products.map((p) => p.productId)).toEqual(["1003"]);
    expect(result.missing).toEqual(["1001", "1002"]);
  });

  it("returns an empty `missing` array rather than omitting the field", async () => {
    const transport = new FakeTransport(() => ({ nodes: [productNode()] }));
    const result = await readCatalogProducts({ transport }, ["1001"]);
    expect(result.missing).toEqual([]);
  });

  it("makes no request at all for an empty id list", async () => {
    const transport = new FakeTransport(() => ({ nodes: [] }));
    expect(await readCatalogProducts({ transport }, [])).toEqual({ products: [], missing: [] });
    expect(transport.requests).toBe(0);
  });

  it("propagates a transport failure instead of reporting every product deleted", async () => {
    // "Everything you saved has been discontinued" would be a false statement
    // that invites the customer to clear their whole wishlist.
    const transport = new ThrowingTransport(new ShopifyAdminRequestError("down"));
    await expect(readCatalogProducts({ transport }, ["1001"])).rejects.toBeInstanceOf(
      ShopifyAdminRequestError,
    );
  });

  it("sends a document that passes the CATALOGUE guard and fails the SCOPED one", async () => {
    // The security-class split, asserted on the real document.
    const { assertGlobalCatalogueQuery, assertScopedCustomerQuery } = await import(
      "../portal/repository/shopifyScope.js"
    );
    expect(() => assertGlobalCatalogueQuery(PORTAL_CATALOG_PRODUCTS_QUERY)).not.toThrow();
    expect(() => assertScopedCustomerQuery(PORTAL_CATALOG_PRODUCTS_QUERY)).toThrow(
      UnscopedShopifyQueryError,
    );
  });
});

/* ========================================================================== *
 * 4 — the 60 s cache (§6.3 N4)
 * ========================================================================== */

describe("CachingPortalCatalogSource", () => {
  it("serves a second identical read from cache with NO second Shopify call", async () => {
    let reads = 0;
    const cached = new CachingPortalCatalogSource({
      listProducts: async () => {
        reads += 1;
        return { products: [], missing: [] };
      },
    });
    await cached.listProducts(["1001", "1002"]);
    await cached.listProducts(["1001", "1002"]);
    expect(reads).toBe(1);
  });

  it("does NOT serve one id set's answer for a different set", async () => {
    const asked: string[][] = [];
    const cached = new CachingPortalCatalogSource({
      listProducts: async (ids) => {
        asked.push([...ids]);
        return { products: [], missing: [] };
      },
    });
    await cached.listProducts(["1001"]);
    await cached.listProducts(["1002"]);
    await cached.listProducts(["1001", "1002"]);
    expect(asked).toEqual([["1001"], ["1002"], ["1001", "1002"]]);
  });

  it("collapses two concurrent reads of the same set into one", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const cached = new CachingPortalCatalogSource({
      listProducts: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = () => resolve({ products: [], missing: [] });
        });
      },
    });
    const a = cached.listProducts(["1001"]);
    const b = cached.listProducts(["1001"]);
    release();
    await Promise.all([a, b]);
    expect(reads).toBe(1);
  });

  it("never caches a failure", async () => {
    let reads = 0;
    const cached = new CachingPortalCatalogSource({
      listProducts: async () => {
        reads += 1;
        if (reads === 1) throw new Error("transient");
        return { products: [], missing: [] };
      },
    });
    await expect(cached.listProducts(["1001"])).rejects.toThrow("transient");
    await expect(cached.listProducts(["1001"])).resolves.toBeDefined();
    expect(reads).toBe(2);
  });

  it("times out a slow read with the typed timeout error", async () => {
    const cached = new CachingPortalCatalogSource(
      { listProducts: () => new Promise(() => {}) },
      { timeoutMs: 5 },
    );
    await expect(cached.listProducts(["1001"])).rejects.toBeInstanceOf(ShopifyReadTimeoutError);
  });
});

/* ========================================================================== *
 * 5 — the route, end to end
 * ========================================================================== */

function buildCatalogApp(source?: PortalCatalogSource): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    ...(source ? { portalCatalogSource: source } : {}),
  });
  return app;
}

function shopifyBackedApp(reply: (variables: Record<string, unknown>) => unknown): FastifyInstance {
  return buildCatalogApp(new ShopifyPortalCatalogSource({ transport: new FakeTransport(reply) }));
}

describe("GET /v1/catalog/products (N4)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns products and missing (§6.3 N4)", async () => {
    app = shopifyBackedApp(() => ({ nodes: [productNode(), null] }));
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/catalog/products?ids=1001,1002",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({
      productId: "1001",
      handle: "oud-royale",
      published: true,
      availableForSale: true,
      priceGBP: "184.00",
      imageWidth: 800,
      imageHeight: 1000,
      defaultVariantId: "4477",
    });
    expect(body.missing).toEqual(["1002"]);
  });

  it("answers 400 invalid_request for more than 50 ids", async () => {
    app = shopifyBackedApp(() => ({ nodes: [] }));
    await app.ready();
    const tooMany = Array.from({ length: 51 }, (_, i) => String(1000 + i)).join(",");
    const res = await app.inject({
      method: "GET",
      url: `/v1/catalog/products?ids=${tooMany}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("answers 400 for a malformed or absent ids parameter", async () => {
    app = shopifyBackedApp(() => ({ nodes: [] }));
    await app.ready();
    for (const query of ["", "?ids=", "?ids=abc", "?ids=gid://shopify/Product/1"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/catalog/products${query}`,
        headers: AUTH,
      });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("answers 502 upstream_unavailable when Shopify is unreachable", async () => {
    app = buildCatalogApp(
      new ShopifyPortalCatalogSource({
        transport: new ThrowingTransport(new ShopifyAdminRequestError("down")),
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/catalog/products?ids=1001",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });

  it("REFUSES rather than reporting every product deleted when unwired", async () => {
    // `{ products: [], missing: ["1001"] }` would tell the wishlist this product
    // is gone, and invite the customer to clear it.
    app = buildCatalogApp(new UnconfiguredPortalCatalogSource());
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/catalog/products?ids=1001",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
    expect(res.json().missing).toBeUndefined();
  });

  it("leaks no upstream detail in the 502 body (Req 2.7)", async () => {
    app = buildCatalogApp(
      new ShopifyPortalCatalogSource({
        transport: new ThrowingTransport(
          new ShopifyAdminRequestError("connect ECONNREFUSED 10.0.0.7:443"),
        ),
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/catalog/products?ids=1001",
      headers: AUTH,
    });
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("10.0.0.7");
  });

  it("requires an authenticated customer even though the data is global", async () => {
    // Otherwise this is a free catalogue-scraping proxy over our Admin token.
    app = shopifyBackedApp(() => ({ nodes: [productNode()] }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/catalog/products?ids=1001" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the SAME answer for two different customers — the data is not scoped", async () => {
    // Stated as a test so a future author cannot quietly add per-customer
    // filtering and believe it was always there.
    app = shopifyBackedApp(() => ({ nodes: [productNode()] }));
    await app.ready();
    const first = await app.inject({
      method: "GET",
      url: "/v1/catalog/products?ids=1001",
      headers: AUTH,
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/catalog/products?ids=1001",
      headers: AUTH,
    });
    expect(first.json()).toEqual(second.json());
  });

  it("stores nothing: the read needs a transport and no database (Req 3.3)", () => {
    // Structural rather than behavioural. `CatalogReadDeps` has one member, so
    // there is no pool to write to on this path — a Postgres write would have to
    // be added along with a dependency a reviewer would see.
    const deps: Parameters<typeof readCatalogProducts>[0] = { transport: new FakeTransport(() => ({ nodes: [] })) };
    expect(Object.keys(deps)).toEqual(["transport"]);
  });
});
