/**
 * Unit tests for the concrete Shopify Admin GraphQL clients (tasks 5.4 & 6.7).
 *
 * NO live/production Shopify Admin API is touched: a fake `fetch` is injected
 * and every response (success, `userErrors`, HTTP 429, GraphQL `THROTTLED`) is
 * scripted. The tests assert the exact endpoint, headers, and GraphQL body for
 * both clients, the success mapping, and the error-mapping contract the
 * gateway/writer depend on:
 *   - HTTP 429 / GraphQL `THROTTLED` -> ShopifyThrottleError (retryable);
 *   - HTTP errors / GraphQL errors / mutation userErrors -> ShopifyAdminRequestError (hard);
 *   - the access token NEVER appears in a thrown error.
 */
import { describe, expect, it } from "vitest";
import { ShopifyThrottleError, type DiscountInput } from "./adminGateway.js";
import type { MetafieldWriteInput } from "./metafieldCache.js";
import {
  ACCESS_TOKEN_HEADER,
  ADMIN_API_VERSION,
  ShopifyAdminRequestError,
  type FetchLike,
  type FetchRequestInit,
  type HttpResponse,
} from "./graphqlClient.js";
import { ShopifyGraphqlAdminClient, ShopifyGraphqlMetafieldClient } from "./adminClient.js";

const SHOP = "myathoorlondon.myshopify.com";
const TOKEN = "shpat_super_secret_token_value";
const EXPECTED_URL = `https://${SHOP}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

const DISCOUNT_INPUT: DiscountInput = {
  customerGid: "gid://shopify/Customer/123",
  amountOffGBP: 15,
  code: "ATH-9F3K-2QX7",
  usageLimit: 1,
  appliesOncePerCustomer: true,
  redemptionId: "redemption-1",
};

const METAFIELD_INPUT: MetafieldWriteInput = {
  customerGid: "gid://shopify/Customer/123",
  metafields: [
    { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "150" },
    { namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "silver" },
  ],
};

/** A recording fake `fetch` that returns a scripted JSON body + status. */
function fakeFetch(script: {
  status?: number;
  ok?: boolean;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  throwErr?: unknown;
}): { fetch: FetchLike; calls: Array<{ url: string; init: FetchRequestInit }> } {
  const calls: Array<{ url: string; init: FetchRequestInit }> = [];
  const status = script.status ?? 200;
  const ok = script.ok ?? (status >= 200 && status < 300);
  const headers = script.headers ?? {};
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (script.throwErr) throw script.throwErr;
    const res: HttpResponse = {
      ok,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
      text: async () =>
        script.rawBody ?? JSON.stringify(script.body ?? { data: {} }),
    };
    return res;
  };
  return { fetch, calls };
}

/* -------------------------- discount-code client -------------------------- */

describe("ShopifyGraphqlAdminClient.createSingleUseDiscount", () => {
  it("POSTs the correct endpoint, headers, and GraphQL body", async () => {
    const { fetch, calls } = fakeFetch({
      body: {
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/987",
              codeDiscount: { title: "t", codes: { nodes: [{ code: DISCOUNT_INPUT.code }] } },
            },
            userErrors: [],
          },
        },
      },
    });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    await client.createSingleUseDiscount(DISCOUNT_INPUT);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(EXPECTED_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers[ACCESS_TOKEN_HEADER]).toBe(TOKEN);
    expect(call.init.headers["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(call.init.body) as {
      query: string;
      variables: { basicCodeDiscount: Record<string, unknown> };
    };
    expect(parsed.query).toContain("discountCodeBasicCreate");
    const d = parsed.variables.basicCodeDiscount;
    expect(d.code).toBe(DISCOUNT_INPUT.code);
    expect(d.usageLimit).toBe(1);
    expect(d.appliesOncePerCustomer).toBe(true);
    expect(d.customerSelection).toEqual({ customers: { add: [DISCOUNT_INPUT.customerGid] } });
    // GBP amount off, formatted to 2dp.
    expect(JSON.stringify(d.customerGets)).toContain('"amount":"15.00"');
  });

  it("maps a successful response to a DiscountCode (discount id parsed from GID)", async () => {
    const { fetch } = fakeFetch({
      body: {
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/987",
              codeDiscount: { title: "t", codes: { nodes: [{ code: DISCOUNT_INPUT.code }] } },
            },
            userErrors: [],
          },
        },
      },
    });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    const result = await client.createSingleUseDiscount(DISCOUNT_INPUT);

    expect(result).toEqual({
      code: DISCOUNT_INPUT.code,
      shopifyPriceRuleId: null,
      shopifyDiscountId: 987,
      amountOffGBP: 15,
    });
  });

  it("maps mutation userErrors to a hard ShopifyAdminRequestError", async () => {
    const { fetch } = fakeFetch({
      body: {
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [{ field: ["code"], message: "Code has already been taken", code: "TAKEN" }],
          },
        },
      },
    });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    const err = await client.createSingleUseDiscount(DISCOUNT_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyAdminRequestError);
    expect((err as ShopifyAdminRequestError).userErrors?.[0]?.message).toContain("already been taken");
  });

  it("maps HTTP 429 to a retryable ShopifyThrottleError (with Retry-After)", async () => {
    const { fetch } = fakeFetch({ status: 429, ok: false, headers: { "Retry-After": "2" } });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    const err = await client.createSingleUseDiscount(DISCOUNT_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyThrottleError);
    expect((err as ShopifyThrottleError).retryAfterSeconds).toBe(2);
  });

  it("maps a GraphQL THROTTLED top-level error to a retryable ShopifyThrottleError", async () => {
    const { fetch } = fakeFetch({
      body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
    });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    await expect(client.createSingleUseDiscount(DISCOUNT_INPUT)).rejects.toBeInstanceOf(
      ShopifyThrottleError,
    );
  });

  it("maps non-throttle GraphQL errors to a hard ShopifyAdminRequestError", async () => {
    const { fetch } = fakeFetch({
      body: { errors: [{ message: "Field 'x' doesn't exist", extensions: { code: "undefinedField" } }] },
    });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    await expect(client.createSingleUseDiscount(DISCOUNT_INPUT)).rejects.toBeInstanceOf(
      ShopifyAdminRequestError,
    );
  });

  it("never leaks the access token in a thrown error", async () => {
    const { fetch } = fakeFetch({ status: 500, ok: false });
    const client = new ShopifyGraphqlAdminClient(SHOP, TOKEN, fetch);

    const err = await client.createSingleUseDiscount(DISCOUNT_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyAdminRequestError);
    const serialized = `${(err as Error).message} ${JSON.stringify(err)} ${(err as Error).stack ?? ""}`;
    expect(serialized).not.toContain(TOKEN);
  });
});

/* ----------------------------- metafield client --------------------------- */

describe("ShopifyGraphqlMetafieldClient.writeCustomerMetafields", () => {
  it("POSTs metafieldsSet with ownerId-bound metafields to the correct endpoint", async () => {
    const { fetch, calls } = fakeFetch({
      body: {
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/1", namespace: "loyalty", key: "points_balance" }],
            userErrors: [],
          },
        },
      },
    });
    const client = new ShopifyGraphqlMetafieldClient(SHOP, TOKEN, fetch);

    await client.writeCustomerMetafields(METAFIELD_INPUT);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(EXPECTED_URL);
    expect(call.init.headers[ACCESS_TOKEN_HEADER]).toBe(TOKEN);

    const parsed = JSON.parse(call.init.body) as {
      query: string;
      variables: { metafields: Array<Record<string, unknown>> };
    };
    expect(parsed.query).toContain("metafieldsSet");
    expect(parsed.variables.metafields).toEqual([
      {
        ownerId: METAFIELD_INPUT.customerGid,
        namespace: "loyalty",
        key: "points_balance",
        type: "number_integer",
        value: "150",
      },
      {
        ownerId: METAFIELD_INPUT.customerGid,
        namespace: "loyalty",
        key: "tier",
        type: "single_line_text_field",
        value: "silver",
      },
    ]);
  });

  it("resolves on a successful write (no userErrors)", async () => {
    const { fetch } = fakeFetch({
      body: { data: { metafieldsSet: { metafields: [], userErrors: [] } } },
    });
    const client = new ShopifyGraphqlMetafieldClient(SHOP, TOKEN, fetch);

    await expect(client.writeCustomerMetafields(METAFIELD_INPUT)).resolves.toBeUndefined();
  });

  it("maps metafieldsSet userErrors to a hard ShopifyAdminRequestError", async () => {
    const { fetch } = fakeFetch({
      body: {
        data: {
          metafieldsSet: {
            metafields: [],
            userErrors: [{ field: ["value"], message: "invalid value", code: "INVALID" }],
          },
        },
      },
    });
    const client = new ShopifyGraphqlMetafieldClient(SHOP, TOKEN, fetch);

    await expect(client.writeCustomerMetafields(METAFIELD_INPUT)).rejects.toBeInstanceOf(
      ShopifyAdminRequestError,
    );
  });

  it("maps HTTP 429 to a retryable ShopifyThrottleError", async () => {
    const { fetch } = fakeFetch({ status: 429, ok: false });
    const client = new ShopifyGraphqlMetafieldClient(SHOP, TOKEN, fetch);

    await expect(client.writeCustomerMetafields(METAFIELD_INPUT)).rejects.toBeInstanceOf(
      ShopifyThrottleError,
    );
  });

  it("maps a GraphQL THROTTLED top-level error to a retryable ShopifyThrottleError", async () => {
    const { fetch } = fakeFetch({
      body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
    });
    const client = new ShopifyGraphqlMetafieldClient(SHOP, TOKEN, fetch);

    await expect(client.writeCustomerMetafields(METAFIELD_INPUT)).rejects.toBeInstanceOf(
      ShopifyThrottleError,
    );
  });

  it("never leaks the access token in a thrown error", async () => {
    const { fetch } = fakeFetch({ throwErr: new Error("network down") });
    const client = new ShopifyGraphqlMetafieldClient(SHOP, TOKEN, fetch);

    const err = await client.writeCustomerMetafields(METAFIELD_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyAdminRequestError);
    const serialized = `${(err as Error).message} ${JSON.stringify(err)} ${(err as Error).stack ?? ""}`;
    expect(serialized).not.toContain(TOKEN);
  });
});
