/**
 * `GET /v1/profile` keeps every shipped field and GAINS `inferred` — task 13.3,
 * §12.8, Req 12.3, 12.4, 12.8, 20.6, 4.9.
 *
 * ── WHY THIS FILE IS SEPARATE FROM profile.test.ts ─────────────────────────
 * `profile.test.ts` asserts what the endpoint has always returned. This file
 * asserts that the addition did not disturb it. Keeping them apart means a future
 * edit that breaks backward compatibility fails a test whose NAME says so, rather
 * than one that looks like it is about personalisation.
 *
 * SAFETY: no network, no production, no live Postgres or Shopify.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import { staticProductTaxonomy, type ProductTaxonomy } from "../profile/inferred.js";
import type {
  FavouriteRecord,
  FragranceProfileDataSource,
  PurchasedFragrance,
  RecentlyViewedRecord,
  TierChangeRecord,
} from "../profile/fragranceProfile.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };

/** The seven fields `GET /v1/profile` has always returned (Req 20.6). */
const SHIPPED_FIELDS = [
  "customerId",
  "favourites",
  "journey",
  "purchasedFragrances",
  "recentlyViewed",
  "suggestions",
  "wishlist",
] as const;

interface Activity {
  purchased?: PurchasedFragrance[];
  favourites?: string[];
  wishlist?: string[];
  recentlyViewed?: RecentlyViewedRecord[];
}

/** A data source that returns exactly the activity given, for one customer. */
function source(activity: Activity): FragranceProfileDataSource {
  return {
    async getPurchasedFragrances(): Promise<readonly PurchasedFragrance[]> {
      return activity.purchased ?? [];
    },
    async getFavourites(): Promise<readonly FavouriteRecord[]> {
      return (activity.favourites ?? []).map((productId) => ({ productId, addedAt: null }));
    },
    async getWishlist(): Promise<readonly string[]> {
      return activity.wishlist ?? [];
    },
    async getRecentlyViewed(): Promise<readonly RecentlyViewedRecord[]> {
      return activity.recentlyViewed ?? [];
    },
    async getSuggestions(): Promise<readonly string[]> {
      return ["suggested-1"];
    },
    async getTierChanges(): Promise<readonly TierChangeRecord[]> {
      return [];
    },
  };
}

function purchase(productId: string, at: string | null): PurchasedFragrance {
  return {
    productId,
    title: `Title ${productId}`,
    firstPurchasedAt: at,
    lastPurchasedAt: at,
    purchaseCount: 1,
  };
}

const TAXONOMY: ProductTaxonomy = staticProductTaxonomy({
  p1: { families: ["oud"], notes: ["saffron"] },
  p2: { families: ["oud"], notes: ["rose"] },
  p3: { families: ["woody"], notes: ["saffron"] },
});

function buildApp(activity: Activity, taxonomy?: ProductTaxonomy): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    fragranceProfileDataSource: source(activity),
    ...(taxonomy === undefined ? {} : { productTaxonomy: taxonomy }),
  });
  return app;
}

async function read(app: FastifyInstance): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: "GET", url: "/v1/profile", headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("GET /v1/profile remains backward compatible (Req 20.6)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("still returns every shipped field, with its original shape", async () => {
    app = buildApp({
      purchased: [purchase("p1", "2026-01-05T10:00:00.000Z")],
      favourites: ["p2"],
      wishlist: ["p3"],
      recentlyViewed: [{ productId: "p1", viewedAt: "2026-06-01T00:00:00.000Z" }],
    });
    await app.ready();
    const body = await read(app);
    for (const field of SHIPPED_FIELDS) {
      expect(body, field).toHaveProperty(field);
    }
    expect(body.customerId).toBe(CUSTOMER);
    expect(Array.isArray(body.purchasedFragrances)).toBe(true);
    expect(body.favourites).toEqual(["p2"]);
    expect(body.wishlist).toEqual(["p3"]);
    expect(body.suggestions).toEqual(["suggested-1"]);
    expect(Array.isArray(body.journey)).toBe(true);
    expect(body.recentlyViewed).toEqual([
      { productId: "p1", viewedAt: "2026-06-01T00:00:00.000Z" },
    ]);
  });

  it("adds EXACTLY ONE key — `inferred` — and removes none", async () => {
    app = buildApp({ wishlist: ["p1"] });
    await app.ready();
    const body = await read(app);
    // `apiVersion` is the versioning plugin's (Req 9.8), present before this task.
    const expected = [...SHIPPED_FIELDS, "apiVersion", "inferred"].sort();
    expect(Object.keys(body).sort()).toEqual(expected);
  });

  it("keeps `suggestions` untouched — `inferred` sits ALONGSIDE it, not over it", async () => {
    // §12.8: "gains an additive `inferred` block alongside the existing
    // `suggestions`". The two are different things: suggestions are products,
    // inferred is families and notes.
    app = buildApp({ purchased: [purchase("p1", null)] }, TAXONOMY);
    await app.ready();
    const body = await read(app);
    expect(body.suggestions).toEqual(["suggested-1"]);
    expect(body.inferred).not.toEqual(body.suggestions);
  });

  it("still returns 200 with empty categories for a customer with no data (Req 17.9)", async () => {
    app = buildApp({});
    await app.ready();
    const body = await read(app);
    expect(body.purchasedFragrances).toEqual([]);
    expect(body.favourites).toEqual([]);
    expect(body.wishlist).toEqual([]);
    // And `inferred` is present and empty rather than absent (Req 12.7).
    expect(body.inferred).toEqual({
      basis: [],
      scent_family: [],
      note: [],
      season: null,
      occasion: null,
      insight: null,
    });
  });

  it("requires an identity", async () => {
    app = buildApp({ wishlist: ["p1"] });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/profile" })).statusCode).toBe(401);
  });
});

describe("the inferred block is derived from the customer's own activity (§12.3)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("ranks families from purchases, wishlist, favourites and views together", async () => {
    app = buildApp(
      {
        purchased: [purchase("p1", "2026-01-05T10:00:00.000Z")],
        wishlist: ["p2"],
        favourites: ["p3"],
      },
      TAXONOMY,
    );
    await app.ready();
    const inferred = (await read(app)).inferred as Record<string, unknown>;
    expect(inferred.scent_family).toEqual([
      { value: "oud", distinctProducts: 2 },
      { value: "woody", distinctProducts: 1 },
    ]);
    expect(inferred.note).toEqual([
      { value: "saffron", distinctProducts: 2 },
      { value: "rose", distinctProducts: 1 },
    ]);
  });

  it("reports the basis as an identifier list naming only what contributed", async () => {
    app = buildApp({ purchased: [purchase("p1", null)], wishlist: ["p2"] }, TAXONOMY);
    await app.ready();
    const inferred = (await read(app)).inferred as { basis: string[] };
    expect(inferred.basis).toEqual(["orders", "wishlist"]);
    for (const name of inferred.basis) expect(name).toMatch(/^[a-z][a-z_]*$/);
  });

  it("emits the Req 4.9 insight once a family has two distinct products", async () => {
    app = buildApp({ purchased: [purchase("p1", null), purchase("p2", null)] }, TAXONOMY);
    await app.ready();
    const inferred = (await read(app)).inferred as Record<string, unknown>;
    expect(inferred.insight).toEqual({
      kind: "family_concentration",
      value: "oud",
      distinctProducts: 2,
    });
  });

  it("withholds the season leaning below three distinct purchase instants", async () => {
    app = buildApp(
      {
        purchased: [
          purchase("p1", "2026-06-01T00:00:00.000Z"),
          purchase("p2", "2026-06-01T00:00:00.000Z"),
        ],
      },
      TAXONOMY,
    );
    await app.ready();
    // Two products bought in ONE order share an instant, so this is one order —
    // the conservative lower bound withholds rather than asserts.
    expect((await read(app)).inferred).toMatchObject({ season: null });
  });

  it("presents the season leaning at three distinct purchase instants", async () => {
    app = buildApp(
      {
        purchased: [
          purchase("p1", "2026-06-01T00:00:00.000Z"),
          purchase("p2", "2026-07-02T00:00:00.000Z"),
          purchase("p3", "2026-08-03T00:00:00.000Z"),
        ],
      },
      TAXONOMY,
    );
    await app.ready();
    expect((await read(app)).inferred).toMatchObject({
      season: { value: "summer", distinctProducts: 3 },
    });
  });

  it("is DETERMINISTIC across two identical requests (Req 12.4, Property 8)", async () => {
    app = buildApp(
      {
        purchased: [purchase("p3", "2026-02-01T00:00:00.000Z"), purchase("p1", null)],
        wishlist: ["p2"],
        recentlyViewed: [{ productId: "p1", viewedAt: "2026-06-01T00:00:00.000Z" }],
      },
      TAXONOMY,
    );
    await app.ready();
    const first = await app.inject({ method: "GET", url: "/v1/profile", headers: AUTH });
    const second = await app.inject({ method: "GET", url: "/v1/profile", headers: AUTH });
    // Byte-identical, over the wire, not merely deep-equal in memory.
    expect(second.body).toBe(first.body);
  });

  it("never infers intensity (§12.3 rule 3)", async () => {
    app = buildApp({ purchased: [purchase("p1", null), purchase("p2", null)] }, TAXONOMY);
    await app.ready();
    expect((await read(app)).inferred).not.toHaveProperty("intensity");
  });

  it("concludes nothing when no taxonomy is wired, and still reports the basis", async () => {
    app = buildApp({ purchased: [purchase("p1", null)], wishlist: ["p2"] });
    await app.ready();
    const inferred = (await read(app)).inferred as Record<string, unknown>;
    expect(inferred.scent_family).toEqual([]);
    expect(inferred.insight).toBeNull();
    // The basis is still true: the customer did have orders and a wishlist.
    expect(inferred.basis).toEqual(["orders", "wishlist"]);
  });
});
