/**
 * `transport/cartClient.ts` — the ONLY caller of Shopify's `/cart/add.js`
 * (spec task 20.4, design §6.3 N3).
 *
 * Requirements 6.6, 6.7, 14.2, 16.3, 16.5.
 *
 * ── WHY THE CART IS NOT WRITTEN BY OUR SERVER ────────────────────────────────
 * §6.3 N3 argues it: the cart is a storefront-session concept the Admin API has no
 * business touching, and routing a cart write through Render would put a possible
 * cold start between a tap and a cart update. So the service returns a PLAN and the
 * browser posts it to Shopify's own endpoint, in the session that owns the cart.
 *
 * ── WHY THIS LIVES IN CORE AND NOT IN THE ORDERS BUNDLE ──────────────────────
 * `portalBundles.dom.test.ts` asserts that core is the only bundle containing
 * `fetch(`. That assertion is not bureaucracy: a second `fetch` call site is a
 * second place the URL, the content type and the duplicate-submission guard can
 * each be got wrong. The cart is a different origin path from `/apps/loyalty/v1`,
 * so it needs its own client — but it gets the same one-place treatment, and the
 * invariant holds unchanged.
 *
 * ── THE ONLY VARIANT IDS THIS WILL SEND ──────────────────────────────────────
 * `addable` from N3, and nothing else. `PortalReorderAddableLine.variantId` is
 * documented as "the variant resolved server-side AT REQUEST TIME, not the one on
 * the old order", which is the whole security property: a two-year-old order's
 * recorded variant may be discontinued, restocked under a new variant, or belong to
 * a product that has since been unpublished. The server decides what is
 * purchasable; the client is not entitled to an opinion, and `addToCart` therefore
 * takes plan lines rather than ids so there is no signature by which a caller could
 * pass an id from somewhere else.
 *
 * ── `/cart/add.js` IS ATOMIC, WHICH IS WHY IT IS ONE CALL ────────────────────
 * Shopify rejects the whole request with `422` if any line cannot be added, and adds
 * nothing. That is a feature here: it means there is no such thing as a partially
 * written cart, so the customer is never told "some of it worked" without knowing
 * which. One call per reorder, and a failure means the cart is untouched — which is
 * what `addToCart` reports, and what Requirement 6.7's "state which line items were
 * unavailable" can then be said honestly against.
 *
 * SAFETY: one POST to a relative, same-origin Shopify path. No customer identity is
 * sent — the cart is identified by the session cookie Shopify already set, which is
 * why `credentials: "same-origin"` is required here and is not a credential of ours.
 */

/** Shopify's AJAX Cart API. Relative, same-origin, and not our service. */
const CART_ADD_PATH = "/cart/add.js";

/** The cart is a fast local write; it gets no cold-start allowance. */
const CART_TIMEOUT_MS = 8_000;

/** What the caller may ask to be added: plan lines, and only plan lines. */
export interface CartLine {
  readonly variantId: string;
  readonly quantity: number;
}

/** The outcome, as a union so the failure branch cannot be ignored. */
export type CartResult =
  | { readonly ok: true; readonly added: number }
  | { readonly ok: false; readonly reason: CartFailureReason };

/**
 * Why a cart write failed, as an identifier — never Shopify's own text.
 *
 * `/cart/add.js` returns a `description` on a 422 that names the product and the
 * available quantity. Forwarding it would put upstream wording in the UI, which
 * design E.1 rule 2 forbids and which `ui/copy.ts` exists to replace.
 */
export type CartFailureReason =
  | "nothing_to_add"
  | "unavailable"
  | "network_unavailable"
  | "request_timeout"
  | "cart_unavailable";

/**
 * In-flight guard, keyed by the caller's intent.
 *
 * DUPLICATE SUBMISSION IS THE HAZARD THIS CLOSES. `/cart/add.js` has no
 * idempotency key — Shopify's endpoint has no notion of one — so a double tap on
 * Reorder would add every line twice, and the customer would discover it at
 * checkout. Disabling the control is necessary but not sufficient: a fast double
 * tap can fire two events before the first handler's disable takes effect, and a
 * keyboard `Enter` repeat does the same.
 *
 * So the guard is here, at the one place that can actually enforce it: a second
 * call with the same key while the first is outstanding is refused rather than
 * queued. Queueing would preserve the duplicate, only later.
 */
const inFlight = new Set<string>();

/** Whether a cart write is currently outstanding for this intent. */
export function isAdding(key: string): boolean {
  return inFlight.has(key);
}

/** Test seam: clear the guard between cases. */
export function resetCart(): void {
  inFlight.clear();
}

/**
 * Add plan lines to the cart.
 *
 * `key` identifies the intent — an order id for Reorder, an order id plus a line
 * index for Buy Again — so two different buttons are not blocked by each other
 * while a double tap on one is.
 */
export async function addToCart(key: string, lines: readonly CartLine[]): Promise<CartResult> {
  if (lines.length === 0) {
    // Not a failure of the cart: there was nothing purchasable in the plan. The
    // caller states the unavailable reasons instead of calling Shopify at all.
    return { ok: false, reason: "nothing_to_add" };
  }
  if (inFlight.has(key)) {
    // A duplicate submission. Reported as though the cart were busy rather than
    // silently resolving, so a caller cannot mistake it for a completed add.
    return { ok: false, reason: "cart_unavailable" };
  }

  inFlight.add(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CART_TIMEOUT_MS);

  try {
    const response = await fetch(CART_ADD_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      // Shopify identifies the cart by its own session cookie. This is not a
      // credential of ours and carries no customer identity we chose to send.
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({
        items: lines.map((line) => ({
          // Shopify's AJAX API takes the NUMERIC variant id. A GID would be
          // rejected, and coercing here rather than at the call site keeps the
          // plan's own shape untouched.
          id: numericVariantId(line.variantId),
          quantity: line.quantity,
        })),
      }),
    });

    if (!response.ok) {
      // 422 is Shopify saying a line is not purchasable after all — the stock
      // changed between the plan and the tap. Nothing was added, because the
      // endpoint is atomic.
      return { ok: false, reason: response.status === 422 ? "unavailable" : "cart_unavailable" };
    }
    return { ok: true, added: lines.length };
  } catch (err) {
    const aborted =
      typeof err === "object" &&
      err !== null &&
      ((err as { name?: unknown }).name === "AbortError" ||
        (err as { name?: unknown }).name === "TimeoutError");
    return { ok: false, reason: aborted ? "request_timeout" : "network_unavailable" };
  } finally {
    clearTimeout(timer);
    inFlight.delete(key);
  }
}

/**
 * The trailing numeric id of a variant reference.
 *
 * N3 returns the numeric id today, but a GID (`gid://shopify/ProductVariant/123`)
 * is the shape the Admin API uses everywhere else, so this accepts both rather than
 * depending on which one the projection happens to emit. Anything with no digits
 * yields `0`, which Shopify rejects — failing closed rather than adding a guess.
 */
function numericVariantId(reference: string): number {
  const match = /(\d+)\s*$/.exec(String(reference));
  return match ? Number(match[1]) : 0;
}
