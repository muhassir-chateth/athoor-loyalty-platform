/**
 * Tests for the portal's Shopify-boundary choke point (spec task 5.4).
 *
 * The transport and the id lookup are both fakes, so nothing here reaches live
 * Shopify or a live database — and the fake transport RECORDS the document and
 * variables it was handed, because the guarantee under test is about what would
 * be sent, not about what comes back.
 *
 * SAFETY: no network, no Postgres, no production.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.6
 */
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { requireCustomerScope, type CustomerScope } from "../../auth/customerScope.js";
import type { ShopifyCustomerIdLookup } from "../../shopify/purchaseHistory.js";
import { PortalResourceNotFoundError } from "./scopedQuery.js";
import {
  SCOPED_CUSTOMER_VARIABLE,
  UnscopedShopifyQueryError,
  assertScopedCustomerQuery,
  resolveScopedCustomerGid,
  runScopedCustomerQuery,
  type ScopedGraphqlTransport,
} from "./shopifyScope.js";

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
  constructor(private readonly reply: unknown = { customer: { id: "gid://shopify/Customer/1" } }) {}
  async request<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    this.calls.push({ document, variables });
    return this.reply as T;
  }
}

/** The shape every portal Shopify read must take. */
const VALID_DOCUMENT = /* GraphQL */ `
  query portalOrders($customerGid: ID!, $pageSize: Int!) {
    customer(id: $customerGid) {
      orders(first: $pageSize, reverse: true, sortKey: PROCESSED_AT) {
        nodes {
          id
          name
        }
      }
    }
  }
`;

/* ========================================================================== *
 * The document guard
 * ========================================================================== */

describe("assertScopedCustomerQuery accepts only a customer-rooted read (design §4.3 Rule 2)", () => {
  it("accepts the customer traversal", () => {
    expect(() => assertScopedCustomerQuery(VALID_DOCUMENT)).not.toThrow();
  });

  it("accepts a variable default containing a brace", () => {
    // A validator that took `indexOf("{")` as the selection set would read `a` as
    // the first field here and reject a safe document — and a rule that produces
    // false rejections gets loosened.
    expect(() =>
      assertScopedCustomerQuery(`query q($customerGid: ID!, $filter: F = { a: 1 }) {
        customer(id: $customerGid) { id }
      }`),
    ).not.toThrow();
  });

  it.each([
    [
      "the top-level order(id:) form this task forbids outright",
      `query q($customerGid: ID!, $id: ID!) { customer(id: $customerGid) { id } order(id: $id) { id } }`,
      "forbidden_root_field",
    ],
    [
      "a bare by-order-id read",
      `query q($id: ID!) { order(id: $id) { id name } }`,
      "missing_customer_variable_declaration",
    ],
    [
      "the node(id:) escape hatch",
      `query q($customerGid: ID!, $id: ID!) { customer(id: $customerGid) { id } node(id: $id) { id } }`,
      "forbidden_root_field",
    ],
    [
      "a bulk nodes(ids:) read",
      `query q($customerGid: ID!, $ids: [ID!]!) { customer(id: $customerGid) { id } nodes(ids: $ids) { id } }`,
      "forbidden_root_field",
    ],
    [
      "the customers( connection, which ranges over the whole shop",
      `query q($customerGid: ID!) { customers(first: 10) { nodes { id } } customer(id: $customerGid) { id } }`,
      "forbidden_root_field",
    ],
    [
      "a customer traversal that is not the first field",
      `query q($customerGid: ID!) { shop { name } customer(id: $customerGid) { id } }`,
      "customer_not_first_field",
    ],
    [
      "a traversal bound to some other variable",
      `query q($customerGid: ID!, $other: ID!) { customer(id: $other) { id } }`,
      "missing_customer_traversal",
    ],
    [
      "a mutation reaching the read path",
      `mutation m($customerGid: ID!) { customer(id: $customerGid) { id } }`,
      "contains_mutation",
    ],
    [
      "an anonymous document with no declarations to check",
      `{ customer(id: $customerGid) { id } }`,
      "not_a_query",
    ],
    ["an interpolated document", "query q($customerGid: ID!) { customer(id: ${gid}) { id } }", "interpolated_document"],
    ["an empty document", "   ", "empty_document"],
  ])("refuses %s", (_label, document, reason) => {
    let thrown: unknown;
    try {
      assertScopedCustomerQuery(document);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnscopedShopifyQueryError);
    expect((thrown as UnscopedShopifyQueryError).reason).toBe(reason);
  });

  it("refuses the exact pagination shape the shipped purchase-history reader uses", () => {
    // `shopify/purchaseHistory.ts` pages an order's line items with
    // `order(id:)`. It is safe THERE — the id came from inside that customer's
    // own orders connection. It is exactly what a portal author would copy into
    // N2's deep pagination, at which point provenance becomes an argument rather
    // than a guarantee. Refused here so the copy cannot happen quietly.
    expect(() =>
      assertScopedCustomerQuery(`query orderLineItems($customerGid: ID!, $id: ID!) {
        customer(id: $customerGid) { id }
        order(id: $id) { lineItems(first: 50) { nodes { product { id } } } }
      }`),
    ).toThrow(UnscopedShopifyQueryError);
  });
});

/* ========================================================================== *
 * The GID is derived, never accepted
 * ========================================================================== */

describe("the customer GID comes only from the sanctioned lookup (design §4.3 Rule 3)", () => {
  it("asks the lookup for the scope's own local customer id and nothing else", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A, [CUSTOMER_B]: SHOPIFY_B });
    const gid = await resolveScopedCustomerGid(lookup, SCOPE_A);
    expect(lookup.asked).toEqual([CUSTOMER_A]);
    expect(gid).toBe(`gid://shopify/Customer/${SHOPIFY_A}`);
  });

  it("returns null when the customer has no Shopify id recorded", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: null });
    await expect(resolveScopedCustomerGid(lookup, SCOPE_A)).resolves.toBeNull();
  });

  it.each([
    ["a GID rather than a numeric id", "gid://shopify/Customer/123"],
    ["an injected traversal", '123) { id } } customer(id: "456"'],
    ["a non-numeric value", "not-an-id"],
    ["an empty string", ""],
  ])("refuses to build a GID from %s", async (_label, stored) => {
    // Re-validated AFTER the lookup returns, so a malformed column value cannot
    // produce a GID Shopify might interpret loosely.
    const lookup = new FakeLookup({ [CUSTOMER_A]: stored });
    await expect(resolveScopedCustomerGid(lookup, SCOPE_A)).resolves.toBeNull();
  });
});

/* ========================================================================== *
 * The primitive owns the customer variable
 * ========================================================================== */

describe("runScopedCustomerQuery binds the customer variable itself (Requirement 2.1)", () => {
  it("sends the derived GID alongside the caller's own variables", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A });
    const transport = new RecordingTransport({ customer: { orders: { nodes: [] } } });

    await runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, { pageSize: 20 });

    expect(transport.calls[0]?.variables).toEqual({
      pageSize: 20,
      [SCOPED_CUSTOMER_VARIABLE]: `gid://shopify/Customer/${SHOPIFY_A}`,
    });
  });

  it("refuses a caller that tries to supply the customer variable", async () => {
    // Silently overriding it would let a call site believe it had chosen the
    // customer — and the next reader of that call site would believe it too.
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A, [CUSTOMER_B]: SHOPIFY_B });
    const transport = new RecordingTransport();

    let thrown: unknown;
    try {
      await runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, {
        pageSize: 20,
        [SCOPED_CUSTOMER_VARIABLE]: `gid://shopify/Customer/${SHOPIFY_B}`,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnscopedShopifyQueryError);
    expect((thrown as UnscopedShopifyQueryError).reason).toBe("caller_supplied_customer_variable");
    expect(transport.calls).toEqual([]);
  });

  it("sends the same document for two customers with only the GID differing", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A, [CUSTOMER_B]: SHOPIFY_B });
    const transport = new RecordingTransport({ customer: { orders: { nodes: [] } } });

    await runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, { pageSize: 1 });
    await runScopedCustomerQuery(transport, lookup, SCOPE_B, VALID_DOCUMENT, { pageSize: 1 });

    expect(transport.calls[0]?.document).toBe(transport.calls[1]?.document);
    expect(transport.calls[0]?.variables[SCOPED_CUSTOMER_VARIABLE]).toContain(SHOPIFY_A);
    expect(transport.calls[1]?.variables[SCOPED_CUSTOMER_VARIABLE]).toContain(SHOPIFY_B);
  });

  it("makes no request at all when the document breaks the contract", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A });
    const transport = new RecordingTransport();

    await expect(
      runScopedCustomerQuery(transport, lookup, SCOPE_A, `query q($id: ID!) { order(id: $id) { id } }`),
    ).rejects.toBeInstanceOf(UnscopedShopifyQueryError);

    expect(transport.calls).toEqual([]);
    // The lookup is not even consulted: validation precedes derivation, so a bad
    // document costs no database read.
    expect(lookup.asked).toEqual([]);
  });

  it("returns the customer node, not the envelope", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A });
    const orders = { orders: { nodes: [{ id: "1", name: "#1042" }] } };
    const transport = new RecordingTransport({ customer: orders });

    await expect(
      runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, { pageSize: 20 }),
    ).resolves.toEqual(orders);
  });
});

/* ========================================================================== *
 * Failure mapping
 * ========================================================================== */

describe("failures map to the outcome the customer should see", () => {
  it("maps an absent Shopify customer to 404 with the caller's chosen code", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: null });
    const transport = new RecordingTransport();

    let thrown: unknown;
    try {
      await runScopedCustomerQuery(
        transport,
        lookup,
        SCOPE_A,
        VALID_DOCUMENT,
        { pageSize: 20 },
        "order_not_found",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortalResourceNotFoundError);
    expect((thrown as PortalResourceNotFoundError).code).toBe("order_not_found");
    expect(transport.calls).toEqual([]);
  });

  it("maps a null customer node to the same 404, so neither case is an oracle", async () => {
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A });
    const transport = new RecordingTransport({ customer: null });

    await expect(
      runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, { pageSize: 20 }),
    ).rejects.toBeInstanceOf(PortalResourceNotFoundError);
  });

  it("lets a transport failure propagate rather than becoming a 404", async () => {
    // "Shopify is down" must not read as "you have no orders" — §6.3 N1 maps this
    // to 502 upstream_unavailable at the route, which is only possible if the
    // repository does not swallow it first.
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A });
    const upstream = new Error("upstream exploded");
    const transport: ScopedGraphqlTransport = {
      async request<T>(): Promise<T> {
        throw upstream;
      },
    };

    await expect(
      runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, { pageSize: 20 }),
    ).rejects.toBe(upstream);
  });

  it("treats an empty connection as data rather than as a missing customer", async () => {
    // A foreign order id under the customer traversal yields an empty `nodes`
    // array — the order is UNREACHABLE, not rejected. Whether that becomes a 404
    // is the endpoint's decision (task 8.2); this layer returns the node.
    const lookup = new FakeLookup({ [CUSTOMER_A]: SHOPIFY_A });
    const transport = new RecordingTransport({ customer: { orders: { nodes: [] } } });

    await expect(
      runScopedCustomerQuery(transport, lookup, SCOPE_A, VALID_DOCUMENT, { pageSize: 20 }),
    ).resolves.toEqual({ orders: { nodes: [] } });
  });
});
