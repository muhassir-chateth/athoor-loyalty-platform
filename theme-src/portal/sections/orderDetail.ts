/**
 * `athoor-portal-order-detail.js` — one order, plus Buy Again and Reorder
 * (spec tasks 20.3, 20.4).
 *
 * Requirements 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 14.2, 16.3, 16.5, 17.5,
 * 17.8.
 *
 * ── THE ORDER ID IS VALIDATED BEFORE A REQUEST IS SPENT ──────────────────────
 * Shopify Liquid cannot read query parameters, so the id arrives from
 * `location.search` and the shape check happens here — against the pattern the
 * TEMPLATE declares (`data-portal-id-pattern`), which is the same `^\d{1,20}$` the
 * API enforces in `PORTAL_ORDER_ID_PATTERN`. Two copies of a rule is how they
 * drift, so the client reads the one the markup carries rather than restating it.
 *
 * The API remains the authority. This check only avoids spending a request on input
 * we can already see is malformed, and it fails closed: no id, or a bad shape, is
 * the same designed not-found state as an id belonging to someone else. Requirement
 * 2.2 wants exactly that — a stranger must not be able to tell a nonexistent order
 * from another customer's, and task 16.5 proved the API's two answers are
 * byte-identical.
 *
 * ── THE FOUR AVAILABILITY STATES, WITHOUT COLOUR (Requirement 17.8) ──────────
 * §7.5's table is expressed in three nullable fields rather than a status string:
 *
 *   published + in stock  productId set, productHandle set, available true
 *   published + no stock  productId set, productHandle set, available false
 *   unpublished           productId set, productHandle null,  available false
 *   deleted               productId null, productHandle null, available false
 *
 * `productHandle === null` is the signal to render NO link (Requirement 6.9),
 * because there is no handle to link to — while `title` and both prices survive all
 * four, since Shopify records them on the order. Every state carries words, so none
 * of it depends on colour.
 *
 * ── REORDER: THE PLAN IS THE AUTHORITY, NOT THIS PAGE ────────────────────────
 * Requirement 6.7: add every currently available line item and STATE which were
 * unavailable. So the flow is N3 then `/cart/add.js`, and the only variant ids sent
 * are the ones N3 returned — resolved server-side at request time, never the ones
 * recorded on the old order. This module never reads `lineItem.variantId` for a
 * cart write; it is used only to identify a line to N3.
 *
 * The cart call is atomic, so there is no partial cart to describe: either the
 * addable lines went in, or nothing did. What this module must never do is claim
 * the whole order was reordered when the plan dropped lines — hence one message
 * that always names both halves.
 *
 * SAFETY: one read (N2), one plan request (N3), one cart write (Shopify's own
 * endpoint, through `transport/cartClient.ts`). No storage.
 */
import { registerSection } from "./registration.js";
import type {
  PortalOrderDetail,
  PortalOrderLineItem,
  PortalReorderPlanResponse,
} from "../data/types.js";

/** The fallback shape, used only if the template omits its declaration. */
const DEFAULT_ID_PATTERN = "^[0-9]{1,20}$";

registerSection("order-detail", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  // Bound to a non-optional const because TypeScript resets a narrowing inside a
  // hoisted function declaration: the guard above proves it, but the closures below
  // are declared in the same scope and would each see the optional type again.
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const scope = root.closest<HTMLElement>("[data-portal-id-source]");
  const body = root.querySelector<HTMLElement>("[data-portal-body]");
  const lineTemplate = root.querySelector<HTMLTemplateElement>('[data-portal-row="line-item"]');

  /** The declared shape, read from the markup so it cannot drift from the API's. */
  const pattern = new RegExp(scope?.getAttribute("data-portal-id-pattern") ?? DEFAULT_ID_PATTERN);

  /**
   * The order id from the query string.
   *
   * `URLSearchParams` is ES2015-era DOM and inside the support matrix. A missing or
   * malformed id returns `null`, and the caller renders not-found without asking
   * the API — which is also what stops a crafted `?id=` from becoming a request.
   */
  function orderId(): string | null {
    const source = scope?.getAttribute("data-portal-id-source") ?? "query:id";
    if (source.indexOf("query:") !== 0) return null;
    const name = source.slice("query:".length);
    const raw = new URLSearchParams(window.location.search).get(name);
    if (raw === null) return null;
    return pattern.test(raw) ? raw : null;
  }

  /** Requirement 2.2 — the same answer for malformed, absent and foreign ids. */
  function renderNotFound(): void {
    runtime.states.degrade(root, {
      code: "order_not_found",
      status: 404,
      requestId: null,
      retryable: false,
    } as PortalFailure);
  }

  /** Fill one line item's slots, honouring §7.5's four states. */
  function renderLine(line: PortalOrderLineItem, template: HTMLTemplateElement): DocumentFragment {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const set = (slot: string, value: string): void => {
      const node = fragment.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      // `textContent`, never `innerHTML`: a recorded product title is upstream data
      // and §5.3 records that the current wishlist builds rows with `innerHTML`.
      if (node) node.textContent = value;
    };

    set("title", line.title);
    set("quantity", `Quantity ${String(line.quantity)}`);
    set("unit-price", line.originalUnitPriceGBP);
    set("line-total", line.discountedTotalGBP);

    const image = fragment.querySelector<HTMLImageElement>('[data-slot="image"]');
    if (image && line.imageUrl) {
      image.src = line.imageUrl;
      // Decorative: the title is adjacent, so announcing the image would repeat it.
      image.alt = "";
      if (line.imageWidth) image.width = line.imageWidth;
      if (line.imageHeight) image.height = line.imageHeight;
    }

    // Requirement 6.8/6.9 — a route ONLY where a handle exists.
    const link = fragment.querySelector<HTMLAnchorElement>('[data-slot="link"]');
    if (link) {
      if (line.productHandle) {
        link.href = `/products/${encodeURIComponent(line.productHandle)}`;
        link.textContent = line.title;
        link.removeAttribute("hidden");
      } else {
        // No handle, so no link. The recorded title and price still render above,
        // which is the whole of Requirement 6.9.
        link.remove();
      }
    }

    // The availability word. Never colour alone (Requirement 17.8).
    set("availability", availabilityWord(line));

    // Buy Again is offered only for a line that is purchasable right now, and
    // carries its reason when it is not (task 20.4).
    const buyAgain = fragment.querySelector<HTMLButtonElement>("[data-portal-buy-again]");
    if (buyAgain) {
      if (line.available && line.productId && line.lineItemId) {
        // The id goes in a data attribute and back to our own API, which re-scopes
        // it to the caller. It is never rendered.
        buyAgain.dataset.lineItemId = line.lineItemId;
        buyAgain.setAttribute("aria-label", `Buy ${line.title} again`);
      } else {
        buyAgain.disabled = true;
        buyAgain.setAttribute("aria-label", `${line.title} — ${availabilityWord(line)}`);
        buyAgain.title = availabilityWord(line);
      }
    }
    return fragment;
  }

  /** §7.5's four states, in words, through the copy map. */
  function availabilityWord(line: PortalOrderLineItem): string {
    if (line.available) return runtime.copy.availability("available");
    if (line.productId === null) return runtime.copy.availability("discontinued");
    if (line.productHandle === null) return runtime.copy.availability("unpublished");
    return runtime.copy.availability("out_of_stock");
  }

  /**
   * Reorder, or Buy Again for one line.
   *
   * `lineItemIds` absent means the whole order — N3's own contract for the
   * distinction, so there is no second convention here.
   */
  async function reorder(
    id: string,
    key: string,
    control: HTMLButtonElement | null,
    lineItemIds?: readonly string[],
  ): Promise<void> {
    // Requirement 16.5 / task 20.4: a repeated click must not add twice. The
    // control is disabled AND the cart client refuses a duplicate key, because a
    // fast double tap can fire two events before the disable takes effect.
    if (control) control.disabled = true;

    const plan = await runtime.request<PortalReorderPlanResponse>({
      method: "POST",
      path: `/orders/${encodeURIComponent(id)}/reorder-plan`,
      // N3's own contract for the distinction: absent means the whole order
      // (Reorder), present means a subset (Buy Again). No second convention.
      body: lineItemIds === undefined ? {} : { lineItemIds: [...lineItemIds] },
      target: "shopify",
    });

    if (!plan.ok) {
      runtime.announce.assertive(root, runtime.copy.error(plan.error.code));
      if (control) control.disabled = false;
      return;
    }

    const addable = plan.value.addable ?? [];
    const unavailable = plan.value.unavailable ?? [];

    if (addable.length === 0) {
      // Nothing purchasable. No cart call at all, and the reasons are stated —
      // never a bare "could not reorder".
      runtime.announce.assertive(root, unavailableSentence(unavailable, 0));
      if (control) control.disabled = false;
      return;
    }

    const result = await runtime.cart.addToCart(
      key,
      addable.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
    );

    if (!result.ok) {
      // The endpoint is atomic, so a failure means the cart is UNTOUCHED. Saying so
      // is the difference between an honest failure and a customer who thinks they
      // have reordered.
      runtime.announce.assertive(root, `Nothing was added to your bag. ${cartFailureSentence(result.reason)}`);
      if (control) control.disabled = false;
      return;
    }

    // Requirement 6.7 — what went in AND what did not, in one sentence.
    runtime.announce.polite(root, `${addedSentence(result.added)} ${unavailableSentence(unavailable, result.added)}`.trim());
    runtime.announce.global(addedSentence(result.added));
    // The control stays disabled on success: the cart now holds these lines, and
    // re-enabling invites the double add this guard exists to prevent.
  }

  function addedSentence(added: number): string {
    return added === 1 ? "1 item added to your bag." : `${String(added)} items added to your bag.`;
  }

  /** Names the unavailable lines and why — never a count alone (Requirement 6.7). */
  function unavailableSentence(
    unavailable: readonly { title: string; reason: string }[],
    added: number,
  ): string {
    if (unavailable.length === 0) return "";
    const described = unavailable
      .map((line) => `${line.title} (${runtime.copy.availability(line.reason).toLowerCase()})`)
      .join(", ");
    if (added === 0) return `Nothing could be added. ${described}.`;
    return `Not added: ${described}.`;
  }

  function cartFailureSentence(reason: string): string {
    if (reason === "unavailable") return "One of the items sold out just now.";
    if (reason === "request_timeout" || reason === "network_unavailable") {
      return runtime.copy.error(reason);
    }
    return "Please try again shortly.";
  }

  async function load(): Promise<void> {
    const id = orderId();
    if (id === null) {
      renderNotFound();
      return;
    }

    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    const result = await runtime.cache.read<PortalOrderDetail>({
      method: "GET",
      path: `/orders/${encodeURIComponent(id)}`,
      target: "shopify",
    });

    if (!result.ok) {
      runtime.states.degrade(root, result.error, () => void load());
      return;
    }

    const order = result.value;
    const lineItems: readonly PortalOrderLineItem[] = Array.isArray(order.lineItems)
      ? order.lineItems
      : [];

    // Header figures.
    for (const [slot, value] of [
      ["number", order.name],
      ["date", runtime.copy.formatDate?.(order.processedAt) ?? order.processedAt],
      ["subtotal", order.subtotalGBP],
      ["shipping", order.shippingGBP],
      ["tax", order.taxGBP],
      ["total", order.totalGBP],
    ] as const) {
      const node = root.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (node && typeof value === "string") node.textContent = value;
    }

    // Fulfilment, and tracking ONLY where Shopify supplied it (Requirements 6.4/6.5).
    const fulfilment = (order.fulfilments ?? [])[0];
    const statusNode = root.querySelector<HTMLElement>('[data-slot="fulfilment"]');
    if (statusNode) {
      statusNode.textContent = runtime.copy.fulfilment(fulfilment?.status ?? order.fulfilmentStatus);
    }
    const tracking = root.querySelector<HTMLAnchorElement>("[data-portal-tracking]");
    if (tracking) {
      if (fulfilment?.trackingUrl && fulfilment.trackingNumber) {
        tracking.href = fulfilment.trackingUrl;
        tracking.textContent = `Track parcel ${fulfilment.trackingNumber}`;
        tracking.removeAttribute("hidden");
      } else {
        // The portal never synthesises a carrier URL from a bare reference: a
        // guessed link that 404s reads as the parcel being lost.
        tracking.remove();
      }
    }

    // Delivery address, if the order has one.
    const addressNode = root.querySelector<HTMLElement>("[data-portal-address]");
    if (addressNode) {
      const address = order.shippingAddress;
      if (!address) {
        addressNode.remove();
      } else {
        const lines = [
          [address.firstName, address.lastName].filter(Boolean).join(" "),
          address.address1,
          address.address2,
          address.city,
          address.province,
          address.zip,
          address.countryCode,
        ].filter((part): part is string => typeof part === "string" && part.length > 0);
        addressNode.textContent = "";
        for (const line of lines) {
          const row = document.createElement("span");
          row.className = "athoor-order__address-line";
          row.textContent = line;
          addressNode.appendChild(row);
        }
      }
    }

    // Line items, each row isolated (§22.6).
    if (body && lineTemplate) {
      const list = document.createElement("ul");
      list.className = "athoor-order__lines";
      list.setAttribute("role", "list");
      const { fragment, failed } = runtime.rows.list(lineItems, lineTemplate, renderLine);
      list.appendChild(fragment);
      body.appendChild(list);
      if (failed > 0) runtime.announce.polite(root, "Some items could not be shown.");
    }

    runtime.states.set(root, "ready");

    // Reorder for the whole order.
    const reorderControl = root.querySelector<HTMLButtonElement>("[data-portal-reorder]");
    if (reorderControl) {
      reorderControl.addEventListener("click", () => {
        void reorder(id, `reorder:${id}`, reorderControl);
      });
    }

    // Buy Again per line. Bound on the list, inside this root — never on
    // `document` (§16.10).
    if (body) {
      body.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const control = target.closest<HTMLButtonElement>("[data-portal-buy-again]");
        if (!control || control.disabled) return;
        const lineItemId = control.dataset.lineItemId;
        // No id means the line was not purchasable, so the control is disabled and
        // this is unreachable — but a missing id must never fall through to a
        // WHOLE-ORDER reorder, which is what a customer pressing "buy this one
        // again" would least expect.
        if (!lineItemId) return;
        void reorder(id, `buy-again:${id}:${lineItemId}`, control, [lineItemId]);
      });
    }
  }

  void load();
});
