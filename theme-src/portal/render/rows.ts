/**
 * `render/rows.ts` — the five row renderers (spec task 18.3, design §16.8,
 * §18.5, §20.3, §5.3).
 *
 * Requirements 16.1–16.8, 15.2, 15.7.
 *
 * ── `<template>` + `textContent`, AND WHY NOT `innerHTML` ────────────────────
 * §5.3 records that `page.wishlist.liquid` and `athoor-wishlist-drawer.liquid`
 * build rows with `innerHTML` from product data today (NB-14). A product title is
 * customer-visible upstream data, so `innerHTML` there means a title containing
 * `<img onerror=…>` executes. The portal never repeats it: markup comes from a
 * `<template>` the Liquid snippet owns, and every value is written with
 * `textContent`. There is no code path in this file that can produce an element
 * from a string.
 *
 * ── WHY THE TEMPLATE IS A PARAMETER ─────────────────────────────────────────
 * The markup belongs to the section's Liquid snippet (task 19.4). A renderer that
 * searched the document for its template would be guessing at another task's
 * markup, and would silently render nothing if the guess were wrong. Passing it in
 * makes the dependency explicit, lets one section own several row shapes, and lets
 * a test supply a fixture without a Liquid file.
 *
 * ── ONE ROW'S FAILURE IS ONE ROW (§22.6) ────────────────────────────────────
 * `list()` wraps each row in its own `try`/`catch` and counts what failed. One
 * unavailable product degrades one row; it does not empty the wishlist. That is
 * the whole of Requirement 15.2 at the row level, and it is why the count is
 * returned rather than swallowed — the section decides what to say about it.
 *
 * ── SLOTS ───────────────────────────────────────────────────────────────────
 * A template marks its fill points with `data-slot="name"`. A slot the template
 * does not declare is skipped, not an error: a compact template may legitimately
 * omit the image, and a renderer that threw for a missing optional slot would make
 * every template change a JavaScript change.
 *
 * SAFETY: DOM only. No network, no storage, no `innerHTML`, no `eval`.
 */
import type { PortalCatalogProduct, PortalOrderSummary } from "../data/types.js";
import * as copy from "../ui/copy.js";

/** A slot's fill: text, or an image's source and alternative text. */
interface SlotValue {
  readonly text?: string;
  readonly src?: string;
  readonly alt?: string;
  readonly href?: string;
}

/**
 * Clone a template and fill its slots.
 *
 * Throws when the template is absent or empty, because that is a markup bug the
 * section's own boundary should surface rather than a row that renders blank.
 */
function fillTemplate(
  template: HTMLTemplateElement,
  values: Readonly<Record<string, SlotValue>>,
): DocumentFragment {
  if (!template || !template.content) {
    throw new Error("row template missing");
  }
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const names = Object.keys(values);

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === undefined) continue;
    const value = values[name];
    if (value === undefined) continue;

    const slots = fragment.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`);
    for (let j = 0; j < slots.length; j += 1) {
      const slot = slots[j];
      if (!slot) continue;
      applySlot(slot, value);
    }
  }
  return fragment;
}

/**
 * Write one slot.
 *
 * An `<img>` gets `src`/`alt` and everything else gets `textContent`. `alt` is set
 * even when empty, because an image with no `alt` attribute is announced by its
 * filename while `alt=""` is correctly skipped as decorative.
 */
function applySlot(slot: HTMLElement, value: SlotValue): void {
  if (value.href !== undefined && slot instanceof HTMLAnchorElement) {
    // Relative paths only. An absolute upstream URL in an href would be an open
    // redirect surface, and every link the portal renders is same-origin.
    slot.setAttribute("href", value.href.indexOf("/") === 0 ? value.href : `/${value.href}`);
  }
  if (value.src !== undefined && slot instanceof HTMLImageElement) {
    slot.src = value.src;
    slot.alt = value.alt ?? "";
    return;
  }
  if (value.text !== undefined) {
    slot.textContent = value.text;
  }
}

/**
 * The availability IDENTIFIER for a catalogue product.
 *
 * N4 returns the two facts (`published`, `availableForSale`) rather than a single
 * identifier, so the client derives §18.9's vocabulary from them. Derived here and
 * not in `copy.ts` because it is a fact about the DTO, not a wording decision, and
 * `copy.ts` must stay a pure identifier→sentence table.
 *
 * `discontinued` is deliberately not produced here: it is the reorder path's
 * distinction (`PortalReorderUnavailableReason`), where Shopify has told us the
 * variant is gone rather than merely out of stock. A wishlist row cannot tell those
 * apart, and guessing would state something we do not know.
 */
function availabilityOf(dto: PortalCatalogProduct): string {
  if (!dto.published) return "unpublished";
  if (!dto.availableForSale) return "out_of_stock";
  return "available";
}

/** "3 items", "1 item" — never "1 items". */
function itemCount(count: number): string {
  if (typeof count !== "number" || !isFinite(count) || count <= 0) return "";
  return count === 1 ? "1 item" : `${String(Math.round(count))} items`;
}

/** Never render `undefined`, `null` or `NaN` (Requirement 16.8). */
function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return isFinite(value) ? String(value) : fallback;
  if (typeof value === "string") return value;
  return fallback;
}

/** One order in the list (N1). */
export function orderRow(
  dto: PortalOrderSummary,
  template: HTMLTemplateElement,
): DocumentFragment {
  // `name` is Shopify's own customer-facing order number (e.g. `#1042`), and `id`
  // is the numeric id the detail route takes. They are different fields and the
  // typechecker caught an earlier version of this file conflating them — which is
  // the defect class §16.7 gives as the reason the build step exists.
  const number = text(dto.name, "your order");
  const date = copy.formatDate(text(dto.processedAt));
  const total = text(dto.totalGBP);
  const values: Record<string, SlotValue> = {
    number: { text: number },
    date: { text: date },
    total: { text: total },
    status: { text: copy.fulfilment(text(dto.fulfilmentStatus)) },
    items: { text: itemCount(dto.lineItemCount) },
    // §20.4 — the row link's accessible name names the order, date and total.
    link: {
      href: `/apps/loyalty/orders/${encodeURIComponent(text(dto.id))}`,
      text: `Order ${number}, ${date}, ${total}`,
    },
  };
  return fillTemplate(template, values);
}

/** One wishlist item (N4/N5). */
export function wishlistRow(
  dto: PortalCatalogProduct,
  template: HTMLTemplateElement,
): DocumentFragment {
  const title = text(dto.title, "This product");
  const values: Record<string, SlotValue> = {
    title: { text: title },
    price: { text: text(dto.priceGBP) },
    availability: { text: copy.availability(availabilityOf(dto)) },
    image: { src: text(dto.imageUrl), alt: "" },
    // §20.4 — "Remove {product title} from your wishlist".
    remove: { text: `Remove ${title} from your wishlist` },
    add: { text: `Add ${title} to your bag` },
  };
  return fillTemplate(template, values);
}

/** One ledger entry (§18.9). The description comes from the copy map, always. */
export function activityRow(
  dto: PortalActivityEntry,
  template: HTMLTemplateElement,
): DocumentFragment {
  const values: Record<string, SlotValue> = {
    description: { text: copy.activityDescription(dto) },
    points: { text: copy.signedPoints(dto.points) },
    date: { text: copy.formatDate(text(dto.date)) },
  };
  return fillTemplate(template, values);
}

/** One redeemable reward (N/A endpoint `/v1/rewards`). */
export function rewardCard(
  dto: PortalRewardOffer,
  template: HTMLTemplateElement,
): DocumentFragment {
  const value = `£${text(dto.valueGBP, "0")}`;
  const cost = text(dto.cost, "0");
  const values: Record<string, SlotValue> = {
    value: { text: value },
    cost: { text: `${cost} points` },
    // §20.4 — "Redeem {points} points for {value}".
    redeem: { text: `Redeem ${cost} points for ${value}` },
  };
  return fillTemplate(template, values);
}

/** One referral stage (§18.9). */
export function stageRow(
  dto: PortalReferralStage,
  template: HTMLTemplateElement,
): DocumentFragment {
  const stage = copy.referralStage(dto);
  // The figure comes from the RESPONSE, never from this asset (Requirement 10.15).
  const points = dto.state === "awarded" ? dto.creditedPoints : dto.currentRewardPoints;
  const values: Record<string, SlotValue> = {
    name: { text: stage.name },
    qualification: { text: stage.qualification },
    state: { text: stage.state },
    points: { text: points === undefined ? "" : `${copy.signedPoints(points).replace("+", "")} points` },
  };
  return fillTemplate(template, values);
}

/**
 * Render a list, each row isolated (§22.6).
 *
 * Returns the fragment and how many rows threw, so the section can decide whether
 * to say anything — "one item is unavailable" is useful; a silent short list is
 * not.
 */
export function list<T>(
  items: readonly T[],
  template: HTMLTemplateElement,
  render: (dto: T, template: HTMLTemplateElement) => DocumentFragment,
): { fragment: DocumentFragment; failed: number } {
  const fragment = document.createDocumentFragment();
  let failed = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    try {
      fragment.appendChild(render(item, template));
    } catch {
      // The exception is deliberately not read (design E.1 rule 2). One row is
      // omitted; the list continues.
      failed += 1;
    }
  }
  return { fragment, failed };
}
