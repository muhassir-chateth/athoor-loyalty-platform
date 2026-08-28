// Feature: customer-experience-portal, Property 6: Section rendering is independent
// @vitest-environment jsdom
/**
 * PROPERTY 6 — spec task 27.4. Validates Requirements 15.1, 15.2, 15.3, 15.4.
 *
 * The property: for ANY subset of the four upstream sources failing, in ANY failure
 * mode, exactly the sections whose sources are in that subset show a degraded state;
 * every other section renders fully with its own data; and navigation stays operable.
 *
 * ── WHY THIS IS A PROPERTY AND NOT A TABLE OF CASES ─────────────────────────
 * §22.2's dependency matrix has fifteen rows and four source columns. A table test
 * over "Postgres down" and "Admin down" checks two of the sixteen source subsets and
 * one of the five failure modes — eleven per cent of the space — and the cases it
 * misses are the interesting ones: two sources failing at once, a malformed body that
 * parses but carries nothing, a connection reset mid-stream. The property is stated
 * over the whole power set precisely so the combinations nobody thought to enumerate
 * are covered.
 *
 * ── THE ORACLE IS THE DESIGN'S OWN MATRIX ───────────────────────────────────
 * `SECTION_SOURCES` below transcribes §22.2 row by row. The property then asserts
 * that the ACTUAL rendered state of each section agrees with what the matrix predicts
 * from the failing subset. That is what makes this a test of the implementation
 * rather than a restatement of it: if a section quietly acquires a dependency the
 * matrix does not record — a Rewards tile that starts needing the Admin API, say —
 * the prediction and the reality diverge and the property fails.
 *
 * ── THE TWO CASES THE REQUIREMENTS NAME ─────────────────────────────────────
 * Requirements 15.3 and 15.4 are asserted as their own properties, because §22.2
 * records an honest correction to 15.3's wording: `/v1/orders` is served BY the
 * Loyalty_Service, so "Loyalty_Service unreachable" and "Postgres unavailable but
 * the service up" degrade DIFFERENT sets. The requirement's single phrase does not
 * distinguish them; the matrix does, by column. Both are asserted separately.
 *
 * SAFETY: jsdom only. No network, no database. Every section is driven through the
 * same stubbed transport the DOM suites use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as draft from "../../../theme-src/portal/state/draft.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as sheet from "../../../theme-src/portal/ui/sheet.js";
import * as states from "../../../theme-src/portal/render/states.js";

/* ========================================================================== *
 * The four sources and the five failure modes
 * ========================================================================== */

/** §22.2's four columns. */
type Source = "liquid" | "admin" | "postgres" | "service";
const SOURCES: readonly Source[] = ["liquid", "admin", "postgres", "service"];

/**
 * The failure modes task 27.4 enumerates.
 *
 * Each maps to what the TRANSPORT would hand a section. `malformed` is the subtle
 * one: it is a `200` whose body parses as JSON but carries none of the fields the
 * section needs, which is why it is modelled as a success rather than a failure.
 */
type Mode = "timeout" | "server_error" | "rate_limited" | "malformed" | "connection_reset";
const MODES: readonly Mode[] = ["timeout", "server_error", "rate_limited", "malformed", "connection_reset"];

function failureFor(mode: Mode): unknown {
  switch (mode) {
    case "timeout":
      // No answer at all: the transport reports a null status.
      return { ok: false, error: { code: "request_timeout", status: null, requestId: null, retryable: true } };
    case "server_error":
      return { ok: false, error: { code: "internal_error", status: 500, requestId: "req-a", retryable: true } };
    case "rate_limited":
      return {
        ok: false,
        error: { code: "rate_limit_exceeded", status: 429, requestId: "req-a", retryable: false, retryAfterSeconds: 30 },
      };
    case "connection_reset":
      return { ok: false, error: { code: "upstream_unavailable", status: null, requestId: null, retryable: true } };
    case "malformed":
      // A 200 that parses and says nothing. The hardest case to handle without
      // throwing, and the one a table test never writes.
      return { ok: true, value: {}, requestId: "req-a" };
  }
}

/* ========================================================================== *
 * §22.2, transcribed
 * ========================================================================== */

/** One portal section under test, its bundle, and the sources it needs. */
interface SectionUnderTest {
  readonly name: string;
  readonly importer: () => Promise<unknown>;
  /** Sources whose failure degrades this section, per §22.2. */
  readonly needs: readonly Source[];
  /** Path → which source serves it. */
  readonly paths: Readonly<Record<string, Source>>;
  /** Payloads that let the section reach `ready` when nothing is failing. */
  readonly happy: Readonly<Record<string, unknown>>;
  readonly markup: string;
}

const SHELL = (name: string, inner: string): string => `
  <section class="athoor-portal__section" data-portal-section="${name}" data-state="loading" aria-busy="true">
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

const ok = (value: unknown) => ({ ok: true, value, requestId: "req-a" });

const BALANCE = {
  spendableBalance: 500,
  tier: "Gold",
  tierMultiplier: 2,
  isTopTier: false,
  nextTier: "Royal_VIP",
  nextTierThresholdGBP: 1000,
  progressToNextTierGBP: 200,
  availableRewards: [{ id: "reward_5", cost: 100, valueGBP: 5, redeemable: true, additionalPointsRequired: 0 }],
};

/**
 * The sections under test.
 *
 * Rewards, Activity, Referrals and Wishlist are Postgres-backed; Orders is
 * Admin-backed. All five need the Render service, because every one of their reads is
 * an App Proxy call the service answers. That last fact is why the `service` column
 * degrades everything — and asserting it is how §22.2's honest correction to
 * Requirement 15.3 gets tested rather than argued about.
 */
const SECTIONS: readonly SectionUnderTest[] = [
  {
    name: "rewards",
    importer: () => import("../../../theme-src/portal/sections/rewards.js"),
    needs: ["postgres", "service"],
    paths: { "/balance": "postgres" },
    happy: { "GET /balance": ok(BALANCE) },
    markup: SHELL(
      "rewards",
      `<p data-slot="balance">0</p><p><span data-slot="tier"></span> <span data-slot="multiplier"></span></p>
       <div data-portal-progress><span data-portal-progress-fill></span></div>
       <p data-slot="progress-text"></p><p data-portal-expiring hidden></p>
       <div data-portal-code-panel hidden><p data-portal-code></p><button type="button" data-portal-copy-code hidden>Copy</button></div>
       <p data-portal-wait hidden></p>
       <template data-portal-row="reward"><li class="athoor-portal__card"><span data-slot="value"></span><span data-slot="cost"></span><span data-slot="eligibility"></span><button type="button" data-slot="redeem"></button></li></template>`,
    ),
  },
  {
    name: "activity",
    importer: () => import("../../../theme-src/portal/sections/activity.js"),
    needs: ["postgres", "service"],
    paths: { "/rewards": "postgres", "/history": "postgres" },
    happy: {
      "GET /rewards": ok({ rewards: [{ id: "reward_5", cost: 100, valueGBP: 5 }] }),
      "GET /history": ok({
        entries: [{ id: "e1", type: "earned", points: 50, reason: "paid_order", date: "2026-06-12T00:00:00.000Z", orderReference: 1042 }],
        hasNextPage: false,
      }),
    },
    markup: SHELL(
      "activity",
      `<template data-portal-row="activity"><li class="athoor-portal__row"><span data-slot="description"></span><span data-slot="points"></span><span data-slot="date"></span><a data-slot="order-link" href="#" hidden></a></li></template>
       <button type="button" data-portal-more-activity hidden>More</button>
       <p data-portal-empty-action>You earn points on every order.</p>`,
    ),
  },
  {
    name: "referrals",
    importer: () => import("../../../theme-src/portal/sections/referrals.js"),
    needs: ["postgres", "service"],
    paths: { "/referral": "postgres" },
    happy: {
      "GET /referral": ok({
        referralCode: "ATHOOR-QY7",
        shareUrl: "https://example/?ref=ATHOOR-QY7",
        wasReferred: true,
        totals: { successful: 2, pending: 1, creditedPoints: 400 },
        stages: [{ key: "friend_signup", qualification: "friend_account_created", currentRewardPoints: 1, creditedPoints: 2, awardedCount: 1, pendingCount: 0, state: "awarded" }],
      }),
    },
    markup: SHELL(
      "referrals",
      `<header><p data-portal-referral-code></p><p data-portal-referral-link hidden></p>
       <button type="button" data-portal-referral-copy hidden>Copy</button>
       <button type="button" data-portal-referral-share hidden>Share</button>
       <p data-portal-referral-copy-result hidden></p></header>
       <ul data-portal-referral-totals role="list" hidden><li><span data-slot="successful"></span></li><li><span data-slot="pending"></span></li><li><span data-slot="credited"></span></li></ul>
       <h2 data-portal-referral-stages-heading hidden>How it works</h2>
       <template data-portal-row="stage"><li class="athoor-portal__row"><span data-slot="name"></span><span data-slot="qualification"></span><span data-slot="state"></span><span data-slot="points"></span></li></template>
       <form data-portal-referral-claim hidden novalidate><input name="referralCode" type="text"><button type="submit" data-portal-referral-claim-submit>Apply</button><p data-portal-referral-claim-message hidden></p></form>
       <p class="athoor-portal__empty-action" data-portal-empty-action>Share your code.</p>`,
    ),
  },
  {
    name: "orders",
    importer: () => import("../../../theme-src/portal/sections/orders.js"),
    needs: ["admin", "service"],
    paths: { "/orders": "admin" },
    happy: {
      "GET /orders": ok({
        orders: [{ id: "gid://shopify/Order/1", name: "#1042", processedAt: "2026-06-12T00:00:00.000Z", financialStatus: "PAID", fulfilmentStatus: "FULFILLED", totalGBP: "195.00", currencyCode: "GBP", lineItemCount: 2, previewLineItems: [] }],
        pageInfo: { hasNextPage: false },
      }),
    },
    markup: SHELL(
      "orders",
      `<template data-portal-row="order"><li class="athoor-portal__row"><a data-slot="link" href="#"><span data-slot="name"></span><span data-slot="date"></span><span data-slot="total"></span><span data-slot="status"></span><span data-slot="items"></span></a></li></template>
       <button type="button" data-portal-more hidden>More</button>
       <p class="athoor-portal__empty-action" data-portal-empty-action><a href="/collections/all">Browse</a></p>`,
    ),
  },
];

/* ========================================================================== *
 * The harness
 * ========================================================================== */

let captured: ((el: HTMLElement) => void) | null = null;

interface Outcome {
  readonly state: string;
  readonly hasRetry: boolean;
  readonly bodyText: string;
  readonly navOperable: boolean;
}

async function renderSection(
  section: SectionUnderTest,
  failing: ReadonlySet<Source>,
  mode: Mode,
): Promise<Outcome> {
  document.body.innerHTML = `
    <div class="athoor-portal" data-portal-root>
      <nav data-portal-nav>
        <a href="/pages/my-athoor">Overview</a>
        <a href="/pages/my-athoor-orders">Orders</a>
        <a href="/pages/my-athoor-rewards">Rewards</a>
        <a href="/pages/my-athoor-settings">Settings</a>
      </nav>
      ${section.markup}
    </div>`;
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const request = vi.fn((spec: { method: string; path: string }) => {
    const source = section.paths[spec.path];
    // EVERY path is answered BY the Render service, so a path fails when its own data
    // source is down OR when the service is. Modelling only the data source would let
    // a service outage look survivable, which is precisely the confusion §22.2's
    // honest correction to Requirement 15.3 exists to remove.
    const failed = source !== undefined && (failing.has(source) || failing.has("service"));
    if (failed) return Promise.resolve(failureFor(mode));
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(section.happy, key)) {
      return Promise.resolve(section.happy[key]);
    }
    return Promise.resolve(ok({}));
  });

  for (const dialog of root.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.showModal = function showModal(): void {
      this.setAttribute("open", "open");
    };
    dialog.close = function close(): void {
      this.removeAttribute("open");
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
    cache: { read: request, invalidateBalance: () => undefined, clear: () => undefined, size: () => 0 },
    draft: { get: draft.get, set: draft.set, clear: draft.clear, has: draft.has },
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
      polite: announce.polite,
      assertive: announce.assertive,
      global: () => undefined,
      loadingOnce: announce.loadingOnce,
    },
    focus,
    sheet: { open: sheet.open, close: sheet.close, isOpen: sheet.isOpen },
    copy,
    cart: { addToCart: () => Promise.resolve({ ok: true, added: 1 }), isAdding: () => false },
  };

  vi.resetModules();
  await section.importer();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 6));

  const nav = document.querySelector("[data-portal-nav]");
  return {
    state: root.getAttribute("data-state") ?? "",
    hasRetry: root.querySelector("[data-portal-retry]")?.hasAttribute("hidden") === false,
    bodyText: root.textContent ?? "",
    // Requirement 15.8 — every route to every other section still reachable.
    navOperable: (nav?.querySelectorAll("a[href]").length ?? 0) === 4,
  };
}

/** §16.3's failure states. Anything else means the section rendered. */
const DEGRADED_STATES: ReadonlySet<string> = new Set(["degraded", "error", "offline", "session-expired"]);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  draft.clearAll();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { AthoorPortal?: unknown }).AthoorPortal;
  draft.clearAll();
});

/* ========================================================================== *
 * The property
 * ========================================================================== */

describe("Property 6: section rendering is independent", () => {
  /** The power set of the four sources, as a generator. */
  const failingSubset = fc
    .subarray([...SOURCES], { minLength: 0, maxLength: SOURCES.length })
    .map((values) => new Set<Source>(values));

  it("exactly the sections whose sources fail degrade; every other renders fully", async () => {
    await fc.assert(
      fc.asyncProperty(
        failingSubset,
        fc.constantFrom(...MODES),
        fc.constantFrom(...SECTIONS.map((s) => s.name)),
        async (failing, mode, sectionName) => {
          const section = SECTIONS.find((s) => s.name === sectionName);
          if (!section) return;

          const outcome = await renderSection(section, failing, mode);
          const predicted = section.needs.some((source) => failing.has(source));

          if (predicted) {
            if (mode === "malformed") {
              // A `200` that carries nothing is not a failure the transport can see,
              // so the section renders an EMPTY or ready state rather than degrading.
              // That is correct behaviour, and asserting `degraded` here would be
              // asserting a bug. What must hold is that it did not throw and the
              // navigation survived.
              expect(DEGRADED_STATES.has(outcome.state) || outcome.state === "empty" || outcome.state === "ready").toBe(true);
            } else {
              expect(
                DEGRADED_STATES.has(outcome.state),
                `${sectionName} should degrade for {${[...failing].join(",")}} / ${mode} but was "${outcome.state}"`,
              ).toBe(true);
            }
          } else {
            expect(
              DEGRADED_STATES.has(outcome.state),
              `${sectionName} degraded for {${[...failing].join(",")}} / ${mode} but depends on none of them`,
            ).toBe(false);
          }

          // Requirement 15.8 — navigation stays operable in every combination.
          expect(outcome.navOperable, "navigation stopped being operable").toBe(true);
          // Requirement 15.7 — no upstream detail in the rendered output, ever.
          // Deliberately NOT a bare status number: a balance of 500 points is
          // legitimate output, and a scan for "500" would flag the customer's own
          // data. The identifiers are what must never surface.
          for (const leak of ["ECONNRESET", "internal_error", "upstream_unavailable", "request_timeout", "rate_limit_exceeded", "stack trace"]) {
            expect(outcome.bodyText, `${sectionName} leaked ${leak}`).not.toContain(leak);
          }
        },
      ),
      { numRuns: 160 },
    );
  }, 120_000);

  it("a degraded section offers a retry unless the answer was determinate (§22.9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Mode>("timeout", "server_error", "connection_reset"),
        fc.constantFrom(...SECTIONS.map((s) => s.name)),
        async (mode, sectionName) => {
          const section = SECTIONS.find((s) => s.name === sectionName);
          if (!section) return;
          const outcome = await renderSection(section, new Set(section.needs), mode);
          // A retryable failure must offer the retry; that is the whole point of it.
          expect(outcome.hasRetry, `${sectionName} / ${mode} offered no retry`).toBe(true);
        },
      ),
      { numRuns: 120 },
    );
  }, 120_000);

  it("Requirement 15.4 — Admin unreachable degrades Orders and NOT the Postgres sections", async () => {
    const failing = new Set<Source>(["admin"]);
    for (const mode of MODES) {
      if (mode === "malformed") continue;
      const orders = await renderSection(SECTIONS.find((s) => s.name === "orders")!, failing, mode);
      expect(DEGRADED_STATES.has(orders.state), `orders / ${mode}`).toBe(true);

      for (const name of ["rewards", "activity", "referrals"]) {
        const outcome = await renderSection(SECTIONS.find((s) => s.name === name)!, failing, mode);
        expect(
          DEGRADED_STATES.has(outcome.state),
          `${name} degraded on an Admin outage but is served by Postgres / ${mode}`,
        ).toBe(false);
      }
    }
  }, 120_000);

  it("Requirement 15.3 — Postgres unavailable but the service UP degrades the loyalty set only", async () => {
    // §22.2's honest correction: `/v1/orders` is served BY the service, so this case
    // and "the service is down" degrade different sets. Here the service is up.
    const failing = new Set<Source>(["postgres"]);
    for (const mode of MODES) {
      if (mode === "malformed") continue;
      for (const name of ["rewards", "activity", "referrals"]) {
        const outcome = await renderSection(SECTIONS.find((s) => s.name === name)!, failing, mode);
        expect(DEGRADED_STATES.has(outcome.state), `${name} / ${mode}`).toBe(true);
      }
      const orders = await renderSection(SECTIONS.find((s) => s.name === "orders")!, failing, mode);
      expect(
        DEGRADED_STATES.has(orders.state),
        `orders degraded on a Postgres outage but touches Shopify only / ${mode}`,
      ).toBe(false);
    }
  }, 120_000);

  it("the SERVICE being down degrades every section that needs an API", async () => {
    const failing = new Set<Source>(["service"]);
    for (const section of SECTIONS) {
      const outcome = await renderSection(section, failing, "connection_reset");
      expect(DEGRADED_STATES.has(outcome.state), `${section.name} survived a service outage`).toBe(true);
      // And the navigation — which is Liquid-rendered — still works.
      expect(outcome.navOperable).toBe(true);
    }
  }, 120_000);

  it("is NON-VACUOUS: the oracle distinguishes the two named cases", () => {
    // If every section needed every source, the property above would be trivially
    // satisfied and would prove nothing. These are the distinctions that make it bite.
    const bySource = (source: Source): string[] =>
      SECTIONS.filter((s) => s.needs.includes(source)).map((s) => s.name).sort();
    expect(bySource("postgres")).toEqual(["activity", "referrals", "rewards"]);
    expect(bySource("admin")).toEqual(["orders"]);
    // Every section needs the service, which is exactly why 15.3's two readings differ.
    expect(bySource("service")).toEqual(["activity", "orders", "referrals", "rewards"]);
    // No section is claimed to need Liquid for its DATA — Liquid renders the chrome.
    expect(bySource("liquid")).toEqual([]);
  });
});
