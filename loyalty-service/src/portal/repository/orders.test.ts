/**
 * Tests for the orders read — documents, projection and the customer-scoped
 * traversal (spec tasks 8.1/8.2, design §6.3 N1/N2, §7.1–§7.6).
 *
 * WHAT IS FAKED, AND WHAT IS NOT. The Admin transport and the Shopify-id lookup
 * are fakes, so nothing here reaches live Shopify or a live database. Everything
 * else is the real thing: the real documents, the real
 * {@link runScopedCustomerQuery}, the real projection. The transport RECORDS what
 * it was handed, because for the ownership properties the guarantee is about what
 * would be SENT, not about what comes back.
 *
 * SAFETY: no network, no Postgres, no production.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9, 6.12, 3.3, 18.5
 */
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { requireCustomerScope, type CustomerScope } from "../../auth/customerScope.js";
import type { ShopifyCustomerIdLookup } from "../../shopify/purchaseHistory.js";
import { PORTAL_ORDER_ID_PATTERN } from "../types.js";
import { AdminThrottleExhaustedError, ShopifyThrottleError } from "../../shopify/adminGateway.js";
import { ShopifyAdminRequestError } from "../../shopify/graphqlClient.js";
import { DEFAULT_SHOPIFY_READ_TIMEOUT_MS } from "../../shopify/coalescingCache.js";
import {
  assertScopedCustomerQuery,
  SCOPED_CUSTOMER_VARIABLE,
  type ScopedGraphqlTransport,
} from "./shopifyScope.js";
import {
  FULFILLED,
  InvalidOrderReferenceError,
  ORDERS_LINE_ITEM_WINDOW,
  ORDERS_PREVIEW_LINE_ITEMS,
  ORDERS_THROTTLE_BACKOFF,
  ORDER_DETAIL_LINE_ITEM_LIMIT,
  ORDER_DETAIL_TRACKING_LIMIT,
  PARTIALLY_FULFILLED,
  PORTAL_ORDERS_PAGE_QUERY,
  PORTAL_ORDER_DETAIL_QUERY,
  UNFULFILLED,
  UnreadableUpstreamValueError,
  deriveFulfilmentStatus,
  formatMoneyGBP,
  projectAddress,
  projectFulfilment,
  projectOrderDetail,
  projectOrderLineItem,
  projectOrderSummary,
  readScopedOrderDetail,
  readScopedOrdersPage,
  type ScopedOrderReadDeps,
  type ShopifyOrderDetailNode,
  type ShopifyOrderSummaryNode,
} from "./orders.js";

const CUSTOMER_A = "1f0c7c4e-0000-4000-8000-00000000000a";
const CUSTOMER_B = "1f0c7c4e-0000-4000-8000-00000000000b";
const SHOPIFY_A = "9395357876563";
const SHOPIFY_B = "8281246765452";

function scopeFor(customerId: string): CustomerScope {
  return requireCustomerScope({
    authCtx: { customerId, channel: "web", source: "app_proxy" },
  } as unknown as FastifyRequest);
}

const SCOPE_A = scopeFor(CUSTOMER_A);
const SCOPE_B = scopeFor(CUSTOMER_B);

class FakeLookup implements ShopifyCustomerIdLookup {
  readonly asked: string[] = [];
  constructor(private readonly mapping: Record<string, string | null>) {}
  async findShopifyCustomerId(localCustomerId: string): Promise<string | null> {
    this.asked.push(localCustomerId);
    return this.mapping[localCustomerId] ?? null;
  }
}

class RecordingTransport implements ScopedGraphqlTransport {
  readonly calls: { document: string; variables: Record<string, unknown> }[] = [];
  constructor(private readonly reply: unknown) {}
  async request<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    this.calls.push({ document, variables });
    return this.reply as T;
  }
}

class FailingTransport implements ScopedGraphqlTransport {
  constructor(private readonly error: Error) {}
  async request<T>(): Promise<T> {
    throw this.error;
  }
}

function depsFor(transport: ScopedGraphqlTransport, lookup: ShopifyCustomerIdLookup): ScopedOrderReadDeps {
  return { transport, lookup };
}

const BOTH_CUSTOMERS = { [CUSTOMER_A]: SHOPIFY_A, [CUSTOMER_B]: SHOPIFY_B };

/* ========================================================================== *
 * The documents
 * ========================================================================== */

describe("both documents are customer-rooted (design §4.3 Rule 2, §4.5 rows 6/7)", () => {
  it("passes the same guard the ownership gate applies to the whole directory", () => {
    // Not redundant with the gate: the gate discovers documents by scanning
    // source, and if the scanner ever stopped finding these it would pass over an
    // empty set. Naming them here means both documents are checked by name too.
    expect(() => assertScopedCustomerQuery(PORTAL_ORDERS_PAGE_QUERY)).not.toThrow();
    expect(() => assertScopedCustomerQuery(PORTAL_ORDER_DETAIL_QUERY)).not.toThrow();
  });

  it("declares the fixed ownership variable and never a by-order-id root field", () => {
    for (const document of [PORTAL_ORDERS_PAGE_QUERY, PORTAL_ORDER_DETAIL_QUERY]) {
      expect(document).toContain(`$${SCOPED_CUSTOMER_VARIABLE}: ID!`);
      expect(document).toContain(`customer(id: $${SCOPED_CUSTOMER_VARIABLE})`);
      // The rejected form of §4.3 Rule 2 — fetch by id, then compare.
      expect(document).not.toMatch(/\border\s*\(\s*id\s*:/);
      expect(document).not.toMatch(/\bnode\s*\(\s*id\s*:/);
    }
  });

  it("orders the list newest-first by processed date (Req 6.1)", () => {
    expect(PORTAL_ORDERS_PAGE_QUERY).toContain("reverse: true");
    expect(PORTAL_ORDERS_PAGE_QUERY).toContain("sortKey: PROCESSED_AT");
  });

  it("contains no mutation, so this read path cannot write (Req 3.3)", () => {
    for (const document of [PORTAL_ORDERS_PAGE_QUERY, PORTAL_ORDER_DETAIL_QUERY]) {
      expect(document.toLowerCase()).not.toContain("mutation");
    }
  });
});

/* ========================================================================== *
 * Money
 * ========================================================================== */

describe("formatMoneyGBP — decimal strings, never floats (design §6.2)", () => {
  it("normalises to exactly two fractional digits", () => {
    expect(formatMoneyGBP("184")).toBe("184.00");
    expect(formatMoneyGBP("184.0")).toBe("184.00");
    expect(formatMoneyGBP("184.00")).toBe("184.00");
    expect(formatMoneyGBP("0.5")).toBe("0.50");
    expect(formatMoneyGBP(".5")).toBe("0.50");
  });

  it("treats an absent money bag as zero, not as an error", () => {
    // Shopify declares `subtotalPriceSet` and `totalTaxSet` nullable; an order
    // with no recorded tax genuinely has none.
    expect(formatMoneyGBP(null)).toBe("0.00");
    expect(formatMoneyGBP(undefined)).toBe("0.00");
    expect(formatMoneyGBP("")).toBe("0.00");
  });

  it("rounds half-up on the DIGITS, where a float would round the wrong way", () => {
    // `(1.005).toFixed(2)` is "1.00" in IEEE-754 because 1.005 is not
    // representable. This is the case that proves the arithmetic is not a float.
    expect(formatMoneyGBP("1.005")).toBe("1.01");
    expect(formatMoneyGBP("2.675")).toBe("2.68");
    expect(formatMoneyGBP("1.004")).toBe("1.00");
  });

  it("carries a rounding increment across the decimal point", () => {
    expect(formatMoneyGBP("9.999")).toBe("10.00");
    expect(formatMoneyGBP("99.999")).toBe("100.00");
    expect(formatMoneyGBP("0.999")).toBe("1.00");
  });

  it("preserves precision a double could not hold", () => {
    expect(formatMoneyGBP("12345678901234567.89")).toBe("12345678901234567.89");
  });

  it("keeps a negative amount signed but normalises a signed zero", () => {
    expect(formatMoneyGBP("-5.5")).toBe("-5.50");
    expect(formatMoneyGBP("-0.000")).toBe("0.00");
  });

  it("refuses an unreadable amount rather than reporting £0.00", () => {
    // A total shown as zero because a string would not parse is a lie about a
    // customer's money, and a convincing one — nothing looks broken.
    expect(() => formatMoneyGBP("about £5")).toThrow(UnreadableUpstreamValueError);
    expect(() => formatMoneyGBP("1,234.00")).toThrow(UnreadableUpstreamValueError);
    expect(() => formatMoneyGBP("NaN")).toThrow(UnreadableUpstreamValueError);
    expect(() => formatMoneyGBP(".")).toThrow(UnreadableUpstreamValueError);
  });

  it("produces values matching the wire contract's money pattern", () => {
    for (const raw of ["184", "0", "-5.5", "1.005", "9.999"]) {
      expect(formatMoneyGBP(raw)).toMatch(/^-?\d+\.\d{2}$/);
    }
  });
});

/* ========================================================================== *
 * Fulfilment status
 * ========================================================================== */

describe("deriveFulfilmentStatus (§6.3 N1, §7.4)", () => {
  it("is NEVER null — an absent status becomes UNFULFILLED", () => {
    expect(deriveFulfilmentStatus({ shopifyStatus: null })).toBe(UNFULFILLED);
    expect(deriveFulfilmentStatus({ shopifyStatus: undefined })).toBe(UNFULFILLED);
    expect(deriveFulfilmentStatus({ shopifyStatus: "   " })).toBe(UNFULFILLED);
    expect(deriveFulfilmentStatus({})).toBe(UNFULFILLED);
  });

  it("derives the three rows of §7.4 when Shopify supplies nothing", () => {
    expect(deriveFulfilmentStatus({ fulfilmentCount: 0, outstandingItemCount: 3 })).toBe(
      UNFULFILLED,
    );
    expect(deriveFulfilmentStatus({ fulfilmentCount: 1, outstandingItemCount: 2 })).toBe(
      PARTIALLY_FULFILLED,
    );
    expect(deriveFulfilmentStatus({ fulfilmentCount: 2, outstandingItemCount: 0 })).toBe(FULFILLED);
  });

  it("passes Shopify's own richer vocabulary through unchanged", () => {
    // `types.ts` keeps `ShopifyStatusIdentifier` open precisely because these
    // occur; collapsing them onto the three-row table would lose information the
    // client's copy map is required to handle (§18.9).
    for (const status of ["ON_HOLD", "SCHEDULED", "RESTOCKED", "PARTIALLY_FULFILLED"]) {
      expect(deriveFulfilmentStatus({ shopifyStatus: status, fulfilmentCount: 0 })).toBe(status);
    }
  });
});

/* ========================================================================== *
 * Projection — N1
 * ========================================================================== */

function summaryNode(overrides: Partial<ShopifyOrderSummaryNode> = {}): ShopifyOrderSummaryNode {
  return {
    id: "gid://shopify/Order/6543210987",
    name: "#1042",
    processedAt: "2026-07-14T10:02:11Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "GBP",
    totalPriceSet: { shopMoney: { amount: "184.00" } },
    lineItems: {
      nodes: [
        {
          title: "Oud Royale 50ml",
          quantity: 1,
          image: { url: "https://cdn/oud.jpg", width: 800, height: 800 },
        },
      ],
    },
    ...overrides,
  };
}

describe("projectOrderSummary (§6.3 N1)", () => {
  it("projects exactly the N1 row shape", () => {
    expect(projectOrderSummary(summaryNode())).toEqual({
      id: "6543210987",
      name: "#1042",
      processedAt: "2026-07-14T10:02:11Z",
      financialStatus: "PAID",
      fulfilmentStatus: "FULFILLED",
      totalGBP: "184.00",
      currencyCode: "GBP",
      lineItemCount: 1,
      previewLineItems: [
        {
          title: "Oud Royale 50ml",
          quantity: 1,
          imageUrl: "https://cdn/oud.jpg",
          imageWidth: 800,
          imageHeight: 800,
        },
      ],
    });
  });

  it("exposes the numeric id, not the GID, and it matches the N2 path pattern", () => {
    const summary = projectOrderSummary(summaryNode());
    expect(summary.id).toBe("6543210987");
    // The list's id must be usable as the detail path, or the two contracts do
    // not compose.
    expect(PORTAL_ORDER_ID_PATTERN.test(summary.id)).toBe(true);
  });

  it("returns intrinsic image dimensions so the client never guesses (Req 18.5)", () => {
    const summary = projectOrderSummary(summaryNode());
    expect(summary.previewLineItems[0]?.imageWidth).toBe(800);
    expect(summary.previewLineItems[0]?.imageHeight).toBe(800);
  });

  it("reports zero dimensions for a line item with no image, rather than a plausible guess", () => {
    const summary = projectOrderSummary(
      summaryNode({ lineItems: { nodes: [{ title: "No image", quantity: 2, image: null }] } }),
    );
    expect(summary.previewLineItems[0]).toEqual({
      title: "No image",
      quantity: 2,
      imageUrl: null,
      imageWidth: 0,
      imageHeight: 0,
    });
  });

  it("previews at most three line items while counting the whole window", () => {
    const nodes = Array.from({ length: 7 }, (_unused, index) => ({
      title: `Item ${index}`,
      quantity: 1,
      image: null,
    }));
    const summary = projectOrderSummary(summaryNode({ lineItems: { nodes } }));
    expect(summary.previewLineItems).toHaveLength(ORDERS_PREVIEW_LINE_ITEMS);
    expect(summary.lineItemCount).toBe(7);
  });

  it("CLAMPS lineItemCount at the window, which is the documented understatement", () => {
    // The honest limit, pinned so it cannot change unnoticed: Shopify's
    // `LineItemConnection` has no count field in 2024-10, so `lineItemCount` is
    // the size of the bounded window rather than the order's real line count. An
    // order with more distinct lines than the window under-reports, and the
    // alternative — paging every line of every order in the page — is the cost
    // §7.6 exists to avoid.
    const nodes = Array.from({ length: ORDERS_LINE_ITEM_WINDOW + 5 }, (_unused, index) => ({
      title: `Item ${index}`,
      quantity: 1,
      image: null,
    }));
    // Shopify would have returned only `first: $lineItemWindow` of these; the
    // slice models that truncation.
    const windowed = nodes.slice(0, ORDERS_LINE_ITEM_WINDOW);
    const summary = projectOrderSummary(summaryNode({ lineItems: { nodes: windowed } }));
    expect(summary.lineItemCount).toBe(ORDERS_LINE_ITEM_WINDOW);
    expect(summary.lineItemCount).toBeLessThan(nodes.length);
  });

  it("REFUSES an order GID with no numeric tail rather than emitting id: ''", () => {
    // An empty id would satisfy no contract and would look valid: the client would
    // render a row whose detail link points at `/orders/`. On the N1 list path
    // there is no validated request to fall back on, because the ids come from
    // Shopify.
    for (const id of ["gid://shopify/Order/abc", "gid://shopify/Order/", "", null]) {
      expect(() => projectOrderSummary(summaryNode({ id }))).toThrow(
        UnreadableUpstreamValueError,
      );
    }
  });

  it("never returns a null fulfilment status, even when Shopify omits it", () => {
    const summary = projectOrderSummary(summaryNode({ displayFulfillmentStatus: null }));
    expect(summary.fulfilmentStatus).toBe(UNFULFILLED);
  });

  it("carries no line-item price or product reference in a preview row", () => {
    const [preview] = projectOrderSummary(summaryNode()).previewLineItems;
    expect(Object.keys(preview ?? {}).sort()).toEqual([
      "imageHeight",
      "imageUrl",
      "imageWidth",
      "quantity",
      "title",
    ]);
  });
});

/* ========================================================================== *
 * Projection — N2, including the §7.5 four-state table
 * ========================================================================== */

const PUBLISHED_PRODUCT = {
  id: "gid://shopify/Product/4400",
  handle: "oud-royale",
  status: "ACTIVE",
  publishedAt: "2024-01-01T00:00:00Z",
};

function lineItemNode(overrides: Record<string, unknown> = {}) {
  return {
    title: "Oud Royale 50ml",
    quantity: 1,
    unfulfilledQuantity: 0,
    originalUnitPriceSet: { shopMoney: { amount: "184.00" } },
    discountedTotalSet: { shopMoney: { amount: "165.60" } },
    image: { url: "https://cdn/oud.jpg", width: 800, height: 800 },
    variant: { id: "gid://shopify/ProductVariant/4477", availableForSale: true },
    product: PUBLISHED_PRODUCT,
    ...overrides,
  };
}

describe("projectOrderLineItem — the four-state product table (§7.5, Req 6.8/6.9)", () => {
  it("published + in stock → id, handle, available true", () => {
    const item = projectOrderLineItem(lineItemNode());
    expect(item.productId).toBe("4400");
    expect(item.productHandle).toBe("oud-royale");
    expect(item.available).toBe(true);
    expect(item.variantId).toBe("4477");
  });

  it("published + out of stock → id, handle, available false", () => {
    const item = projectOrderLineItem(
      lineItemNode({ variant: { id: "gid://shopify/ProductVariant/4477", availableForSale: false } }),
    );
    expect(item.productId).toBe("4400");
    expect(item.productHandle).toBe("oud-royale");
    expect(item.available).toBe(false);
  });

  it("unpublished → id, handle NULL, available false (Req 6.9)", () => {
    const item = projectOrderLineItem(
      lineItemNode({ product: { ...PUBLISHED_PRODUCT, publishedAt: null } }),
    );
    expect(item.productId).toBe("4400");
    // No handle means the client has nothing to build a link FROM — the absence
    // is the signal, not a flag it has to interpret.
    expect(item.productHandle).toBeNull();
    expect(item.available).toBe(false);
  });

  it("treats a DRAFT or ARCHIVED product as unpublished — a dead link is worse than none", () => {
    for (const status of ["DRAFT", "ARCHIVED"]) {
      const item = projectOrderLineItem(lineItemNode({ product: { ...PUBLISHED_PRODUCT, status } }));
      expect(item.productHandle).toBeNull();
      expect(item.available).toBe(false);
    }
  });

  it("deleted → productId NULL, handle NULL, available false (Req 6.9)", () => {
    const item = projectOrderLineItem(lineItemNode({ product: null, variant: null }));
    expect(item.productId).toBeNull();
    expect(item.productHandle).toBeNull();
    expect(item.variantId).toBeNull();
    expect(item.available).toBe(false);
  });

  it("keeps the recorded title and prices in ALL FOUR states (Req 6.9)", () => {
    const states = [
      lineItemNode(),
      lineItemNode({ variant: { id: "gid://shopify/ProductVariant/4477", availableForSale: false } }),
      lineItemNode({ product: { ...PUBLISHED_PRODUCT, publishedAt: null } }),
      lineItemNode({ product: null, variant: null }),
    ];
    for (const node of states) {
      const item = projectOrderLineItem(node);
      expect(item.title).toBe("Oud Royale 50ml");
      expect(item.originalUnitPriceGBP).toBe("184.00");
      expect(item.discountedTotalGBP).toBe("165.60");
    }
  });
});

describe("projectFulfilment — tracking passed through only (§7.4, Req 6.4/6.5)", () => {
  it("passes Shopify's tracking company, number and URL through", () => {
    expect(
      projectFulfilment({
        status: "SUCCESS",
        displayStatus: "IN_TRANSIT",
        trackingInfo: [{ company: "Royal Mail", number: "AB123", url: "https://track/AB123" }],
      }),
    ).toEqual({
      status: "IN_TRANSIT",
      trackingCompany: "Royal Mail",
      trackingNumber: "AB123",
      trackingUrl: "https://track/AB123",
    });
  });

  it("shows the state with NO tracking control when trackingInfo is empty (Req 6.5)", () => {
    expect(
      projectFulfilment({ status: "SUCCESS", displayStatus: "FULFILLED", trackingInfo: [] }),
    ).toEqual({
      status: "FULFILLED",
      trackingCompany: null,
      trackingNumber: null,
      trackingUrl: null,
    });
  });

  it("NEVER constructs a carrier URL from a bare tracking number (§7.4)", () => {
    // A guessed link that 404s reads to a customer as their parcel being lost.
    const projected = projectFulfilment({
      status: "SUCCESS",
      displayStatus: "IN_TRANSIT",
      trackingInfo: [{ company: "Royal Mail", number: "AB123", url: null }],
    });
    expect(projected.trackingNumber).toBe("AB123");
    expect(projected.trackingUrl).toBeNull();
  });

  it("requests exactly as many tracking entries as the contract can carry", () => {
    // `PortalFulfilment` has a SINGULAR tracking triple, so fetching more would
    // pay for objects the response cannot express — on the path §7.6 exists to
    // keep cheap. The limitation this pins: a two-parcel order shows one number.
    expect(ORDER_DETAIL_TRACKING_LIMIT).toBe(1);
    expect(PORTAL_ORDER_DETAIL_QUERY).toContain("trackingInfo(first: $trackingLimit)");
  });

  it("prefers displayStatus, which is where the shipment milestones live (§7.4 row 4)", () => {
    for (const milestone of ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      expect(
        projectFulfilment({ status: "SUCCESS", displayStatus: milestone, trackingInfo: [] }).status,
      ).toBe(milestone);
    }
  });

  it("falls back to the coarse status when displayStatus is absent", () => {
    expect(projectFulfilment({ status: "SUCCESS", displayStatus: null }).status).toBe("SUCCESS");
    expect(projectFulfilment({}).status).toBe(UNFULFILLED);
  });
});

describe("projectAddress (§6.3 N2)", () => {
  it("maps countryCodeV2 onto the contract's countryCode", () => {
    expect(
      projectAddress({
        firstName: "A",
        lastName: "B",
        address1: "1 Road",
        address2: null,
        city: "London",
        province: null,
        zip: "W1A 1AA",
        countryCodeV2: "GB",
        phone: null,
      }),
    ).toEqual({
      firstName: "A",
      lastName: "B",
      address1: "1 Road",
      address2: null,
      city: "London",
      province: null,
      zip: "W1A 1AA",
      countryCode: "GB",
      phone: null,
    });
  });

  it("is null for an order with no shipping address", () => {
    expect(projectAddress(null)).toBeNull();
    expect(projectAddress(undefined)).toBeNull();
  });
});

function detailNode(overrides: Partial<ShopifyOrderDetailNode> = {}): ShopifyOrderDetailNode {
  return {
    ...summaryNode(),
    subtotalPriceSet: { shopMoney: { amount: "165.60" } },
    totalShippingPriceSet: { shopMoney: { amount: "4.95" } },
    totalTaxSet: { shopMoney: { amount: "13.45" } },
    shippingAddress: {
      firstName: "A",
      lastName: "B",
      address1: "1 Road",
      address2: null,
      city: "London",
      province: null,
      zip: "W1A 1AA",
      countryCodeV2: "GB",
      phone: null,
    },
    fulfillments: [
      {
        status: "SUCCESS",
        displayStatus: "DELIVERED",
        trackingInfo: [{ company: "Royal Mail", number: "AB123", url: "https://track/AB123" }],
      },
    ],
    lineItems: { nodes: [lineItemNode()] },
    ...overrides,
  };
}

describe("projectOrderDetail (§6.3 N2)", () => {
  it("returns the four money fields as decimal strings", () => {
    const detail = projectOrderDetail(detailNode());
    expect(detail.subtotalGBP).toBe("165.60");
    expect(detail.shippingGBP).toBe("4.95");
    expect(detail.taxGBP).toBe("13.45");
    expect(detail.totalGBP).toBe("184.00");
  });

  it("reports 0.00 for money bags Shopify declares nullable and did not send", () => {
    const detail = projectOrderDetail(
      detailNode({ subtotalPriceSet: null, totalTaxSet: null }),
    );
    expect(detail.subtotalGBP).toBe("0.00");
    expect(detail.taxGBP).toBe("0.00");
  });

  it("derives PARTIALLY_FULFILLED from outstanding items when Shopify sends no status", () => {
    const detail = projectOrderDetail(
      detailNode({
        displayFulfillmentStatus: null,
        lineItems: { nodes: [lineItemNode({ unfulfilledQuantity: 1 })] },
      }),
    );
    expect(detail.fulfilmentStatus).toBe(PARTIALLY_FULFILLED);
  });

  it("derives UNFULFILLED with no fulfilments, and FULFILLED with nothing outstanding", () => {
    expect(
      projectOrderDetail(detailNode({ displayFulfillmentStatus: null, fulfillments: [] }))
        .fulfilmentStatus,
    ).toBe(UNFULFILLED);
    expect(
      projectOrderDetail(detailNode({ displayFulfillmentStatus: null })).fulfilmentStatus,
    ).toBe(FULFILLED);
  });

  it("carries an empty fulfilments array rather than omitting the field", () => {
    expect(projectOrderDetail(detailNode({ fulfillments: [] })).fulfilments).toEqual([]);
  });
});

/* ========================================================================== *
 * The scoped reads
 * ========================================================================== */

describe("readScopedOrdersPage (N1)", () => {
  it("binds the GID from the SCOPE, never from anything a caller supplied", async () => {
    const transport = new RecordingTransport({
      customer: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    });
    const lookup = new FakeLookup(BOTH_CUSTOMERS);
    await readScopedOrdersPage(depsFor(transport, lookup), SCOPE_A, { pageSize: 20 });

    expect(lookup.asked).toEqual([CUSTOMER_A]);
    expect(transport.calls[0]?.variables[SCOPED_CUSTOMER_VARIABLE]).toBe(
      `gid://shopify/Customer/${SHOPIFY_A}`,
    );
    // The whole IDOR answer: customer B's GID cannot appear on customer A's read.
    expect(JSON.stringify(transport.calls[0]?.variables)).not.toContain(SHOPIFY_B);
  });

  it("reads a DIFFERENT customer's connection for a different scope", async () => {
    const transport = new RecordingTransport({
      customer: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    });
    const lookup = new FakeLookup(BOTH_CUSTOMERS);
    await readScopedOrdersPage(depsFor(transport, lookup), SCOPE_B, { pageSize: 20 });
    expect(transport.calls[0]?.variables[SCOPED_CUSTOMER_VARIABLE]).toBe(
      `gid://shopify/Customer/${SHOPIFY_B}`,
    );
  });

  it("forwards the requested page size and cursor, and the line-item window", async () => {
    const transport = new RecordingTransport({
      customer: { orders: { pageInfo: { hasNextPage: true, endCursor: "cur-2" }, nodes: [] } },
    });
    await readScopedOrdersPage(depsFor(transport, new FakeLookup(BOTH_CUSTOMERS)), SCOPE_A, {
      pageSize: 5,
      cursor: "cur-1",
    });
    expect(transport.calls[0]?.variables).toMatchObject({
      pageSize: 5,
      cursor: "cur-1",
      lineItemWindow: ORDERS_LINE_ITEM_WINDOW,
    });
  });

  it("returns the page's cursor information so the client can append (§7.3)", async () => {
    const transport = new RecordingTransport({
      customer: {
        orders: {
          pageInfo: { hasNextPage: true, endCursor: "eyJsYXN0X2lkIjo" },
          nodes: [summaryNode()],
        },
      },
    });
    const page = await readScopedOrdersPage(
      depsFor(transport, new FakeLookup(BOTH_CUSTOMERS)),
      SCOPE_A,
      { pageSize: 20 },
    );
    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: "eyJsYXN0X2lkIjo" });
    expect(page.orders).toHaveLength(1);
  });

  it("gives a customer with no Shopify id an EMPTY PAGE, not a 404 (Req 6.11)", async () => {
    // N1 defines no not-found outcome, and a customer we cannot resolve has no
    // orders to show — which is the empty state, not an error.
    const transport = new RecordingTransport({ customer: null });
    const page = await readScopedOrdersPage(
      depsFor(transport, new FakeLookup({ [CUSTOMER_A]: null })),
      SCOPE_A,
      { pageSize: 20 },
    );
    expect(page).toEqual({ orders: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });

  it("gives an empty page when Shopify will not return the customer node", async () => {
    const transport = new RecordingTransport({ customer: null });
    const page = await readScopedOrdersPage(
      depsFor(transport, new FakeLookup(BOTH_CUSTOMERS)),
      SCOPE_A,
      { pageSize: 20 },
    );
    expect(page.orders).toEqual([]);
  });

  it("lets a TRANSPORT failure propagate — never an empty page (§6.3 N1)", async () => {
    // An empty page here would tell a customer they have never ordered anything
    // because Shopify was briefly unreachable.
    await expect(
      readScopedOrdersPage(
        depsFor(
          new FailingTransport(new ShopifyAdminRequestError("Shopify Admin API request failed to send.")),
          new FakeLookup(BOTH_CUSTOMERS),
        ),
        SCOPE_A,
        { pageSize: 20 },
      ),
    ).rejects.toBeInstanceOf(ShopifyAdminRequestError);
  });
});

describe("throttling is retried once, within the customer-read budget", () => {
  it("uses a policy that fits inside the 2.5 s hard timeout, not the worker's", () => {
    // `DEFAULT_BACKOFF` sleeps 1 s before its first retry and allows ten
    // attempts — right for a queue worker, and on this path the first sleep alone
    // would consume 40% of the budget, so the retry could never complete.
    expect(ORDERS_THROTTLE_BACKOFF.maxAttempts).toBe(2);
    const totalDelay = ORDERS_THROTTLE_BACKOFF.initialMs;
    expect(totalDelay).toBeLessThan(DEFAULT_SHOPIFY_READ_TIMEOUT_MS / 2);
  });

  it("retries a THROTTLED read once and succeeds", async () => {
    let attempts = 0;
    const slept: number[] = [];
    const transport: ScopedGraphqlTransport = {
      async request<T>(): Promise<T> {
        attempts += 1;
        if (attempts === 1) {
          throw new ShopifyThrottleError("throttled");
        }
        return {
          customer: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        } as T;
      },
    };
    const page = await readScopedOrdersPage(
      {
        transport,
        lookup: new FakeLookup(BOTH_CUSTOMERS),
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      },
      SCOPE_A,
      { pageSize: 20 },
    );
    expect(attempts).toBe(2);
    expect(slept).toEqual([ORDERS_THROTTLE_BACKOFF.initialMs]);
    expect(page.orders).toEqual([]);
  });

  it("does NOT retry a hard failure — that would hide a real fault behind a delay", async () => {
    let attempts = 0;
    const transport: ScopedGraphqlTransport = {
      async request<T>(): Promise<T> {
        attempts += 1;
        throw new ShopifyAdminRequestError("Shopify Admin API returned HTTP 500.");
      },
    };
    await expect(
      readScopedOrdersPage(
        { transport, lookup: new FakeLookup(BOTH_CUSTOMERS), sleep: async () => {} },
        SCOPE_A,
        { pageSize: 20 },
      ),
    ).rejects.toBeInstanceOf(ShopifyAdminRequestError);
    expect(attempts).toBe(1);
  });

  it("gives up after the bounded retries rather than sleeping through the budget", async () => {
    const transport: ScopedGraphqlTransport = {
      async request<T>(): Promise<T> {
        throw new ShopifyThrottleError("throttled");
      },
    };
    await expect(
      readScopedOrdersPage(
        { transport, lookup: new FakeLookup(BOTH_CUSTOMERS), sleep: async () => {} },
        SCOPE_A,
        { pageSize: 20 },
      ),
    ).rejects.toBeInstanceOf(AdminThrottleExhaustedError);
  });
});

describe("readScopedOrderDetail (N2)", () => {
  it("filters the customer's OWN connection by order id", async () => {
    const transport = new RecordingTransport({
      customer: { orders: { nodes: [detailNode()] } },
    });
    const detail = await readScopedOrderDetail(
      depsFor(transport, new FakeLookup(BOTH_CUSTOMERS)),
      SCOPE_A,
      "6543210987",
    );
    expect(detail?.id).toBe("6543210987");
    expect(transport.calls[0]?.variables).toMatchObject({
      orderQuery: "id:6543210987",
      lineItemLimit: ORDER_DETAIL_LINE_ITEM_LIMIT,
    });
    expect(transport.calls[0]?.variables[SCOPED_CUSTOMER_VARIABLE]).toBe(
      `gid://shopify/Customer/${SHOPIFY_A}`,
    );
  });

  it("returns null for an order outside the scope's connection — UNREACHABLE, not rejected", async () => {
    // §4.5 row 6: a foreign order is not fetched and then refused; it is simply
    // not in the connection, so there is no ownership comparison to omit.
    const transport = new RecordingTransport({ customer: { orders: { nodes: [] } } });
    const detail = await readScopedOrderDetail(
      depsFor(transport, new FakeLookup(BOTH_CUSTOMERS)),
      SCOPE_A,
      "999999999",
    );
    expect(detail).toBeNull();
  });

  it("answers identically for a nonexistent id and a foreign one (§4.5 row 14)", async () => {
    // The two scenarios are genuinely different upstream answers, not the same
    // empty fixture twice: "nonexistent" gets nothing back, "foreign" gets an
    // order back that is NOT the one asked for. Both must reduce to `null`, or
    // the two cases would be distinguishable from outside.
    const nonexistent = await readScopedOrderDetail(
      depsFor(
        new RecordingTransport({ customer: { orders: { nodes: [] } } }),
        new FakeLookup(BOTH_CUSTOMERS),
      ),
      SCOPE_A,
      "1",
    );
    const foreign = await readScopedOrderDetail(
      depsFor(
        new RecordingTransport({ customer: { orders: { nodes: [detailNode()] } } }),
        new FakeLookup(BOTH_CUSTOMERS),
      ),
      SCOPE_A,
      "7777777777",
    );
    expect(nonexistent).toBe(foreign);
    expect(nonexistent).toBeNull();
  });

  it("REFUSES an order Shopify returned that is not the one asked for", async () => {
    // Without this post-condition, WHICH order comes back is guaranteed only by
    // Shopify's `query: "id:N"` search semantics — so §4.5 row 6's "unreachable"
    // property would belong to a search DSL we do not own. The fixture answers
    // with order 6543210987 whatever is asked for, exactly as a widened or
    // relevance-ordered search would.
    const transport = new RecordingTransport({
      customer: { orders: { nodes: [detailNode()] } },
    });
    const detail = await readScopedOrderDetail(
      depsFor(transport, new FakeLookup(BOTH_CUSTOMERS)),
      SCOPE_A,
      "1",
    );
    // A `200` carrying another order's id, totals and line items would be worse
    // than a 404: every field would be self-consistent, so nothing would look
    // wrong to the customer reading it.
    expect(detail).toBeNull();
    // The request WAS made — this is a post-condition on the answer, not an
    // early return that skipped the read.
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.variables.orderQuery).toBe("id:1");
  });

  it("accepts the order when the returned id matches the reference", async () => {
    // The negative control for the test above: the post-condition must not reject
    // the ordinary case.
    const detail = await readScopedOrderDetail(
      depsFor(
        new RecordingTransport({ customer: { orders: { nodes: [detailNode()] } } }),
        new FakeLookup(BOTH_CUSTOMERS),
      ),
      SCOPE_A,
      "6543210987",
    );
    expect(detail?.id).toBe("6543210987");
  });

  it("returns null when the customer has no Shopify id, with no existence oracle", async () => {
    const transport = new RecordingTransport({ customer: null });
    const detail = await readScopedOrderDetail(
      depsFor(transport, new FakeLookup({ [CUSTOMER_A]: null })),
      SCOPE_A,
      "6543210987",
    );
    expect(detail).toBeNull();
  });

  it("refuses a malformed reference BEFORE building the search expression", async () => {
    const transport = new RecordingTransport({ customer: { orders: { nodes: [] } } });
    const deps = depsFor(transport, new FakeLookup(BOTH_CUSTOMERS));
    for (const reference of [
      "gid://shopify/Order/123",
      "1 OR 1=1",
      "id:1 status:open",
      "",
      "12345678901234567890123",
      "abc",
      "-1",
      "1.5",
    ]) {
      await expect(readScopedOrderDetail(deps, SCOPE_A, reference)).rejects.toBeInstanceOf(
        InvalidOrderReferenceError,
      );
    }
    // NOT ONE request was made: a search DSL is never assembled from an
    // unvalidated string.
    expect(transport.calls).toEqual([]);
  });

  it("carries no order reference on the rejection", async () => {
    const error = new InvalidOrderReferenceError();
    expect(error.message).not.toMatch(/\d/);
  });

  it("lets a TRANSPORT failure propagate so the route can answer 502", async () => {
    await expect(
      readScopedOrderDetail(
        depsFor(new FailingTransport(new Error("Shopify 503")), new FakeLookup(BOTH_CUSTOMERS)),
        SCOPE_A,
        "6543210987",
      ),
    ).rejects.toThrow("Shopify 503");
  });
});

/* ========================================================================== *
 * Nothing is persisted
 * ========================================================================== */

describe("no order data is stored anywhere on this path (Req 3.3, §7.1)", () => {
  it("contains no write statement of any kind", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./orders.ts", import.meta.url)), "utf8");
    for (const write of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\bUPSERT\b/i,
      /\bON\s+CONFLICT\b/i,
    ]) {
      expect(write.test(source), `orders.ts must not contain ${String(write)}`).toBe(false);
    }
  });

  it("issues exactly one Shopify request per read and touches no store", async () => {
    const transport = new RecordingTransport({
      customer: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [summaryNode()] } },
    });
    const lookup = new FakeLookup(BOTH_CUSTOMERS);
    await readScopedOrdersPage(depsFor(transport, lookup), SCOPE_A, { pageSize: 20 });
    // One identity lookup, one Shopify query, and no third collaborator exists to
    // write to — the deps interface admits only these two.
    expect(transport.calls).toHaveLength(1);
    expect(lookup.asked).toHaveLength(1);
  });
});
