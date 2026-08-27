/**
 * THE ORDERS READ — Shopify documents and projection for N1 and N2
 * (spec tasks 8.1/8.2, design §6.3, §7.1–§7.6).
 *
 * ── WHY THIS LIVES IN `portal/repository/` ───────────────────────────────────
 * `ownership.gate.test.ts` already says it, and says it about this exact file:
 * "This directory holds no document yet — the first is task 8.2's N2 read."
 * Rule 8 of that gate runs {@link assertScopedCustomerQuery} over every GraphQL
 * literal in this directory, so putting the documents here means the ownership
 * property is CHECKED rather than reviewed. A document added later that fetched
 * an order by id fails an existing test.
 *
 * ── THE WHOLE IDOR ANSWER, IN ONE SENTENCE ───────────────────────────────────
 * Both documents are rooted at `customer(id: $customerGid)`, and `$customerGid`
 * is bound by {@link runScopedCustomerQuery} from the row keyed by the verified
 * scope. No caller-supplied value reaches the GID, and no code path here can
 * name a customer. A foreign order is therefore not *rejected* — it is outside
 * the connection being read, so it is UNREACHABLE (§4.5 row 6). There is no
 * ownership comparison to forget, because there is nothing to compare.
 *
 * ── NOTHING IS PERSISTED ─────────────────────────────────────────────────────
 * Req 3.3 forbids storing any copy of order line items, totals or fulfilment
 * state. This module contains no SQL, no INSERT and no writer of any kind: it
 * reads Shopify and returns a projection. The only Postgres read on this path is
 * the `shopify_customer_id` lookup inside `resolveScopedCustomerGid`, which
 * belongs to identity, not to orders.
 *
 * ── MONEY ────────────────────────────────────────────────────────────────────
 * Every amount crosses the wire as a decimal STRING and is normalised by
 * {@link formatMoneyGBP}, which does its arithmetic on digit strings. No money
 * value in this file is ever converted to a JavaScript number — see that
 * function's own note for why that is not fussiness.
 *
 * ── LIMITS, STATED RATHER THAN HIDDEN ────────────────────────────────────────
 * 1. `lineItemCount` counts the line items inside a bounded window
 *    ({@link ORDERS_LINE_ITEM_WINDOW} for N1, {@link ORDER_DETAIL_LINE_ITEM_LIMIT}
 *    for N2). Shopify's `LineItemConnection` exposes no count field in
 *    `2024-10`, so an exact count would mean paging every line of every order in
 *    the page — 20 orders × N lines per portal visit, on a free tier whose whole
 *    §7.6 concern is Admin API budget. An order with more distinct lines than the
 *    window reports the window size. That is a cosmetic understatement on a rare
 *    order, traded against a query cost paid by every customer on every visit.
 * 2. N2 returns the first {@link ORDER_DETAIL_LINE_ITEM_LIMIT} line items and
 *    does not page deeper. `shopifyScope.ts` explains why that is deliberate:
 *    the idiomatic way to page one order's lines is the top-level `order(id:)`
 *    form, which this layer refuses outright, so deep pagination has to be a
 *    reviewed decision rather than an idiom inherited by accident.
 *
 * SAFETY: pure to import. No request is made until a caller passes a real
 * transport. Read-only — {@link assertScopedCustomerQuery} refuses any document
 * containing a mutation, so this module cannot grow a write.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
// The SAME trailing-numeric-id extraction `purchaseHistory.ts` already ships,
// imported rather than restated so the two cannot disagree about what a Shopify
// GID's numeric tail is. Its name says "product" because that was its first
// caller; the function itself is generic over GIDs, which is why it is aliased
// here rather than copied with a better name.
import {
  productIdFromGid as numericIdFromGid,
  type ShopifyCustomerIdLookup,
} from "../../shopify/purchaseHistory.js";
import { DEFAULT_BACKOFF, type BackoffParams, type Sleeper } from "../../shopify/adminGateway.js";
import { withThrottleRetry } from "../../migration/shopifyMigrationSupport.js";
import {
  PORTAL_ORDER_ID_PATTERN,
  type MoneyGBP,
  type PortalAddress,
  type PortalFulfilment,
  type PortalOrderDetail,
  type PortalOrderLineItem,
  type PortalOrderPreviewLineItem,
  type PortalOrderSummary,
  type PortalOrdersResponse,
} from "../types.js";
import { PortalRepositoryError } from "./scopedQuery.js";
import {
  runScopedCustomerQuery,
  type ScopedGraphqlTransport,
} from "./shopifyScope.js";

/* ========================================================================== *
 * Bounds
 * ========================================================================== */

/** Line items fetched per order in the N1 list read. See limit 1 in the header. */
export const ORDERS_LINE_ITEM_WINDOW = 10;

/** Preview thumbnails returned per order row (§6.3 N1 `previewLineItems`). */
export const ORDERS_PREVIEW_LINE_ITEMS = 3;

/** Line items returned by the N2 detail read. See limit 2 in the header. */
export const ORDER_DETAIL_LINE_ITEM_LIMIT = 100;

/** Fulfilments returned by the N2 detail read; more than this on one order is not a real case. */
export const ORDER_DETAIL_FULFILMENT_LIMIT = 20;

/**
 * Tracking entries requested per fulfilment: exactly ONE.
 *
 * `PortalFulfilment` (§6.3 N2) carries a SINGULAR
 * `trackingCompany`/`trackingNumber`/`trackingUrl` triple, so one entry is all
 * the contract can express. Requesting ten and then reading `trackingInfo[0]`
 * would fetch nine objects per fulfilment and discard them — on the very path
 * §7.6 exists to keep cheap — while implying a multi-parcel capability the
 * response shape does not have.
 *
 * THE LIMITATION THIS MAKES EXPLICIT: an order shipped in two parcels shows the
 * first parcel's tracking only. Widening it needs the CONTRACT to change
 * (`fulfilments[].tracking[]`), which is a spec decision, not something to
 * smuggle in by over-fetching.
 */
export const ORDER_DETAIL_TRACKING_LIMIT = 1;

/**
 * Throttle policy for the orders reads — tuned to the CUSTOMER-READ budget, not
 * reused from the background workers.
 *
 * `DEFAULT_BACKOFF` is `initialMs: 1000, maxAttempts: 10`, which is right for a
 * migration or a queue worker and wrong here: the first sleep alone would consume
 * 40% of the 2.5 s hard timeout, so the retry would never complete and the read
 * would burn its whole budget before failing anyway — worse than not retrying.
 *
 * One retry after 250 ms fits comfortably inside the budget and absorbs the single
 * most likely upstream failure on a shared Admin bucket. `THROTTLED` is Shopify
 * saying "ask again shortly", which is precisely the failure a short retry is for;
 * anything else is a hard failure and {@link withThrottleRetry} rethrows it
 * immediately rather than hiding a real fault behind a delay.
 */
export const ORDERS_THROTTLE_BACKOFF: BackoffParams = {
  initialMs: 250,
  factor: 2,
  capMs: 500,
  maxAttempts: 2,
} as const;

/**
 * The `fulfilmentStatus` used when Shopify supplies none (§6.3 N1: "derived;
 * never null — `UNFULFILLED` when absent").
 */
export const UNFULFILLED = "UNFULFILLED";

/** Derived when at least one fulfilment exists but items remain outstanding (§7.4). */
export const PARTIALLY_FULFILLED = "PARTIALLY_FULFILLED";

/** Derived when fulfilments exist and no item is outstanding (§7.4). */
export const FULFILLED = "FULFILLED";

/**
 * CHECKED HERE AS WELL AS AT THE ROUTE, and that is the point.
 *
 * The route rejects a malformed reference with `400 invalid_order_reference` for
 * the customer's benefit; this module re-checks because the validated id is
 * interpolated into a Shopify SEARCH expression (`id:1234`), and a search DSL
 * built from an unvalidated string is an injection surface. Placing the check at
 * the boundary that BUILDS the expression means it cannot be bypassed by a future
 * caller that forgot the route's check.
 *
 * The PATTERN itself is imported from the shared contract rather than restated —
 * two copies of the accepted form is how the route and the boundary come to
 * disagree about what a valid reference is.
 */
const ORDER_ID_PATTERN = PORTAL_ORDER_ID_PATTERN;

/* ========================================================================== *
 * Errors
 * ========================================================================== */

/**
 * Raised when an order reference is not `^\d{1,20}$` (§6.3 N2).
 *
 * Carries NO reference. It can reach an error log, and §24.3 lists an order
 * number among the values never to log; the route already knows what was asked
 * for and does not need the error to tell it.
 */
export class InvalidOrderReferenceError extends PortalRepositoryError {
  readonly code = "invalid_order_reference" as const;

  constructor() {
    super("The order reference is not in the accepted form.");
    this.name = "InvalidOrderReferenceError";
  }
}

/**
 * Raised when Shopify returned a value this service cannot interpret — a money
 * amount that will not parse, or an order GID with no numeric tail.
 *
 * WHY THIS IS NOT "SUBSTITUTE A DEFAULT". A total rendered as `£0.00` because a
 * string would not parse is a lie about a customer's money, and it is a
 * convincing one — nothing about the page looks broken. An order row with
 * `id: ""` is the same mistake in a different field: it looks valid and yields a
 * link to `/orders/`. Refusing is honest, and the route maps this to
 * `502 upstream_unavailable`, which says "we could not read Shopify's answer" —
 * which is what happened.
 *
 * An ABSENT money bag is a different thing and is not an error: Shopify declares
 * `subtotalPriceSet` and `totalTaxSet` nullable, and an order with no recorded
 * tax legitimately has none. That case yields `"0.00"`.
 *
 * Carries the FIELD KIND but never the value: this can reach a log line, and an
 * order id is one of the things §24.3 forbids logging.
 */
export class UnreadableUpstreamValueError extends PortalRepositoryError {
  readonly code = "unreadable_upstream_value" as const;
  /** Which kind of field could not be read. An identifier, never a value. */
  readonly field: "money" | "order_id" | "product_id";

  constructor(field: "money" | "order_id" | "product_id") {
    super("Shopify returned a value that could not be interpreted.");
    this.name = "UnreadableUpstreamValueError";
    this.field = field;
  }
}

/* ========================================================================== *
 * The documents
 * ========================================================================== */

/**
 * N1 — a page of the customer's orders, newest first.
 *
 * `reverse: true` with `sortKey: PROCESSED_AT` gives the reverse-chronological
 * order Req 6.1 requires. `after: $cursor` is Shopify's own cursor: §7.3 explains
 * why this endpoint is cursor-paged while `/v1/history` is offset-paged — faking
 * offsets over Shopify's connection loses rows when a new order lands mid-page.
 *
 * `lineItems` is requested at {@link ORDERS_LINE_ITEM_WINDOW} rather than at the
 * preview size because `lineItemCount` has to come from somewhere and the
 * connection has no count field (header limit 1).
 */
export const PORTAL_ORDERS_PAGE_QUERY = /* GraphQL */ `
  query portalOrdersPage(
    $customerGid: ID!
    $pageSize: Int!
    $cursor: String
    $lineItemWindow: Int!
  ) {
    customer(id: $customerGid) {
      id
      orders(first: $pageSize, after: $cursor, reverse: true, sortKey: PROCESSED_AT) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          name
          processedAt
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          lineItems(first: $lineItemWindow) {
            nodes {
              title
              quantity
              image {
                url
                width
                height
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * N2 — one order, reached THROUGH the customer's own `orders` connection.
 *
 * `query: $orderQuery` carries `id:<numeric>`. The alternative — a top-level
 * `order(id:)` plus a comparison against `order.customer.id` — is refused by
 * `assertScopedCustomerQuery`, and §4.3 Rule 2 explains why: under that form the
 * foreign order is fetched and then rejected, so the endpoint's safety is the
 * presence of one `if`. Here a foreign id simply yields an empty `nodes` array.
 *
 * `first: 1` because an id filter matches at most one order, and because a wider
 * window would invite a future edit to iterate and compare — the very shape this
 * form exists to avoid.
 */
export const PORTAL_ORDER_DETAIL_QUERY = /* GraphQL */ `
  query portalOrderDetail(
    $customerGid: ID!
    $orderQuery: String!
    $lineItemLimit: Int!
    $fulfilmentLimit: Int!
    $trackingLimit: Int!
  ) {
    customer(id: $customerGid) {
      id
      orders(first: 1, query: $orderQuery) {
        nodes {
          id
          name
          processedAt
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
            }
          }
          totalTaxSet {
            shopMoney {
              amount
            }
          }
          shippingAddress {
            firstName
            lastName
            address1
            address2
            city
            province
            zip
            countryCodeV2
            phone
          }
          fulfillments(first: $fulfilmentLimit) {
            status
            displayStatus
            trackingInfo(first: $trackingLimit) {
              company
              number
              url
            }
          }
          lineItems(first: $lineItemLimit) {
            nodes {
              title
              quantity
              unfulfilledQuantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                }
              }
              discountedTotalSet {
                shopMoney {
                  amount
                }
              }
              image {
                url
                width
                height
              }
              variant {
                id
                availableForSale
              }
              product {
                id
                handle
                status
                publishedAt
              }
            }
          }
        }
      }
    }
  }
`;

/* ========================================================================== *
 * Shopify response shapes
 * ========================================================================== */

/** `MoneyV2.amount` arrives as a `Decimal`, which the JSON transport gives us as a string. */
interface ShopifyMoneyBag {
  shopMoney?: { amount?: string | null } | null;
}

interface ShopifyImage {
  url?: string | null;
  width?: number | null;
  height?: number | null;
}

interface ShopifyPreviewLineItemNode {
  title?: string | null;
  quantity?: number | null;
  image?: ShopifyImage | null;
}

interface ShopifyDetailLineItemNode extends ShopifyPreviewLineItemNode {
  unfulfilledQuantity?: number | null;
  originalUnitPriceSet?: ShopifyMoneyBag | null;
  discountedTotalSet?: ShopifyMoneyBag | null;
  variant?: { id?: string | null; availableForSale?: boolean | null } | null;
  product?: {
    id?: string | null;
    handle?: string | null;
    status?: string | null;
    publishedAt?: string | null;
  } | null;
}

interface ShopifyTrackingInfo {
  company?: string | null;
  number?: string | null;
  url?: string | null;
}

interface ShopifyFulfilment {
  status?: string | null;
  displayStatus?: string | null;
  trackingInfo?: readonly ShopifyTrackingInfo[] | null;
}

interface ShopifyMailingAddress {
  firstName?: string | null;
  lastName?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
}

/** The order node as the N1 document requests it. */
export interface ShopifyOrderSummaryNode {
  id?: string | null;
  name?: string | null;
  processedAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  currencyCode?: string | null;
  totalPriceSet?: ShopifyMoneyBag | null;
  lineItems?: { nodes?: readonly ShopifyPreviewLineItemNode[] | null } | null;
}

/** The order node as the N2 document requests it. */
export interface ShopifyOrderDetailNode extends ShopifyOrderSummaryNode {
  subtotalPriceSet?: ShopifyMoneyBag | null;
  totalShippingPriceSet?: ShopifyMoneyBag | null;
  totalTaxSet?: ShopifyMoneyBag | null;
  shippingAddress?: ShopifyMailingAddress | null;
  fulfillments?: readonly ShopifyFulfilment[] | null;
  lineItems?: { nodes?: readonly ShopifyDetailLineItemNode[] | null } | null;
}

/** The `customer` node the N1 document returns. */
interface OrdersPageCustomerNode {
  orders?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    nodes?: readonly ShopifyOrderSummaryNode[] | null;
  } | null;
}

/** The `customer` node the N2 document returns. */
interface OrderDetailCustomerNode {
  orders?: { nodes?: readonly ShopifyOrderDetailNode[] | null } | null;
}

/* ========================================================================== *
 * Money — decimal strings only
 * ========================================================================== */

/** Adds one to a non-negative decimal digit string, carrying left. */
function incrementDigits(digits: string): string {
  const out = digits.split("");
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const digit = Number(out[i]);
    if (digit < 9) {
      out[i] = String(digit + 1);
      return out.join("");
    }
    out[i] = "0";
  }
  return `1${out.join("")}`;
}

/** Drops leading zeros while keeping at least one digit. */
function stripLeadingZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Normalises a Shopify `Decimal` into a {@link MoneyGBP} — a decimal string with
 * exactly two fractional digits.
 *
 * ── NOT ONE FLOAT, ANYWHERE IN HERE ──────────────────────────────────────────
 * The obvious implementation is `Number(amount).toFixed(2)`, and it is wrong for
 * a reason that does not show up in testing with tidy values: IEEE-754 cannot
 * represent `0.1`, and `toFixed` rounds half-to-even on the binary
 * approximation, so `(1.005).toFixed(2)` is `"1.00"`. Money that has been through
 * a float stops matching the receipt, and the customer-visible symptom is a
 * penny that appears and disappears depending on which endpoint they look at.
 * Design §6.2 requires strings for exactly this reason, so the rounding here is
 * done on the DIGITS: half-up at the third fractional digit, with the carry
 * propagated by {@link incrementDigits}.
 *
 * Absent (`null`/`undefined`/empty) → `"0.00"`: Shopify declares several order
 * money bags nullable and an order with no recorded tax genuinely has none.
 * Present but unparseable → {@link UnreadableUpstreamValueError}, never `"0.00"`.
 *
 * `-0.00` is normalised to `"0.00"`; a signed zero is an artefact, not an amount.
 */
export function formatMoneyGBP(raw: string | number | null | undefined): MoneyGBP {
  if (raw === null || raw === undefined) {
    return "0.00";
  }
  const text = String(raw).trim();
  if (text === "") {
    return "0.00";
  }
  const parts = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (parts === null) {
    throw new UnreadableUpstreamValueError("money");
  }
  const [, sign = "", wholeRaw = "", fraction = ""] = parts;
  if (wholeRaw === "" && fraction === "") {
    // `"."`, `"+"`, `"-"` — matched the shape but carries no digit at all.
    throw new UnreadableUpstreamValueError("money");
  }
  const whole = wholeRaw === "" ? "0" : wholeRaw;

  let normalisedWhole: string;
  let normalisedFraction: string;
  if (fraction.length <= 2) {
    normalisedWhole = whole;
    normalisedFraction = fraction.padEnd(2, "0");
  } else {
    const keep = fraction.slice(0, 2);
    const roundUp = Number(fraction[2]) >= 5;
    if (!roundUp) {
      normalisedWhole = whole;
      normalisedFraction = keep;
    } else {
      const bumped = incrementDigits(`${whole}${keep}`);
      normalisedWhole = bumped.slice(0, bumped.length - 2);
      normalisedFraction = bumped.slice(bumped.length - 2);
    }
  }

  const magnitude = `${stripLeadingZeros(normalisedWhole)}.${normalisedFraction}`;
  const negative = sign === "-" && /[1-9]/.test(magnitude);
  return `${negative ? "-" : ""}${magnitude}`;
}

/** The shop-currency amount of a money bag, normalised. */
function moneyFromBag(bag: ShopifyMoneyBag | null | undefined): MoneyGBP {
  return formatMoneyGBP(bag?.shopMoney?.amount);
}

/* ========================================================================== *
 * Pure projection
 * ========================================================================== */

/**
 * An image with its intrinsic dimensions (Req 18.5).
 *
 * Absent dimensions become `0`, which the client reads as "unknown" and handles
 * with its designed no-image box. Substituting a plausible-looking default would
 * be worse than admitting ignorance: a wrong intrinsic size is a layout shift
 * that only appears once the real image lands.
 */
function projectImage(image: ShopifyImage | null | undefined): {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
} {
  return {
    imageUrl: image?.url ?? null,
    imageWidth: typeof image?.width === "number" ? image.width : 0,
    imageHeight: typeof image?.height === "number" ? image.height : 0,
  };
}

/**
 * The order-level fulfilment status. DERIVED AND NEVER NULL (§6.3 N1, §7.4).
 *
 * ── HOW THE TWO HALVES OF THE SPEC ARE RECONCILED ────────────────────────────
 * §6.3 N1 describes this field as "derived; never null — `UNFULFILLED` when
 * absent", which is a pass-through with a default. §7.4 gives a three-row table
 * (no fulfilments → `UNFULFILLED`; some items outstanding → `PARTIALLY_FULFILLED`;
 * all fulfilled → `FULFILLED`). Read as an exhaustive rule the table would
 * OVERWRITE Shopify's richer vocabulary — `ON_HOLD`, `SCHEDULED`, `RESTOCKED` —
 * and `types.ts` deliberately keeps `ShopifyStatusIdentifier` open precisely
 * because those values occur and the client's copy map is required to be total
 * over unmapped ones (§18.9).
 *
 * So Shopify's own value wins when it has one, and the table is the DERIVATION
 * used when it does not. The two agree wherever they overlap: the table's three
 * outcomes are themselves Shopify `displayFulfillmentStatus` values. Recorded as
 * a spec tension rather than silently resolved.
 *
 * ── BE HONEST ABOUT WHEN THE DERIVATION ACTUALLY RUNS ────────────────────────
 * `Order.displayFulfillmentStatus` is `OrderDisplayFulfillmentStatus!` — NON-NULL
 * — in Admin `2024-10`. So against a conforming Shopify response the supplied
 * value is always present and the three-row branches below are unreachable. They
 * guard a MALFORMED response, not a real Shopify state, and that is the whole of
 * their job: §6.3 N1 requires this field never to be null, and "never" has to
 * hold even when the upstream misbehaves. The tests that exercise the branches
 * pin `displayFulfillmentStatus: null` deliberately, which is a value Shopify does
 * not send — they test the guard, not a reachable path.
 *
 * On the N1 list path the derivation is narrower still: that document does not
 * request `fulfillments`, so `projectOrderSummary` passes `fulfilmentCount: 0` and
 * the only outcome the fallback can produce is `UNFULFILLED` — exactly what §6.3
 * N1 specifies for an absent status, and no more than that.
 */
export function deriveFulfilmentStatus(input: {
  readonly shopifyStatus?: string | null;
  readonly fulfilmentCount?: number;
  readonly outstandingItemCount?: number;
}): string {
  const supplied = typeof input.shopifyStatus === "string" ? input.shopifyStatus.trim() : "";
  if (supplied !== "") {
    return supplied;
  }
  if ((input.fulfilmentCount ?? 0) === 0) {
    return UNFULFILLED;
  }
  return (input.outstandingItemCount ?? 0) > 0 ? PARTIALLY_FULFILLED : FULFILLED;
}

/** A preview thumbnail row (§6.3 N1). Carries no price and no product reference. */
export function projectPreviewLineItem(
  node: ShopifyPreviewLineItemNode,
): PortalOrderPreviewLineItem {
  return {
    title: node.title ?? "",
    quantity: typeof node.quantity === "number" ? node.quantity : 0,
    ...projectImage(node.image),
  };
}

/** The seven fields N1 and N2 share (`PortalOrderCore`), projected once. */
function projectOrderCore(node: ShopifyOrderSummaryNode, fulfilmentStatus: string) {
  // REFUSED, not defaulted. `Order.id` is `ID!` in the Admin schema, so a GID
  // with no numeric tail means the response is not what the schema promises. An
  // `id: ""` fallback would violate the contract's `^\d{1,20}$` while LOOKING
  // valid — the client would render a row whose detail link points at `/orders/`.
  // On the N1 list path there is nothing downstream to catch that, because the
  // ids come from Shopify rather than from a validated request.
  const id = numericIdFromGid(node.id ?? "");
  if (id === null) {
    throw new UnreadableUpstreamValueError("order_id");
  }
  return {
    id,
    name: node.name ?? "",
    processedAt: node.processedAt ?? "",
    financialStatus: node.displayFinancialStatus ?? "",
    fulfilmentStatus,
    totalGBP: moneyFromBag(node.totalPriceSet),
    currencyCode: node.currencyCode ?? "GBP",
  };
}

/** One row of `GET /v1/orders` (§6.3 N1). */
export function projectOrderSummary(node: ShopifyOrderSummaryNode): PortalOrderSummary {
  const lineItems = node.lineItems?.nodes ?? [];
  return {
    ...projectOrderCore(
      node,
      deriveFulfilmentStatus({
        shopifyStatus: node.displayFulfillmentStatus,
        fulfilmentCount: 0,
      }),
    ),
    lineItemCount: lineItems.length,
    previewLineItems: lineItems
      .slice(0, ORDERS_PREVIEW_LINE_ITEMS)
      .map(projectPreviewLineItem),
  };
}

/**
 * A postal address (§6.3 N2).
 *
 * `countryCodeV2` is Shopify's ISO-3166-1 alpha-2 field; the contract calls it
 * `countryCode` because the client wants a country code, not Shopify's field
 * versioning.
 */
export function projectAddress(
  address: ShopifyMailingAddress | null | undefined,
): PortalAddress | null {
  if (!address) {
    return null;
  }
  return {
    firstName: address.firstName ?? null,
    lastName: address.lastName ?? null,
    address1: address.address1 ?? null,
    address2: address.address2 ?? null,
    city: address.city ?? null,
    province: address.province ?? null,
    zip: address.zip ?? null,
    countryCode: address.countryCodeV2 ?? null,
    phone: address.phone ?? null,
  };
}

/**
 * One fulfilment (§6.3 N2, §7.4).
 *
 * TRACKING IS PASSED THROUGH ONLY WHEN SHOPIFY SUPPLIES IT. A fulfilment with
 * `trackingInfo: []` yields three nulls, which is the client's cue to show the
 * state with no tracking control (Req 6.5). The portal never builds a carrier URL
 * from a tracking number: a guessed link that 404s reads to a customer as their
 * parcel being lost, and carrier-specific URL construction would put carrier
 * logic in this codebase with nothing to keep it current.
 *
 * `status` prefers `displayStatus`, which is where Shopify puts the shipment
 * milestones §7.4 row 4 asks to surface per fulfilment (`IN_TRANSIT`,
 * `OUT_FOR_DELIVERY`, `DELIVERED`). The coarser `status` enum — `SUCCESS`,
 * `PENDING` — has no vocabulary for them.
 */
export function projectFulfilment(fulfilment: ShopifyFulfilment): PortalFulfilment {
  const tracking = fulfilment.trackingInfo?.[0];
  return {
    status: fulfilment.displayStatus?.trim() || fulfilment.status?.trim() || UNFULFILLED,
    trackingCompany: tracking?.company ?? null,
    trackingNumber: tracking?.number ?? null,
    // Only Shopify's own URL. Never synthesised.
    trackingUrl: tracking?.url ?? null,
  };
}

/**
 * One detail line item, implementing the four-state product table of §7.5.
 *
 *   published + in stock  → id, handle, `available: true`
 *   published + no stock  → id, handle, `available: false`
 *   unpublished           → id, `handle: null`, `available: false`
 *   deleted               → `productId: null`, `handle: null`, `available: false`
 *
 * `title` and both prices survive all four because Shopify records them ON the
 * order, which is what lets a two-year-old order render after the product is gone
 * (Req 6.9). `productHandle: null` is the client's signal to emit no link — not a
 * flag it has to interpret, but the absence of the thing a link is built from.
 *
 * "Published" means `publishedAt` is set AND, when Shopify tells us, `status` is
 * `ACTIVE`: a `DRAFT` or `ARCHIVED` product has no storefront page to link to, so
 * treating it as published would produce exactly the dead link Req 6.9 forbids.
 */
export function projectOrderLineItem(node: ShopifyDetailLineItemNode): PortalOrderLineItem {
  const product = node.product ?? null;
  const productId = product ? (numericIdFromGid(product.id ?? "") ?? null) : null;
  const status = typeof product?.status === "string" ? product.status.toUpperCase() : null;
  const published =
    product !== null &&
    product.publishedAt !== null &&
    product.publishedAt !== undefined &&
    (status === null || status === "ACTIVE");
  const variant = node.variant ?? null;

  return {
    title: node.title ?? "",
    quantity: typeof node.quantity === "number" ? node.quantity : 0,
    originalUnitPriceGBP: moneyFromBag(node.originalUnitPriceSet),
    discountedTotalGBP: moneyFromBag(node.discountedTotalSet),
    productId,
    variantId: variant ? (numericIdFromGid(variant.id ?? "") ?? null) : null,
    productHandle: published ? (product?.handle ?? null) : null,
    available: published && variant?.availableForSale === true,
    ...projectImage(node.image),
  };
}

/** The `200` body of `GET /v1/orders/:orderId` (§6.3 N2). */
export function projectOrderDetail(node: ShopifyOrderDetailNode): PortalOrderDetail {
  const fulfilments = node.fulfillments ?? [];
  const lineItemNodes = node.lineItems?.nodes ?? [];
  const outstanding = lineItemNodes.reduce(
    (total, item) => total + (typeof item.unfulfilledQuantity === "number" ? item.unfulfilledQuantity : 0),
    0,
  );

  return {
    ...projectOrderCore(
      node,
      deriveFulfilmentStatus({
        shopifyStatus: node.displayFulfillmentStatus,
        fulfilmentCount: fulfilments.length,
        outstandingItemCount: outstanding,
      }),
    ),
    lineItems: lineItemNodes.map(projectOrderLineItem),
    shippingAddress: projectAddress(node.shippingAddress),
    fulfilments: fulfilments.map(projectFulfilment),
    subtotalGBP: moneyFromBag(node.subtotalPriceSet),
    shippingGBP: moneyFromBag(node.totalShippingPriceSet),
    taxGBP: moneyFromBag(node.totalTaxSet),
  };
}

/* ========================================================================== *
 * The scoped reads
 * ========================================================================== */

/** What the orders reads need: an Admin transport and the sanctioned id lookup. */
export interface ScopedOrderReadDeps {
  readonly transport: ScopedGraphqlTransport;
  readonly lookup: ShopifyCustomerIdLookup;
  /** Overrides {@link ORDERS_THROTTLE_BACKOFF}; a test supplies a tighter one. */
  readonly backoff?: BackoffParams;
  /** Injected pauser so a test never waits on a real backoff delay. */
  readonly sleep?: Sleeper;
}

/**
 * Runs one scoped read, retrying ONLY on `THROTTLED` and only within the
 * customer-read budget.
 *
 * `withThrottleRetry` is the SAME retry loop `ShopifyGraphqlPurchaseHistorySource`
 * uses, so the two Shopify reads in this process respond to the same upstream
 * condition the same way. What differs is the policy handed to it — see
 * {@link ORDERS_THROTTLE_BACKOFF} for why a worker's 1 s/10-attempt backoff
 * cannot be reused on a path with a 2.5 s ceiling.
 */
function withOrdersThrottlePolicy<T>(
  deps: ScopedOrderReadDeps,
  operation: () => Promise<T>,
): Promise<T> {
  return withThrottleRetry(operation, {
    backoff: deps.backoff ?? ORDERS_THROTTLE_BACKOFF,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
}

/** A validated N1 request. Carries no customer identifier — the scope does that. */
export interface ScopedOrdersPageRequest {
  readonly pageSize: number;
  readonly cursor?: string | undefined;
}

/**
 * Reads one page of the scope's own orders.
 *
 * A customer with no Shopify id, or one Shopify will not return, yields an EMPTY
 * PAGE rather than a `404`. §6.3 N1 defines no not-found outcome for this
 * endpoint, and Req 6.11 wants a designed empty state for a customer with no
 * orders — which is what such a customer has. `shopifyScope.ts` anticipates this
 * split explicitly: the detail read wants a `404`, the list read wants an empty
 * page.
 *
 * A TRANSPORT failure is NOT caught here. It propagates so the route can answer
 * `502 upstream_unavailable`; converting it to an empty page would tell a
 * customer they have never ordered anything because Shopify was briefly down.
 */
export async function readScopedOrdersPage(
  deps: ScopedOrderReadDeps,
  scope: CustomerScope,
  request: ScopedOrdersPageRequest,
): Promise<PortalOrdersResponse> {
  let customer: OrdersPageCustomerNode;
  try {
    customer = await withOrdersThrottlePolicy(deps, () =>
      runScopedCustomerQuery<OrdersPageCustomerNode>(
        deps.transport,
        deps.lookup,
        scope,
        PORTAL_ORDERS_PAGE_QUERY,
        {
          pageSize: request.pageSize,
          cursor: request.cursor ?? null,
          lineItemWindow: ORDERS_LINE_ITEM_WINDOW,
        },
        // An orders-specific code rather than the generic default, so this catch
        // matches ONLY the condition it means to. Matching on `not_found` would
        // swallow any future not-found raised on this path into an empty page.
        "order_not_found",
      ),
    );
  } catch (err) {
    if (err instanceof PortalRepositoryError && err.code === "order_not_found") {
      return { orders: [], pageInfo: { hasNextPage: false, endCursor: null } };
    }
    throw err;
  }

  const orders = customer.orders?.nodes ?? [];
  return {
    orders: orders.map(projectOrderSummary),
    pageInfo: {
      hasNextPage: customer.orders?.pageInfo?.hasNextPage === true,
      endCursor: customer.orders?.pageInfo?.endCursor ?? null,
    },
  };
}

/**
 * Reads one of the scope's own orders in full, or `null` when there is no such
 * order in the scope's connection.
 *
 * `null` covers both "no such order anywhere" and "that order belongs to someone
 * else", and it covers them IDENTICALLY, because the traversal cannot tell them
 * apart — a foreign order is simply not in the connection. That is what closes
 * the existence oracle of §4.5 row 14 structurally rather than by remembering to
 * return the same body in two branches.
 *
 * @throws {InvalidOrderReferenceError} the reference is not `^\d{1,20}$`
 */
export async function readScopedOrderDetail(
  deps: ScopedOrderReadDeps,
  scope: CustomerScope,
  orderReference: string,
): Promise<PortalOrderDetail | null> {
  if (!ORDER_ID_PATTERN.test(orderReference)) {
    // Re-checked at the boundary that builds the search expression, so the
    // expression can never be assembled from an unvalidated string.
    throw new InvalidOrderReferenceError();
  }

  let customer: OrderDetailCustomerNode;
  try {
    customer = await withOrdersThrottlePolicy(deps, () =>
      runScopedCustomerQuery<OrderDetailCustomerNode>(
        deps.transport,
        deps.lookup,
        scope,
        PORTAL_ORDER_DETAIL_QUERY,
        {
          orderQuery: `id:${orderReference}`,
          lineItemLimit: ORDER_DETAIL_LINE_ITEM_LIMIT,
          fulfilmentLimit: ORDER_DETAIL_FULFILMENT_LIMIT,
          trackingLimit: ORDER_DETAIL_TRACKING_LIMIT,
        },
        "order_not_found",
      ),
    );
  } catch (err) {
    if (err instanceof PortalRepositoryError && err.code === "order_not_found") {
      // No Shopify customer, or Shopify would not return them. Indistinguishable
      // from "no such order for this caller", which is the correct answer.
      return null;
    }
    throw err;
  }

  const node = customer.orders?.nodes?.[0];
  if (!node) {
    return null;
  }

  const detail = projectOrderDetail(node);
  if (detail.id !== orderReference) {
    // THE POST-CONDITION, and it is not paranoia. Without it, WHICH order comes
    // back is guaranteed solely by Shopify's `query: "id:N"` search semantics —
    // so the "a foreign order is unreachable" property of §4.5 row 6 would be a
    // property of a search DSL we do not own rather than of this code. A search
    // that widened, matched on a different field, or returned a relevance-ordered
    // first hit would silently serve one order under another's reference.
    //
    // `null`, identical to "no such order", because from the caller's side that is
    // exactly what it is: the order they asked for was not returned. Serving the
    // other order would be worse than a 404 — the customer would read someone
    // else's totals as their own, and every id in the response would be
    // self-consistent, so nothing would look wrong.
    return null;
  }
  return detail;
}
