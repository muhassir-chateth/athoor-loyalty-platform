// @vitest-environment jsdom
/**
 * Spec tasks 27.1–27.3 — the Portal_Home.
 *
 * Validates Requirements 4.1–4.12, 1.8, 15.1, 15.2, 15.8, 16.1, 18.2, 18.5, 21.5,
 * 26.2.
 *
 * The harness renders the REAL Liquid arm, extracted from `portal-section.liquid`,
 * with the one Liquid conditional evaluated for a named and an anonymous customer.
 * Task 24's non-vacuity run proved a transcribed markup constant cannot see a change
 * to the file that ships.
 *
 * Task 27.3's two structural rules get their own describe block and are asserted by
 * comparing the DOM before and after hydration rather than by reading the module's
 * intentions.
 *
 * SAFETY: jsdom only. `fetch` is never reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as states from "../../../theme-src/portal/render/states.js";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query?: unknown;
}

interface Harness {
  root: HTMLElement;
  requests: Recorded[];
  announced: string[];
  /** The server render, captured before the module ran. */
  serverHtml: string;
  observed: string[];
  reveal: () => Promise<void>;
}

const ok = (value: unknown) => ({ ok: true, value, requestId: "req-abcdef123456" });
const fail = (code: string, status: number | null) => ({
  ok: false,
  error: { code, status, requestId: "req-abcdef123456", retryable: status === null || status >= 500 },
});

const BALANCE = {
  spendableBalance: 500,
  tier: "Gold",
  isTopTier: false,
  nextTier: "Royal_VIP",
  nextTierThresholdGBP: 1000,
  progressToNextTierGBP: 200,
  availableRewards: [
    { id: "reward_5", cost: 100, valueGBP: 5, redeemable: true },
    { id: "reward_15", cost: 250, valueGBP: 15, redeemable: true },
    { id: "reward_75", cost: 1000, valueGBP: 75, redeemable: false },
  ],
};

const ORDERS = {
  orders: [
    {
      id: "gid://shopify/Order/5001",
      name: "#1042",
      processedAt: "2026-06-12T00:00:00.000Z",
      totalGBP: "195.00",
      fulfilmentStatus: "FULFILLED",
    },
  ],
  pageInfo: { hasNextPage: false },
};

const WISHLIST = { wishlist: ["1001", "1002"] };

const CATALOG = {
  products: [
    { productId: "1001", title: "Oud Royale 50ml", handle: "oud-royale", imageUrl: "https://cdn/a.jpg", published: true, availableForSale: true },
    { productId: "1002", title: "Amber Nuit", handle: "amber-nuit", imageUrl: "https://cdn/b.jpg", published: true, availableForSale: true },
  ],
  missing: [],
};

const REFERRAL = { referralCode: "ATHOOR-QY7", totals: { successful: 3, pending: 1, creditedPoints: 400 } };

const BIRTHDAY = {
  birthday: { month: 6, day: 12 },
  eligibility: { state: "eligible", windowOpensOn: "2026-06-05", windowDays: 14 },
  changeable: { allowed: true, allowedFrom: null },
};

const PROFILE = {
  inferred: { insight: { kind: "family_concentration", value: "oud", distinctProducts: 3 } },
  recentlyViewed: [{ productId: "1001" }],
};

function armSource(): string {
  const whole = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "theme", "snippets", "portal-section.liquid"),
    "utf8",
  );
  const start = whole.indexOf("{%- when 'overview' -%}");
  expect(start, "the overview arm is missing from portal-section.liquid").toBeGreaterThan(-1);
  const end = whole.indexOf("{%- when ", start + 1);
  return whole.slice(start + "{%- when 'overview' -%}".length, end === -1 ? undefined : end);
}

/** The arm with its comments stripped and its one conditional evaluated. */
function markup(firstName: string | null): string {
  let arm = armSource().replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
  // The single `{%- if customer.first_name != blank -%}` branch.
  arm = arm.replace(
    /\{%-\s*if customer\.first_name != blank\s*-%\}([\s\S]*?)\{%-\s*else\s*-%\}([\s\S]*?)\{%-\s*endif\s*-%\}/,
    (_all, named: string, anon: string) =>
      firstName === null ? anon.trim() : named.trim().replace("{{ customer.first_name }}", firstName),
  );
  return `
    <section class="athoor-portal__section" data-portal-section="overview" data-state="loading" aria-busy="true">
      <p data-portal-live aria-live="polite"></p>
      <div class="athoor-portal__state">
        <p data-portal-state-message>Preparing your account</p>
        <p data-portal-reference hidden></p>
        <button type="button" data-portal-retry hidden>Try again</button>
      </div>
      <div data-portal-skeleton aria-hidden="true"></div>
      <div data-portal-body></div>
      ${arm}
    </section>`;
}

let captured: ((el: HTMLElement) => void) | null = null;

async function boot(
  responses: Record<string, unknown>,
  opts: { firstName?: string | null; observer?: boolean } = {},
): Promise<Harness> {
  document.body.innerHTML = markup(opts.firstName === undefined ? "Layla" : opts.firstName);
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;
  const serverHtml = root.innerHTML;

  const requests: Recorded[] = [];
  const announced: string[] = [];
  const observed: string[] = [];
  const triggers: (() => void)[] = [];

  const request = vi.fn((spec: { method: string; path: string; query?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, query: spec.query });
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return Promise.resolve(responses[key]);
    return Promise.resolve(fail("not_found", 404));
  });

  // A controllable IntersectionObserver: nothing deferred fires until `reveal()`.
  if (opts.observer === false) {
    Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true });
  } else {
    class Stub {
      private readonly cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element): void {
        observed.push(target.getAttribute("data-portal-tile") ?? "");
        triggers.push(() => {
          this.cb(
            [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        });
      }
      disconnect(): void {
        /* the module disconnects before loading; nothing to undo in the stub */
      }
      unobserve(): void {
        /* unused */
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    Object.defineProperty(window, "IntersectionObserver", { value: Stub, configurable: true });
    Object.defineProperty(globalThis, "IntersectionObserver", { value: Stub, configurable: true });
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
    sheet: {
      open: (d: HTMLDialogElement) => () => d.removeAttribute("open"),
      close: (d: HTMLDialogElement) => d.removeAttribute("open"),
      isOpen: (d: HTMLDialogElement) => d.hasAttribute("open"),
    },
    copy,
    cart: { addToCart: () => Promise.resolve({ ok: true, added: 1 }), isAdding: () => false },
  };

  vi.resetModules();
  await import("../../../theme-src/portal/sections/overview.js");
  expect(captured, "no boot function registered").not.toBeNull();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 5));

  return {
    root,
    requests,
    announced,
    serverHtml,
    observed,
    reveal: async () => {
      for (const trigger of triggers) trigger();
      await new Promise((resolve) => setTimeout(resolve, 8));
    },
  };
}

let h: Harness;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { AthoorPortal?: unknown }).AthoorPortal;
});

const BASE = {
  "GET /balance": ok(BALANCE),
  "GET /orders": ok(ORDERS),
  "GET /profile/wishlist": ok(WISHLIST),
  "GET /catalog/products": ok(CATALOG),
  "GET /referral": ok(REFERRAL),
  "GET /profile/birthday": ok(BIRTHDAY),
  "GET /profile": ok(PROFILE),
};

const tiles = (harness: Harness): string[] =>
  [...harness.root.querySelectorAll("[data-portal-tile]")].map((t) => t.getAttribute("data-portal-tile") ?? "");

/* ========================================================================== *
 * The greeting
 * ========================================================================== */

describe("Overview: the greeting (Requirement 4.1)", () => {
  it("is SERVER-RENDERED from Liquid, present before any script runs", async () => {
    h = await boot(BASE, { firstName: "Layla" });
    // In the server HTML, captured before the module was invoked.
    expect(h.serverHtml).toContain("Welcome back, Layla");
    expect(h.root.querySelector("[data-portal-greeting]")?.textContent?.trim()).toBe("Welcome back, Layla");
  });

  it("degrades to a generic greeting rather than a dangling comma", async () => {
    h = await boot(BASE, { firstName: null });
    const greeting = h.root.querySelector("[data-portal-greeting]")?.textContent?.trim();
    expect(greeting).toBe("Welcome back");
    expect(greeting).not.toContain(",");
  });

  it("is not written or altered by the module", async () => {
    const before = await boot(BASE, { firstName: "Layla" });
    // The greeting node is byte-identical before and after hydration.
    const serverGreeting = /<p[^>]*data-portal-greeting[^>]*>([\s\S]*?)<\/p>/.exec(before.serverHtml)?.[1];
    expect(serverGreeting?.trim()).toBe("Welcome back, Layla");
    expect(before.root.querySelector("[data-portal-greeting]")?.textContent?.trim()).toBe(serverGreeting?.trim());
  });
});

/* ========================================================================== *
 * Task 27.3 — the omit-empty and no-shift rules
 * ========================================================================== */

describe("Overview: omit-empty and no-shift (Requirements 4.11, 16.1, 18.2)", () => {
  /** Every element in document order, as a shape signature. */
  function signature(html: string): string[] {
    const host = document.createElement("div");
    host.innerHTML = html;
    return [...host.querySelectorAll("*")].map(
      (node) =>
        `${node.tagName}#${node.getAttribute("data-portal-tile") ?? node.getAttribute("data-slot") ?? ""}`,
    );
  }

  it("NO element appears on hydration that the server render lacked", async () => {
    h = await boot(BASE);
    await h.reveal();
    const before = new Set(signature(h.serverHtml));
    const after = signature(h.root.innerHTML);
    // Rows cloned from a `<template>` are the one legitimate addition, and they land
    // INSIDE a server-rendered list. Everything else must already have existed.
    const templated = new Set(["LI#", "A#link", "SPAN#image", "SPAN#title", "IMG#image", "SPAN#", "A#", "IMG#"]);
    for (const node of after) {
      if (before.has(node) || templated.has(node)) continue;
      expect.fail(`hydration revealed an element the server render lacked: ${node}`);
    }
  });

  it("inserts NO content above existing content", async () => {
    h = await boot(BASE);
    const firstBefore = signature(h.serverHtml)[0];
    await h.reveal();
    // The greeting stays first. A late banner above it is a shift for the whole page.
    expect(signature(h.root.innerHTML)[0]).toBe(firstBefore);
    expect(h.root.firstElementChild?.tagName).toBe("P");
  });

  it("a tile with NO DATA is REMOVED, never left as an empty container (Req 4.11)", async () => {
    h = await boot({
      ...BASE,
      // No orders, no wishlist, no referral code, no birthday, no insight.
      "GET /orders": ok({ orders: [], pageInfo: { hasNextPage: false } }),
      "GET /profile/wishlist": ok({ wishlist: [] }),
      "GET /referral": ok({ referralCode: null, totals: { successful: 0 } }),
      "GET /profile/birthday": ok({ birthday: null, eligibility: { state: "not_set" }, changeable: { allowed: true, allowedFrom: null } }),
      "GET /profile": ok({ inferred: { insight: null }, recentlyViewed: [] }),
    });
    await h.reveal();

    // Gone entirely — not present-and-empty.
    for (const name of ["order", "wishlist", "referral", "birthday", "fragrance"]) {
      expect(h.root.querySelector(`[data-portal-tile="${name}"]`), `${name} survived with no data`).toBeNull();
    }
    // And the ones with data remain.
    expect(tiles(h)).toEqual(["loyalty", "reward"]);
  });

  it("a FAILED tile is removed rather than showing its own error box", async () => {
    h = await boot({ ...BASE, "GET /orders": fail("upstream_unavailable", 502) });
    expect(h.root.querySelector('[data-portal-tile="order"]')).toBeNull();
    // Eight "unavailable" boxes is a worse summary than a shorter page.
    expect(h.root.getAttribute("data-state")).toBe("ready");
  });

  it("emits no empty container anywhere once hydrated", async () => {
    h = await boot(BASE);
    await h.reveal();
    for (const container of h.root.querySelectorAll("[data-portal-tile]")) {
      const text = container.textContent?.replace(/\s+/g, "") ?? "";
      expect(text.length, `${container.getAttribute("data-portal-tile") ?? "?"} is an empty container`).toBeGreaterThan(0);
    }
  });
});

/* ========================================================================== *
 * The tiles
 * ========================================================================== */

describe("Overview: the tiles (Requirements 4.2-4.9)", () => {
  it("renders balance, tier and progress (Requirements 4.2)", async () => {
    h = await boot(BASE);
    const loyalty = h.root.querySelector('[data-portal-tile="loyalty"]') as HTMLElement;
    expect(loyalty.querySelector("[data-slot='balance']")?.textContent).toBe("500");
    expect(loyalty.querySelector("[data-slot='tier']")?.textContent).toBe("Gold");
    const bar = loyalty.querySelector("[data-portal-progress]");
    expect(bar?.getAttribute("role")).toBe("progressbar");
    expect(bar?.getAttribute("aria-valuemax")).toBe("1000");
    expect(bar?.getAttribute("aria-valuenow")).toBe("800");
    expect(loyalty.querySelector("[data-slot='progress-text']")?.textContent).toContain("£200.00 more spend");
    // Set once, never transitioned.
    const fill = loyalty.querySelector<HTMLElement>("[data-portal-progress-fill]");
    expect(fill?.style.width).toBe("80%");
    expect(fill?.style.transition).toBe("");
  });

  it("shows the highest-tier indication INSTEAD of a progress bar (Req 4.3)", async () => {
    // `isTopTier` must WIN even when the threshold fields are still populated, which
    // a server can legitimately do. Nulling them in the fixture would make the flag
    // redundant and the assertion would pass with the flag ignored entirely.
    h = await boot({
      ...BASE,
      "GET /balance": ok({ ...BALANCE, isTopTier: true, nextTier: "Royal_VIP", nextTierThresholdGBP: 1000, progressToNextTierGBP: 200 }),
    });
    let loyalty = h.root.querySelector('[data-portal-tile="loyalty"]') as HTMLElement;
    expect(loyalty.querySelector("[data-portal-progress]")).toBeNull();
    expect(loyalty.querySelector("[data-slot='progress-text']")?.textContent).toContain("highest tier");

    // And with the fields absent as well, which is the other shape of top tier.
    h = await boot({
      ...BASE,
      "GET /balance": ok({ ...BALANCE, isTopTier: true, nextTier: null, nextTierThresholdGBP: null, progressToNextTierGBP: null }),
    });
    loyalty = h.root.querySelector('[data-portal-tile="loyalty"]') as HTMLElement;
    expect(loyalty.querySelector("[data-portal-progress]")).toBeNull();
    expect(loyalty.querySelector("[data-slot='progress-text']")?.textContent).toContain("highest tier");
  });

  it("presents the most recent order with its date and a route (Req 4.4)", async () => {
    h = await boot(BASE);
    const order = h.root.querySelector('[data-portal-tile="order"]') as HTMLElement;
    expect(order.querySelector("[data-slot='name']")?.textContent).toBe("#1042");
    expect(order.querySelector("[data-slot='date']")?.textContent).toBe("12 June 2026");
    expect(order.querySelector("[data-slot='total']")?.textContent).toBe("£195.00");
    expect(order.querySelector<HTMLAnchorElement>("[data-portal-order-link]")?.getAttribute("href")).toBe(
      "/pages/my-athoor-order-detail?id=gid%3A%2F%2Fshopify%2FOrder%2F5001",
    );
  });

  it("presents ONE reward, the best the customer can afford (Req 4.5)", async () => {
    h = await boot(BASE);
    const reward = h.root.querySelector('[data-portal-tile="reward"]') as HTMLElement;
    // £15 is redeemable and worth more than £5; £75 is not redeemable.
    expect(reward.querySelector("[data-slot='value']")?.textContent).toBe("£15");
    expect(reward.querySelector("[data-slot='cost']")?.textContent).toBe("250 points");
    expect(reward.querySelectorAll(".athoor-portal__card")).toHaveLength(1);
  });

  it("omits the reward tile when nothing is redeemable", async () => {
    h = await boot({
      ...BASE,
      "GET /balance": ok({ ...BALANCE, availableRewards: [{ id: "reward_75", cost: 1000, valueGBP: 75, redeemable: false }] }),
    });
    expect(h.root.querySelector('[data-portal-tile="reward"]')).toBeNull();
    // The loyalty tile is unaffected.
    expect(h.root.querySelector('[data-portal-tile="loyalty"]')).not.toBeNull();
  });

  it("previews up to THREE wishlist items (Requirement 4.6)", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/wishlist": ok({ wishlist: ["1001", "1002", "1003", "1004", "1005"] }),
    });
    // Only three ids are ever requested.
    const query = h.requests.find((r) => r.path === "/catalog/products")?.query as { ids?: string };
    expect(query?.ids).toBe("1001,1002,1003");
    expect(h.root.querySelectorAll(".athoor-overview__wishlist-item").length).toBeLessThanOrEqual(3);
    expect(h.root.textContent).toContain("Oud Royale 50ml");
  });

  it("presents the referral count with a route, where a code exists (Req 4.7)", async () => {
    h = await boot(BASE);
    await h.reveal();
    const referral = h.root.querySelector('[data-portal-tile="referral"]') as HTMLElement;
    expect(referral.querySelector("[data-slot='referral-count']")?.textContent).toBe(
      "3 friends have joined with your code.",
    );
    expect(referral.querySelector("a")?.getAttribute("href")).toBe("/pages/my-athoor-referrals");
  });

  it("presents the birthday state ONLY when a benefit is available (Req 4.8)", async () => {
    h = await boot(BASE);
    await h.reveal();
    expect(h.root.querySelector('[data-portal-tile="birthday"] [data-slot="birthday-state"]')?.textContent).toBe(
      copy.birthdayEligibility("eligible"),
    );

    // A recorded birthday with NO benefit available is omitted, not announced.
    for (const state of ["outside_window", "already_granted_this_year"]) {
      h = await boot({
        ...BASE,
        "GET /profile/birthday": ok({ ...BIRTHDAY, eligibility: { state, windowOpensOn: null, windowDays: 14 } }),
      });
      await h.reveal();
      expect(h.root.querySelector('[data-portal-tile="birthday"]'), state).toBeNull();
    }
  });

  it("presents ONE fragrance insight from the customer's own profile (Req 4.9)", async () => {
    h = await boot(BASE);
    await h.reveal();
    const fragrance = h.root.querySelector('[data-portal-tile="fragrance"]') as HTMLElement;
    expect(fragrance.querySelector("[data-slot='insight']")?.textContent).toBe("Your collection leans toward Oud");
    // No raw identifier reaches the screen.
    expect(fragrance.textContent).not.toContain("family_concentration");
    expect(fragrance.textContent).not.toContain("oud_");
  });

  it("keeps the insight when the recently-viewed strip cannot be enriched", async () => {
    h = await boot({
      ...BASE,
      "GET /profile": ok(PROFILE),
      "GET /catalog/products": fail("upstream_unavailable", 502),
    });
    await h.reveal();
    const fragrance = h.root.querySelector('[data-portal-tile="fragrance"]') as HTMLElement | null;
    expect(fragrance).not.toBeNull();
    expect(fragrance?.querySelector("[data-slot='insight']")?.textContent).toContain("leans toward");
    // The empty strip is removed rather than left as a bare list.
    expect(fragrance?.querySelector("[data-portal-recent-list]")).toBeNull();
  });

  it("routes to every other Portal_Section (Requirement 4.12)", async () => {
    h = await boot(BASE);
    await h.reveal();
    const hrefs = new Set([...h.root.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? ""));
    for (const section of ["rewards", "orders", "wishlist", "referrals", "profile", "fragrance"]) {
      expect([...hrefs].some((href) => href === `/pages/my-athoor-${section}`), section).toBe(true);
    }
    // Settings and Activity are reached from the nav rail, which the chrome renders on
    // every portal page — asserted against that file below.
  });
});

/* ========================================================================== *
 * §21.5 — the request plan
 * ========================================================================== */

describe("Overview: the request plan (§21.5, Requirements 18.8, 21.5)", () => {
  it("makes exactly THREE reads on boot, and defers the rest", async () => {
    h = await boot(BASE);
    const bootPaths = h.requests.filter((r) => r.path !== "/catalog/products").map((r) => r.path).sort();
    expect(bootPaths).toEqual(["/balance", "/orders", "/profile/wishlist"]);
    // Referral, birthday and the profile read have NOT gone out yet.
    expect(h.requests.some((r) => r.path === "/referral")).toBe(false);
    expect(h.requests.some((r) => r.path === "/profile/birthday")).toBe(false);
    expect(h.requests.some((r) => r.path === "/profile")).toBe(false);
  });

  it("observes the three below-fold tiles, and fetches them on intersection", async () => {
    h = await boot(BASE);
    expect(h.observed.sort()).toEqual(["birthday", "fragrance", "referral"]);
    await h.reveal();
    for (const path of ["/referral", "/profile/birthday", "/profile"]) {
      expect(h.requests.filter((r) => r.path === path), path).toHaveLength(1);
    }
  });

  it("asks for ONE order, not a page of them", async () => {
    h = await boot(BASE);
    expect(h.requests.find((r) => r.path === "/orders")?.query).toEqual({ pageSize: 1 });
  });

  it("loads deferred tiles immediately when IntersectionObserver is absent", async () => {
    // A tile that silently never appears is worse than one extra request on a
    // browser that is already unusual.
    h = await boot(BASE, { observer: false });
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.some((r) => r.path === "/referral")).toBe(true);
    expect(h.requests.some((r) => r.path === "/profile/birthday")).toBe(true);
  });

  it("reads the balance through the cache, so Rewards is served the same snapshot", async () => {
    h = await boot(BASE);
    expect(h.requests.filter((r) => r.path === "/balance")).toHaveLength(1);
  });
});

/* ========================================================================== *
 * Independence and containment
 * ========================================================================== */

describe("Overview: independence (Requirements 15.1, 15.2, 15.8)", () => {
  it("one failed source drops only its own tiles", async () => {
    h = await boot({ ...BASE, "GET /balance": fail("upstream_unavailable", 502) });
    await h.reveal();
    // Loyalty and reward both come from `/balance`, so both go.
    expect(h.root.querySelector('[data-portal-tile="loyalty"]')).toBeNull();
    expect(h.root.querySelector('[data-portal-tile="reward"]')).toBeNull();
    // Everything else stands with its own data.
    expect(h.root.querySelector('[data-portal-tile="order"]')).not.toBeNull();
    expect(h.root.querySelector('[data-portal-tile="referral"]')).not.toBeNull();
    expect(h.root.getAttribute("data-state")).toBe("ready");
  });

  it("degrades the SECTION only when all three boot reads fail", async () => {
    h = await boot({
      ...BASE,
      "GET /balance": fail("upstream_unavailable", 502),
      "GET /orders": fail("upstream_unavailable", 502),
      "GET /profile/wishlist": fail("upstream_unavailable", 502),
    });
    // At that point there is no summary left to show.
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });

  it("excludes the upstream error detail from the output (Requirement 15.7)", async () => {
    h = await boot({
      ...BASE,
      "GET /balance": fail("upstream_unavailable", 502),
      "GET /orders": fail("upstream_unavailable", 502),
      "GET /profile/wishlist": fail("upstream_unavailable", 502),
    });
    const text = h.root.textContent ?? "";
    expect(text).not.toContain("502");
    expect(text).not.toContain("upstream_unavailable");
    expect(text).not.toContain("ECONNRESET");
  });

  it("a malformed payload drops its tile without throwing", async () => {
    h = await boot({
      ...BASE,
      // `availableRewards: 42` is not iterable, so the reward renderer THROWS rather
      // than returning false — which is what exercises the per-tile `catch`
      // (Requirement 15.8). A shape that merely returns false would leave that path
      // untested.
      "GET /balance": ok({ spendableBalance: "not a number", availableRewards: 42 }),
    });
    await h.reveal();
    expect(h.root.querySelector('[data-portal-tile="loyalty"]')).toBeNull();
    expect(h.root.querySelector('[data-portal-tile="reward"]')).toBeNull();
    // And the page still works.
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector('[data-portal-tile="order"]')).not.toBeNull();
  });

  it("an <img onerror> in a product title creates no element (Requirement 26.2)", async () => {
    h = await boot({
      ...BASE,
      "GET /catalog/products": ok({
        products: [{ productId: "1001", title: `<img src=x onerror="window.__pwned=true">`, handle: "x", published: true, availableForSale: true }],
        missing: [],
      }),
    });
    await h.reveal();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

/* ========================================================================== *
 * Security and storage
 * ========================================================================== */

describe("Overview: no customer identifier, no storage (Requirements 1.8, 26.6)", () => {
  it("emits NO customerId in any config block or data attribute", async () => {
    h = await boot(BASE);
    await h.reveal();
    const html = h.root.innerHTML;
    for (const token of ["customerId", "customer_id", "customer-id", "logged_in_customer_id"]) {
      expect(html, `the rendered output contains ${token}`).not.toContain(token);
    }
    // No inline config block at all.
    expect(h.root.querySelectorAll("script")).toHaveLength(0);
    // And the server render was clean too.
    expect(h.serverHtml).not.toContain("customerId");
  });

  it("sends no customer identity in any request", async () => {
    h = await boot(BASE);
    await h.reveal();
    for (const request of h.requests) {
      const serialised = JSON.stringify(request);
      expect(serialised).not.toContain("customerId");
      expect(serialised).not.toContain("logged_in_customer_id");
      expect(request.path.startsWith("/")).toBe(true);
    }
  });

  it("writes nothing to client storage", async () => {
    h = await boot(BASE);
    await h.reveal();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("performs NO mutation of any kind", async () => {
    h = await boot(BASE);
    await h.reveal();
    // Overview is the one section with no write path at all.
    expect(h.requests.every((r) => r.method === "GET")).toBe(true);
  });
});

/* ========================================================================== *
 * The shipped Liquid
 * ========================================================================== */

describe("Overview: the shipped Liquid", () => {
  const arm = armSource();

  it("renders the greeting from Liquid, with no script dependency", () => {
    expect(arm).toContain("{{ customer.first_name }}");
    expect(arm).toContain("data-portal-greeting");
    // The greeting is the FIRST element in the arm, so it is the LCP candidate and
    // nothing can be inserted above it.
    const firstTag = /<(\w+)/.exec(arm.replace(/\{%-?[\s\S]*?-?%\}/g, "").trim())?.[1];
    expect(firstTag).toBe("p");
  });

  it("emits no customer identifier", () => {
    for (const token of ["customer.id", "customerId", "logged_in_customer_id"]) {
      expect(arm, `the overview arm emits ${token}`).not.toContain(`{{ ${token}`);
    }
    expect(arm).not.toContain("data-customer");
  });

  it("uses exactly ONE card, and it is the reward (§18.5)", () => {
    // The negative lookahead matters: `\b` would also match `athoor-portal__card-value`,
    // `-cost` and `-action`, which are slots INSIDE the one card rather than cards.
    const cards = arm.match(/athoor-portal__card(?![\w-])/g) ?? [];
    expect(cards).toHaveLength(1);
    const rewardTile = arm.slice(arm.indexOf('data-portal-tile="reward"'));
    expect(rewardTile.slice(0, 600)).toContain("athoor-portal__card");
  });

  it("marks exactly the three below-fold tiles as deferred", () => {
    const deferred = arm.match(/data-portal-defer/g) ?? [];
    expect(deferred).toHaveLength(3);
    for (const name of ["referral", "birthday", "fragrance"]) {
      const tileMarkup = arm.slice(arm.indexOf(`data-portal-tile="${name}"`));
      expect(tileMarkup.slice(0, 200), name).toContain("data-portal-defer");
    }
  });

  it("the nav rail routes to Settings and Activity, which the tiles do not", () => {
    // Requirement 4.12 is satisfied jointly: the tiles carry the routes they own and
    // the chrome's nav carries the rest on every portal page.
    const nav = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "theme", "snippets", "portal-nav.liquid"),
      "utf8",
    );
    for (const route of ["/pages/my-athoor-settings", "/pages/my-athoor-rewards", "/pages/my-athoor-profile"]) {
      expect(nav, `the nav lacks ${route}`).toContain(route);
    }
  });
});
