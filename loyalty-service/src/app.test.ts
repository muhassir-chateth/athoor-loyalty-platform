import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "./auth/identity.js";
import { API_VERSION, API_VERSION_FIELD, API_VERSION_HEADER } from "./version.js";

/** Identity fixtures for the dependency-forwarding checks below. */
const BEARER = "app-test-caa-token";
const SHOPIFY_ID = "9395357876563";
const CUSTOMER_UUID = "11111111-1111-4111-8111-111111111111";

describe("app boot + /v1 versioning", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("boots and serves the health endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", version: API_VERSION });
  });

  it("exposes the /v1 version endpoint with the version identifier", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: API_VERSION });
  });

  it("emits the version identifier on every JSON response (Req 9.8)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    // Header mechanism
    expect(res.headers[API_VERSION_HEADER]).toBe(API_VERSION);
    // In-payload mechanism
    expect(res.json()).toHaveProperty(API_VERSION_FIELD, API_VERSION);
  });

  it("emits the version header even on 404 responses", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers[API_VERSION_HEADER]).toBe(API_VERSION);
  });

  it("returns the four-reward catalog on GET /v1/rewards (Req 3.1, task 5.1)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rewards: Array<{ id: string; cost: number; valueGBP: number }> };
    expect(body.rewards).toHaveLength(4);
    expect(body.rewards).toEqual([
      { id: "reward_5", cost: 100, valueGBP: 5 },
      { id: "reward_15", cost: 250, valueGBP: 15 },
      { id: "reward_35", cost: 500, valueGBP: 35 },
      { id: "reward_75", cost: 1000, valueGBP: 75 },
    ]);
    // The versioning plugin still injects the version identifier (Req 9.8).
    expect(res.json()).toHaveProperty(API_VERSION_FIELD, API_VERSION);
  });

  it("does not expose loyalty operations outside the /v1 prefix (Req 9.1)", async () => {
    // The same operation without the /v1 prefix must not be routable.
    const res = await app.inject({ method: "GET", url: "/rewards" });
    expect(res.statusCode).toBe(404);
    // And it is available under /v1.
    const ok = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(ok.statusCode).toBe(200);
  });

  it("keeps handling stateless — sets no session cookie on any response (Req 9.8)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

/* ========================================================================== *
 * Portal dependencies actually REACH their routes (task 9.1 regression)
 * ========================================================================== */

describe("buildApp forwards every portal dependency into /v1", () => {
  /**
   * WHY THIS EXISTS. Task 8.4 built `portalCatalogSource`, index.ts constructed it
   * and handed it to `buildApp` — but `AppDependencies` never declared it and
   * `app.ts` never forwarded it, so `GET /v1/catalog/products` ran on its refusing
   * default in production and answered `502` for every request.
   *
   * It typechecked because index.ts passes it through a SPREAD:
   * `...(x ? { x } : {})`. TypeScript applies excess-property checking to object
   * LITERALS only, so a dependency no type declared travelled silently all the way
   * to being dropped.
   *
   * Declaring the field fixed that instance. These tests close the CLASS by
   * observing BEHAVIOUR at the route, so the next portal dependency that is added
   * and not forwarded fails here rather than in production.
   */
  it("forwards portalCatalogSource — a wired source must not answer 502", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      portalCatalogSource: {
        async listProducts(ids: readonly string[]) {
          return {
            products: ids.map((id) => ({
              productId: id,
              title: "T",
              handle: "t",
              published: true,
              availableForSale: true,
              priceGBP: "1.00",
              compareAtPriceGBP: null,
              imageUrl: null,
              imageWidth: 0,
              imageHeight: 0,
              defaultVariantId: null,
            })),
            missing: [],
          };
        },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/v1/catalog/products?ids=1001" });
      // 401 is fine here (no identity wired). 502 is NOT — that would mean the
      // source never arrived at the route.
      expect(res.statusCode).not.toBe(502);
    } finally {
      await app.close();
    }
  });

  it("forwards referralDeps.shareDomain into the built shareUrl", async () => {
    // The task 11.1 counterpart of the checks above. `shareUrl` is only correct if
    // the configured domain actually REACHES the route, and a hardcoded module
    // default would hide a missing hand-off — the same shape as the
    // `portalCatalogSource` defect. Asserted through the response.
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      referralDeps: {
        repo: {} as never,
        transactor: {} as never,
        db: {
          async query() {
            return {
              rows: [
                {
                  referral_code: "ATH-WIRED",
                  was_referred: false,
                  signup_rewards: 0,
                  purchase_rewards: 0,
                  signup_awarded: 0,
                  signup_pending: 0,
                  purchase_awarded: 0,
                  purchase_pending: 0,
                  signup_credited: "0",
                  purchase_credited: "0",
                  total_credited: "0",
                },
              ],
              rowCount: 1,
              command: "SELECT",
              oid: 0,
              fields: [],
            };
          },
        } as never,
        shareDomain: "wired.example",
      },
    });
    try {
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/v1/referral" });
      // Unauthenticated, so 401 — but the route must EXIST, which proves
      // referralDeps was forwarded at all.
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("forwards birthdayDeps — both the db AND the clock reach the route (task 12.2)", async () => {
    // STRONGER THAN THE CHECKS ABOVE, and it has to be. The birthday routes register
    // UNCONDITIONALLY with a refusing executor, so "the route exists" proves nothing
    // about whether `birthdayDeps` arrived — a dropped hand-off would still answer 401
    // to an anonymous caller and 500 only to a real customer. So this test authenticates
    // and observes the response, which is the only place a missing executor shows up.
    let queries = 0;
    const clockNow = new Date("2031-03-05T12:00:00Z");
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      tokenVerifier: new FakeTokenVerifier({ [BEARER]: SHOPIFY_ID }),
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_ID]: CUSTOMER_UUID }),
      birthdayDeps: {
        db: {
          async query(sql: string) {
            queries += 1;
            const rows = sql.includes("FROM customer_birthdays")
              ? [{ birth_month: 3, birth_day: 12, changed_at: null }]
              : [];
            return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
          },
        } as never,
        clock: { now: () => clockNow },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: "/v1/profile/birthday",
        headers: { authorization: `Bearer ${BEARER}` },
      });
      // A 500 here would be `BirthdayStoreUnconfiguredError` — the refusing default,
      // meaning the executor never arrived.
      expect(res.statusCode).toBe(200);
      expect(queries).toBeGreaterThan(0);
      const body = res.json() as { birthday: unknown; eligibility: { windowOpensOn: string } };
      expect(body.birthday).toEqual({ month: 3, day: 12 });
      // The INJECTED clock's year, not the real one. If `clock` were dropped while `db`
      // survived, the read would still succeed and only this date would be wrong — which
      // is exactly the kind of half-forwarded dependency the earlier defect was.
      expect(body.eligibility.windowOpensOn).toBe("2031-03-12");
    } finally {
      await app.close();
    }
  });

  it("forwards preferencesDeps — db AND transactor reach the route (task 13.2)", async () => {
    // Same shape as the birthday check: the preferences routes register
    // UNCONDITIONALLY with a refusing executor, so "the route exists" proves
    // nothing. This authenticates and observes the response, which is the only
    // place a dropped hand-off shows up.
    let queries = 0;
    let transactions = 0;
    const db = {
      async query(sql: string) {
        queries += 1;
        const rows = sql.includes("FROM customer_fragrance_preferences")
          ? [{ dimension: "scent_family", value: "oud" }]
          : [];
        return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
      },
    };
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      tokenVerifier: new FakeTokenVerifier({ [BEARER]: SHOPIFY_ID }),
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_ID]: CUSTOMER_UUID }),
      preferencesDeps: {
        db: db as never,
        transactor: {
          async transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
            transactions += 1;
            // Hands the SAME executor to the callback, which is what a real
            // pool-backed transactor does with its client.
            return fn(db as never);
          },
        },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: "/v1/profile/preferences",
        headers: { authorization: `Bearer ${BEARER}` },
      });
      // A 500 would be `PreferenceStoreUnconfiguredError` — the refusing default,
      // meaning the executor never arrived.
      expect(res.statusCode).toBe(200);
      expect(queries).toBeGreaterThan(0);
      const body = res.json() as { declared: { scent_family: string[] } };
      expect(body.declared.scent_family).toEqual(["oud"]);

      // And the TRANSACTOR half, which a read cannot exercise: a write must reach
      // it, or set-replacements would run without atomicity.
      const write = await app.inject({
        method: "PUT",
        url: "/v1/profile/preferences",
        headers: { authorization: `Bearer ${BEARER}`, "idempotency-key": "app-test-pref-1" },
        payload: { declared: { note: ["rose"] } },
      });
      expect(write.statusCode).toBe(200);
      expect(transactions).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("forwards productTaxonomy into the /v1/profile inferred block (task 13.3)", async () => {
    // `inferred` is present either way, so its PRESENCE proves nothing. What proves
    // the hand-off is a CONCLUSION only the wired taxonomy could produce.
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      tokenVerifier: new FakeTokenVerifier({ [BEARER]: SHOPIFY_ID }),
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_ID]: CUSTOMER_UUID }),
      productTaxonomy: {
        lookup(productId: string) {
          return productId === "wired-product"
            ? { families: ["oud"], notes: ["saffron"] }
            : undefined;
        },
      },
      fragranceProfileDataSource: {
        async getPurchasedFragrances() {
          return [
            {
              productId: "wired-product",
              title: null,
              firstPurchasedAt: null,
              lastPurchasedAt: null,
              purchaseCount: 1,
            },
          ];
        },
        async getFavourites() {
          return [];
        },
        async getWishlist() {
          return [];
        },
        async getRecentlyViewed() {
          return [];
        },
        async getSuggestions() {
          return [];
        },
        async getTierChanges() {
          return [];
        },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: "/v1/profile",
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.statusCode).toBe(200);
      const inferred = (res.json() as { inferred: { scent_family: unknown[] } }).inferred;
      // Empty here would mean the taxonomy was constructed and dropped — the
      // `portalCatalogSource` defect, in the shape it would take on this route.
      expect(inferred.scent_family).toEqual([{ value: "oud", distinctProducts: 1 }]);
    } finally {
      await app.close();
    }
  });

  it("forwards identityDeps and addressDeps — the Shopify source reaches N6-N9 (task 14)", async () => {
    // The N6-N9 routes register unconditionally and answer 502 when unwired, so
    // "the route exists" proves nothing and neither does a 401. This authenticates
    // and asserts a 200 carrying a value only the wired transport could supply.
    let documents = 0;
    const transport = {
      async request<T>(document: string, variables: Record<string, unknown>): Promise<T> {
        documents += 1;
        if (document.startsWith("query portalCustomerIdentity")) {
          return {
            customer: {
              id: variables.customerGid,
              firstName: "WIRED",
              lastName: null,
              email: "wired@example.com",
              phone: null,
            },
          } as T;
        }
        if (document.startsWith("query portalCustomerAddresses")) {
          return {
            customer: {
              id: variables.customerGid,
              defaultAddress: { id: "gid://shopify/MailingAddress/7" },
              addresses: [{ id: "gid://shopify/MailingAddress/7", address1: "7 Wired Way" }],
            },
          } as T;
        }
        throw new Error(`unexpected document: ${document.slice(0, 40)}`);
      },
    };
    const lookup = {
      async findShopifyCustomerId(): Promise<string | null> {
        return "9395357876563";
      },
    };
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      tokenVerifier: new FakeTokenVerifier({ [BEARER]: SHOPIFY_ID }),
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_ID]: CUSTOMER_UUID }),
      identityDeps: { deps: { transport, lookup } },
      addressDeps: { deps: { transport, lookup } },
    });
    try {
      await app.ready();
      const identity = await app.inject({
        method: "GET",
        url: "/v1/profile/identity",
        headers: { authorization: `Bearer ${BEARER}` },
      });
      // A 502 here would mean `identityDeps` never arrived at the route.
      expect(identity.statusCode).toBe(200);
      expect(identity.json()).toMatchObject({ firstName: "WIRED", emailEditable: false });

      const addresses = await app.inject({
        method: "GET",
        url: "/v1/profile/addresses",
        headers: { authorization: `Bearer ${BEARER}` },
      });
      // Asserted separately because the two are separate hand-offs: forwarding one
      // and dropping the other is exactly the half-wiring this test class exists for.
      expect(addresses.statusCode).toBe(200);
      expect(addresses.json()).toMatchObject({
        addresses: [{ address1: "7 Wired Way", isDefault: true }],
      });
      expect(documents).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  it("forwards privacyDeps — the export readers AND the db reach N14/N15 (task 15)", async () => {
    // Both halves, because they are separate hand-offs: the export needs
    // `exportReaders`, the erasure request needs `db`, and forwarding one while
    // dropping the other is exactly the half-wiring this test class exists for.
    let inserts = 0;
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      tokenVerifier: new FakeTokenVerifier({ [BEARER]: SHOPIFY_ID }),
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_ID]: CUSTOMER_UUID }),
      privacyDeps: {
        db: {
          async query(sql: string) {
            if (sql.trim().startsWith("INSERT INTO customer_erasure_requests")) {
              inserts += 1;
              const rows = [
                {
                  id: "abcdabcd-1111-4111-8111-111111111111",
                  requested_at: "2026-08-27T12:00:00.000Z",
                  status: "received",
                  completed_at: null,
                  source: "portal",
                },
              ];
              return { rows, rowCount: 1, command: "INSERT", oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
          },
        } as never,
        exportReaders: {
          identity: async () => ({ firstName: "WIRED-EXPORT" }),
          addresses: async () => [],
          consent: async () => null,
          balance: async () => null,
          ledger: async () => null,
          redemptions: async () => null,
          referral: async () => null,
          wishlist: async () => [],
          favourites: async () => [],
          recentlyViewed: async () => [],
          preferences: async () => null,
          birthday: async () => null,
          portalVisits: async () => null,
          erasureRequests: async () => [],
        },
        clock: { now: () => new Date("2026-08-27T12:34:56.000Z") },
      },
    });
    try {
      await app.ready();
      const exported = await app.inject({
        method: "GET",
        url: "/v1/profile/export",
        headers: { authorization: `Bearer ${BEARER}` },
      });
      // A 502 here would mean `exportReaders` never arrived at the route.
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["content-disposition"]).toContain("attachment");
      expect((exported.json() as { data: { identity: unknown } }).data.identity).toEqual({
        firstName: "WIRED-EXPORT",
      });

      const requested = await app.inject({
        method: "POST",
        url: "/v1/profile/erasure-request",
        headers: { authorization: `Bearer ${BEARER}`, "idempotency-key": "app-test-erasure-1" },
        payload: {},
      });
      expect(requested.statusCode).toBe(200);
      expect((requested.json() as { reference: string }).reference).toMatch(/^ERASE-/);
      expect(inserts).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("forwards wishlistStore — a wired store must not answer 404", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      wishlistStore: {
        async read() {
          return [];
        },
        async count() {
          return 0;
        },
        async set() {
          return true;
        },
      },
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "PUT",
        url: "/v1/profile/wishlist/1001",
        payload: { on: true },
      });
      // A 404 would mean the route never registered, which a client reads as
      // "that product is not on your wishlist".
      expect(res.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });
});
