/**
 * THE REORDER PLAN (spec task 8.3, design §6.3 N3, §7.5, Req 6.6/6.7).
 *
 * Answers "what of this order can I buy again right now" — and nothing else. It
 * does NOT write a cart: §6.3 N3 keeps the cart on the storefront, because the
 * cart is a session concept the Admin API has no business touching and routing it
 * through Render would put a cold start between a tap and a cart update. What
 * stays server-side is the only part needing authoritative data — deciding what
 * is purchasable — which is why `unavailable` is RETURNED rather than silently
 * dropped (Req 6.7): a customer who taps Reorder and gets three of five items
 * must be told which two were missed.
 *
 * ── WHY THE VARIANT IS RE-RESOLVED AND NOT READ OFF THE ORDER ────────────────
 * §7.5: the variant id recorded on a two-year-old order may no longer exist. The
 * recorded line tells us WHAT was bought; only the product's current variants tell
 * us what can be bought today. Reusing the recorded variant would produce a plan
 * that fails at `/cart/add.js` — an error after the tap instead of an honest
 * "discontinued" before it.
 *
 * ── THIS IS THE CUSTOMER-SCOPED SECURITY CLASS ───────────────────────────────
 * The document is rooted at `customer(id: $customerGid)`, so a reorder plan
 * cannot be generated from another customer's order: a foreign order id is simply
 * not in the connection, and the read returns `null` → `404`. Identical to N2, and
 * for the same structural reason — there is no ownership comparison to forget.
 *
 * SAFETY: read-only. No mutation, no cart write, no Postgres write.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { ShopifyCustomerIdLookup } from "../../shopify/purchaseHistory.js";
import { runScopedCustomerQuery, type ScopedGraphqlTransport } from "./shopifyScope.js";
import { PortalRepositoryError } from "./scopedQuery.js";
import { InvalidOrderReferenceError, ORDER_DETAIL_LINE_ITEM_LIMIT } from "./orders.js";
import { numericVariantIdFromGid } from "./catalog.js";
import { PORTAL_ORDER_ID_PATTERN } from "../types.js";
import type {
  PortalReorderAddableLine,
  PortalReorderPlanResponse,
  PortalReorderUnavailableLine,
} from "../types.js";

/** Variants read per product to resolve a default. One — the first is the default. */
export const REORDER_VARIANT_WINDOW = 1;

/**
 * The N3 document: the order's lines plus each product's CURRENT default variant.
 *
 * Rooted at `customer(id: $customerGid)` and using `orders(query:)` rather than
 * `order(id:)`, exactly as N2 does — `shopifyScope.ts` refuses the by-id form.
 */
export const PORTAL_REORDER_PLAN_QUERY = /* GraphQL */ `
  query portalReorderPlan(
    $customerGid: ID!
    $orderQuery: String!
    $lineItemLimit: Int!
    $variantWindow: Int!
  ) {
    customer(id: $customerGid) {
      id
      orders(first: 1, query: $orderQuery) {
        nodes {
          id
          lineItems(first: $lineItemLimit) {
            nodes {
              id
              title
              quantity
              product {
                id
                status
                publishedAt
                variants(first: $variantWindow) {
                  nodes {
                    id
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface ReorderVariantNode {
  readonly id?: string | null;
  readonly availableForSale?: boolean | null;
}

interface ReorderProductNode {
  readonly id?: string | null;
  readonly status?: string | null;
  readonly publishedAt?: string | null;
  readonly variants?: { nodes?: readonly ReorderVariantNode[] | null } | null;
}

export interface ReorderLineItemNode {
  readonly id?: string | null;
  readonly title?: string | null;
  readonly quantity?: number | null;
  readonly product?: ReorderProductNode | null;
}

interface ReorderOrderNode {
  readonly id?: string | null;
  readonly lineItems?: { nodes?: readonly ReorderLineItemNode[] | null } | null;
}

interface ReorderCustomerNode {
  readonly orders?: { nodes?: readonly ReorderOrderNode[] | null } | null;
}

/** What the reorder read needs — the same shape N1/N2 use. */
export interface ScopedReorderReadDeps {
  readonly transport: ScopedGraphqlTransport;
  readonly lookup: ShopifyCustomerIdLookup;
}

/**
 * Classifies one line into the plan.
 *
 * The two reasons are distinguished because they mean different things to a
 * customer and §6.3 N3 names both: `discontinued` is "this is gone, stop hoping",
 * `out_of_stock` is "come back". Collapsing them would make the client guess.
 */
export function classifyReorderLine(
  line: ReorderLineItemNode,
): { addable: PortalReorderAddableLine } | { unavailable: PortalReorderUnavailableLine } {
  const title = typeof line.title === "string" ? line.title : "";
  const quantity =
    typeof line.quantity === "number" && Number.isSafeInteger(line.quantity) && line.quantity > 0
      ? line.quantity
      : 1;

  const product = line.product ?? null;
  // Deleted from the catalogue: Shopify nulls `product` but keeps the line.
  if (product === null || product === undefined) {
    return { unavailable: { title, reason: "discontinued" } };
  }
  // Unpublished counts as discontinued for REORDER purposes: it cannot be bought.
  // §7.5 distinguishes unpublished from deleted for the DETAIL view, where the
  // consequence is whether to render a link. Here the consequence is identical —
  // there is nothing to add to a cart — so one reason is honest rather than lossy.
  const published =
    product.status === "ACTIVE" && typeof product.publishedAt === "string" && product.publishedAt !== "";
  if (!published) {
    return { unavailable: { title, reason: "discontinued" } };
  }

  const variant = product.variants?.nodes?.[0] ?? null;
  const variantId = numericVariantIdFromGid(variant?.id);
  if (variant === null || variantId === null) {
    // Published but with no variant we can name. Not purchasable, and not a
    // stock problem.
    return { unavailable: { title, reason: "discontinued" } };
  }
  if (variant.availableForSale !== true) {
    return { unavailable: { title, reason: "out_of_stock" } };
  }
  return { addable: { variantId, quantity, title } };
}

/**
 * Builds the reorder plan for one of the scope's own orders, or `null` when the
 * reference names no order reachable by this scope.
 *
 * `lineItemIds` selects a subset — the Buy Again case. An id that is not on the
 * order is IGNORED rather than reported: it names nothing this customer can act
 * on, and echoing it back would confirm which line ids exist. When every supplied
 * id is unknown the plan is empty, which is the honest answer to "reorder these
 * lines that are not on this order".
 *
 * @throws {InvalidOrderReferenceError} the reference is not `^\d{1,20}$`
 */
export async function readScopedReorderPlan(
  deps: ScopedReorderReadDeps,
  scope: CustomerScope,
  orderReference: string,
  lineItemIds?: readonly string[],
): Promise<PortalReorderPlanResponse | null> {
  if (!PORTAL_ORDER_ID_PATTERN.test(orderReference)) {
    throw new InvalidOrderReferenceError();
  }

  let customer: ReorderCustomerNode;
  try {
    customer = await runScopedCustomerQuery<ReorderCustomerNode>(
      deps.transport,
      deps.lookup,
      scope,
      PORTAL_REORDER_PLAN_QUERY,
      {
        orderQuery: `id:${orderReference}`,
        lineItemLimit: ORDER_DETAIL_LINE_ITEM_LIMIT,
        variantWindow: REORDER_VARIANT_WINDOW,
      },
      "order_not_found",
    );
  } catch (err) {
    if (err instanceof PortalRepositoryError && err.code === "order_not_found") {
      return null;
    }
    throw err;
  }

  const node = customer.orders?.nodes?.[0];
  if (!node) {
    return null;
  }
  // The same post-condition N2 carries: prove the order we got back is the order
  // we asked for, rather than trusting Shopify's search semantics.
  const returnedId = /(\d{1,20})$/.exec(typeof node.id === "string" ? node.id : "")?.[1] ?? null;
  if (returnedId !== orderReference) {
    return null;
  }

  const wanted = lineItemIds === undefined ? null : new Set(lineItemIds);
  const addable: PortalReorderAddableLine[] = [];
  const unavailable: PortalReorderUnavailableLine[] = [];

  for (const line of node.lineItems?.nodes ?? []) {
    if (wanted !== null) {
      const id = typeof line.id === "string" ? line.id : "";
      const numeric = /(\d{1,20})$/.exec(id)?.[1] ?? "";
      if (!wanted.has(id) && !wanted.has(numeric)) continue;
    }
    const classified = classifyReorderLine(line);
    if ("addable" in classified) {
      addable.push(classified.addable);
    } else {
      unavailable.push(classified.unavailable);
    }
  }

  return { addable, unavailable };
}
