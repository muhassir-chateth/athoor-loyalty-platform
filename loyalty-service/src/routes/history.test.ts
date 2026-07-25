/**
 * Tests for `GET /v1/history` (task 6.4, Requirements 6.1–6.7).
 *
 * Three layers:
 *   1. Unit tests for the pure mapping/pagination helpers — {@link mapEntryType},
 *      {@link parsePagination}, {@link mapHistoryEntry}, {@link buildLedgerPage}.
 *   2. Unit tests for the {@link InMemoryLedgerHistorySource} ordering + slicing.
 *   3. HTTP tests through a real Fastify app wired with the actual `/v1` auth
 *      layer — verifies an authenticated request returns a typed, ordered,
 *      paginated page; that invalid pagination is rejected with no entries; that
 *      empty history yields total 0; and (the key property of Req 6.7) that the
 *      SAME local customer yields byte-identical data whether the request
 *      arrives via App Proxy (web) or a Customer Account API bearer token.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { InMemoryCustomerResolver, FakeTokenVerifier } from "../auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import {
  buildLedgerPage,
  mapEntryType,
  mapHistoryEntry,
  parsePagination,
  InMemoryLedgerHistorySource,
  HISTORY_DEFAULT_PAGE_SIZE,
  HISTORY_MAX_PAGE_SIZE,
  type RawHistoryEntry,
} from "./history.js";

describe("mapEntryType (Req 6.1)", () => {
  it("maps every earn_* credit to 'earned'", () => {
    expect(mapEntryType("earn_signup", 50)).toBe("earned");
    expect(mapEntryType("earn_order", 100)).toBe("earned");
    expect(mapEntryType("earn_first_purchase", 100)).toBe("earned");
    expect(mapEntryType("earn_referral", 150)).toBe("earned");
  });

  it("maps 'spend' to 'spent'", () => {
    expect(mapEntryType("spend", -100)).toBe("spent");
  });

  it("maps 'expire' to 'expired'", () => {
    expect(mapEntryType("expire", -25)).toBe("expired");
  });

  it("maps a 'clawback' debit to 'spent' (documented mapping)", () => {
    expect(mapEntryType("clawback", -40)).toBe("spent");
  });

  it("maps 'adjust' and 'migration' by sign", () => {
    expect(mapEntryType("adjust", 30)).toBe("earned");
    expect(mapEntryType("adjust", -30)).toBe("spent");
    expect(mapEntryType("migration", 200)).toBe("earned");
  });
});

describe("parsePagination (Req 6.3/6.4/6.5)", () => {
  it("defaults to page 1, pageSize 20 when unspecified (Req 6.3)", () => {
    const result = parsePagination({});
    expect(result).toEqual({ ok: true, pagination: { page: 1, pageSize: HISTORY_DEFAULT_PAGE_SIZE } });
  });

  it("accepts a valid custom page and pageSize (Req 6.4)", () => {
    const result = parsePagination({ page: "3", pageSize: "50" });
    expect(result).toEqual({ ok: true, pagination: { page: 3, pageSize: 50 } });
  });

  it("accepts the maximum page size of 100 (Req 6.4)", () => {
    const result = parsePagination({ pageSize: String(HISTORY_MAX_PAGE_SIZE) });
    expect(result).toEqual({ ok: true, pagination: { page: 1, pageSize: 100 } });
  });

  it("rejects a page size greater than 100 (Req 6.5)", () => {
    const result = parsePagination({ pageSize: "101" });
    expect(result.ok).toBe(false);
  });

  it("rejects a page size less than 1 (Req 6.5)", () => {
    expect(parsePagination({ pageSize: "0" }).ok).toBe(false);
    expect(parsePagination({ pageSize: "-5" }).ok).toBe(false);
  });

  it("rejects a page number less than 1 (Req 6.5)", () => {
    expect(parsePagination({ page: "0" }).ok).toBe(false);
    expect(parsePagination({ page: "-1" }).ok).toBe(false);
  });

  it("rejects non-integer pagination values (Req 6.5)", () => {
    expect(parsePagination({ page: "abc" }).ok).toBe(false);
    expect(parsePagination({ pageSize: "2.5" }).ok).toBe(false);
    expect(parsePagination({ pageSize: "10x" }).ok).toBe(false);
  });
});

describe("mapHistoryEntry (Req 6.1)", () => {
  it("projects a raw entry into type, reason, ISO date, and order reference", () => {
    const raw: RawHistoryEntry = {
      id: "e1",
      entryType: "earn_order",
      points: 120,
      reason: "Order #1001",
      orderReference: 1001,
      createdAt: new Date("2024-01-15T10:30:00.000Z"),
    };
    expect(mapHistoryEntry(raw)).toEqual({
      id: "e1",
      type: "earned",
      points: 120,
      reason: "Order #1001",
      date: "2024-01-15T10:30:00.000Z",
      orderReference: 1001,
    });
  });

  it("carries a null order reference for non-order-associated entries (Req 6.1)", () => {
    const raw: RawHistoryEntry = {
      id: "e2",
      entryType: "earn_signup",
      points: 50,
      reason: "Signup bonus",
      orderReference: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    expect(mapHistoryEntry(raw).orderReference).toBeNull();
  });
});

describe("buildLedgerPage (Req 6.3/6.4/6.6)", () => {
  const raw = (id: string): RawHistoryEntry => ({
    id,
    entryType: "earn_order",
    points: 10,
    reason: "r",
    orderReference: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
  });

  it("reports hasNextPage true when more entries remain (Req 6.3/6.4)", () => {
    const page = buildLedgerPage({ entries: [raw("a"), raw("b")], totalCount: 5 }, 1, 2);
    expect(page).toMatchObject({ page: 1, pageSize: 2, totalCount: 5, hasNextPage: true });
    expect(page.entries).toHaveLength(2);
  });

  it("reports hasNextPage false on the last page", () => {
    const page = buildLedgerPage({ entries: [raw("e")], totalCount: 5 }, 3, 2);
    expect(page).toMatchObject({ totalCount: 5, hasNextPage: false });
  });

  it("returns an empty page with total 0 for no entries (Req 6.6)", () => {
    const page = buildLedgerPage({ entries: [], totalCount: 0 }, 1, 20);
    expect(page).toEqual({ entries: [], page: 1, pageSize: 20, totalCount: 0, hasNextPage: false });
  });
});

describe("InMemoryLedgerHistorySource (Req 6.2)", () => {
  it("orders entries most-recent-first and slices to the page", async () => {
    const entries: RawHistoryEntry[] = [
      { id: "old", entryType: "earn_signup", points: 50, reason: "a", orderReference: null, createdAt: new Date("2024-01-01T00:00:00.000Z") },
      { id: "new", entryType: "spend", points: -100, reason: "b", orderReference: null, createdAt: new Date("2024-03-01T00:00:00.000Z") },
      { id: "mid", entryType: "earn_order", points: 30, reason: "c", orderReference: 7, createdAt: new Date("2024-02-01T00:00:00.000Z") },
    ];
    const source = new InMemoryLedgerHistorySource({ c1: entries });

    const page1 = await source.load({ customerId: "c1", page: 1, pageSize: 2 });
    expect(page1.totalCount).toBe(3);
    expect(page1.entries.map((e) => e.id)).toEqual(["new", "mid"]);

    const page2 = await source.load({ customerId: "c1", page: 2, pageSize: 2 });
    expect(page2.entries.map((e) => e.id)).toEqual(["old"]);
  });

  it("returns an empty page with total 0 for an unknown customer (Req 6.6)", async () => {
    const source = new InMemoryLedgerHistorySource();
    const page = await source.load({ customerId: "nobody", page: 1, pageSize: 20 });
    expect(page).toEqual({ entries: [], totalCount: 0 });
  });
});

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";

function sampleEntries(): RawHistoryEntry[] {
  return [
    { id: "e1", entryType: "earn_signup", points: 50, reason: "Signup bonus", orderReference: null, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    { id: "e2", entryType: "earn_order", points: 120, reason: "Order #1001", orderReference: 1001, createdAt: new Date("2024-02-01T00:00:00.000Z") },
    { id: "e3", entryType: "spend", points: -100, reason: "Redeemed £5", orderReference: null, createdAt: new Date("2024-03-01T00:00:00.000Z") },
    { id: "e4", entryType: "expire", points: -20, reason: "Points expired", orderReference: null, createdAt: new Date("2024-04-01T00:00:00.000Z") },
  ];
}

/** Builds a `/v1`-mounted app wired with the real auth layer and a fake history source. */
function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);

  const customerResolver = new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID });
  const tokenVerifier = new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID });
  const historySource = new InMemoryLedgerHistorySource({ [LOCAL_CUSTOMER_ID]: sampleEntries() });

  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver,
    tokenVerifier,
    appProxySecret: APP_PROXY_SECRET,
    historySource,
  });

  return app;
}

/** Build the query string for a validly signed App Proxy request, merging extra params. */
function signedQuery(params: QueryParams, extra: Record<string, string> = {}): string {
  const signable = { ...params, ...extra };
  const withSig = { ...signable, signature: computeAppProxySignature(signable, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  return search.toString();
}

describe("GET /v1/history (Req 6.1–6.7)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns typed, most-recent-first entries with reason, ISO date, order ref (Req 6.1/6.2)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/history",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCount).toBe(4);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(HISTORY_DEFAULT_PAGE_SIZE);
    expect(body.hasNextPage).toBe(false);

    // Most-recent-first ordering (Req 6.2).
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["e4", "e3", "e2", "e1"]);

    // Types mapped to exactly earned/spent/expired (Req 6.1).
    expect(body.entries.map((e: { type: string }) => e.type)).toEqual([
      "expired",
      "spent",
      "earned",
      "earned",
    ]);

    // Order-associated entry carries its order reference; others are null (Req 6.1).
    const orderEntry = body.entries.find((e: { id: string }) => e.id === "e2");
    expect(orderEntry).toMatchObject({ orderReference: 1001, reason: "Order #1001" });
    expect(orderEntry.date).toBe("2024-02-01T00:00:00.000Z");
    const signupEntry = body.entries.find((e: { id: string }) => e.id === "e1");
    expect(signupEntry.orderReference).toBeNull();
  });

  it("honours page size and reports a next-page indicator (Req 6.3/6.4)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/history?page=1&pageSize=2",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pageSize).toBe(2);
    expect(body.totalCount).toBe(4);
    expect(body.hasNextPage).toBe(true);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["e4", "e3"]);
  });

  it("rejects invalid pagination with an error and no entries (Req 6.5)", async () => {
    for (const qs of ["pageSize=0", "pageSize=101", "page=0", "page=abc", "pageSize=2.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/history?${qs}`,
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toMatchObject({ error: "invalid_pagination" });
      expect(body.entries).toBeUndefined();
    }
  });

  it("returns an empty history with total 0 for a customer with no entries (Req 6.6)", async () => {
    const app2 = Fastify({ logger: false });
    registerVersioning(app2);
    app2.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
      historySource: new InMemoryLedgerHistorySource(),
    });
    await app2.ready();

    const res = await app2.inject({
      method: "GET",
      url: "/v1/history",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
    expect(body.totalCount).toBe(0);
    expect(body.hasNextPage).toBe(false);

    await app2.close();
  });

  it("returns identical data via App Proxy and Customer Account API identity (Req 6.7)", async () => {
    const bearerRes = await app.inject({
      method: "GET",
      url: "/v1/history?page=1&pageSize=3",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    const qs = signedQuery(
      {
        shop: "myathoorlondon.myshopify.com",
        logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
        path_prefix: "/apps/loyalty",
        timestamp: "1700000000",
      },
      { page: "1", pageSize: "3" },
    );
    const proxyRes = await app.inject({ method: "GET", url: `/v1/history?${qs}` });

    expect(bearerRes.statusCode).toBe(200);
    expect(proxyRes.statusCode).toBe(200);
    // The loyalty payload must be identical regardless of identity source (Req 6.7).
    expect(proxyRes.json()).toEqual(bearerRes.json());
  });

  it("rejects an unauthenticated request before the handler runs (Req 9.3)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/history" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });
});
