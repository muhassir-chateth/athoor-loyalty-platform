/**
 * `athoor-portal-wishlist.js` — the Wishlist section (spec tasks 21.2, 21.3).
 *
 * Requirements 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 7.11, 1.8, 15.2, 15.8, 16.3, 17.5,
 * 17.8.
 *
 * ── TWO READS, AND WHY THE SECOND ONE MAY FAIL WITHOUT LOSING THE LIST ───────
 * The SET lives in our Postgres (N5); the DETAILS live in Shopify (N4). That split
 * is the whole reason this section can degrade gracefully: if Shopify is
 * unavailable, we still know exactly which products the customer saved, so every
 * row renders with "details unavailable" and a WORKING remove control (task 21.3).
 *
 * The alternative — one combined read — would mean a Shopify outage emptied the
 * customer's wishlist on screen, which is the single most alarming thing this
 * section could do. A customer who cannot see their saved items assumes they are
 * gone.
 *
 * ── THE BACKEND IS AUTHORITATIVE FOR REMOVALS (task 9) ──────────────────────
 * A removal is `PUT /v1/profile/wishlist/:productId {on:false}`, which writes a
 * TOMBSTONE. This module never writes `localStorage`, never reads it to decide what
 * to show, and never reconciles on its own initiative — because a stale device list
 * re-added on every page load is exactly how a removed product resurrects, and the
 * tombstone table exists to make that impossible server-side.
 *
 * ZERO STORAGE WRITES, asserted rather than promised. The theme's older
 * `athoor-loyalty.js` keeps a `shopify-wishlist` key in `localStorage`; this module
 * neither writes nor deletes it. That key stays exactly as it is (Requirement 1.8
 * and the preservation rule), and reconciliation of it is `POST
 * /v1/profile/wishlist/reconcile`'s job, invoked by the code that owns that flow —
 * not by a page render.
 *
 * ── A MISSING PRODUCT IS STILL REMOVABLE (Requirement 7.6) ──────────────────
 * Ids in N4's `missing[]` are products Shopify no longer returns — deleted, or
 * unpublished. They render as unavailable, with NO add-to-bag and a live remove
 * control. Without that, a deleted product would be permanently stuck in the
 * customer's wishlist with no way to clear it.
 *
 * SAFETY: two reads, one scoped write per removal, and one cart add through core's
 * single cart boundary. No storage of any kind.
 */
import { registerSection } from "./registration.js";
import type {
  PortalCatalogProduct,
  PortalCatalogResponse,
  PortalWishlistSetResponse,
} from "../data/types.js";

/** N4 accepts at most this many ids per request (`PORTAL_CATALOG_MAX_IDS`). */
const CATALOG_BATCH = 50;

interface WishlistSet {
  readonly wishlist?: readonly string[];
}

registerSection("wishlist", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const body = root.querySelector<HTMLElement>("[data-portal-body]");
  const template = root.querySelector<HTMLTemplateElement>('[data-portal-row="wishlist"]');
  const grid = document.createElement("ul");
  grid.className = "athoor-wishlist__grid";
  // A list, so the saved-item count is announced (§20.3).
  grid.setAttribute("role", "list");

  /** Product ids currently on screen, so a removal can update without a re-read. */
  let ids: string[] = [];

  /**
   * Render one row.
   *
   * `enriched` is `null` for an id N4 could not resolve, or for every id when the
   * enrichment read failed outright — the two cases collapse to the same designed
   * row, because from the customer's point of view they are the same thing: we
   * know you saved it and we cannot tell you more right now.
   */
  function renderRow(id: string, enriched: PortalCatalogProduct | null): DocumentFragment | null {
    if (!template) return null;
    const fragment = template.content.cloneNode(true) as DocumentFragment;

    const set = (slot: string, value: string): void => {
      const node = fragment.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      // `textContent` only. §5.3 records that the CURRENT wishlist builds rows with
      // `innerHTML` from product data (NB-14) — a title containing `<img onerror>`
      // executes there. This is the section that must not repeat it.
      if (node) node.textContent = value;
    };

    const removeControl = fragment.querySelector<HTMLButtonElement>("[data-portal-wishlist-remove]");
    if (removeControl) {
      // ALWAYS live, in every state, including for a product Shopify has lost
      // (Requirement 7.6). Explicitly labelled — never a swipe (task 21.1).
      removeControl.dataset.productId = id;
    }

    const addControl = fragment.querySelector<HTMLButtonElement>("[data-portal-wishlist-add]");

    if (enriched === null) {
      set("title", "Saved item");
      set("availability", "Details unavailable");
      set("price", "");
      if (removeControl) removeControl.setAttribute("aria-label", "Remove this saved item");
      // No add-to-bag: there is no variant to add, and offering one that fails is
      // worse than not offering it.
      if (addControl) addControl.remove();
      return fragment;
    }

    const rendered = runtime.rows.wishlistRow(enriched, template);
    // The shared renderer owns the slots; re-apply the two things it cannot know.
    const removed = rendered.querySelector<HTMLButtonElement>("[data-portal-wishlist-remove]");
    if (removed) removed.dataset.productId = id;
    const add = rendered.querySelector<HTMLButtonElement>("[data-portal-wishlist-add]");
    if (add) {
      if (enriched.availableForSale && enriched.defaultVariantId) {
        add.dataset.variantId = enriched.defaultVariantId;
        add.setAttribute("aria-label", `Add ${enriched.title} to your bag`);
      } else {
        // Out of stock items are RETAINED with the state stated in text
        // (Requirement 7.7) — not hidden, and not silently unclickable.
        add.disabled = true;
        add.setAttribute("aria-label", `${enriched.title} — ${runtime.copy.availability("out_of_stock")}`);
      }
    }
    return rendered;
  }

  /** Enrich a set of ids, in batches, tolerating a total failure. */
  async function enrich(all: readonly string[]): Promise<{
    products: Map<string, PortalCatalogProduct>;
    missing: Set<string>;
    failed: boolean;
  }> {
    const products = new Map<string, PortalCatalogProduct>();
    const missing = new Set<string>();
    let failed = false;

    for (let i = 0; i < all.length; i += CATALOG_BATCH) {
      const batch = all.slice(i, i + CATALOG_BATCH);
      const result = await runtime.cache.read<PortalCatalogResponse>({
        method: "GET",
        path: "/catalog/products",
        query: { ids: batch.join(",") },
        target: "shopify",
      });
      if (!result.ok) {
        // Not fatal. The set is already known, so every row still renders.
        failed = true;
        continue;
      }
      for (const product of result.value.products ?? []) {
        products.set(String(product.productId), product);
      }
      for (const id of result.value.missing ?? []) missing.add(String(id));
    }
    return { products, missing, failed };
  }

  function paint(
    all: readonly string[],
    products: Map<string, PortalCatalogProduct>,
    missing: Set<string>,
  ): void {
    grid.textContent = "";
    let failedRows = 0;
    for (const id of all) {
      try {
        // A missing id gets the same row as an unenriched one, with no add-to-bag.
        const enriched = missing.has(id) ? null : (products.get(id) ?? null);
        const fragment = renderRow(id, enriched);
        if (fragment) grid.appendChild(fragment);
      } catch {
        // A row that throws degrades ALONE (Requirement 15.2, §22.6). The
        // exception is not read (design E.1 rule 2).
        failedRows += 1;
      }
    }
    if (body && !body.contains(grid)) body.appendChild(grid);
    if (failedRows > 0) runtime.announce.polite(root, "Some saved items could not be shown.");
  }

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    // The SET, from our own Postgres. This one failing is fatal to the section:
    // without it we do not know what the customer saved.
    const set = await runtime.cache.read<WishlistSet>({
      method: "GET",
      path: "/profile/wishlist",
    });
    if (!set.ok) {
      runtime.states.degrade(root, set.error, () => void load());
      return;
    }

    ids = [...(set.value.wishlist ?? [])].map(String);
    if (ids.length === 0) {
      // Requirement 7.11 — a designed empty state with a route to the catalogue,
      // which the Liquid renders.
      runtime.states.set(root, "empty", { announce: "You have no saved items yet." });
      return;
    }

    const { products, missing, failed } = await enrich(ids);
    paint(ids, products, missing);
    runtime.states.set(root, "ready");

    if (failed) {
      // Requirement 7.7 / task 21.3: the rows are all there, and the customer is
      // told why they are sparse rather than left to wonder.
      runtime.announce.polite(root, "Your saved items are here, but product details are unavailable just now.");
    }
  }

  /** Remove one product. The backend is authoritative; this writes no storage. */
  async function remove(productId: string, control: HTMLButtonElement): Promise<void> {
    // Repeated presses must not send repeated writes. The write is idempotent
    // server-side, but a second request would still race the first's re-render.
    if (control.disabled) return;
    control.disabled = true;

    const result = await runtime.request<PortalWishlistSetResponse>({
      method: "PUT",
      path: `/profile/wishlist/${encodeURIComponent(productId)}`,
      body: { on: false },
    });

    if (!result.ok) {
      control.disabled = false;
      runtime.announce.assertive(root, runtime.copy.error(result.error.code));
      return;
    }

    // The RESPONSE's wishlist is the truth, not our local array — the server has
    // just written a tombstone and knows the resulting set.
    ids = [...(result.value.wishlist ?? [])].map(String);
    const row = control.closest("li");
    if (row) row.remove();

    // The cached set is now stale.
    runtime.cache.clear();

    if (ids.length === 0) {
      runtime.states.set(root, "empty", { announce: "Removed. You have no saved items now." });
      return;
    }
    runtime.announce.polite(root, `Removed. ${String(ids.length)} saved items remaining.`);
  }

  /** Add one product to the bag, using N4's own `defaultVariantId`. */
  async function addToBag(control: HTMLButtonElement): Promise<void> {
    const variantId = control.dataset.variantId;
    // No variant means the row was not purchasable, so the control is disabled and
    // this is unreachable — but a missing variant must never become a guess.
    if (!variantId || control.disabled) return;
    control.disabled = true;

    const result = await runtime.cart.addToCart(`wishlist:${variantId}`, [{ variantId, quantity: 1 }]);
    if (!result.ok) {
      control.disabled = false;
      runtime.announce.assertive(
        root,
        result.reason === "unavailable"
          ? "That item sold out just now."
          : runtime.copy.error(result.reason === "request_timeout" ? "request_timeout" : "upstream_unavailable"),
      );
      return;
    }
    // An announced confirmation (task 21.2).
    runtime.announce.polite(root, "Added to your bag.");
    runtime.announce.global("Added to your bag.");
    control.disabled = false;
  }

  // Bound on this section's own root, never on `document` (§16.10).
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const removeControl = target.closest<HTMLButtonElement>("[data-portal-wishlist-remove]");
    if (removeControl?.dataset.productId) {
      void remove(removeControl.dataset.productId, removeControl);
      return;
    }
    const addControl = target.closest<HTMLButtonElement>("[data-portal-wishlist-add]");
    if (addControl) void addToBag(addControl);
  });

  void load();
});
