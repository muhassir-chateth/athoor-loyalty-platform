/**
 * The two-customer portal harness (spec task 16, design §4.5/§4.6).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NEW ──────────────────────────────────────
 * Task 16's four properties are all statements about RESPONSES across EVERY `/v1`
 * endpoint. Two multi-endpoint sweeps already exist — `routeCensus.contract.test.ts`
 * and `logCapture.gate.test.ts` — and neither can serve them, for the same reason:
 * both wire every dependency as a THROWING proxy, because both assert negative
 * outcomes (401, or "no leak in the log"). Neither app can return `200`.
 *
 * Property 1 ("no response contains another customer's data") is vacuous against an
 * app that answers 401 to everything. So this harness wires every portal dependency
 * as a WORKING per-customer fake, and can authenticate EITHER of two customers —
 * which no existing file does either (`wishlistIdor` seeds B's rows directly and its
 * signer hard-codes A's Shopify id).
 *
 * ── IT IS TEST SUPPORT, AND MUST NEVER BE IMPORTED BY PRODUCTION ────────────
 * `vitest` collects only `*.test.ts`, so this file is not a suite. `tsconfig`
 * includes it, so it IS typechecked — which is deliberate: a harness with a type
 * error would otherwise fail at test time with a confusing message rather than at
 * build time with a clear one. `harnessBoundary.test.ts` asserts no production
 * module imports it, so the fakes cannot reach a deployed build.
 *
 * ── EVERY FAKE IS KEYED BY CUSTOMER, WHICH IS THE WHOLE POINT ───────────────
 * A fake that returned the same data regardless of the caller would make Property 1
 * pass by construction and prove nothing. So each store is a `Map` keyed on the
 * local customer id, both customers are populated with DISTINCT, RECOGNISABLE
 * marker values, and a leak is therefore observable as a substring of B's markers in
 * a response to A.
 *
 * SAFETY: in-memory only. No network, no database, no Shopify, no production. Every
 * value is a fixture; no real customer data appears anywhere in this file.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildApp, type AppDependencies } from "../app.js";
import { loadConfig } from "../config.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { CustomerScope } from "../auth/customerScope.js";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";

/* ========================================================================== *
 * The two customers
 * ========================================================================== */

/** The authenticated caller in every sweep. */
export const A = Object.freeze({
  shopifyId: "111111111",
  localId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  bearer: "bearer-token-for-a",
  /** Appears in every value belonging to A, so presence is checkable. */
  marker: "AAMARKERAA",
});

/**
 * The victim. Never the caller, except in the tests that authenticate as B to prove
 * the harness itself is not simply returning A's data to everyone.
 *
 * Markers use a DISJOINT alphabet from A's. Task 15 learned this the hard way: two
 * merely-distinct markers can be substrings of one another, and the leak assertion
 * then fails for a reason that is not a leak.
 */
export const B = Object.freeze({
  shopifyId: "222222222",
  localId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  bearer: "bearer-token-for-b",
  marker: "ZZVICTIMZZ",
});

/** Every value belonging to B that must never appear in a response to A. */
/**
 * Values that are genuinely PRIVATE to B.
 *
 * ── PRODUCT IDS ARE DELIBERATELY NOT HERE ───────────────────────────────────
 * They were, and the first run of Property 2 duly "found a leak": `PUT
 * /v1/profile/wishlist/9990001` echoed the product id it had been asked to set. That
 * is not a leak. Products are GLOBAL data — §12.3 and the N4 catalogue route both
 * treat them as such, and two customers may legitimately wishlist the same bottle.
 * Listing a product id as B's secret asserted something false, and would have
 * pressured a correct handler to stop echoing its own input.
 *
 * What IS private is B's wishlist MEMBERSHIP, and that is asserted by the marker
 * fields plus the snapshot-invariance properties, not by a substring search for a
 * product id.
 */
export const B_SECRETS: readonly string[] = Object.freeze([
  B.localId,
  B.shopifyId,
  B.marker,
  `${B.marker}@victim.invalid`,
  "BREF-ZZVICTIMZZ", // B's referral code — private to B
  "ZZ-VICTIM-DISCOUNT", // B's discount code — private to B
  "8880001", // B's order number — private to B
]);

export const APP_PROXY_SECRET = "app-proxy-shared-secret";

/* ========================================================================== *
 * Signing — parameterised by customer, which no existing helper is
 * ========================================================================== */

export interface SignOptions {
  /** Extra params INSIDE the signed payload — a legitimate client could send these. */
  readonly extraSigned?: Record<string, string>;
  /** Extra params appended AFTER signing — §4.5 row 2's "added after Shopify signed". */
  readonly extraUnsigned?: Record<string, string>;
  /** Override the timestamp, for staleness cases. */
  readonly timestamp?: string;
}

/**
 * A signed App Proxy URL for a named Shopify customer id.
 *
 * `shopifyId` is a parameter because §4.5 rows 3 and 4 turn on swapping it, and
 * because a two-customer sweep needs to authenticate as either.
 */
export function signedUrl(path: string, shopifyId: string, opts: SignOptions = {}): string {
  const params: QueryParams = {
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: shopifyId,
    path_prefix: "/apps/loyalty",
    // The auth layer enforces a +/-5 minute freshness window and fails closed when
    // the timestamp is absent, so a realistic fixture always carries one.
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    ...(opts.extraSigned ?? {}),
  };
  const signed = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(signed)) {
    if (typeof value === "string") search.set(key, value);
  }
  for (const [key, value] of Object.entries(opts.extraUnsigned ?? {})) {
    search.append(key, value);
  }
  return `${path}?${search.toString()}`;
}

/** A signature computed over DIFFERENT params than those sent (§4.5 row 4). */
export function tamperedUrl(path: string, fromShopifyId: string, toShopifyId: string): string {
  return signedUrl(path, fromShopifyId).replace(
    `logged_in_customer_id=${fromShopifyId}`,
    `logged_in_customer_id=${toShopifyId}`,
  );
}

/** A genuinely signed request whose customer is anonymous (§4.5 row 3's cousin). */
export function anonymousSignedUrl(path: string): string {
  return signedUrl(path, "0");
}

/** The bearer header for a customer, the other authenticated route into `/v1`. */
export function bearer(customer: typeof A | typeof B): Record<string, string> {
  return { authorization: `Bearer ${customer.bearer}` };
}

/* ========================================================================== *
 * The per-customer fake database
 * ========================================================================== */

/**
 * A `Queryable` covering every table the portal routes read, keyed by customer.
 *
 * Dispatches on SQL text and THROWS on an unrecognised statement rather than
 * returning an empty result — task 9.1's prefix trap caught three doubles that
 * silently matched the wrong table, and an empty result would make a leak test pass
 * by returning nothing at all.
 */
export class HarnessDb implements Queryable {
  readonly statements: string[] = [];

  /** `customerId` → declared preference rows. */
  readonly preferences = new Map<string, { dimension: string; value: string }[]>();
  readonly communication = new Map<
    string,
    {
      product_launches: boolean;
      restock_alerts: boolean;
      birthday_messages: boolean;
      referral_updates: boolean;
    }
  >();
  readonly birthdays = new Map<string, { month: number; day: number; changedAt: Date | null }>();
  readonly grants = new Set<string>();
  readonly wishlist = new Map<string, string[]>();
  readonly favourites = new Map<string, string[]>();
  readonly recentlyViewed = new Map<string, { productId: string; viewedAt: string }[]>();
  readonly visits = new Map<string, { first: string; last: string }>();
  readonly erasure = new Map<
    string,
    { id: string; requested_at: string; status: string; completed_at: string | null; source: string }[]
  >();
  readonly referral = new Map<string, Record<string, unknown>>();

  /**
   * A deterministic serialisation of every stored collection.
   *
   * For "nothing was written" assertions. Keys are sorted so two snapshots of the
   * same content compare equal regardless of insertion order — otherwise a test
   * could fail merely because a Map was rebuilt in a different sequence.
   */
  snapshot(): string {
    const collections: Record<string, unknown> = {
      preferences: this.preferences,
      communication: this.communication,
      birthdays: this.birthdays,
      grants: [...this.grants].sort(),
      wishlist: this.wishlist,
      favourites: this.favourites,
      recentlyViewed: this.recentlyViewed,
      visits: this.visits,
      erasure: this.erasure,
      referral: this.referral,
    };
    const flat: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(collections)) {
      flat[name] =
        value instanceof Map
          ? Object.fromEntries([...value.entries()].sort(([a], [b]) => a.localeCompare(b)))
          : value;
    }
    return JSON.stringify(flat);
  }

  seed(): this {
    for (const [c, n] of [
      [A, 1] as const,
      [B, 9990] as const,
    ]) {
      const id = c.localId;
      this.preferences.set(id, [
        { dimension: "scent_family", value: c === A ? "oud" : "floral" },
        { dimension: "intensity", value: c === A ? "bold" : "subtle" },
      ]);
      this.communication.set(id, {
        product_launches: c === A,
        restock_alerts: false,
        birthday_messages: true,
        referral_updates: true,
      });
      this.birthdays.set(id, { month: c === A ? 6 : 12, day: c === A ? 10 : 25, changedAt: null });
      this.wishlist.set(id, [`${n}001`, `${n}002`]);
      this.favourites.set(id, [`${n}001`]);
      this.recentlyViewed.set(id, [
        { productId: `${n}002`, viewedAt: "2026-06-01T00:00:00.000Z" },
      ]);
      this.visits.set(id, { first: "2026-01-01T00:00:00.000Z", last: "2026-08-01T00:00:00.000Z" });
      this.erasure.set(id, [
        {
          id: c === A ? "eeeeeeee-1111-4111-8111-eeeeeeeeeeee" : "ffffffff-2222-4222-8222-ffffffffffff",
          requested_at: "2026-07-01T00:00:00.000Z",
          status: "received",
          completed_at: null,
          source: "portal",
        },
      ]);
      this.referral.set(id, {
        referral_code: c === A ? `AREF-${c.marker}` : `BREF-${c.marker}`,
        was_referred: false,
        signup_rewards: 1,
        purchase_rewards: 0,
        signup_awarded: 1,
        signup_pending: 0,
        purchase_awarded: 0,
        purchase_pending: 0,
        signup_credited: "50",
        purchase_credited: "0",
        total_credited: "50",
      });
    }
    return this;
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    this.statements.push(q);
    const cid = String(values[0] ?? "");
    const ok = (rows: QueryResultRow[], n = rows.length): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: n,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    // Longest table name first throughout — `customer_wishlist_removals` contains
    // `customer_wishlist`.
    if (q.includes("customer_wishlist_removals")) return ok([]);
    if (q.startsWith("INSERT INTO customer_erasure_requests")) {
      const row = {
        id: "11111111-aaaa-4aaa-8aaa-111111111111",
        requested_at: "2026-08-27T12:00:00.000Z",
        status: "received",
        completed_at: null,
        source: String(values[1] ?? "portal"),
      };
      this.erasure.set(cid, [...(this.erasure.get(cid) ?? []), row]);
      return ok([row]);
    }
    if (q.includes("FROM customer_erasure_requests")) return ok(this.erasure.get(cid) ?? []);
    if (q.includes("FROM customer_fragrance_preferences")) return ok(this.preferences.get(cid) ?? []);
    if (q.startsWith("DELETE FROM customer_fragrance_preferences")) return ok([], 0);
    if (q.startsWith("INSERT INTO customer_fragrance_preferences")) return ok([], 1);
    if (q.includes("FROM customer_communication_preferences")) {
      const row = this.communication.get(cid);
      return ok(row ? [row] : []);
    }
    if (q.startsWith("INSERT INTO customer_communication_preferences")) return ok([], 1);
    if (q.startsWith("UPDATE customer_communication_preferences")) return ok([], 1);
    if (q.startsWith("INSERT INTO birthday_grants")) return ok([], 1);
    if (q.includes("FROM birthday_grants")) {
      return ok(this.grants.has(`${cid}|2026`) ? [{ one: 1 }] : []);
    }
    if (q.startsWith("INSERT INTO customer_birthdays")) return ok([], 0);
    if (q.startsWith("UPDATE customer_birthdays")) return ok([], 1);
    if (q.includes("FROM customer_birthdays")) {
      const row = this.birthdays.get(cid);
      return ok(row ? [{ birth_month: row.month, birth_day: row.day, changed_at: row.changedAt }] : []);
    }
    if (q.includes("FROM customer_recently_viewed")) {
      return ok(
        (this.recentlyViewed.get(cid) ?? []).map((r) => ({
          shopify_product_id: r.productId,
          viewed_at: r.viewedAt,
        })),
      );
    }
    if (q.includes("FROM portal_visits")) {
      const v = this.visits.get(cid);
      return ok(v ? [{ first_visited_at: v.first, last_visited_at: v.last }] : []);
    }
    if (q.includes("count(*)") && q.includes("customer_wishlist")) {
      return ok([{ item_count: String((this.wishlist.get(cid) ?? []).length) }]);
    }
    if (q.includes("FROM customer_wishlist")) {
      return ok((this.wishlist.get(cid) ?? []).map((p) => ({ shopify_product_id: p })));
    }
    if (q.startsWith("INSERT INTO customer_wishlist") || q.startsWith("DELETE FROM customer_wishlist")) {
      return ok([], 1);
    }
    if (q.includes("FROM customer_favourites")) {
      return ok((this.favourites.get(cid) ?? []).map((p) => ({ shopify_product_id: p })));
    }
    if (q.includes("FROM referrals") || q.includes("referral_code")) {
      const row = this.referral.get(cid);
      return ok(row ? [row] : []);
    }
    if (q.includes("shopify_customer_id")) {
      // The sanctioned lookup: local id → Shopify id.
      const shopifyId = cid === A.localId ? A.shopifyId : cid === B.localId ? B.shopifyId : null;
      return ok(shopifyId === null ? [] : [{ shopify_customer_id: shopifyId }]);
    }
    if (q.startsWith("SELECT id FROM customers")) return ok([{ id: cid }]);
    if (q.includes("FROM customers")) {
      return ok([{ id: cid, email: `${markerFor(cid)}@victim.invalid`, tier: "silver" }]);
    }
    // Ledger-family reads answer EMPTY rather than throwing. The referral claim path
    // runs the real engine, and an empty ledger sends it down its not-eligible branch
    // — a 4xx, which is what these sweeps need. Throwing here would surface as a 500
    // and make "never 5xx" unassertable on that route.
    if (/ledger_entries|point_lots|redemptions|referrals|discount_codes|idempotency_keys/i.test(q)) {
      return ok([], 0);
    }
    throw new Error(`HarnessDb: unrecognised statement: ${q.slice(0, 90)}`);
  }
}

/* ========================================================================== *
 * Per-customer fixtures for the non-database sources
 * ========================================================================== */

function markerFor(customerId: string): string {
  return customerId === A.localId ? A.marker : customerId === B.localId ? B.marker : "UNKNOWN";
}

function productBase(customerId: string): string {
  return customerId === A.localId ? "1" : "9990";
}

function orderNumber(customerId: string): string {
  return customerId === A.localId ? "7770001" : "8880001";
}
/**
 * Whether an `addressId` GID names THIS customer's one address.
 *
 * Compares the final path segment exactly rather than with `endsWith`, so
 * `.../21` is not read as owning `.../1`.
 */
function ownsAddress(customerId: string, addressId: unknown): boolean {
  return (String(addressId).split("/").pop() ?? "") === productBase(customerId);
}

/** Every dependency `buildApp` accepts, wired as a working per-customer fake. */
/**
 * A deliberately huge allowance, applied to every per-route limiter.
 *
 * ── WHY THE SWEEPS MUST NOT BE RATE LIMITED ─────────────────────────────────
 * `GET /v1/profile/export` is 1 per hour and `POST /v1/profile/erasure-request` is 1
 * per day. A property that sends a baseline request and then a variant hits the limit
 * on the second call and gets a `429` — which fails the assertion for a reason that
 * has nothing to do with the property. Task 12 hit exactly this with the birthday
 * limiter and the fix is the same: the properties here are about identity resolution,
 * isolation and response shape, and each limiter's own behaviour is asserted in its
 * own route test.
 */
const PERMISSIVE = { maxRequests: 100_000 } as const;

/**
 * Every route limiter's configuration.
 *
 * Permissive by default because a sweep hits every endpoint many times and the real
 * limits are per-customer and deliberately small — the export route allows one an
 * hour and erasure one a day, so a property test would be cut short by a 429 that
 * has nothing to do with the property. Parameterised so a test that is ABOUT the
 * 429 can ask for a real limit instead (see `buildHarness`).
 */
export function harnessDependencies(
  db: HarnessDb,
  rateLimit: { maxRequests: number } = PERMISSIVE,
  failUpstream = false,
): AppDependencies {
  const shopifyTransport = {
    async request<T>(document: string, variables: Record<string, unknown>): Promise<T> {
      // OPT-IN UPSTREAM FAILURE, so a test can reach the `502 upstream_unavailable`
      // class. Without it every Shopify-backed route always succeeds here and the
      // 502 body — the one place Shopify's own text could leak into a response —
      // is never contract-checked.
      if (failUpstream) throw new Error("Shopify said: customer bob@example.com is invalid");
      const gid = String(variables.customerGid ?? "");
      const localId = gid.endsWith(A.shopifyId) ? A.localId : B.localId;
      const marker = markerFor(localId);
      if (document.startsWith("query portalCustomerIdentity")) {
        return {
          customer: {
            id: gid,
            firstName: marker,
            lastName: `${marker}-last`,
            email: `${marker}@victim.invalid`,
            phone: "+447700900000",
          },
        } as T;
      }
      if (document.startsWith("query portalCustomerAddresses")) {
        return {
          customer: {
            id: gid,
            defaultAddress: { id: `gid://shopify/MailingAddress/${productBase(localId)}` },
            addresses: [
              {
                id: `gid://shopify/MailingAddress/${productBase(localId)}`,
                firstName: marker,
                address1: `${marker} Street`,
                city: marker,
                zip: "N1 1AA",
                countryCodeV2: "GB",
              },
            ],
          },
        } as T;
      }
      if (document.startsWith("query portalCustomerConsent")) {
        return {
          customer: {
            id: gid,
            emailMarketingConsent: {
              marketingState: "SUBSCRIBED",
              consentUpdatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        } as T;
      }
      // Mutations: echo a plausible node with no userErrors.
      if (document.includes("customerUpdate(")) {
        return {
          customerUpdate: {
            customer: { id: gid, firstName: marker, lastName: null, email: null, phone: null },
            userErrors: [],
          },
        } as T;
      }
      if (document.includes("customerAddressCreate(")) {
        return {
          customerAddressCreate: {
            address: { id: "gid://shopify/MailingAddress/5", address1: `${marker} New Rd` },
            userErrors: [],
          },
        } as T;
      }
      // The three by-id address mutations MODEL OWNERSHIP, because the contract
      // under test is a statement about a refusal. §13.5 and the `addresses.ts`
      // header say a foreign `addressId` "is rejected by Shopify and mapped to 404
      // with no address attribute in the body". A fake that echoes any id back with
      // `userErrors: []` asserts the opposite of the design, and every isolation
      // property over these routes would pass by never exercising the refusal.
      //
      // Shopify's refusal arrives as a `userError`, not as a 404 — the mutation
      // names OUR customer GID, so an address belonging to someone else is simply
      // not one of that customer's addresses and there is nothing to act on. The
      // shape is `{ field, message }` with no `code` (task 14 OQ-8, verified by
      // live introspection), which `assertNoPortalWriteErrors` turns into
      // `PortalWriteRejectedError` and the route turns into 404.
      const refusal = {
        userErrors: [{ field: ["addressId"], message: "Address does not exist." }],
      };
      if (document.includes("customerAddressUpdate(")) {
        if (!ownsAddress(localId, variables.addressId)) {
          return { customerAddressUpdate: { address: null, ...refusal } } as T;
        }
        return {
          customerAddressUpdate: {
            address: { id: String(variables.addressId), address1: `${marker} Rd` },
            userErrors: [],
          },
        } as T;
      }
      if (document.includes("customerAddressDelete(")) {
        if (!ownsAddress(localId, variables.addressId)) {
          return { customerAddressDelete: { deletedAddressId: null, ...refusal } } as T;
        }
        return {
          customerAddressDelete: { deletedAddressId: String(variables.addressId), userErrors: [] },
        } as T;
      }
      if (document.includes("customerUpdateDefaultAddress(")) {
        if (!ownsAddress(localId, variables.addressId)) {
          return { customerUpdateDefaultAddress: { customer: null, ...refusal } } as T;
        }
        return {
          customerUpdateDefaultAddress: {
            customer: { id: gid, defaultAddress: { id: String(variables.addressId) } },
            userErrors: [],
          },
        } as T;
      }
      if (document.includes("customerEmailMarketingConsentUpdate(")) {
        return {
          customerEmailMarketingConsentUpdate: {
            customer: {
              id: gid,
              emailMarketingConsent: {
                marketingState: "SUBSCRIBED",
                consentUpdatedAt: "2026-08-27T12:00:00.000Z",
              },
            },
            userErrors: [],
          },
        } as T;
      }
      throw new Error(`harness transport: unrecognised document ${document.slice(0, 50)}`);
    },
  };
  const lookup = {
    async findShopifyCustomerId(localCustomerId: string): Promise<string | null> {
      return localCustomerId === A.localId
        ? A.shopifyId
        : localCustomerId === B.localId
          ? B.shopifyId
          : null;
    },
  };
  const shopifySource = { transport: shopifyTransport, lookup };

  return {
    customerResolver: new InMemoryCustomerResolver({
      [A.shopifyId]: A.localId,
      [B.shopifyId]: B.localId,
    }),
    tokenVerifier: new FakeTokenVerifier({
      [A.bearer]: A.shopifyId,
      [B.bearer]: B.shopifyId,
    }),

    balanceSource: {
      async load(customerId: string) {
        return {
          spendableBalance: customerId === A.localId ? 275 : 99999,
          tier: customerId === A.localId ? "silver" : "gold",
          lifetimeSpendGBP: customerId === A.localId ? 450 : 12345,
        };
      },
    } as never,

    historySource: {
      async load(query: { customerId: string }) {
        const marker = markerFor(query.customerId);
        // `totalCount` (not `total`), a NUMERIC `orderReference`, and a real `Date` —
        // the shapes `RawHistoryPage`/`RawHistoryEntry` actually declare. Getting any
        // of the three wrong produced a 500, which would have made every sweep over
        // this route assert nothing.
        return {
          totalCount: 1,
          entries: [
            {
              id: `led-${marker}`,
              entryType: "earn_order" as const,
              reason: "paid_order",
              points: 50,
              createdAt: new Date("2026-06-01T00:00:00.000Z"),
              orderReference: Number(orderNumber(query.customerId)),
            },
          ],
        };
      },
    } as never,

    portalOrderSource: {
      async listOrders(scope: CustomerScope) {
        const marker = markerFor(scope.customerId);
        return {
          orders: [
            {
              orderId: orderNumber(scope.customerId),
              orderNumber: `#${orderNumber(scope.customerId)}`,
              processedAt: "2026-06-01T00:00:00.000Z",
              totalGBP: "184.00",
              status: "fulfilled",
              lineItems: [
                { title: `${marker} Oud`, quantity: 1, productId: `${productBase(scope.customerId)}001` },
              ],
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      async getOrder(scope: CustomerScope, orderReference: string) {
        // ONLY the caller's own order resolves. A foreign order reference is not
        // merely rejected — it is outside the customer's connection, so it is
        // unreachable (§4.5 row 6).
        if (orderReference !== orderNumber(scope.customerId)) return null;
        const marker = markerFor(scope.customerId);
        return {
          orderId: orderReference,
          orderNumber: `#${orderReference}`,
          processedAt: "2026-06-01T00:00:00.000Z",
          totalGBP: "184.00",
          status: "fulfilled",
          shippingAddress: { firstName: marker, address1: `${marker} Street`, city: marker },
          lineItems: [],
          fulfilments: [],
        };
      },
      // `planReorder`, NOT `reorderPlan`. The wrong name made the method invisible to
      // the route, which then answered 502 `upstream_unavailable` — indistinguishable
      // from Shopify being down, and it would have made every sweep over this route
      // assert nothing.
      async planReorder(scope: CustomerScope, orderReference: string) {
        if (orderReference !== orderNumber(scope.customerId)) return null;
        return { addable: [], unavailable: [] };
      },
    } as never,

    portalCatalogSource: {
      async listProducts(ids: readonly string[]) {
        return {
          products: ids.map((productId) => ({
            productId,
            title: "Catalogue Product",
            handle: "catalogue-product",
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
    } as never,

    wishlistStore: {
      async read(scope: CustomerScope) {
        return db.wishlist.get(scope.customerId) ?? [];
      },
      async count(scope: CustomerScope) {
        return (db.wishlist.get(scope.customerId) ?? []).length;
      },
      async set() {
        return true;
      },
    } as never,

    redemptionSource: {
      async list(scope: CustomerScope) {
        const marker = markerFor(scope.customerId);
        return {
          redemptions: [
            {
              redemptionId: `red-${marker}`,
              rewardId: "reward_5",
              pointsSpent: 100,
              valueGBP: "5.00",
              status: "issued",
              discountCode: scope.customerId === A.localId ? "AA-DISCOUNT" : "ZZ-VICTIM-DISCOUNT",
              createdAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        };
      },
    } as never,

    birthdayDeps: {
      db,
      clock: { now: () => new Date("2026-06-12T12:00:00.000Z") },
      birthdayRateLimit: rateLimit,
    },
    preferencesDeps: {
      db,
      transactor: { transaction: (fn) => fn(db) },
      preferencesRateLimit: rateLimit,
    },
    identityDeps: {
      deps: shopifySource,
      identityRateLimit: rateLimit,
      consentRateLimit: rateLimit,
    },
    addressDeps: { deps: shopifySource, addressRateLimit: rateLimit },
    privacyDeps: {
      db,
      clock: { now: () => new Date("2026-08-27T12:34:56.000Z") },
      exportRateLimit: rateLimit,
      erasureRateLimit: rateLimit,
      exportReaders: Object.fromEntries(
        [
          "identity",
          "addresses",
          "consent",
          "balance",
          "ledger",
          "redemptions",
          "referral",
          "wishlist",
          "favourites",
          "recentlyViewed",
          "preferences",
          "birthday",
          "portalVisits",
          "erasureRequests",
        ].map((section) => [
          section,
          async (scope: CustomerScope) => ({ section, owner: markerFor(scope.customerId) }),
        ]),
      ) as never,
    },

    fragranceProfileDataSource: {
      async getPurchasedFragrances(customerId: string) {
        return [
          {
            productId: `${productBase(customerId)}001`,
            title: `${markerFor(customerId)} Oud`,
            firstPurchasedAt: "2026-01-01T00:00:00.000Z",
            lastPurchasedAt: "2026-01-01T00:00:00.000Z",
            purchaseCount: 1,
          },
        ];
      },
      async getFavourites(customerId: string) {
        return (db.favourites.get(customerId) ?? []).map((productId) => ({
          productId,
          addedAt: null,
        }));
      },
      async getWishlist(customerId: string) {
        return db.wishlist.get(customerId) ?? [];
      },
      async getRecentlyViewed(customerId: string) {
        return db.recentlyViewed.get(customerId) ?? [];
      },
      async getSuggestions(customerId: string) {
        return [`${productBase(customerId)}003`];
      },
      async getTierChanges() {
        return [];
      },
    } as never,

    portalVisitRecorder: {
      async record() {
        return { firstVisit: false };
      },
    } as never,

    preferenceStore: {
      async setFavourite() {},
      async listFavourites(customerId: string) {
        return db.favourites.get(customerId) ?? [];
      },
      async getWishlist(customerId: string) {
        return db.wishlist.get(customerId) ?? [];
      },
      async reconcileWishlist(customerId: string) {
        return db.wishlist.get(customerId) ?? [];
      },
    } as never,

    recentlyViewedRecorder: { async recordView() {} } as never,

    deviceTokenStore: {
      async register() {},
      async deregister() {
        return true;
      },
    } as never,

    // A REAL `LedgerRepository` over the harness db, because the claim path in
    // `POST /v1/referral` runs the ledger engine and an empty object produced a 500.
    // The db answers ledger reads with empty sets, so a claim takes its
    // not-eligible / already-claimed branch and returns a 4xx — a legitimate outcome
    // for these sweeps, and one that keeps "never 5xx" assertable.
    // Wired so `POST /v1/redeem` is not a 501 `not_implemented`. The real engine over
    // the harness db finds no point lots, so a redemption takes its insufficient-points
    // branch and returns a 4xx — which is what these sweeps need, and is a truthful
    // outcome rather than a stubbed success.
    redeemDeps: {
      repo: new LedgerRepository(db),
      transactor: { transaction: (fn: (tx: Queryable) => unknown) => fn(db) } as never,
      enqueuer: { async enqueue() {} } as never,
    } as never,

    referralDeps: {
      repo: new LedgerRepository(db),
      transactor: { transaction: (fn: (tx: Queryable) => unknown) => fn(db) } as never,
      db,
      shareDomain: "myathoorlondon.myshopify.com",
      referralRateLimit: rateLimit,
    } as never,

    entitlementResolver: {
      async resolveBenefits(customerId: string) {
        return [{ key: "perk", label: `${markerFor(customerId)} perk`, tier: "silver" }];
      },
      async qualifies() {
        return true;
      },
      async requestBenefit(customerId: string) {
        return { id: `ben-${markerFor(customerId)}`, status: "requested" };
      },
    } as never,

    membershipCredentialService: {
      async issueCredential(customerId: string) {
        return { signedMemberId: `signed-${markerFor(customerId)}`, tier: "silver" };
      },
      async verifyCredential() {
        return { valid: false };
      },
    } as never,
  };
}

/* ========================================================================== *
 * Building the app, and enumerating what it registered
 * ========================================================================== */

/** One registered route. */
export interface HarnessRoute {
  readonly method: string;
  readonly url: string;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: HarnessDb;
  readonly routes: readonly HarnessRoute[];
}

/**
 * Builds the fully-wired app and enumerates its routes.
 *
 * The `onRoute` hook is installed on the instance BEFORE `ready()`, which is what
 * makes the enumeration see fully-prefixed URLs — `buildApp` registers the `/v1`
 * router via `app.register`, deferred until `ready()`. Reading `printRoutes()`
 * instead was tried by `routeCensus.contract.test.ts` and rejected: it produces a
 * nested tree with relative children.
 *
 * Enumerating rather than listing is what makes every sweep in task 16 cover
 * endpoints ADDED LATER, which is the property §4.6 actually wants.
 */
export async function buildHarness(
  overrides: AppDependencies = {},
  opts: { rateLimit?: { maxRequests: number }; failUpstream?: boolean } = {},
): Promise<Harness> {
  const db = new HarnessDb().seed();
  const config = loadConfig({
    NODE_ENV: "test",
    SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET,
  });
  const app = buildApp(config, {
    ...harnessDependencies(db, opts.rateLimit ?? PERMISSIVE, opts.failUpstream ?? false),
    ...overrides,
  });
  const routes: HarnessRoute[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const method of methods) routes.push({ method, url: r.url });
  });
  await app.ready();
  return { app, db, routes };
}

/** Routes that carry no customer data and are therefore outside these properties. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "/v1/version",
  "/v1/rewards",
  "/v1/membership-card/verify",
]);

export const ADMIN_PREFIX = "/v1/admin/";

/** Methods that carry a body. */
export const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/**
 * The `/v1` routes these properties apply to.
 *
 * Excludes `HEAD`/`OPTIONS` (Fastify derives HEAD from GET and neither has a body to
 * assert), the public routes, and `/v1/admin/**` — which has its own credential
 * scheme and is not a portal surface.
 */
export function portalRoutes(routes: readonly HarnessRoute[]): readonly HarnessRoute[] {
  return routes.filter(
    (r) =>
      r.url.startsWith("/v1") &&
      r.method !== "HEAD" &&
      r.method !== "OPTIONS" &&
      !r.url.startsWith(ADMIN_PREFIX) &&
      !PUBLIC_ROUTES.has(r.url),
  );
}

/**
 * Substitutes a concrete value for each path parameter, for a given customer.
 *
 * Parameterised by customer because a sweep needs A's own order id when
 * authenticating as A, and B's when probing a foreign one.
 */
export function concretise(url: string, customer: typeof A | typeof B): string {
  const values: Record<string, string> = {
    ":orderId": orderNumber(customer.localId),
    ":productId": `${productBase(customer.localId)}001`,
    ":addressId": productBase(customer.localId),
    ":token": `device-token-${customer.marker}`,
    ":customerId": customer.localId,
    ":id": `${productBase(customer.localId)}001`,
    ":key": "perk",
  };
  return url
    .split("/")
    .map((seg) => (seg.startsWith(":") ? (values[seg] ?? "x") : seg))
    .join("/");
}

/** A body appropriate to each write route, so a sweep exercises the handler. */
export function bodyFor(url: string): Record<string, unknown> {
  if (url.endsWith("/wishlist/reconcile")) return { deviceLocal: ["1001"] };
  if (url.includes("/wishlist/")) return { on: true };
  if (url.endsWith("/profile/preferences")) return { declared: { scent_family: ["oud"] } };
  if (url.endsWith("/profile/birthday")) return { month: 6, day: 10 };
  if (url.endsWith("/profile/identity")) return { firstName: "Amina" };
  if (url.endsWith("/profile/consent")) return { emailMarketing: true };
  if (url.includes("/profile/addresses")) return { address1: "1 Test St", countryCode: "GB" };
  if (url.endsWith("/profile/recently-viewed")) return { productId: "1001" };
  if (url.endsWith("/devices")) return { token: "device-token-new", platform: "ios" };
  if (url.endsWith("/redeem")) return { rewardId: "reward_5" };
  if (url.endsWith("/referral")) return { referralCode: "SOMECODE" };
  return {};
}

/** An idempotency key, required by the `/v1`-wide plugin on state-changing methods. */
let keyCounter = 0;
export function idempotencyKey(): string {
  keyCounter += 1;
  return `harness-${keyCounter}-${Math.random().toString(36).slice(2)}`;
}
