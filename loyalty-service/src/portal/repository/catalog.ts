/**
 * THE GLOBAL CATALOGUE READ (spec task 8.4, design §6.3 N4).
 *
 * `GET /v1/catalog/products?ids=` answers "what is true about these products
 * right now" — current price, availability, handle, image. It is the enrichment
 * behind the wishlist (Req 7.4) and the product-state matrix of §7.5.
 *
 * ── WHY THIS FILE IS A DIFFERENT SECURITY CLASS FROM `orders.ts` ─────────────
 * Every other document in this directory is rooted at `customer(id: $customerGid)`
 * and validated by `assertScopedCustomerQuery`. This one CANNOT be: products are
 * global data with no customer to scope to. Rather than loosen the scoped gate —
 * which is the portal's only structural defence against reading another
 * customer's orders — this document belongs to the second, equally fail-closed
 * class and is validated by {@link assertGlobalCatalogueQuery}, which proves the
 * INVERSE property: the query cannot reach customer-owned data at all.
 *
 * `ownership.gate.test.ts` assigns every document here to exactly one class by
 * FILENAME, never by content. That direction matters: if the class were inferred
 * from what a document contains, removing a customer traversal would silently
 * downgrade a document to the weaker gate. Declaring the class per file means a
 * customer read cannot become a catalogue read by being edited.
 *
 * ── THE ID SUBSTITUTION HAZARD, AND WHAT CLOSES IT ──────────────────────────
 * `nodes(ids:)` resolves ANY GID, so a caller who could supply one could ask for
 * `gid://shopify/Customer/123`. They cannot: the route accepts DIGITS, and
 * `runGlobalCatalogueQuery` templates `gid://shopify/Product/<digits>` itself. The
 * `Product` segment is a literal in our code, exactly as `Customer` is on the
 * scoped path. A caller can choose WHICH product, never WHICH TYPE.
 *
 * SAFETY: read-only. No mutation, no Postgres write, and nothing here is stored —
 * §6.3 N4 calls this data non-authoritative and it is cached in process only.
 */
import {
  assertGlobalCatalogueQuery,
  runGlobalCatalogueQuery,
  type ScopedGraphqlTransport,
} from "./shopifyScope.js";
import { formatMoneyGBP, UnreadableUpstreamValueError } from "./orders.js";
import type { MoneyGBP, PortalCatalogProduct, PortalCatalogResponse } from "../types.js";

/**
 * How many variants are read per product to resolve a default.
 *
 * ONE. §6.3 N4 returns a single `defaultVariantId`, and Shopify orders a
 * product's variants by position, so the first is the default. Reading more would
 * cost query cost for a field the contract does not have.
 */
export const CATALOG_VARIANT_WINDOW = 1;

/**
 * The N4 document. Rooted at `nodes(ids:)` with `... on Product` as the ONLY
 * inline fragment, which is what {@link assertGlobalCatalogueQuery} requires.
 */
export const PORTAL_CATALOG_PRODUCTS_QUERY = /* GraphQL */ `
  query portalCatalogProducts($ids: [ID!]!, $variantWindow: Int!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        status
        publishedAt
        availableForSale
        featuredImage {
          url
          width
          height
        }
        priceRangeV2 {
          minVariantPrice {
            amount
          }
        }
        compareAtPriceRange {
          minVariantCompareAtPrice {
            amount
          }
        }
        variants(first: $variantWindow) {
          nodes {
            id
          }
        }
      }
    }
  }
`;

/** A `Product` node as the N4 document selects it. Every field optional — this is upstream data. */
export interface ShopifyCatalogProductNode {
  readonly id?: string | null;
  readonly title?: string | null;
  readonly handle?: string | null;
  readonly status?: string | null;
  readonly publishedAt?: string | null;
  readonly availableForSale?: boolean | null;
  readonly featuredImage?: { url?: string | null; width?: number | null; height?: number | null } | null;
  readonly priceRangeV2?: { minVariantPrice?: { amount?: string | null } | null } | null;
  readonly compareAtPriceRange?: {
    minVariantCompareAtPrice?: { amount?: string | null } | null;
  } | null;
  readonly variants?: { nodes?: readonly { id?: string | null }[] | null } | null;
}

interface CatalogNodesEnvelope {
  readonly nodes?: readonly (ShopifyCatalogProductNode | null)[] | null;
}

/** `gid://shopify/Product/1001` → `"1001"`. Returns null for any other shape. */
export function numericProductIdFromGid(gid: string | null | undefined): string | null {
  if (typeof gid !== "string") return null;
  const match = /^gid:\/\/shopify\/Product\/(\d{1,20})$/.exec(gid);
  return match?.[1] ?? null;
}

/**
 * `gid://shopify/ProductVariant/4477` → `"4477"`. Returns null for any other shape.
 *
 * NUMERIC, NOT THE GID, because of who consumes it. `defaultVariantId` and N3's
 * `addable[].variantId` both exist so the client can post to Shopify's own
 * `/cart/add.js`, and that endpoint takes a numeric variant id. §6.3 N3's example
 * shows `"variantId": "4477"` for the same reason. Returning a GID would make
 * every client strip the prefix, and one of them would eventually do it wrong.
 */
export function numericVariantIdFromGid(gid: string | null | undefined): string | null {
  if (typeof gid !== "string") return null;
  const match = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/.exec(gid);
  return match?.[1] ?? null;
}

/**
 * Whether a product is published.
 *
 * BOTH conditions, because either alone is wrong: `status: ACTIVE` with a null
 * `publishedAt` is a product active in the admin but not on the storefront, and a
 * `publishedAt` on an ARCHIVED product is a stale timestamp. §7.5's "unpublished"
 * row must be true for both, since the consequence — render no link — is the same.
 */
export function derivePublished(node: ShopifyCatalogProductNode): boolean {
  return node.status === "ACTIVE" && typeof node.publishedAt === "string" && node.publishedAt !== "";
}

/**
 * Projects one Shopify product node onto the N4 contract.
 *
 * @throws {UnreadableUpstreamValueError} the node carries no usable product id
 */
export function projectCatalogProduct(node: ShopifyCatalogProductNode): PortalCatalogProduct {
  const productId = numericProductIdFromGid(node.id);
  if (productId === null) {
    // Reached only if Shopify returned a node we did not ask for. Refused rather
    // than emitted with an empty id, which the client would use as a cache key.
    // The KIND of field only. Passing `node.id` would put an upstream value into
    // an error that can reach a log, which §24.3 forbids.
    throw new UnreadableUpstreamValueError("product_id");
  }

  const published = derivePublished(node);
  const compareAtRaw = node.compareAtPriceRange?.minVariantCompareAtPrice?.amount ?? null;
  const priceGBP: MoneyGBP = formatMoneyGBP(node.priceRangeV2?.minVariantPrice?.amount);

  // A compare-at equal to or below the price is not a discount; Shopify reports
  // one on products that were never marked down. Emitting it would render a fake
  // strikethrough, so it is normalised away rather than passed through.
  let compareAtPriceGBP: MoneyGBP | null = null;
  if (compareAtRaw !== null && compareAtRaw !== "") {
    const formatted = formatMoneyGBP(compareAtRaw);
    if (Number.parseFloat(formatted) > Number.parseFloat(priceGBP)) {
      compareAtPriceGBP = formatted;
    }
  }

  const defaultVariantId = numericVariantIdFromGid(node.variants?.nodes?.[0]?.id);

  return {
    productId,
    title: typeof node.title === "string" ? node.title : "",
    // `null` when unpublished so the client emits no link (§7.5, Req 6.9) even
    // though Shopify still reports the handle.
    handle: published && typeof node.handle === "string" && node.handle !== "" ? node.handle : null,
    published,
    availableForSale: node.availableForSale === true,
    priceGBP,
    compareAtPriceGBP,
    imageUrl: typeof node.featuredImage?.url === "string" ? node.featuredImage.url : null,
    imageWidth: typeof node.featuredImage?.width === "number" ? node.featuredImage.width : 0,
    imageHeight: typeof node.featuredImage?.height === "number" ? node.featuredImage.height : 0,
    defaultVariantId,
  };
}

/** What the catalogue read needs: a transport, and nothing customer-shaped. */
export interface CatalogReadDeps {
  readonly transport: ScopedGraphqlTransport;
}

/**
 * Reads current catalogue facts for `numericProductIds`.
 *
 * `missing` names every requested id that did not come back as a product —
 * deleted, or invisible to this token. It is computed by DIFFERENCE against what
 * was asked for, not by trusting positional nulls, so a Shopify response that
 * reorders or short-returns still yields a correct answer. Req 7.6 depends on
 * this: an id the client cannot see is an id it cannot remove from a wishlist.
 *
 * A transport failure propagates so the route can answer `502` — it is never
 * converted into "every product is missing", which would read to a customer as
 * their whole wishlist having been discontinued.
 */
export async function readCatalogProducts(
  deps: CatalogReadDeps,
  numericProductIds: readonly string[],
): Promise<PortalCatalogResponse> {
  if (numericProductIds.length === 0) {
    return { products: [], missing: [] };
  }

  const data = await runGlobalCatalogueQuery<CatalogNodesEnvelope>(
    deps.transport,
    PORTAL_CATALOG_PRODUCTS_QUERY,
    numericProductIds,
    { variantWindow: CATALOG_VARIANT_WINDOW },
  );

  const products: PortalCatalogProduct[] = [];
  const returned = new Set<string>();
  for (const node of data?.nodes ?? []) {
    if (node === null || node === undefined) continue;
    if (numericProductIdFromGid(node.id) === null) continue;
    const product = projectCatalogProduct(node);
    if (returned.has(product.productId)) continue;
    returned.add(product.productId);
    products.push(product);
  }

  // Difference, de-duplicated, in the order the caller asked.
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of numericProductIds) {
    if (returned.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(id);
  }

  return { products, missing };
}

/** Re-exported so a test can assert the document belongs to the catalogue class. */
export { assertGlobalCatalogueQuery };
