// @vitest-environment jsdom
/**
 * Spec tasks 21.4 and 22.5 — the Wishlist, Rewards and Activity sections.
 *
 * Validates Requirements 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 7.11, 1.8, 8.7, 8.8, 8.9,
 * 8.10, 8.11, 8.13, 8.14, 9.2, 9.5, 9.8, 9.10, 15.2, 15.8, 16.3, 16.5, 26.2, 26.6.
 *
 * The harness is the one task 20 established: install a runtime with the REAL task-18
 * primitives and only the network stubbed, import the section module, capture its boot
 * function, invoke it. A fake copy map or state machine would let a module pass while
 * rendering `undefined`, and those two are where task 18 found its defects.
 *
 * SAFETY: jsdom only. `fetch` is never reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as states from "../../../theme-src/portal/render/states.js";

type Section = "wishlist" | "rewards" | "activity";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly query?: unknown;
}

interface Harness {
  root: HTMLElement;
  requests: Recorded[];
  cartCalls: { key: string; lines: unknown[] }[];
  announced: string[];
  /**
   * A LIVE count, not a snapshot. Reading a `let` into the returned object captures
   * its value at boot time — always 0 — so `expect(h.invalidations).toBe(1)` could
   * never pass however correct the section was. A getter reads it at assertion time.
   */
  readonly invalidations: number;
  request: ReturnType<typeof vi.fn>;
}

const ok = (value: unknown) => ({ ok: true, value, requestId: "req-abcdef123456" });
const fail = (code: string, status: number | null, extra: Record<string, unknown> = {}) => ({
  ok: false,
  error: { code, status, requestId: "req-abcdef123456", retryable: status === null || status >= 500, ...extra },
});

function product(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: "1001",
    title: "Oud Royale 50ml",
    handle: "oud-royale",
    published: true,
    availableForSale: true,
    priceGBP: "95.00",
    compareAtPriceGBP: null,
    defaultVariantId: "9001",
    imageUrl: "https://cdn/oud.jpg",
    imageWidth: 300,
    imageHeight: 300,
    ...over,
  };
}

function markup(section: Section): string {
  const shell = (inner: string): string => `
    <section class="athoor-portal__section" data-portal-section="${section}" data-state="loading" aria-busy="true">
      <p data-portal-live aria-live="polite"></p>
      <div class="athoor-portal__state">
        <p data-portal-state-message>Preparing your account</p>
        <p data-portal-reference hidden></p>
        <button type="button" data-portal-retry hidden>Try again</button>
      </div>
      <div data-portal-skeleton aria-hidden="true"></div>
      <div data-portal-body></div>
      ${inner}
    </section>`;

  if (section === "wishlist") {
    return shell(`
      <template data-portal-row="wishlist">
        <li class="athoor-portal__grid-item">
          <span class="athoor-portal__image-box"><img data-slot="image" alt="" width="300" height="300"></span>
          <span data-slot="title"></span><span data-slot="price"></span>
          <span data-slot="availability"></span>
          <button type="button" data-portal-wishlist-remove data-slot="remove"></button>
          <button type="button" data-portal-wishlist-add data-slot="add"></button>
        </li>
      </template>
      <p data-portal-empty-action><a href="/collections/all">Browse fragrances</a></p>`);
  }
  if (section === "rewards") {
    return shell(`
      <header>
        <p data-slot="balance">0</p>
        <p><span data-slot="tier"></span> <span data-slot="multiplier"></span></p>
        <div data-portal-progress><span data-portal-progress-fill></span></div>
        <p data-slot="progress-text"></p>
        <p data-portal-expiring hidden></p>
      </header>
      <div data-portal-code-panel hidden>
        <p data-portal-code></p>
        <button type="button" data-portal-copy-code hidden>Copy code</button>
      </div>
      <p data-portal-wait hidden></p>
      <dialog data-portal-redeem-sheet aria-labelledby="T">
        <div><h2 id="T" data-portal-sheet-heading>Confirm your reward</h2>
        <p data-slot="sheet-cost"></p><p data-slot="sheet-after"></p>
        <button type="button" data-portal-redeem-confirm>Confirm</button>
        <button type="button" data-portal-sheet-dismiss>Cancel</button></div>
      </dialog>
      <template data-portal-row="reward">
        <li class="athoor-portal__card">
          <span data-slot="value"></span><span data-slot="cost"></span>
          <span data-slot="eligibility"></span>
          <button type="button" data-slot="redeem"></button>
        </li>
      </template>`);
  }
  return shell(`
    <template data-portal-row="activity">
      <li class="athoor-portal__row">
        <span data-slot="description"></span><span data-slot="points"></span>
        <span data-slot="date"></span>
        <a data-slot="order-link" href="#" hidden></a>
      </li>
    </template>
    <button type="button" data-portal-more-activity hidden>Show earlier activity</button>
    <p data-portal-empty-action>You earn points on every order.</p>`);
}

let captured: ((el: HTMLElement) => void) | null = null;

async function boot(
  section: Section,
  responses: Record<string, unknown>,
  opts: { cartResult?: { ok: boolean; added?: number; reason?: string } } = {},
): Promise<Harness> {
  document.body.innerHTML = markup(section);
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const requests: Recorded[] = [];
  const cartCalls: Harness["cartCalls"] = [];
  const announced: string[] = [];
  const counters = { invalidations: 0 };

  const request = vi.fn((spec: { method: string; path: string; body?: unknown; query?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, body: spec.body, query: spec.query });
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return Promise.resolve(responses[key]);
    return Promise.resolve(fail("not_found", 404));
  });

  const dialog = root.querySelector<HTMLDialogElement>("[data-portal-redeem-sheet]");
  if (dialog) {
    dialog.showModal = function showModal(): void {
      this.setAttribute("open", "open");
    };
    dialog.close = function close(): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }

  captured = null;
  (window as unknown as { AthoorPortal: unknown }).AthoorPortal = {
    version: "test",
    register: (_n: string, fn: (el: HTMLElement) => void) => {
      captured = fn;
    },
    boot: () => undefined,
    registered: () => [],
    request,
    sessionRef: "test",
    cache: {
      read: request,
      invalidateBalance: () => {
        counters.invalidations += 1;
      },
      clear: () => undefined,
      size: () => 0,
    },
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
    sheet: {
      open: (d: HTMLDialogElement, invoker?: Element | null) => {
        d.setAttribute("open", "open");
        focus.toSheetHeading(d);
        return () => {
          d.removeAttribute("open");
          focus.restore(invoker ?? null);
        };
      },
      close: (d: HTMLDialogElement) => d.removeAttribute("open"),
      isOpen: (d: HTMLDialogElement) => d.hasAttribute("open"),
    },
    copy,
    cart: {
      addToCart: (key: string, lines: unknown[]) => {
        cartCalls.push({ key, lines: [...lines] });
        return Promise.resolve(opts.cartResult ?? { ok: true, added: 1 });
      },
      isAdding: () => false,
    },
  };

  vi.resetModules();
  // Static importers, one per section. Vite cannot resolve a fully dynamic import
  // specifier — it has to see the literal to build the graph — so a template string
  // here fails with "Unknown variable dynamic import" rather than loading anything.
  const importers: Record<Section, () => Promise<unknown>> = {
    wishlist: () => import("../../../theme-src/portal/sections/wishlist.js"),
    rewards: () => import("../../../theme-src/portal/sections/rewards.js"),
    activity: () => import("../../../theme-src/portal/sections/activity.js"),
  };
  await importers[section]();
  expect(captured, "no boot function registered").not.toBeNull();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 3));

  return {
    root,
    requests,
    cartCalls,
    announced,
    request,
    get invalidations(): number {
      return counters.invalidations;
    },
  };
}

let h: Harness;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  // Unconditional, and BEFORE anything that can throw. One test installs fake timers
  // to advance the poll; if it fails an assertion its own trailing `useRealTimers()`
  // never runs, and then every later `await new Promise(setTimeout)` waits on a clock
  // nobody advances — a real failure disguised as nine unrelated 5 s timeouts.
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { AthoorPortal?: unknown }).AthoorPortal;
});

/* ========================================================================== *
 * Task 21 — Wishlist
 * ========================================================================== */

describe("Wishlist: the states (Requirements 7.4, 7.11, 16.2)", () => {
  it("renders a populated grid from the set plus the enrichment", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001", "1002"] }),
      "GET /catalog/products": ok({
        products: [product(), product({ productId: "1002", title: "Amber Nuit", defaultVariantId: "9002" })],
        missing: [],
      }),
    });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelectorAll("li")).toHaveLength(2);
    expect(h.root.querySelector("ul")?.getAttribute("role")).toBe("list");
    expect(h.root.textContent).toContain("Oud Royale 50ml");
    expect(h.root.textContent).toContain("Available");
  });

  it("renders the EMPTY state with a route to the catalogue (Requirement 7.11)", async () => {
    h = await boot("wishlist", { "GET /profile/wishlist": ok({ wishlist: [] }) });
    expect(h.root.getAttribute("data-state")).toBe("empty");
    // Server-rendered, so it works before any script runs.
    expect(h.root.querySelector("[data-portal-empty-action] a")?.getAttribute("href")).toBe("/collections/all");
    // No enrichment request for an empty set.
    expect(h.requests.filter((r) => r.path === "/catalog/products")).toHaveLength(0);
  });

  it("degrades when the SET read fails — that one is fatal", async () => {
    h = await boot("wishlist", { "GET /profile/wishlist": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });

  it("writes NOTHING to client storage, and leaves an existing key alone (Req 1.8)", async () => {
    // The theme's older script keeps this key. The portal must neither write nor
    // delete it — reconciliation is a separate, explicit flow.
    window.localStorage.setItem("shopify-wishlist", '["1001","9999"]');
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({ products: [product()], missing: [] }),
    });
    expect(window.localStorage.getItem("shopify-wishlist")).toBe('["1001","9999"]');
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    // And a stale device id never appears on screen: the SERVER's set is the truth.
    expect(h.root.querySelectorAll("li")).toHaveLength(1);
    expect(h.root.textContent).not.toContain("9999");
  });

  it("never reconciles on its own initiative, so a tombstone cannot be undone", async () => {
    window.localStorage.setItem("shopify-wishlist", '["1001","2002"]');
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({ products: [product()], missing: [] }),
    });
    // A page render that reconciled would re-add 2002 on every visit, which is
    // exactly how a removed product resurrects.
    expect(h.requests.some((r) => r.path.includes("reconcile"))).toBe(false);
  });
});

describe("Wishlist: per-row degradation (Requirements 7.6, 7.7, 15.2, 15.8)", () => {
  it("a MISSING product renders unavailable, removable, with NO add-to-bag", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001", "7777"] }),
      "GET /catalog/products": ok({ products: [product()], missing: ["7777"] }),
    });
    expect(h.root.querySelectorAll("li")).toHaveLength(2);
    const rows = [...h.root.querySelectorAll("li")];
    const missingRow = rows.find((r) => r.textContent?.includes("Details unavailable"));
    expect(missingRow).toBeDefined();
    // Removable, or a deleted product could never be cleared (Requirement 7.6).
    expect(missingRow?.querySelector("[data-portal-wishlist-remove]")).not.toBeNull();
    expect(missingRow?.querySelector("[data-portal-wishlist-add]")).toBeNull();
  });

  it("an OUT-OF-STOCK item is retained with the state in text (Requirement 7.7)", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({ products: [product({ availableForSale: false })], missing: [] }),
    });
    // Retained, not hidden.
    expect(h.root.querySelectorAll("li")).toHaveLength(1);
    expect(h.root.textContent).toContain("Out of stock");
    const add = h.root.querySelector<HTMLButtonElement>("[data-portal-wishlist-add]");
    expect(add?.disabled).toBe(true);
    expect(add?.getAttribute("aria-label")).toContain("Out of stock");
  });

  it("an UNPUBLISHED item renders as no longer available", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({ products: [product({ published: false, availableForSale: false })], missing: [] }),
    });
    expect(h.root.textContent).toContain("No longer available");
  });

  it("a WHOLE enrichment failure still renders every row, with a live remove", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001", "1002", "1003"] }),
      "GET /catalog/products": fail("upstream_unavailable", 502),
    });
    // A Shopify outage must NOT empty the customer's wishlist on screen.
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelectorAll("li")).toHaveLength(3);
    expect(h.root.querySelectorAll("[data-portal-wishlist-remove]")).toHaveLength(3);
    expect(h.root.querySelectorAll("[data-portal-wishlist-add]")).toHaveLength(0);
    expect(h.announced.join(" ")).toContain("details are unavailable");
  });

  it("an <img onerror> title creates no element (Requirement 26.2)", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({
        products: [product({ title: `<img src=x onerror="window.__pwned=true">` })],
        missing: [],
      }),
    });
    // One <img>: the template's own.
    expect(h.root.querySelectorAll("img")).toHaveLength(1);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe("Wishlist: removal and add-to-bag (Requirements 7.1, 7.3, 16.3)", () => {
  async function populated(): Promise<Harness> {
    return boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001", "1002"] }),
      "GET /catalog/products": ok({
        products: [product(), product({ productId: "1002", title: "Amber Nuit", defaultVariantId: "9002" })],
        missing: [],
      }),
      "PUT /profile/wishlist/1001": ok({ productId: "1001", on: false, wishlist: ["1002"] }),
    });
  }

  it("removes via the scoped write and takes the RESPONSE's set as the truth", async () => {
    h = await populated();
    const remove = h.root.querySelector<HTMLButtonElement>('[data-portal-wishlist-remove][data-product-id="1001"]');
    remove?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const write = h.requests.find((r) => r.method === "PUT");
    expect(write?.path).toBe("/profile/wishlist/1001");
    expect(write?.body).toEqual({ on: false });
    // The server has just written a tombstone and knows the resulting set.
    expect(h.root.querySelectorAll("li")).toHaveLength(1);
    expect(h.announced.join(" ")).toContain("1 saved items remaining");
  });

  it("a repeated remove press sends ONE write", async () => {
    h = await populated();
    const remove = h.root.querySelector<HTMLButtonElement>('[data-portal-wishlist-remove][data-product-id="1001"]') as HTMLButtonElement;
    remove.click();
    remove.click();
    remove.click();
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("a failed removal restores the control and keeps the row", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({ products: [product()], missing: [] }),
      "PUT /profile/wishlist/1001": fail("upstream_unavailable", 502),
    });
    const remove = h.root.querySelector<HTMLButtonElement>("[data-portal-wishlist-remove]") as HTMLButtonElement;
    remove.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.root.querySelectorAll("li")).toHaveLength(1);
    expect(remove.disabled).toBe(false);
    expect(h.announced.join(" ")).toContain("not available just now");
  });

  it("removing the last item lands in the empty state", async () => {
    h = await boot("wishlist", {
      "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
      "GET /catalog/products": ok({ products: [product()], missing: [] }),
      "PUT /profile/wishlist/1001": ok({ productId: "1001", on: false, wishlist: [] }),
    });
    h.root.querySelector<HTMLButtonElement>("[data-portal-wishlist-remove]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.root.getAttribute("data-state")).toBe("empty");
  });

  it("adds to the bag using N4's defaultVariantId, with an announced confirmation", async () => {
    h = await populated();
    h.root.querySelector<HTMLButtonElement>("[data-portal-wishlist-add]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.cartCalls).toHaveLength(1);
    expect(h.cartCalls[0]?.lines).toEqual([{ variantId: "9001", quantity: 1 }]);
    expect(h.announced.join(" ")).toContain("Added to your bag");
  });

  it("reports a failed add without claiming success", async () => {
    h = await boot(
      "wishlist",
      {
        "GET /profile/wishlist": ok({ wishlist: ["1001"] }),
        "GET /catalog/products": ok({ products: [product()], missing: [] }),
      },
      { cartResult: { ok: false, reason: "unavailable" } },
    );
    h.root.querySelector<HTMLButtonElement>("[data-portal-wishlist-add]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.announced.join(" ")).toContain("sold out");
    expect(h.announced.join(" ")).not.toContain("Added to your bag");
  });
});

/* ========================================================================== *
 * Task 22 — Rewards
 * ========================================================================== */

const BALANCE = {
  spendableBalance: 500,
  tier: "Gold",
  tierMultiplier: 2,
  lifetimeSpendGBP: 800,
  isTopTier: false,
  nextTier: "Royal_VIP",
  nextTierThresholdGBP: 1000,
  progressToNextTierGBP: 200,
  availableRewards: [
    { id: "reward_5", cost: 100, valueGBP: 5, redeemable: true, additionalPointsRequired: 0 },
    { id: "reward_75", cost: 1000, valueGBP: 75, redeemable: false, additionalPointsRequired: 500 },
  ],
};

describe("Rewards: rendering as given, with no client arithmetic (task 22.2)", () => {
  it("renders balance, tier and multiplier exactly as the server reported", async () => {
    h = await boot("rewards", { "GET /balance": ok(BALANCE) });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector("[data-slot='balance']")?.textContent).toBe("500");
    expect(h.root.querySelector("[data-slot='tier']")?.textContent).toBe("Gold");
    expect(h.root.querySelector("[data-slot='multiplier']")?.textContent).toBe("2× points");
  });

  it("makes ONE request for everything (task 22.2)", async () => {
    h = await boot("rewards", { "GET /balance": ok(BALANCE) });
    expect(h.requests.filter((r) => r.path === "/balance")).toHaveLength(1);
  });

  it("renders a progressbar with values AND an adjacent text statement (§20.4)", async () => {
    h = await boot("rewards", { "GET /balance": ok(BALANCE) });
    const bar = h.root.querySelector("[data-portal-progress]");
    expect(bar?.getAttribute("role")).toBe("progressbar");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("1000");
    // The ONE permitted calculation: 1000 - 200 attained.
    expect(bar?.getAttribute("aria-valuenow")).toBe("800");
    // `aria-valuenow` is not a sentence a sighted customer can read.
    expect(h.root.querySelector("[data-slot='progress-text']")?.textContent).toContain("£200.00 more spend");
  });

  it("removes the bar at the top tier rather than showing a full one", async () => {
    h = await boot("rewards", {
      "GET /balance": ok({ ...BALANCE, isTopTier: true, nextTier: null, nextTierThresholdGBP: null, progressToNextTierGBP: null }),
    });
    expect(h.root.querySelector("[data-portal-progress]")).toBeNull();
    expect(h.root.querySelector("[data-slot='progress-text']")?.textContent).toContain("highest tier");
  });

  it("does not transition the progress fill (task 22.1)", async () => {
    h = await boot("rewards", { "GET /balance": ok(BALANCE) });
    const fill = h.root.querySelector<HTMLElement>("[data-portal-progress-fill]");
    expect(fill?.style.width).toBe("80%");
    // Motion the customer did not ask for, and it makes the value ambiguous.
    expect(fill?.style.transition).toBe("");
  });

  it("renders eligibility from the server's own additionalPointsRequired", async () => {
    h = await boot("rewards", { "GET /balance": ok(BALANCE) });
    const actions = [...h.root.querySelectorAll<HTMLButtonElement>("[data-slot='redeem']")];
    expect(actions).toHaveLength(2);
    expect(actions[0]?.disabled).toBe(false);
    expect(actions[1]?.disabled).toBe(true);
    // No threshold comparison of our own.
    expect(actions[1]?.getAttribute("aria-label")).toContain("500 more points needed");
  });

  it("shows the expiring-points note only when there is one (Requirement 8.13)", async () => {
    h = await boot("rewards", { "GET /balance": ok(BALANCE) });
    expect(h.root.querySelector("[data-portal-expiring]")).toBeNull();

    h = await boot("rewards", {
      "GET /balance": ok({
        ...BALANCE,
        expiringSoon: { points: 120, earliestExpiryAt: "2026-09-01T00:00:00.000Z", windowDays: 30 },
      }),
    });
    const note = h.root.querySelector("[data-portal-expiring]");
    expect(note?.hasAttribute("hidden")).toBe(false);
    expect(note?.textContent).toContain("120 points expire on 1 September 2026");
  });

  it("degrades on failure with a retry", async () => {
    h = await boot("rewards", { "GET /balance": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });
});

describe("Rewards: the redemption flow (Requirements 8.7-8.11, 8.14, 16.5)", () => {
  const REDEEM = "POST /redeem";

  async function bootRewards(redeemAnswer: unknown, balanceAfter?: unknown): Promise<Harness> {
    const responses: Record<string, unknown> = {
      "GET /balance": ok(balanceAfter ?? BALANCE),
      [REDEEM]: redeemAnswer,
      "GET /redemptions": ok({ redemptions: [] }),
    };
    return boot("rewards", responses);
  }

  /** Open the sheet and press Confirm. */
  async function redeemFirst(harness: Harness): Promise<void> {
    const action = harness.root.querySelector<HTMLButtonElement>("[data-slot='redeem']") as HTMLButtonElement;
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 2));
    harness.root.querySelector<HTMLButtonElement>("[data-portal-redeem-confirm]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 6));
  }

  it("confirms in the Task 18.5 sheet, showing cost and resulting balance (Req 8.7)", async () => {
    h = await bootRewards(ok({ id: "red-1", status: "issued", code: "ATH-5-ABC" }));
    const action = h.root.querySelector<HTMLButtonElement>("[data-slot='redeem']") as HTMLButtonElement;
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 2));

    const sheet = h.root.querySelector("[data-portal-redeem-sheet]");
    expect(sheet?.hasAttribute("open")).toBe(true);
    // Focus to the heading — the Task 18.5 primitive, not a new modal system.
    expect(document.activeElement?.id).toBe("T");
    expect(h.root.querySelector("[data-slot='sheet-cost']")?.textContent).toBe("100 points for £5");
    expect(h.root.querySelector("[data-slot='sheet-after']")?.textContent).toContain("400 points remaining");
    // Nothing has been spent yet.
    expect(h.requests.filter((r) => r.path === "/redeem")).toHaveLength(0);
  });

  it("shows the issued code, and invalidates then RE-READS the balance (Req 8.14)", async () => {
    h = await bootRewards(ok({ id: "red-1", status: "issued", code: "ATH-5-ABC" }), {
      ...BALANCE,
      spendableBalance: 400,
    });
    await redeemFirst(h);

    expect(h.requests.filter((r) => r.path === "/redeem")).toHaveLength(1);
    expect(h.root.querySelector("[data-portal-code]")?.textContent).toBe("ATH-5-ABC");
    expect(h.root.querySelector("[data-portal-code-panel]")?.hasAttribute("hidden")).toBe(false);
    // The 60 s snapshot would otherwise show the pre-redemption balance.
    expect(h.invalidations).toBe(1);
    expect(h.requests.filter((r) => r.path === "/balance").length).toBeGreaterThanOrEqual(2);
    expect(h.root.querySelector("[data-slot='balance']")?.textContent).toBe("400");
  });

  it("A DOUBLE PRESS yields ONE request and ONE outcome (Requirement 8.9)", async () => {
    h = await bootRewards(ok({ id: "red-1", status: "issued", code: "ATH-5-ABC" }));
    const action = h.root.querySelector<HTMLButtonElement>("[data-slot='redeem']") as HTMLButtonElement;
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const confirmControl = h.root.querySelector<HTMLButtonElement>("[data-portal-redeem-confirm]") as HTMLButtonElement;
    confirmControl.click();
    confirmControl.click();
    confirmControl.click();
    await new Promise((resolve) => setTimeout(resolve, 8));

    // One in-flight promise per reward: the later presses join the first.
    expect(h.requests.filter((r) => r.path === "/redeem")).toHaveLength(1);
    const codeAnnouncements = h.announced.filter((m) => m.includes("ATH-5-ABC"));
    expect(codeAnnouncements).toHaveLength(1);
  });

  it("presents pending_code as CONFIRMED, never as an error (Requirement 8.10)", async () => {
    h = await bootRewards(ok({ id: "red-1", status: "pending_code", code: null }));
    await redeemFirst(h);
    const said = h.announced.join(" ");
    expect(said).toContain("Redeemed 100 points");
    expect(said).toContain("being issued");
    // The points ARE spent, so this is success awaiting a code.
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.announced.join(" ")).not.toContain("could not");
  });

  it("polls at most 5 times and ends with the Activity message, not an error", async () => {
    // Boot on REAL timers — the harness settles the initial load with a real
    // `setTimeout`, and a fake clock installed before it would strand that await.
    // Only the 2 s poll needs to be advanced, and it starts on the confirm press.
    h = await bootRewards(ok({ id: "red-1", status: "pending_code", code: null }));
    vi.useFakeTimers();
    const action = h.root.querySelector<HTMLButtonElement>("[data-slot='redeem']") as HTMLButtonElement;
    action.click();
    await vi.advanceTimersByTimeAsync(2);
    h.root.querySelector<HTMLButtonElement>("[data-portal-redeem-confirm]")?.click();
    await vi.advanceTimersByTimeAsync(5);
    // 5 attempts at 2 s.
    await vi.advanceTimersByTimeAsync(12_000);

    const polls = h.requests.filter((r) => r.path === "/redemptions");
    expect(polls.length).toBeLessThanOrEqual(5);
    expect(h.root.querySelector("[data-portal-code]")?.textContent).toContain("Rewards Activity");
    // Never an invented error.
    expect(h.announced.join(" ")).not.toContain("could not be completed");
    vi.useRealTimers();
  });

  it("each failure is a distinct designed outcome with NO code (Requirement 8.11)", async () => {
    for (const [code, status] of [
      ["insufficient_points", 409],
      ["invalid_reward", 400],
      ["reward_channel_not_allowed", 403],
      ["lock_timeout", 503],
    ] as const) {
      h = await bootRewards(fail(code, status));
      await redeemFirst(h);
      const said = h.announced.join(" ");
      expect(said, `${code} said nothing`).toContain(copy.error(code));
      // The no-points-taken assurance.
      expect(said, `${code} lacked the assurance`).toContain("No points have been taken");
      // And no code panel.
      expect(h.root.querySelector("[data-portal-code-panel]")?.hasAttribute("hidden")).toBe(true);
      // The control is re-enabled so the customer can act.
      expect(h.root.querySelector<HTMLButtonElement>("[data-slot='redeem']")?.disabled).toBe(false);
    }
  });

  it("a 429 renders a wait state with the countdown and no code (Requirement 8.11)", async () => {
    h = await bootRewards(fail("rate_limit_exceeded", 429, { retryAfterSeconds: 30 }));
    await redeemFirst(h);
    const wait = h.root.querySelector("[data-portal-wait]");
    expect(wait?.hasAttribute("hidden")).toBe(false);
    expect(wait?.textContent).toContain("30 seconds");
    expect(h.root.querySelector("[data-portal-code-panel]")?.hasAttribute("hidden")).toBe(true);
    // A rate limit is not a claim about points, so no assurance is attached.
    expect(h.announced.join(" ")).not.toContain("No points have been taken");
  });

  it("announces nothing about success before the backend confirms", async () => {
    h = await bootRewards(fail("lock_timeout", 503));
    await redeemFirst(h);
    expect(h.announced.join(" ")).not.toMatch(/Redeemed \d+ points/);
    expect(h.invalidations).toBe(0);
  });

  it("a network TIMEOUT renders exactly ONE outcome and no code (task 22.5)", async () => {
    // The transport has already retried internally, carrying the SAME
    // `Idempotency-Key` — asserted at that layer in `portalTransport.dom.test.ts`
    // ("retries a write on a network failure with the SAME Idempotency-Key"),
    // which is the layer where that header is observable at all. What
    // this section owns is the consequence: one settled result, one rendered
    // outcome, no invented second attempt of its own.
    h = await bootRewards(fail("request_timeout", null));
    await redeemFirst(h);

    expect(h.requests.filter((r) => r.path === "/redeem")).toHaveLength(1);
    const outcomes = h.announced.filter((m) => m.includes(copy.error("request_timeout")));
    expect(outcomes).toHaveLength(1);
    expect(h.root.querySelector("[data-portal-code-panel]")?.hasAttribute("hidden")).toBe(true);
    // A timeout is not a claim that the points survived, but it IS retryable.
    expect(h.root.querySelector<HTMLButtonElement>("[data-slot='redeem']")?.disabled).toBe(false);
    expect(h.invalidations).toBe(0);
  });

  it("the disabled control states its reason while in flight (§18.8)", async () => {
    h = await bootRewards(ok({ id: "red-1", status: "issued", code: "ATH-5-ABC" }));
    const action = h.root.querySelector<HTMLButtonElement>("[data-slot='redeem']") as HTMLButtonElement;
    action.click();
    await new Promise((resolve) => setTimeout(resolve, 2));
    h.root.querySelector<HTMLButtonElement>("[data-portal-redeem-confirm]")?.click();
    // Synchronously disabled with a stated reason.
    expect(action.disabled).toBe(true);
    expect(action.getAttribute("aria-label")).toContain("Redeeming");
    await new Promise((resolve) => setTimeout(resolve, 6));
    // Still disabled after success: the points are spent.
    expect(action.disabled).toBe(true);
  });
});

/* ========================================================================== *
 * Task 22.4 — Rewards Activity
 * ========================================================================== */

describe("Rewards Activity (Requirements 9.2, 9.5, 9.8, 9.10)", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    type: "earned",
    points: 50,
    reason: "paid_order",
    date: "2026-06-12T00:00:00.000Z",
    orderReference: 1042,
    ...over,
  });

  it("renders descriptions from the copy map, never the ledger reason", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [{ id: "reward_5", cost: 100, valueGBP: 5 }] }),
      "GET /history": ok({ entries: [entry(), entry({ id: "e2", type: "spent", points: -100, reason: "reward_5", orderReference: null })], hasNextPage: false }),
    });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.textContent).toContain("Points from order 1042");
    // The reward's VALUE, never its id (§1.5's defect).
    expect(h.root.textContent).toContain("Redeemed — £5 credit");
    expect(h.root.textContent).not.toContain("reward_5");
    expect(h.root.textContent).not.toContain("paid_order");
  });

  it("renders every ledger type, and an UNMAPPED one gets the neutral description", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [] }),
      "GET /history": ok({
        entries: [
          entry({ id: "a", reason: "signup_bonus", orderReference: null }),
          entry({ id: "b", reason: "referral_signup_bonus", orderReference: null }),
          entry({ id: "c", reason: "point_lot_expired", type: "expired", points: -20, orderReference: null }),
          entry({ id: "d", reason: "refund_clawback", points: -10, orderReference: null }),
          // Requirement 9.8 — a value this asset has never seen.
          entry({ id: "e", reason: "future_entry_type_2031", orderReference: null }),
          // Operator free text (Requirement 9.7).
          entry({ id: "f", reason: "goodwill for Sarah, ticket 4821", orderReference: null }),
        ],
        hasNextPage: false,
      }),
    });
    const text = h.root.textContent ?? "";
    expect(text).toContain("Welcome to My Athoor");
    expect(text).toContain("A friend joined on your invitation");
    expect(text).toContain("Points expired");
    expect(text).toContain("Adjusted after a refund");
    // Both the unmapped type and the free text land on the neutral description.
    expect((text.match(/An adjustment to your account/g) ?? []).length).toBe(2);
    expect(text).not.toContain("future_entry_type_2031");
    expect(text).not.toContain("Sarah");
    expect(text).not.toContain("4821");
  });

  it("renders a signed amount, with the minus sign not a hyphen", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [] }),
      "GET /history": ok({ entries: [entry({ points: -100, orderReference: null })], hasNextPage: false }),
    });
    expect(h.root.querySelector("[data-slot='points']")?.textContent).toBe("\u2212100");
  });

  it("routes to the order only for an order-related entry (Requirement 9.5)", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [] }),
      "GET /history": ok({
        entries: [entry(), entry({ id: "e2", reason: "signup_bonus", orderReference: null })],
        hasNextPage: false,
      }),
    });
    const links = [...h.root.querySelectorAll("[data-slot='order-link']")];
    // One link for the order entry; the other was removed rather than left blank.
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/pages/my-athoor-order-detail?id=1042");
  });

  it("pages at 25 and appends without stealing focus", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [] }),
      "GET /history": ok({ entries: [entry()], hasNextPage: true }),
    });
    expect(h.request.mock.calls.some((c) => (c[0] as { query?: { pageSize?: number } }).query?.pageSize === 25)).toBe(true);

    const more = h.root.querySelector<HTMLButtonElement>("[data-portal-more-activity]") as HTMLButtonElement;
    expect(more.hasAttribute("hidden")).toBe(false);
    more.focus();
    more.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(document.activeElement).toBe(more);
    expect(h.announced.join(" ")).toContain("in total");
  });

  it("renders the empty state describing how points are earned (Requirement 9.10)", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [] }),
      "GET /history": ok({ entries: [], hasNextPage: false }),
    });
    expect(h.root.getAttribute("data-state")).toBe("empty");
    expect(h.root.querySelector("[data-portal-empty-action]")?.textContent).toContain("earn points on every order");
  });

  it("degrades on failure with a retry", async () => {
    h = await boot("activity", {
      "GET /rewards": ok({ rewards: [] }),
      "GET /history": fail("upstream_unavailable", 502),
    });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });
});
