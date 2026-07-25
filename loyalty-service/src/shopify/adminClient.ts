/**
 * Concrete Shopify Admin API clients (tasks 5.4 & 6.7).
 *
 * These are the PRODUCTION implementations of the two injectable boundaries the
 * higher-level components depend on:
 *   - {@link ShopifyGraphqlAdminClient} implements {@link ShopifyAdminClient}
 *     (from `adminGateway.ts`): mints a single-use, customer-bound discount code
 *     via `discountCodeBasicCreate` (Req 3.5 / 3.6, Property 10).
 *   - {@link ShopifyGraphqlMetafieldClient} implements
 *     {@link CustomerMetafieldClient} (from `metafieldCache.ts`): writes the
 *     `loyalty.*` display metafields via `metafieldsSet` (Req 15.5).
 *
 * Both speak the Admin GraphQL API through the shared
 * {@link ShopifyGraphqlTransport}, which enforces the error-mapping contract the
 * gateway/writer rely on:
 *   - HTTP 429 / GraphQL `THROTTLED` → {@link ShopifyThrottleError} (retryable);
 *   - everything else (HTTP errors, GraphQL `errors`, mutation `userErrors`) →
 *     {@link ShopifyAdminRequestError} (hard failure).
 *
 * SECURITY: HTTPS only; the access token travels solely in the
 * `X-Shopify-Access-Token` header and is never logged or embedded in a thrown
 * error. Both clients are side-effect-free at construction and take an optional
 * injected `fetch` so tests never touch the network.
 */
import type {
  DiscountCode,
  DiscountInput,
  ShopifyAdminClient,
} from "./adminGateway.js";
import type {
  CustomerMetafieldClient,
  MetafieldWriteInput,
} from "./metafieldCache.js";
import {
  assertNoUserErrors,
  numericIdFromGid,
  ShopifyGraphqlTransport,
  type FetchLike,
  type ShopifyUserError,
} from "./graphqlClient.js";

/* -------------------------------------------------------------------------- */
/* Discount-code client (Req 3.5 / 3.6, Property 10)                          */
/* -------------------------------------------------------------------------- */

/** The `discountCodeBasicCreate` mutation minting a single-use, customer-bound code. */
const DISCOUNT_CODE_BASIC_CREATE = /* GraphQL */ `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            codes(first: 1) {
              nodes { code }
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface DiscountCodeBasicCreateData {
  discountCodeBasicCreate: {
    codeDiscountNode: {
      id: string;
      codeDiscount: { title?: string; codes?: { nodes: Array<{ code: string }> } } | null;
    } | null;
    userErrors: ShopifyUserError[];
  };
}

/**
 * Builds the `DiscountCodeBasicInput` for a redemption: a fixed GBP amount off,
 * `usageLimit: 1`, `appliesOncePerCustomer: true`, and `customerSelection`
 * bound to the single customer GID (Req 3.6, Property 10). The amount is sent as
 * a decimal string in the shop currency (GBP).
 */
function buildDiscountInput(input: DiscountInput): Record<string, unknown> {
  return {
    title: `Loyalty reward ${input.code}`,
    code: input.code,
    startsAt: new Date().toISOString(),
    usageLimit: input.usageLimit,
    appliesOncePerCustomer: input.appliesOncePerCustomer,
    customerSelection: {
      customers: { add: [input.customerGid] },
    },
    customerGets: {
      value: {
        discountAmount: {
          amount: input.amountOffGBP.toFixed(2),
          appliesOnEachItem: false,
        },
      },
      items: { all: true },
    },
  };
}

/**
 * Concrete {@link ShopifyAdminClient} backed by the Admin GraphQL API. Wired by
 * the {@link ShopifyAdminGateway}, which supplies the backoff/retry loop; this
 * client just performs one mutation per call and translates the response into a
 * {@link DiscountCode}, throwing the throttle/hard-failure errors the gateway
 * expects.
 */
export class ShopifyGraphqlAdminClient implements ShopifyAdminClient {
  private readonly transport: ShopifyGraphqlTransport;

  constructor(shopDomain: string, accessToken: string, fetchImpl?: FetchLike) {
    this.transport = new ShopifyGraphqlTransport(shopDomain, accessToken, fetchImpl);
  }

  async createSingleUseDiscount(input: DiscountInput): Promise<DiscountCode> {
    const data = await this.transport.request<DiscountCodeBasicCreateData>(
      DISCOUNT_CODE_BASIC_CREATE,
      { basicCodeDiscount: buildDiscountInput(input) },
    );

    const payload = data.discountCodeBasicCreate;
    assertNoUserErrors("discountCodeBasicCreate", payload.userErrors);

    const node = payload.codeDiscountNode;
    // The new Discounts API has no price rule; expose the discount node id only.
    const shopifyDiscountId = numericIdFromGid(node?.id);
    const returnedCode = node?.codeDiscount?.codes?.nodes[0]?.code ?? input.code;

    return {
      code: returnedCode,
      shopifyPriceRuleId: null,
      shopifyDiscountId,
      amountOffGBP: input.amountOffGBP,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Metafield client (Req 15.5)                                                */
/* -------------------------------------------------------------------------- */

/** The `metafieldsSet` mutation upserting the `loyalty.*` display metafields. */
const METAFIELDS_SET = /* GraphQL */ `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldsSetData {
  metafieldsSet: {
    metafields: Array<{ id: string; namespace: string; key: string }> | null;
    userErrors: ShopifyUserError[];
  };
}

/**
 * Concrete {@link CustomerMetafieldClient} backed by the Admin GraphQL API.
 * Wired by the {@link MetafieldCacheWriter}, which supplies the non-fatal
 * retry/preserve-last-known-good behaviour; this client just performs one
 * `metafieldsSet` per call. A resolved promise means the write succeeded; any
 * failure throws (throttle → retryable, else hard) so the writer can retry.
 */
export class ShopifyGraphqlMetafieldClient implements CustomerMetafieldClient {
  private readonly transport: ShopifyGraphqlTransport;

  constructor(shopDomain: string, accessToken: string, fetchImpl?: FetchLike) {
    this.transport = new ShopifyGraphqlTransport(shopDomain, accessToken, fetchImpl);
  }

  async writeCustomerMetafields(input: MetafieldWriteInput): Promise<void> {
    const metafields = input.metafields.map((f) => ({
      ownerId: input.customerGid,
      namespace: f.namespace,
      key: f.key,
      type: f.type,
      value: f.value,
    }));

    const data = await this.transport.request<MetafieldsSetData>(METAFIELDS_SET, { metafields });
    assertNoUserErrors("metafieldsSet", data.metafieldsSet.userErrors);
  }
}
