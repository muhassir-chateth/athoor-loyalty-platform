/**
 * N6–N9 route tests — tasks 14.2, 14.3, 14.4, 14.5; design §13.1–§13.6;
 * Req 5.1, 5.2, 5.3, 5.4, 5.5, 5.8, 13.3, 13.4, 13.5, 2.1, 2.2, 2.3, 2.7, 3.1,
 * 3.2, 21.7.
 *
 * SAFETY: no network, no production, no live Shopify. The fake transport answers
 * the six mutations and three reads locally and RECORDS every document and every
 * variable set it was given, so the tests can assert what would have been sent.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";
import type { ShopifyCustomerIdLookup } from "../shopify/purchaseHistory.js";
import { IDENTITY_BODY_SCHEMA, IDENTITY_RATE_LIMIT_MAX_REQUESTS } from "./identity.js";
import { ADDRESS_RATE_LIMIT_MAX_REQUESTS } from "./addresses.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const OTHER_SHOPIFY_ID = "5555555555555";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";
const AUTH = { authorization: `Bearer ${BEARER_TOKEN}` };
const OUR_GID = `gid://shopify/Customer/${SHOPIFY_CUSTOMER_ID}`;

let keyN = 0;
function keyed(): Record<string, string> {
  keyN += 1;
  return { ...AUTH, "idempotency-key": `id14-${keyN}-${Math.random().toString(36).slice(2)}` };
}

interface Recorded {
  document: string;
  variables: Record<string, unknown>;
}

/** One address as the fake holds it. */
interface FakeAddress {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
}

/**
 * A Shopify stand-in.
 *
 * Keyed by customer GID throughout, so a write that named the wrong customer would
 * land in the wrong bucket and the cross-customer tests would see it.
 */
class FakeShopify {
  readonly calls: Recorded[] = [];
  /** `userErrors` to return for the next mutation matching this operation name. */
  failWith: { operation: string; userErrors: { field?: string[]; message: string; code?: string }[] } | null =
    null;
  /** When set, the transport throws — an upstream fault rather than a refusal. */
  throwUpstream = false;

  identity = new Map<string, { firstName: string | null; lastName: string | null; email: string | null; phone: string | null }>([
    [OUR_GID, { firstName: "Amina", lastName: "Rahim", email: "amina@example.com", phone: "+447700900123" }],
    [
      `gid://shopify/Customer/${OTHER_SHOPIFY_ID}`,
      { firstName: "OTHER", lastName: "PERSON", email: "other@example.com", phone: "+447700900999" },
    ],
  ]);
  addresses = new Map<string, FakeAddress[]>([
    [OUR_GID, [{ id: "gid://shopify/MailingAddress/1", address1: "1 Ours St", city: "London", zip: "N1 1AA", countryCodeV2: "GB" }]],
    [
      `gid://shopify/Customer/${OTHER_SHOPIFY_ID}`,
      [{ id: "gid://shopify/MailingAddress/999", address1: "999 Theirs Rd", city: "Leeds", zip: "LS1 1AA", countryCodeV2: "GB" }],
    ],
  ]);
  defaultAddress = new Map<string, string | null>([[OUR_GID, "gid://shopify/MailingAddress/1"]]);
  consent = new Map<string, { marketingState: string; consentUpdatedAt: string }>([
    [OUR_GID, { marketingState: "UNSUBSCRIBED", consentUpdatedAt: "2026-01-01T00:00:00Z" }],
  ]);
  private nextId = 100;

  async request<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    this.calls.push({ document, variables });
    if (this.throwUpstream) throw new Error("upstream boom");

    const gid = String(variables.customerGid ?? "");
    const ue = (operation: string): { field?: string[]; message: string; code?: string }[] => {
      if (this.failWith !== null && document.includes(this.failWith.operation)) {
        const errs = this.failWith.userErrors;
        this.failWith = null;
        return errs;
      }
      void operation;
      return [];
    };

    /* ------------------------------- reads ------------------------------- */
    if (document.startsWith("query portalCustomerIdentity")) {
      const node = this.identity.get(gid);
      return { customer: node ? { id: gid, ...node } : null } as T;
    }
    if (document.startsWith("query portalCustomerAddresses")) {
      const list = this.addresses.get(gid);
      return {
        customer:
          list === undefined
            ? null
            : { id: gid, defaultAddress: { id: this.defaultAddress.get(gid) ?? null }, addresses: list },
      } as T;
    }
    if (document.startsWith("query portalCustomerConsent")) {
      const c = this.consent.get(gid);
      return {
        customer: this.identity.has(gid)
          ? { id: gid, emailMarketingConsent: c ?? { marketingState: "NOT_SUBSCRIBED", consentUpdatedAt: null } }
          : null,
      } as T;
    }

    /* ----------------------------- mutations ----------------------------- */
    if (document.includes("customerUpdate(")) {
      const errs = ue("customerUpdate");
      if (errs.length > 0) return { customerUpdate: { customer: null, userErrors: errs } } as T;
      const cur = this.identity.get(gid);
      if (!cur) return { customerUpdate: { customer: null, userErrors: [] } } as T;
      const next = { ...cur };
      if (variables.firstName !== null) next.firstName = String(variables.firstName);
      if (variables.lastName !== null) next.lastName = String(variables.lastName);
      if (variables.phone !== null) {
        // Shopify NORMALISES a phone number — the reason a write must read back.
        next.phone = `+44${String(variables.phone).replace(/\D/g, "").replace(/^0+/, "")}`;
      }
      this.identity.set(gid, next);
      return { customerUpdate: { customer: { id: gid, ...next }, userErrors: [] } } as T;
    }
    if (document.includes("customerAddressCreate(")) {
      const errs = ue("customerAddressCreate");
      if (errs.length > 0) return { customerAddressCreate: { address: null, userErrors: errs } } as T;
      const input = (variables.address ?? {}) as Record<string, unknown>;
      const created: FakeAddress = { id: `gid://shopify/MailingAddress/${this.nextId++}`, ...input } as FakeAddress;
      this.addresses.set(gid, [...(this.addresses.get(gid) ?? []), created]);
      return { customerAddressCreate: { address: created, userErrors: [] } } as T;
    }
    if (document.includes("customerAddressUpdate(")) {
      const errs = ue("customerAddressUpdate");
      if (errs.length > 0) return { customerAddressUpdate: { address: null, userErrors: errs } } as T;
      const list = this.addresses.get(gid) ?? [];
      const target = list.find((a) => a.id === String(variables.addressId));
      // NOT OURS → Shopify has nothing to act on. `address: null`, no error.
      if (!target) return { customerAddressUpdate: { address: null, userErrors: [] } } as T;
      Object.assign(target, variables.address ?? {});
      return { customerAddressUpdate: { address: target, userErrors: [] } } as T;
    }
    if (document.includes("customerAddressDelete(")) {
      const errs = ue("customerAddressDelete");
      if (errs.length > 0) return { customerAddressDelete: { deletedAddressId: null, userErrors: errs } } as T;
      const list = this.addresses.get(gid) ?? [];
      const idx = list.findIndex((a) => a.id === String(variables.addressId));
      if (idx < 0) return { customerAddressDelete: { deletedAddressId: null, userErrors: [] } } as T;
      const [removed] = list.splice(idx, 1);
      return { customerAddressDelete: { deletedAddressId: removed?.id ?? null, userErrors: [] } } as T;
    }
    if (document.includes("customerUpdateDefaultAddress(")) {
      const errs = ue("customerUpdateDefaultAddress");
      if (errs.length > 0)
        return { customerUpdateDefaultAddress: { customer: null, userErrors: errs } } as T;
      const list = this.addresses.get(gid) ?? [];
      const target = list.find((a) => a.id === String(variables.addressId));
      if (!target) return { customerUpdateDefaultAddress: { customer: null, userErrors: [] } } as T;
      this.defaultAddress.set(gid, target.id);
      return {
        customerUpdateDefaultAddress: { customer: { id: gid, defaultAddress: { id: target.id } }, userErrors: [] },
      } as T;
    }
    if (document.includes("customerEmailMarketingConsentUpdate(")) {
      const errs = ue("customerEmailMarketingConsentUpdate");
      if (errs.length > 0)
        return { customerEmailMarketingConsentUpdate: { customer: null, userErrors: errs } } as T;
      const consent = (variables.consent ?? {}) as { marketingState?: string };
      // SHOPIFY stamps the timestamp — the portal never sends one.
      const stored = {
        marketingState: String(consent.marketingState ?? "NOT_SUBSCRIBED"),
        consentUpdatedAt: "2026-08-27T12:00:00Z",
      };
      this.consent.set(gid, stored);
      return {
        customerEmailMarketingConsentUpdate: {
          customer: { id: gid, emailMarketingConsent: stored },
          userErrors: [],
        },
      } as T;
    }
    throw new Error(`FakeShopify: unknown document: ${document.slice(0, 60)}`);
  }
}

/** The sanctioned lookup, faked. `null` means the scope has no Shopify customer. */
function lookupFor(shopifyId: string | null): ShopifyCustomerIdLookup {
  return {
    async findShopifyCustomerId(): Promise<string | null> {
      return shopifyId;
    },
  };
}

function buildApp(
  shopify: FakeShopify,
  opts: { shopifyId?: string | null; maxRequests?: number } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  const deps = {
    transport: shopify,
    lookup: lookupFor(opts.shopifyId === undefined ? SHOPIFY_CUSTOMER_ID : opts.shopifyId),
  };
  const limit = opts.maxRequests === undefined ? {} : { maxRequests: opts.maxRequests };
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    identityDeps: { deps, identityRateLimit: limit, consentRateLimit: limit },
    addressDeps: { deps, addressRateLimit: limit },
  });
  return app;
}

/* ========================================================================== *
 * N6 / N7 — identity
 * ========================================================================== */

describe("GET /v1/profile/identity (N6)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("returns the five contract fields with emailEditable false", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      firstName: "Amina",
      lastName: "Rahim",
      email: "amina@example.com",
      emailEditable: false,
    });
    expect(Object.keys(body).sort()).toEqual([
      "apiVersion",
      "email",
      "emailEditable",
      "firstName",
      "lastName",
      "phone",
    ]);
  });

  it("requires an identity", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/identity" });
    expect(res.statusCode).toBe(401);
    // Nothing about anyone leaks from an unauthenticated read.
    expect(res.body).not.toContain("Amina");
    expect(res.body).not.toContain("example.com");
  });

  it("reads only OUR customer, never another (Req 2.1)", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: AUTH });
    expect(res.body).not.toContain("OTHER");
    // The document was bound to OUR gid, from the sanctioned lookup.
    expect(shopify.calls.at(-1)?.variables.customerGid).toBe(OUR_GID);
  });

  it("answers 404 when the scope has no Shopify customer", async () => {
    app = buildApp(new FakeShopify(), { shopifyId: null });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("answers 502 on an upstream failure, never an empty identity", async () => {
    const shopify = new FakeShopify();
    shopify.throwUpstream = true;
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unavailable");
  });
});

describe("PUT /v1/profile/identity (N7)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("has NO email key in the N7 schema at all, so it cannot be admitted (Req 5.8)", () => {
    // The OUTER layer, asserted directly. The route also never copies `email` into
    // the mutation patch and the document has no email field, so the end-to-end test
    // below passes even if this schema were widened — which is exactly why this
    // assertion exists separately. `.strip()` is the claim the module header makes,
    // and this is what makes that claim testable rather than aspirational.
    expect(Object.keys(IDENTITY_BODY_SCHEMA.shape).sort()).toEqual([
      "firstName",
      "lastName",
      "phone",
    ]);
    expect(IDENTITY_BODY_SCHEMA.shape).not.toHaveProperty("email");
    // And a body carrying one parses to an object without it.
    const parsed = IDENTITY_BODY_SCHEMA.parse({ firstName: "A", email: "x@y.z" });
    expect(parsed).not.toHaveProperty("email");
    expect(JSON.stringify(parsed)).not.toContain("x@y.z");
  });

  it("STRIPS an email key and never writes it (Req 5.8, task 14.5)", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/identity",
      headers: keyed(),
      payload: { firstName: "Amina", email: "attacker@evil.example" },
    });
    expect(res.statusCode).toBe(200);
    // The stored email is unchanged...
    expect(res.json().email).toBe("amina@example.com");
    // ...and the attempted value reached NO document and NO variable set.
    const sent = JSON.stringify(shopify.calls);
    expect(sent).not.toContain("attacker@evil.example");
    // The mutation document has no email field at all.
    const mutation = shopify.calls.find((c) => c.document.includes("customerUpdate("));
    expect(mutation?.document).not.toMatch(/email\s*:/);
    expect(Object.keys(mutation?.variables ?? {})).not.toContain("email");
  });

  it("returns what Shopify STORED, not what was submitted (task 14.5)", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/identity",
      headers: keyed(),
      payload: { phone: "07700 900456" },
    });
    expect(res.statusCode).toBe(200);
    // The fake normalises, as Shopify does. An echo would have shown the input.
    expect(res.json().phone).toBe("+447700900456");
    expect(res.json().phone).not.toBe("07700 900456");
  });

  it("passes ONLY the submitted keys, so a partial save cannot clear a name", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    await app.inject({
      method: "PUT",
      url: "/v1/profile/identity",
      headers: keyed(),
      payload: { phone: "07700900456" },
    });
    // Shopify treats an explicit null as "clear", so a body changing only the phone
    // must not send firstName at all — and the stored name survives.
    const after = await app.inject({ method: "GET", url: "/v1/profile/identity", headers: AUTH });
    expect(after.json().firstName).toBe("Amina");
    expect(after.json().lastName).toBe("Rahim");
  });

  it("accepts an EMPTY body as a no-op and returns the stored state", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/identity",
      headers: keyed(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().firstName).toBe("Amina");
  });

  it("maps a userError to 400 with field CODES and NO upstream text (Req 5.4, 2.7)", async () => {
    const shopify = new FakeShopify();
    shopify.failWith = {
      operation: "customerUpdate",
      userErrors: [{ field: ["input", "phone"], message: "SHOPIFY-UPSTREAM-SENTENCE" }],
    };
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/identity",
      headers: keyed(),
      payload: { phone: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual([{ field: "phone", code: "invalid_phone" }]);
    expect(res.body).not.toContain("SHOPIFY-UPSTREAM-SENTENCE");
    // The previously stored value comes back so the client can present it (Req 5.5).
    expect(res.json().current).toMatchObject({ phone: "+447700900123" });
    expect(res.json().retryable).toBe(true);
  });

  it("distinguishes a REFUSAL (400) from NOT KNOWING (502)", async () => {
    const refuse = new FakeShopify();
    refuse.failWith = { operation: "customerUpdate", userErrors: [{ field: ["input", "phone"], message: "x" }] };
    app = buildApp(refuse);
    await app.ready();
    const refused = await app.inject({
      method: "PUT", url: "/v1/profile/identity", headers: keyed(), payload: { phone: "x" },
    });
    expect(refused.statusCode).toBe(400);
    await app.close();

    const down = new FakeShopify();
    down.throwUpstream = true;
    app = buildApp(down);
    await app.ready();
    const unknown = await app.inject({
      method: "PUT", url: "/v1/profile/identity", headers: keyed(), payload: { phone: "x" },
    });
    // A customer with a bad phone number must not be told the service is down.
    expect(unknown.statusCode).toBe(502);
  });

  it("returns field codes for a malformed body without touching Shopify", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify, { maxRequests: 1000 });
    await app.ready();
    for (const payload of [
      { firstName: "" },
      { firstName: "x".repeat(65) },
      { phone: 7 },
      { lastName: null },
    ]) {
      const res = await app.inject({
        method: "PUT", url: "/v1/profile/identity", headers: keyed(), payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      for (const f of res.json().fields) expect(f.code).toMatch(/^[a-z][a-z_]*$/);
    }
    expect(shopify.calls.filter((c) => c.document.includes("mutation"))).toHaveLength(0);
  });

  it("requires an Idempotency-Key", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({
      method: "PUT", url: "/v1/profile/identity", headers: AUTH, payload: { firstName: "A" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
  });

  it(`rate limits after ${IDENTITY_RATE_LIMIT_MAX_REQUESTS} writes`, async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    for (let i = 0; i < IDENTITY_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await app.inject({
        method: "PUT", url: "/v1/profile/identity", headers: keyed(), payload: { firstName: "A" },
      });
    }
    const limited = await app.inject({
      method: "PUT", url: "/v1/profile/identity", headers: keyed(), payload: { firstName: "A" },
    });
    expect(limited.statusCode).toBe(429);
  });

  it("requires an identity BEFORE reporting anything about the body", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "PUT", url: "/v1/profile/identity", payload: { firstName: "" },
    });
    expect(res.statusCode).toBe(401);
    expect(shopify.calls).toHaveLength(0);
  });

  it("IGNORES a browser-supplied customer id (Req 1.2)", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    await app.inject({
      method: "PUT",
      url: `/v1/profile/identity?customerId=${OTHER_SHOPIFY_ID}`,
      headers: { ...keyed(), "x-customer-id": OTHER_SHOPIFY_ID, cookie: `customerId=${OTHER_SHOPIFY_ID}` },
      payload: { firstName: "Changed" },
    });
    // Every document was bound to OUR gid; the other customer is untouched.
    for (const call of shopify.calls) expect(call.variables.customerGid).toBe(OUR_GID);
    expect(shopify.identity.get(`gid://shopify/Customer/${OTHER_SHOPIFY_ID}`)?.firstName).toBe("OTHER");
  });
});

/* ========================================================================== *
 * N8 — addresses
 * ========================================================================== */

describe("/v1/profile/addresses (N8)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("lists the caller's addresses with isDefault read from Shopify", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/addresses", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().addresses).toHaveLength(1);
    expect(res.json().addresses[0]).toMatchObject({
      id: "gid://shopify/MailingAddress/1",
      address1: "1 Ours St",
      countryCode: "GB",
      isDefault: true,
    });
  });

  it("NEVER lists another customer's addresses (Req 2.1)", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/addresses", headers: AUTH });
    expect(res.body).not.toContain("999 Theirs Rd");
    expect(res.body).not.toContain("LS1 1AA");
  });

  it("creates an address and returns it plus the resulting list", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/addresses",
      headers: keyed(),
      payload: { address1: "2 New Rd", city: "Bath", zip: "BA1 1AA", countryCode: "GB" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().address).toMatchObject({ address1: "2 New Rd", city: "Bath" });
    expect(res.json().addresses).toHaveLength(2);
  });

  it("maps `province` to Shopify's `provinceCode` and never sends an unknown key", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/v1/profile/addresses",
      headers: keyed(),
      payload: { address1: "3 A St", province: "Avon", countryCode: "GB" },
    });
    const call = shopify.calls.find((c) => c.document.includes("customerAddressCreate("));
    const input = call?.variables.address as Record<string, unknown>;
    expect(input).toHaveProperty("provinceCode", "Avon");
    expect(input).not.toHaveProperty("province");
    // Only keys the live MailingAddressInput accepts.
    for (const key of Object.keys(input)) {
      expect([
        "firstName", "lastName", "address1", "address2", "city", "provinceCode", "zip",
        "countryCode", "phone",
      ]).toContain(key);
    }
  });

  it("STRIPS id and isDefault from a create body", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/v1/profile/addresses",
      headers: keyed(),
      payload: { address1: "4 B St", id: "gid://shopify/MailingAddress/999", isDefault: true },
    });
    const call = shopify.calls.find((c) => c.document.includes("customerAddressCreate("));
    const input = call?.variables.address as Record<string, unknown>;
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("isDefault");
    // The other customer's address 999 was not adopted.
    expect(JSON.stringify(shopify.addresses.get(OUR_GID))).not.toContain("/999");
  });

  it("updates the caller's own address", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/profile/addresses/1",
      headers: keyed(),
      payload: { city: "Oxford" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().address.city).toBe("Oxford");
  });

  it("answers 404 for a FOREIGN addressId and changes nothing (Req 2.2, 2.3)", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/v1/profile/addresses/999",
        headers: keyed(),
        ...(method === "PUT" ? { payload: { city: "Hacked" } } : {}),
      });
      expect(res.statusCode, method).toBe(404);
      // No attribute of the foreign resource appears in the body.
      expect(res.body).not.toContain("999 Theirs Rd");
      expect(res.body).not.toContain("Leeds");
    }
    // The victim's address is untouched.
    expect(shopify.addresses.get(`gid://shopify/Customer/${OTHER_SHOPIFY_ID}`)).toEqual([
      { id: "gid://shopify/MailingAddress/999", address1: "999 Theirs Rd", city: "Leeds", zip: "LS1 1AA", countryCodeV2: "GB" },
    ]);
  });

  it("sends OUR customerGid even for a foreign addressId, so Shopify has nothing to act on", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    await app.inject({
      method: "PUT", url: "/v1/profile/addresses/999", headers: keyed(), payload: { city: "x" },
    });
    const call = shopify.calls.find((c) => c.document.includes("customerAddressUpdate("));
    expect(call?.variables.customerGid).toBe(OUR_GID);
    expect(call?.variables.addressId).toBe("gid://shopify/MailingAddress/999");
  });

  it("answers 404 for a MALFORMED addressId without reaching Shopify", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify, { maxRequests: 1000 });
    await app.ready();
    for (const bad of ["abc", "1;drop", "../../etc", "gid://shopify/Customer/1", "%20", "1 OR 1=1"]) {
      const res = await app.inject({
        method: "DELETE",
        url: `/v1/profile/addresses/${encodeURIComponent(bad)}`,
        headers: keyed(),
      });
      expect(res.statusCode, bad).toBe(404);
    }
    expect(shopify.calls.filter((c) => c.document.includes("mutation"))).toHaveLength(0);
  });

  it("accepts either a bare numeric id or a full GID", async () => {
    app = buildApp(new FakeShopify(), { maxRequests: 1000 });
    await app.ready();
    const bare = await app.inject({
      method: "PUT", url: "/v1/profile/addresses/1", headers: keyed(), payload: { city: "A" },
    });
    expect(bare.statusCode).toBe(200);
    const full = await app.inject({
      method: "PUT",
      url: `/v1/profile/addresses/${encodeURIComponent("gid://shopify/MailingAddress/1")}`,
      headers: keyed(),
      payload: { city: "B" },
    });
    expect(full.statusCode).toBe(200);
    expect(full.json().address.city).toBe("B");
  });

  it("deletes the caller's address and returns the resulting list", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: "/v1/profile/addresses/1", headers: keyed() });
    expect(res.statusCode).toBe(200);
    expect(res.json().addresses).toHaveLength(0);
  });

  it("sets the default and reports it back from Shopify's own defaultAddress", async () => {
    const shopify = new FakeShopify();
    shopify.addresses.set(OUR_GID, [
      { id: "gid://shopify/MailingAddress/1", address1: "1 Ours St" },
      { id: "gid://shopify/MailingAddress/2", address1: "2 Ours St" },
    ]);
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "PUT", url: "/v1/profile/addresses/2/default", headers: keyed(),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().addresses as { id: string; isDefault: boolean }[];
    expect(list.find((a) => a.id.endsWith("/2"))?.isDefault).toBe(true);
    expect(list.find((a) => a.id.endsWith("/1"))?.isDefault).toBe(false);
  });

  it("answers 404 when asked to default a FOREIGN address", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({
      method: "PUT", url: "/v1/profile/addresses/999/default", headers: keyed(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("maps a create userError to 400 with codes and no upstream text", async () => {
    const shopify = new FakeShopify();
    shopify.failWith = {
      operation: "customerAddressCreate",
      userErrors: [
        { field: ["address", "zip"], message: "UPSTREAM-ZIP-TEXT" },
        { field: ["address", "countryCode"], message: "UPSTREAM-COUNTRY-TEXT" },
      ],
    };
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/v1/profile/addresses", headers: keyed(), payload: { zip: "?" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual([
      { field: "zip", code: "invalid_postcode" },
      { field: "countryCode", code: "invalid_country" },
    ]);
    expect(res.body).not.toContain("UPSTREAM");
  });

  it("requires an identity on every route, and reveals nothing", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    const cases: readonly [string, string][] = [
      ["GET", "/v1/profile/addresses"],
      ["POST", "/v1/profile/addresses"],
      ["PUT", "/v1/profile/addresses/1"],
      ["DELETE", "/v1/profile/addresses/1"],
      ["PUT", "/v1/profile/addresses/1/default"],
    ];
    for (const [method, url] of cases) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: { "idempotency-key": `anon-${method}-${url}` },
        payload: {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.body).not.toContain("Ours St");
    }
    expect(shopify.calls).toHaveLength(0);
  });

  it(`rate limits writes after ${ADDRESS_RATE_LIMIT_MAX_REQUESTS} in the window`, async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    for (let i = 0; i < ADDRESS_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await app.inject({
        method: "POST", url: "/v1/profile/addresses", headers: keyed(), payload: { address1: `${i} St` },
      });
    }
    const limited = await app.inject({
      method: "POST", url: "/v1/profile/addresses", headers: keyed(), payload: { address1: "x" },
    });
    expect(limited.statusCode).toBe(429);
  });

  it("answers 502 on upstream failure, never an empty address list", async () => {
    const shopify = new FakeShopify();
    shopify.throwUpstream = true;
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/addresses", headers: AUTH });
    expect(res.statusCode).toBe(502);
    // An empty list would read as "you have no saved addresses".
    expect(res.json()).not.toHaveProperty("addresses");
  });
});

/* ========================================================================== *
 * N9 — consent
 * ========================================================================== */

describe("/v1/profile/consent (N9)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("reads consent from Shopify with Shopify's own timestamp", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/consent", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      emailMarketing: false,
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("writes consent and returns SHOPIFY's updatedAt, never our clock (Req 3.2)", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({
      method: "PUT", url: "/v1/profile/consent", headers: keyed(), payload: { emailMarketing: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ emailMarketing: true, updatedAt: "2026-08-27T12:00:00Z" });
    // The portal sent NO timestamp — there is exactly one clock for this fact.
    const call = shopify.calls.find((c) => c.document.includes("customerEmailMarketingConsentUpdate("));
    expect(JSON.stringify(call?.variables)).not.toContain("consentUpdatedAt");
  });

  it("sends SUBSCRIBED with an opt-in level and UNSUBSCRIBED without", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify, { maxRequests: 1000 });
    await app.ready();
    await app.inject({
      method: "PUT", url: "/v1/profile/consent", headers: keyed(), payload: { emailMarketing: true },
    });
    const on = shopify.calls.at(-1)?.variables.consent as Record<string, unknown>;
    expect(on).toEqual({ marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" });

    await app.inject({
      method: "PUT", url: "/v1/profile/consent", headers: keyed(), payload: { emailMarketing: false },
    });
    const off = shopify.calls.at(-1)?.variables.consent as Record<string, unknown>;
    expect(off).toEqual({ marketingState: "UNSUBSCRIBED" });
  });

  it("treats ONLY SUBSCRIBED as consent — PENDING is not consent", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    for (const state of ["PENDING", "NOT_SUBSCRIBED", "UNSUBSCRIBED", "REDACTED", "INVALID"]) {
      shopify.consent.set(OUR_GID, { marketingState: state, consentUpdatedAt: "2026-01-01T00:00:00Z" });
      const res = await app.inject({ method: "GET", url: "/v1/profile/consent", headers: AUTH });
      expect(res.json().emailMarketing, state).toBe(false);
    }
    shopify.consent.set(OUR_GID, { marketingState: "SUBSCRIBED", consentUpdatedAt: "2026-01-01T00:00:00Z" });
    const yes = await app.inject({ method: "GET", url: "/v1/profile/consent", headers: AUTH });
    expect(yes.json().emailMarketing).toBe(true);
  });

  it("stores NO local copy of consent — the write only ever reaches Shopify", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify);
    await app.ready();
    await app.inject({
      method: "PUT", url: "/v1/profile/consent", headers: keyed(), payload: { emailMarketing: true },
    });
    // Every call went to the Shopify transport. There is no database dependency on
    // these routes at all, so there is nowhere a second copy could live.
    expect(shopify.calls.length).toBeGreaterThan(0);
    // And a later read reflects Shopify's state, not a cached one: change it
    // underneath and the next read follows.
    shopify.consent.set(OUR_GID, { marketingState: "UNSUBSCRIBED", consentUpdatedAt: "2027-01-01T00:00:00Z" });
    const res = await app.inject({ method: "GET", url: "/v1/profile/consent", headers: AUTH });
    expect(res.json()).toMatchObject({ emailMarketing: false, updatedAt: "2027-01-01T00:00:00Z" });
  });

  it("rejects a non-boolean and a missing value", async () => {
    const shopify = new FakeShopify();
    app = buildApp(shopify, { maxRequests: 1000 });
    await app.ready();
    for (const payload of [{}, { emailMarketing: "true" }, { emailMarketing: 1 }, { emailMarketing: null }]) {
      const res = await app.inject({
        method: "PUT", url: "/v1/profile/consent", headers: keyed(), payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().fields[0].code).toMatch(/^[a-z][a-z_]*$/);
    }
    expect(shopify.calls.filter((c) => c.document.includes("mutation"))).toHaveLength(0);
  });

  it("requires an identity and reveals no consent state", async () => {
    app = buildApp(new FakeShopify());
    await app.ready();
    for (const method of ["GET", "PUT"] as const) {
      const res = await app.inject({
        method,
        url: "/v1/profile/consent",
        ...(method === "PUT" ? { headers: { "idempotency-key": "x" }, payload: { emailMarketing: true } } : {}),
      });
      expect(res.statusCode, method).toBe(401);
      expect(res.body).not.toContain("SUBSCRIBED");
    }
  });

  it("FAILS rather than inventing a consent state when Shopify is unreachable", async () => {
    const shopify = new FakeShopify();
    shopify.throwUpstream = true;
    app = buildApp(shopify);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/profile/consent", headers: AUTH });
    expect(res.statusCode).toBe(502);
    // Reporting `emailMarketing: false` here would tell a subscribed customer they
    // had already opted out — inventing a compliance-relevant fact.
    expect(res.json()).not.toHaveProperty("emailMarketing");
  });
});

/* ========================================================================== *
 * Unwired build
 * ========================================================================== */

describe("the N6-N9 routes register even with NO Shopify source wired", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("answers 401 unauthenticated and 502 authenticated — never 404", async () => {
    app = Fastify({ logger: false });
    registerVersioning(app);
    app.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: CUSTOMER }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
    });
    await app.ready();
    for (const url of ["/v1/profile/identity", "/v1/profile/addresses", "/v1/profile/consent"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, `anon ${url}`).toBe(401);
      const authed = await app.inject({ method: "GET", url, headers: AUTH });
      // 502, not 404: a 404 would read as "this account has no identity" and would
      // silently shrink the unauthenticated route census.
      expect(authed.statusCode, `authed ${url}`).toBe(502);
    }
  });
});
