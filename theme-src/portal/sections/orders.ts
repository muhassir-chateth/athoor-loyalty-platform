/**
 * `athoor-portal-orders.js` — the Orders section (spec tasks 20.1, 20.2).
 *
 * Requirements 6.1, 6.2, 6.11, 6.12, 15.2, 15.5, 15.6, 16.1, 16.2, 17.5.
 *
 * ── ONE REQUEST ON BOOT, THEN CURSOR PAGING ──────────────────────────────────
 * N1 pages at 20 (Requirement 6.12), and the cursor comes from `pageInfo.endCursor`.
 * "Show earlier orders" APPENDS: it does not replace the list and it does not move
 * focus. §20.2 is explicit that focus stays on the control and the new count is
 * announced instead — a customer who presses a button expects to stay where they
 * pressed it, and a screen reader user needs to know how many rows arrived.
 *
 * ── FAILURE DEGRADES THIS SECTION AND NOTHING ELSE ───────────────────────────
 * Every failure goes through `states.degrade`, which chooses between
 * `session-expired`, `offline`, `degraded` and `error`, renders §22.9's shortened
 * request reference, and offers retry only where a retry can help. The retry
 * re-requests THIS section (Requirement 15.6) — there is no page reload, because a
 * reload would discard every other section's loaded data to fix one.
 *
 * SAFETY: reads only. This module never writes anything, anywhere.
 */
import { registerSection } from "./registration.js";
import type { PortalOrderSummary, PortalOrdersResponse } from "../data/types.js";

/** Requirement 6.12 — N1's maximum, and the value the design fixes. */
const PAGE_SIZE = 20;

registerSection("orders", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  // Bound to a non-optional const because TypeScript resets a narrowing inside a
  // hoisted function declaration: the guard above proves it, but the closures below
  // are declared in the same scope and would each see the optional type again.
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const body = root.querySelector<HTMLElement>("[data-portal-body]");
  const template = root.querySelector<HTMLTemplateElement>('[data-portal-row="order"]');
  const more = root.querySelector<HTMLButtonElement>("[data-portal-more-orders]");
  const list = document.createElement("ul");
  list.className = "athoor-orders__list";
  // `<ul>`/`<li>` so the row count is announced (task 20.1, §20.3). A list of
  // `<div>`s reads as prose and gives a screen reader user no sense of how many
  // orders there are.
  list.setAttribute("role", "list");

  let cursor: string | null = null;
  let loading = false;
  let rendered = 0;

  /** Requirement 6.11 — a designed empty state with a route to the catalogue. */
  function renderEmpty(): void {
    runtime.states.set(root, "empty", {
      announce: "You have no orders yet.",
    });
  }

  function announceCount(added: number): void {
    // §20.2 — the new count, not the fact that something happened.
    runtime.announce.polite(
      root,
      added === 1
        ? `1 more order shown. ${String(rendered)} in total.`
        : `${String(added)} more orders shown. ${String(rendered)} in total.`,
    );
  }

  async function load(append: boolean): Promise<void> {
    if (loading) return;
    loading = true;
    if (more) more.disabled = true;

    if (!append) {
      runtime.states.set(root, "loading");
      runtime.announce.loadingOnce(root, runtime.copy.state("loading"));
    }

    const query: Record<string, string | number> = { pageSize: PAGE_SIZE };
    if (append && cursor) query.after = cursor;

    const result = await runtime.cache.read<PortalOrdersResponse>({
      method: "GET",
      path: "/orders",
      query,
      // N1 reads Shopify, so it gets the 8 s budget and no cold-start allowance.
      target: "shopify",
    });

    loading = false;

    if (!result.ok) {
      // A failure while APPENDING must not destroy the rows already on screen: the
      // customer asked for more, not for less. So the degraded state is rendered
      // and the existing list is left in place.
      runtime.states.degrade(root, result.error, () => void load(append));
      if (more) more.disabled = false;
      return;
    }

    const page = result.value;
    const orders: readonly PortalOrderSummary[] = Array.isArray(page.orders) ? page.orders : [];

    if (!append && orders.length === 0) {
      renderEmpty();
      return;
    }

    const { fragment, failed } = runtime.rows.list(orders, template as HTMLTemplateElement, runtime.rows.orderRow);
    list.appendChild(fragment);
    rendered += orders.length - failed;

    if (body && !body.contains(list)) body.appendChild(list);
    runtime.states.set(root, "ready");

    cursor = page.pageInfo?.endCursor ?? null;
    const hasMore = page.pageInfo?.hasNextPage === true && cursor !== null;
    if (more) {
      more.disabled = false;
      if (hasMore) more.removeAttribute("hidden");
      else more.setAttribute("hidden", "hidden");
    }

    if (append) {
      announceCount(orders.length - failed);
      // Focus deliberately NOT moved (§20.2): it stays on "Show earlier orders".
    }
    if (failed > 0) {
      // One row that could not render is one row, not a broken list (§22.6). Said
      // rather than hidden, because a silently short list is indistinguishable from
      // having fewer orders.
      runtime.announce.polite(root, "Some orders could not be shown.");
    }
  }

  if (more) {
    more.addEventListener("click", () => void load(true));
  }

  void load(false);
});
