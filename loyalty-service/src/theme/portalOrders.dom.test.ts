// @vitest-environment jsdom
/**
 * Spec tasks 20.2, 20.3, 20.4, 20.5 — the Orders and Order detail modules, and the
 * reorder path.
 *
 * Validates Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.11, 6.12,
 * 14.2, 15.2, 15.5, 15.6, 16.3, 16.5, 17.5, 17.8, 26.2, 26.5.
 *
 * ── HOW A SECTION MODULE IS TESTED ───────────────────────────────────────────
 * A section bundle calls `registerSection` at import time, which reads
 * `window.AthoorPortal` and hands over a boot function. So the harness installs a
 * runtime FIRST, imports the module, captures the boot, and invokes it against a
 * root of its own — which is exactly the sequence a real page performs.
 *
 * The runtime is the REAL `copy`, `states`, `rows`, `announce` and `focus` from task
 * 18, with only `request`, `cache` and `cart` stubbed. That is deliberate: a fake
 * copy map or a fake state machine would let a module pass while rendering
 * `undefined`, and those two are where task 18 found its defects.
 *
 * SAFETY: jsdom only. No network — `request` and `cart` are stubs and `fetch` is
 * never reached. No database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as states from "../../../theme-src/portal/render/states.js";

/* ========================================================================== *
 * Fixtures — the real N1/N2/N3 contracts
 * ========================================================================== */

function orderSummary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "6012345678901",
    name: "#1042",
    processedAt: "2026-06-01T10:00:00.000Z",
    financialStatus: "PAID",
    fulfilmentStatus: "FULFILLED",
    totalGBP: "125.00",
    currencyCode: "GBP",
    lineItemCount: 2,
    previewLineItems: [],
    ...over,
  };
}

/** §7.5's four states, as the three nullable fields express them. */
const LINE_PUBLISHED_IN_STOCK = {
  lineItemId: "111",
  title: "Oud Royale 50ml",
  quantity: 1,
  originalUnitPriceGBP: "95.00",
  discountedTotalGBP: "95.00",
  productId: "1001",
  variantId: "9001",
  productHandle: "oud-royale",
  available: true,
  imageUrl: "https://cdn.shopify.com/oud.jpg",
  imageWidth: 300,
  imageHeight: 300,
};

const LINE_OUT_OF_STOCK = {
  ...LINE_PUBLISHED_IN_STOCK,
  lineItemId: "222",
  title: "Amber Nuit 100ml",
  productId: "1002",
  variantId: "9002",
  productHandle: "amber-nuit",
  available: false,
};

const LINE_UNPUBLISHED = {
  ...LINE_PUBLISHED_IN_STOCK,
  lineItemId: "333",
  title: "Rose Taif (retired)",
  productId: "1003",
  variantId: "9003",
  productHandle: null,
  available: false,
};

const LINE_DELETED = {
  ...LINE_PUBLISHED_IN_STOCK,
  lineItemId: "444",
  title: "Musk Blanc (discontinued)",
  productId: null,
  variantId: null,
  productHandle: null,
  available: false,
  imageUrl: null,
};

function orderDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...orderSummary(),
    subtotalGBP: "190.00",
    shippingGBP: "0.00",
    taxGBP: "0.00",
    lineItems: [LINE_PUBLISHED_IN_STOCK, LINE_OUT_OF_STOCK],
    shippingAddress: {
      firstName: "Amina",
      lastName: "K",
      address1: "12 Museum Street",
      address2: null,
      city: "London",
      province: null,
      zip: "N1 1AA",
      countryCode: "GB",
      phone: null,
    },
    fulfilments: [{ status: "FULFILLED", trackingNumber: "TRK123", trackingUrl: "https://track.example/TRK123" }],
    ...over,
  };
}

/* ========================================================================== *
 * The harness
 * ========================================================================== */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface Harness {
  root: HTMLElement;
  requests: Recorded[];
  cartCalls: { key: string; lines: { variantId: string; quantity: number }[] }[];
  announced: string[];
  request: ReturnType<typeof vi.fn>;
  cartResult: { ok: boolean; added?: number; reason?: string };
}

let harness: Harness;

/** The markup `portal-section.liquid` renders for `orders`. */
function ordersMarkup(): string {
  return `
    <section class="athoor-portal__section" data-portal-section="orders" data-state="loading" aria-busy="true">
      <p data-portal-live aria-live="polite"></p>
      <div class="athoor-portal__state">
        <p data-portal-state-message>Preparing your account</p>
        <p data-portal-reference hidden></p>
        <button type="button" data-portal-retry hidden>Try again</button>
      </div>
      <div data-portal-skeleton aria-hidden="true"></div>
      <div data-portal-body></div>
      <template data-portal-row="order">
        <li class="athoor-portal__row athoor-orders__row">
          <span class="athoor-portal__image-box"><img data-slot="image" alt="" width="64" height="64"></span>
          <a class="athoor-portal__row-link" data-slot="link" href="#"></a>
          <span data-slot="number"></span><span data-slot="date"></span>
          <span data-slot="items"></span><span data-slot="total"></span><span data-slot="status"></span>
        </li>
      </template>
      <button type="button" data-portal-more-orders hidden>Show earlier orders</button>
    </section>`;
}

/** The markup `portal-section.liquid` renders for `order-detail`. */
function detailMarkup(): string {
  return `
    <div data-portal-id-source="query:id" data-portal-id-pattern="^[0-9]{1,20}$">
      <section class="athoor-portal__section" data-portal-section="order-detail" data-state="loading" aria-busy="true">
        <p data-portal-live aria-live="polite"></p>
        <div class="athoor-portal__state">
          <p data-portal-state-message>Preparing your account</p>
          <p data-portal-reference hidden></p>
          <button type="button" data-portal-retry hidden>Try again</button>
        </div>
        <div data-portal-skeleton aria-hidden="true"></div>
        <header>
          <h2 data-slot="number"></h2><p data-slot="date"></p><p data-slot="fulfilment"></p>
          <a data-portal-tracking href="#" hidden></a>
        </header>
        <button type="button" data-portal-reorder>Reorder everything available</button>
        <table><caption>Order totals</caption><tbody>
          <tr><th scope="row">Subtotal</th><td data-slot="subtotal"></td></tr>
          <tr><th scope="row">Delivery</th><td data-slot="shipping"></td></tr>
          <tr><th scope="row">Tax</th><td data-slot="tax"></td></tr>
          <tr><th scope="row">Total</th><td data-slot="total"></td></tr>
        </tbody></table>
        <section><h3>Delivered to</h3><p data-portal-address></p></section>
        <div data-portal-body></div>
        <template data-portal-row="line-item">
          <li class="athoor-portal__row athoor-order__line">
            <span class="athoor-portal__image-box"><img data-slot="image" alt="" width="80" height="80"></span>
            <a class="athoor-order__line-link" data-slot="link" href="#"></a>
            <span class="athoor-order__line-title" data-slot="title"></span>
            <span data-slot="quantity"></span><span data-slot="unit-price"></span>
            <span data-slot="line-total"></span>
            <span class="athoor-order__line-availability" data-slot="availability"></span>
            <button type="button" data-portal-buy-again>Buy again</button>
          </li>
        </template>
      </section>
    </div>`;
}

/**
 * Install a runtime, import a section module, and boot it.
 *
 * `vi.resetModules()` first, because a module registers on import and vitest caches
 * modules — without it the second test in a file would import nothing and boot a
 * stale closure.
 */
async function boot(
  section: "orders" | "order-detail",
  responses: Record<string, unknown>,
  opts: { search?: string; cartResult?: Harness["cartResult"] } = {},
): Promise<Harness> {
  document.body.innerHTML = section === "orders" ? ordersMarkup() : detailMarkup();
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const requests: Recorded[] = [];
  const cartCalls: Harness["cartCalls"] = [];
  const announced: string[] = [];

  // The URL the module reads its id from.
  if (opts.search !== undefined) {
    window.history.replaceState({}, "", `/pages/my-athoor-order-detail${opts.search}`);
  }

  const request = vi.fn((spec: { method: string; path: string; body?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, body: spec.body });
    const key = `${spec.method} ${spec.path}`;
    const answer = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : undefined;
    if (answer === undefined) {
      return Promise.resolve({ ok: false, error: { code: "not_found", status: 404, requestId: null, retryable: false } });
    }
    return Promise.resolve(answer);
  });

  const cartResult = opts.cartResult ?? { ok: true, added: 1 };

  const runtime = {
    version: "test",
    register: (_name: string, fn: (el: HTMLElement) => void) => {
      captured = fn;
    },
    boot: () => undefined,
    registered: () => [],
    request,
    sessionRef: "test",
    cache: { read: request, invalidateBalance: () => undefined, clear: () => undefined, size: () => 0 },
    draft: { get: () => ({}), set: () => undefined, clear: () => undefined, has: () => false },
    states: { set: states.set, current: states.current, degrade: states.degrade, states: states.STATES },
    rows: {
      orderRow: rows.orderRow,
      wishlistRow: rows.wishlistRow,
      activityRow: rows.activityRow,
      rewardCard: rows.rewardCard,
      stageRow: rows.stageRow,
      list: rows.list,
    },
    announce: {
      polite: (el: HTMLElement, m: string) => {
        announced.push(m);
        announce.polite(el, m);
      },
      assertive: (el: HTMLElement, m: string) => {
        announced.push(m);
        announce.assertive(el, m);
      },
      global: (m: string) => announced.push(m),
      loadingOnce: announce.loadingOnce,
    },
    focus,
    sheet: { open: () => () => undefined, close: () => undefined, isOpen: () => false },
    copy,
    cart: {
      addToCart: (key: string, lines: { variantId: string; quantity: number }[]) => {
        cartCalls.push({ key, lines: [...lines] });
        return Promise.resolve(cartResult);
      },
      isAdding: () => false,
    },
  };

  let captured: ((el: HTMLElement) => void) | null = null;
  (window as unknown as { AthoorPortal: unknown }).AthoorPortal = runtime;

  vi.resetModules();
  await import(
    section === "orders"
      ? "../../../theme-src/portal/sections/orders.js"
      : "../../../theme-src/portal/sections/orderDetail.js"
  );

  expect(captured, "the module did not register a boot function").not.toBeNull();
  captured?.(root);
  // Let the module's awaited reads settle.
  await new Promise((resolve) => setTimeout(resolve, 2));

  return { root, requests, cartCalls, announced, request, cartResult };
}

const ok = (value: unknown) => ({ ok: true, value, requestId: "req-abcdef123456" });
const fail = (code: string, status: number | null, retryable = true) => ({
  ok: false,
  error: { code, status, requestId: "req-abcdef123456", retryable },
});

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { AthoorPortal?: unknown }).AthoorPortal;
});

/* ========================================================================== *
 * 20.2 — the Orders section
 * ========================================================================== */

describe("Orders: the three history states (task 20.5)", () => {
  it("renders a POPULATED list, most recent first, as a real list", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({
        orders: [orderSummary(), orderSummary({ id: "2", name: "#1041", totalGBP: "60.00" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });
    expect(harness.root.getAttribute("data-state")).toBe("ready");
    const list = harness.root.querySelector("ul");
    // `<ul>`/`<li>` so the count is announced (task 20.1, §20.3).
    expect(list?.getAttribute("role")).toBe("list");
    expect(harness.root.querySelectorAll("li")).toHaveLength(2);
    expect(harness.root.textContent).toContain("#1042");
    expect(harness.root.textContent).toContain("1 June 2026");
    expect(harness.root.textContent).toContain("Sent");
  });

  it("renders the designed EMPTY state with no rows (Requirement 6.11)", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({ orders: [], pageInfo: { hasNextPage: false, endCursor: null } }),
    });
    expect(harness.root.getAttribute("data-state")).toBe("empty");
    expect(harness.root.querySelectorAll("li")).toHaveLength(0);
    const message = harness.root.querySelector("[data-portal-state-message]")?.textContent ?? "";
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("undefined");
  });

  it("requests ONE page on boot, at N1's page size of 20 (Requirement 6.12)", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({ orders: [orderSummary()], pageInfo: { hasNextPage: true, endCursor: "cur-1" } }),
    });
    expect(harness.requests).toHaveLength(1);
    expect(harness.request.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/orders",
      query: { pageSize: 20 },
    });
  });

  it("DEEP HISTORY: appends the next page, keeps focus, and announces the new count", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({ orders: [orderSummary()], pageInfo: { hasNextPage: true, endCursor: "cur-1" } }),
    });
    const more = harness.root.querySelector<HTMLButtonElement>("[data-portal-more-orders]") as HTMLButtonElement;
    expect(more.hasAttribute("hidden")).toBe(false);

    more.focus();
    more.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Appended, not replaced.
    expect(harness.root.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
    // §20.2 — focus stays on the control that was pressed.
    expect(document.activeElement).toBe(more);
    // …and the new count is announced instead.
    expect(harness.announced.join(" ")).toMatch(/more order/);
    expect(harness.announced.join(" ")).toContain("in total");
    // The cursor was carried.
    expect(harness.request.mock.calls[1]?.[0]).toMatchObject({ query: { pageSize: 20, after: "cur-1" } });
  });

  it("hides the paging control when there is no further page", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({ orders: [orderSummary()], pageInfo: { hasNextPage: false, endCursor: null } }),
    });
    expect(
      harness.root.querySelector("[data-portal-more-orders]")?.hasAttribute("hidden"),
    ).toBe(true);
  });
});

describe("Orders: failure and recovery (Requirements 15.2, 15.5, 15.6)", () => {
  it("degrades on 502 and offers a retry that re-requests only this section", async () => {
    harness = await boot("orders", { "GET /orders": fail("upstream_unavailable", 502) });
    expect(harness.root.getAttribute("data-state")).toBe("degraded");
    // §22.9 — the shortened request reference.
    expect(harness.root.querySelector("[data-portal-reference]")?.textContent).toMatch(/^Reference \w{8}$/);

    const retry = harness.root.querySelector<HTMLButtonElement>("[data-portal-retry]") as HTMLButtonElement;
    expect(retry.hasAttribute("hidden")).toBe(false);
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A second request for THIS section — never a page reload, which would discard
    // every other section's data to fix one.
    expect(harness.requests.length).toBeGreaterThanOrEqual(2);
    expect(harness.requests.every((r) => r.path === "/orders")).toBe(true);
  });

  it("degrades on a timeout, and offers retry", async () => {
    harness = await boot("orders", { "GET /orders": fail("request_timeout", null) });
    expect(harness.root.getAttribute("data-state")).toBe("degraded");
    expect(harness.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });

  it("a 401 becomes session-expired, not an error", async () => {
    harness = await boot("orders", { "GET /orders": fail("identity_resolution_failed", 401, false) });
    expect(harness.root.getAttribute("data-state")).toBe("session-expired");
  });

  it("a failure while APPENDING keeps the rows already on screen", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({ orders: [orderSummary()], pageInfo: { hasNextPage: true, endCursor: "cur-1" } }),
    });
    expect(harness.root.querySelectorAll("li")).toHaveLength(1);

    harness.request.mockImplementationOnce(() => Promise.resolve(fail("upstream_unavailable", 502)));
    harness.root.querySelector<HTMLButtonElement>("[data-portal-more-orders]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The customer asked for MORE, not for less.
    expect(harness.root.querySelectorAll("li")).toHaveLength(1);
    expect(harness.root.getAttribute("data-state")).toBe("degraded");
  });

  it("one unrenderable row degrades one row, not the list (§22.6)", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({
        orders: [orderSummary(), null, orderSummary({ id: "3", name: "#1040" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });
    expect(harness.root.getAttribute("data-state")).toBe("ready");
    expect(harness.root.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
  });
});

describe("Orders: hostile upstream data (task 20.5, Requirement 26.2)", () => {
  it("an <img onerror> payload in a product title creates NO element", async () => {
    const hostile = `<img src=x onerror="window.__pwned = true">`;
    harness = await boot("orders", {
      "GET /orders": ok({
        orders: [orderSummary({ name: hostile })],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });
    // One <img> only: the template's own thumbnail. The title is text.
    expect(harness.root.querySelectorAll("img")).toHaveLength(1);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(harness.root.textContent).toContain(hostile);
  });

  it("renders no undefined, null or NaN for a sparse order (Requirement 16.8)", async () => {
    harness = await boot("orders", {
      "GET /orders": ok({
        orders: [orderSummary({ name: null, processedAt: null, totalGBP: null, lineItemCount: Number.NaN })],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });
    for (const forbidden of ["undefined", "null", "NaN"]) {
      expect(harness.root.textContent ?? "", `rendered ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* ========================================================================== *
 * 20.3 — Order detail
 * ========================================================================== */

describe("Order detail: the id, and IDOR (Requirements 2.2, 6.3)", () => {
  it("reads the id from the query string and requests that order", async () => {
    harness = await boot("order-detail", { "GET /orders/6012345678901": ok(orderDetail()) }, {
      search: "?id=6012345678901",
    });
    expect(harness.root.getAttribute("data-state")).toBe("ready");
    expect(harness.requests[0]?.path).toBe("/orders/6012345678901");
  });

  it("spends NO request on a malformed id, and answers not-found", async () => {
    for (const search of ["?id=abc", "?id=", "?id=-1", "?id=1e5", "?id=" + "9".repeat(21), "?other=1", ""]) {
      harness = await boot("order-detail", {}, { search });
      expect(harness.requests, `requested for ${search}`).toHaveLength(0);
      expect(harness.root.getAttribute("data-state")).toBe("error");
    }
  });

  it("a foreign order id gets the SAME answer as a nonexistent one (Requirement 2.2)", async () => {
    // The API proves these identical (task 16.5); the client must not reintroduce a
    // difference by rendering them differently.
    const foreign = await boot("order-detail", { "GET /orders/8880001": fail("order_not_found", 404, false) }, {
      search: "?id=8880001",
    });
    const foreignHtml = foreign.root.querySelector("[data-portal-state-message]")?.textContent;

    const missing = await boot("order-detail", { "GET /orders/6009999999": fail("order_not_found", 404, false) }, {
      search: "?id=6009999999",
    });
    expect(missing.root.querySelector("[data-portal-state-message]")?.textContent).toBe(foreignHtml);
    // No attribute of the resource in the body.
    expect(missing.root.textContent).not.toContain("8880001");
  });

  it("offers no retry for a not-found, because a retry cannot help", async () => {
    harness = await boot("order-detail", { "GET /orders/6012345678901": fail("order_not_found", 404, false) }, {
      search: "?id=6012345678901",
    });
    expect(harness.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("Order detail: the four availability states (§7.5, Requirements 6.8, 6.9, 17.8)", () => {
  async function withLines(lineItems: unknown[]): Promise<Harness> {
    return boot("order-detail", { "GET /orders/6012345678901": ok(orderDetail({ lineItems })) }, {
      search: "?id=6012345678901",
    });
  }

  it("published and in stock: a product link, and Buy Again enabled", async () => {
    harness = await withLines([LINE_PUBLISHED_IN_STOCK]);
    const link = harness.root.querySelector<HTMLAnchorElement>('[data-slot="link"]');
    expect(link?.getAttribute("href")).toBe("/products/oud-royale");
    expect(harness.root.textContent).toContain("Available");
    expect(harness.root.querySelector<HTMLButtonElement>("[data-portal-buy-again]")?.disabled).toBe(false);
  });

  it("published but out of stock: still linked, Buy Again DISABLED with a stated reason", async () => {
    harness = await withLines([LINE_OUT_OF_STOCK]);
    expect(harness.root.querySelector('[data-slot="link"]')?.getAttribute("href")).toBe("/products/amber-nuit");
    expect(harness.root.textContent).toContain("Out of stock");
    const control = harness.root.querySelector<HTMLButtonElement>("[data-portal-buy-again]");
    expect(control?.disabled).toBe(true);
    // The reason is stated, never conveyed by the disabled look alone (§18.8).
    expect(control?.getAttribute("aria-label")).toContain("Out of stock");
  });

  it("UNPUBLISHED: no link at all, but the recorded title and price remain (Req 6.9)", async () => {
    harness = await withLines([LINE_UNPUBLISHED]);
    expect(harness.root.querySelector('[data-slot="link"]')).toBeNull();
    expect(harness.root.textContent).toContain("Rose Taif (retired)");
    expect(harness.root.textContent).toContain("95.00");
    expect(harness.root.textContent).toContain("No longer available");
    expect(harness.root.querySelector<HTMLButtonElement>("[data-portal-buy-again]")?.disabled).toBe(true);
  });

  it("DELETED: no link, no product id, and the order still reads correctly", async () => {
    harness = await withLines([LINE_DELETED]);
    expect(harness.root.querySelector('[data-slot="link"]')).toBeNull();
    expect(harness.root.textContent).toContain("Musk Blanc (discontinued)");
    expect(harness.root.textContent).toContain("No longer available");
    expect(harness.root.querySelector<HTMLButtonElement>("[data-portal-buy-again]")?.disabled).toBe(true);
  });

  it("every state's availability is legible as TEXT, not colour (Requirement 17.8)", async () => {
    harness = await withLines([LINE_PUBLISHED_IN_STOCK, LINE_OUT_OF_STOCK, LINE_UNPUBLISHED, LINE_DELETED]);
    const words = [...harness.root.querySelectorAll('[data-slot="availability"]')].map((n) => n.textContent);
    expect(words).toHaveLength(4);
    for (const word of words) expect((word ?? "").length).toBeGreaterThan(0);
  });
});

describe("Order detail: totals, address and tracking (Requirements 6.3, 6.4, 6.5)", () => {
  it("renders the totals table with a caption and row headers", async () => {
    harness = await boot("order-detail", { "GET /orders/6012345678901": ok(orderDetail()) }, {
      search: "?id=6012345678901",
    });
    expect(harness.root.querySelector("caption")?.textContent).toBe("Order totals");
    expect(harness.root.querySelectorAll('th[scope="row"]')).toHaveLength(4);
    expect(harness.root.querySelector('[data-slot="total"]')?.textContent).toBe("125.00");
    expect(harness.root.querySelector('[data-slot="subtotal"]')?.textContent).toBe("190.00");
  });

  it("renders the delivery address as separate lines, omitting blanks", async () => {
    harness = await boot("order-detail", { "GET /orders/6012345678901": ok(orderDetail()) }, {
      search: "?id=6012345678901",
    });
    const lines = [...harness.root.querySelectorAll(".athoor-order__address-line")].map((n) => n.textContent);
    expect(lines).toContain("Amina K");
    expect(lines).toContain("12 Museum Street");
    expect(lines).toContain("N1 1AA");
    // `address2` and `province` were null and must not appear as blanks.
    expect(lines.every((line) => (line ?? "").length > 0)).toBe(true);
  });

  it("removes the address block entirely when the order has none", async () => {
    harness = await boot(
      "order-detail",
      { "GET /orders/6012345678901": ok(orderDetail({ shippingAddress: null })) },
      { search: "?id=6012345678901" },
    );
    expect(harness.root.querySelector("[data-portal-address]")).toBeNull();
  });

  it("A FULFILMENT WITH NO TRACKING renders no link and no synthesised URL (task 20.5)", async () => {
    harness = await boot(
      "order-detail",
      {
        "GET /orders/6012345678901": ok(
          orderDetail({ fulfilments: [{ status: "IN_TRANSIT", trackingNumber: null, trackingUrl: null }] }),
        ),
      },
      { search: "?id=6012345678901" },
    );
    // A guessed carrier link that 404s reads as the parcel being lost.
    expect(harness.root.querySelector("[data-portal-tracking]")).toBeNull();
    expect(harness.root.textContent).toContain("On its way");
  });

  it("renders the tracking link only when Shopify supplied both parts", async () => {
    harness = await boot("order-detail", { "GET /orders/6012345678901": ok(orderDetail()) }, {
      search: "?id=6012345678901",
    });
    const tracking = harness.root.querySelector<HTMLAnchorElement>("[data-portal-tracking]");
    expect(tracking?.hasAttribute("hidden")).toBe(false);
    expect(tracking?.getAttribute("href")).toBe("https://track.example/TRK123");
  });
});

/* ========================================================================== *
 * 20.4 — Reorder and Buy Again
 * ========================================================================== */

describe("Reorder: the plan is the authority (Requirements 6.6, 6.7, 14.2, 16.3)", () => {
  const PLAN_PATH = "POST /orders/6012345678901/reorder-plan";

  async function bootDetail(plan: unknown, cartResult?: Harness["cartResult"]): Promise<Harness> {
    return boot(
      "order-detail",
      { "GET /orders/6012345678901": ok(orderDetail({ lineItems: [LINE_PUBLISHED_IN_STOCK, LINE_OUT_OF_STOCK] })), [PLAN_PATH]: plan },
      { search: "?id=6012345678901", ...(cartResult ? { cartResult } : {}) },
    );
  }

  it("adds ONLY the variant ids the plan returned — never the order's own", async () => {
    // The plan resolves the purchasable variant server-side at request time. The
    // order records 9001; the plan says 7777, because the product was restocked
    // under a new variant. The cart must receive 7777.
    harness = await bootDetail(
      ok({
        addable: [{ variantId: "7777", quantity: 1, title: "Oud Royale 50ml" }],
        unavailable: [],
      }),
    );
    harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.cartCalls).toHaveLength(1);
    expect(harness.cartCalls[0]?.lines).toEqual([{ variantId: "7777", quantity: 1 }]);
    // The recorded variant is never sent.
    expect(JSON.stringify(harness.cartCalls)).not.toContain("9001");
  });

  it("NEVER adds an unavailable or discontinued line, and says which and why (Req 6.7)", async () => {
    harness = await bootDetail(
      ok({
        addable: [{ variantId: "9001", quantity: 1, title: "Oud Royale 50ml" }],
        unavailable: [
          { title: "Amber Nuit 100ml", reason: "out_of_stock" },
          { title: "Musk Blanc", reason: "discontinued" },
        ],
      }),
    );
    harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Only the addable line reached the cart.
    expect(harness.cartCalls[0]?.lines).toHaveLength(1);
    const said = harness.announced.join(" ");
    // Both halves of Requirement 6.7, in one message.
    expect(said).toContain("added to your bag");
    expect(said).toContain("Amber Nuit 100ml");
    expect(said).toContain("out of stock");
    expect(said).toContain("Musk Blanc");
    expect(said).toContain("no longer available");
  });

  it("does NOT claim success when the plan has nothing addable", async () => {
    harness = await bootDetail(
      ok({ addable: [], unavailable: [{ title: "Amber Nuit 100ml", reason: "out_of_stock" }] }),
    );
    harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // No cart call at all, and the reasons are stated.
    expect(harness.cartCalls).toHaveLength(0);
    const said = harness.announced.join(" ");
    expect(said).toContain("Nothing could be added");
    expect(said).toContain("Amber Nuit 100ml");
    expect(said).not.toContain("added to your bag.");
  });

  it("does NOT claim success when the cart write fails — and says nothing was added", async () => {
    harness = await bootDetail(
      ok({ addable: [{ variantId: "9001", quantity: 1, title: "Oud" }], unavailable: [] }),
      { ok: false, reason: "unavailable" },
    );
    harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const said = harness.announced.join(" ");
    // `/cart/add.js` is atomic, so a failure means the cart is untouched. Saying so
    // is the difference between an honest failure and a customer who believes they
    // have reordered.
    expect(said).toContain("Nothing was added to your bag");
    expect(said).not.toMatch(/\d+ items? added/);
    // …and the control is re-enabled so they can try again.
    expect(harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]")?.disabled).toBe(false);
  });

  it("PREVENTS a duplicate add from a repeated click (Requirement 16.5)", async () => {
    harness = await bootDetail(
      ok({ addable: [{ variantId: "9001", quantity: 1, title: "Oud" }], unavailable: [] }),
    );
    const control = harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]") as HTMLButtonElement;
    control.click();
    control.click();
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The control is disabled synchronously on the first click, so the later two
    // never reach the plan — and the cart saw exactly one write.
    expect(harness.cartCalls.length).toBeLessThanOrEqual(1);
    expect(harness.requests.filter((r) => r.path.endsWith("/reorder-plan"))).toHaveLength(1);
  });

  it("stays disabled after a SUCCESSFUL add, so the lines cannot go in twice", async () => {
    harness = await bootDetail(
      ok({ addable: [{ variantId: "9001", quantity: 1, title: "Oud" }], unavailable: [] }),
    );
    const control = harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]") as HTMLButtonElement;
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(control.disabled).toBe(true);
  });

  it("reports a plan failure without touching the cart", async () => {
    harness = await bootDetail(fail("upstream_unavailable", 502));
    harness.root.querySelector<HTMLButtonElement>("[data-portal-reorder]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.cartCalls).toHaveLength(0);
    expect(harness.announced.join(" ")).toContain("not available just now");
  });

  it("Buy Again asks for ONE line by its id, not the whole order (Requirement 6.6)", async () => {
    harness = await bootDetail(
      ok({ addable: [{ variantId: "9001", quantity: 1, title: "Oud Royale 50ml" }], unavailable: [] }),
    );
    const buyAgain = harness.root.querySelector<HTMLButtonElement>("[data-portal-buy-again]") as HTMLButtonElement;
    expect(buyAgain.disabled).toBe(false);
    buyAgain.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const planRequest = harness.requests.find((r) => r.path.endsWith("/reorder-plan"));
    // N3's own contract for a subset: `lineItemIds` present.
    expect(planRequest?.body).toEqual({ lineItemIds: ["111"] });
    expect(harness.cartCalls[0]?.lines).toEqual([{ variantId: "9001", quantity: 1 }]);
  });

  it("a disabled Buy Again does nothing at all", async () => {
    harness = await bootDetail(ok({ addable: [], unavailable: [] }));
    const controls = harness.root.querySelectorAll<HTMLButtonElement>("[data-portal-buy-again]");
    const disabled = [...controls].find((c) => c.disabled);
    expect(disabled).toBeDefined();
    disabled?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.requests.filter((r) => r.path.endsWith("/reorder-plan"))).toHaveLength(0);
  });
});
