// @vitest-environment jsdom
/**
 * Spec tasks 24.2 and 24.3 — the Fragrance Profile section.
 *
 * Validates Requirements 12.1, 12.2, 12.6, 12.7, 12.8, 14.1, 16.3, 17.8, 26.2.
 *
 * Task 24.3's provenance separation is the reason this file exists in the shape it
 * does: the assertions are structural and mechanical — no rendered list, grid or
 * sentence may mix `data-provenance="declared"` with `data-provenance="derived"` —
 * because a caption is easy to add and easy to get subtly wrong, and reviewing it by
 * eye does not scale past the first change.
 *
 * SAFETY: jsdom only. `fetch` is never reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as states from "../../../theme-src/portal/render/states.js";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface Harness {
  root: HTMLElement;
  requests: Recorded[];
  announced: string[];
}

const ok = (value: unknown) => ({ ok: true, value, requestId: "req-abcdef123456" });
const fail = (code: string, status: number | null) => ({
  ok: false,
  error: { code, status, requestId: "req-abcdef123456", retryable: status === null || status >= 500 },
});

/** The service's own frozen vocabulary, abridged to keep the fixtures readable. */
const VOCABULARY = {
  scent_family: ["oud", "amber", "floral", "woody"],
  note: ["rose", "saffron", "orange_blossom"],
  intensity: ["subtle", "balanced", "bold"],
  occasion: ["daily", "evening", "formal"],
  season: ["spring", "summer", "autumn", "winter"],
};

const LIMITS = { scent_family: 10, note: 20, occasion: 6, season: 4 };

function preferences(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vocabulary: VOCABULARY,
    declared: { scent_family: [], note: [], intensity: null, occasion: [], season: [] },
    communication: {
      productLaunches: true,
      restockAlerts: true,
      birthdayMessages: true,
      referralUpdates: true,
    },
    limits: LIMITS,
    ...over,
  };
}

function profile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inferred: {
      basis: [],
      scent_family: [],
      note: [],
      season: null,
      occasion: null,
      insight: null,
    },
    recentlyViewed: [],
    ...over,
  };
}

/** The Liquid arm, transcribed. The templates are what `rows.list` is handed. */
const MARKUP = `
  <section class="athoor-portal__section" data-portal-section="fragrance" data-state="loading" aria-busy="true">
    <p data-portal-live aria-live="polite"></p>
    <div class="athoor-portal__state">
      <p data-portal-state-message>Preparing your account</p>
      <p data-portal-reference hidden></p>
      <button type="button" data-portal-retry hidden>Try again</button>
    </div>
    <div data-portal-skeleton aria-hidden="true"></div>
    <div data-portal-body></div>
    <section data-portal-declared aria-labelledby="AthoorFragranceDeclaredTitle" hidden>
      <h2 id="AthoorFragranceDeclaredTitle">You told us</h2>
      <div data-portal-dimensions></div>
    </section>
    <template data-portal-row="dimension">
      <fieldset class="athoor-fragrance__dimension">
        <legend data-slot="legend"></legend>
        <p data-slot="prompt"></p>
        <div data-slot="pills" role="group"></div>
      </fieldset>
    </template>
    <template data-portal-row="pill">
      <button type="button" data-portal-pill data-provenance="declared" aria-pressed="false"><span data-slot="label"></span></button>
    </template>
    <section data-portal-derived aria-labelledby="AthoorFragranceDerivedTitle" hidden>
      <h2 id="AthoorFragranceDerivedTitle">From your own activity — your orders, saved items and recent views</h2>
      <p data-portal-basis></p>
      <p data-portal-insight hidden></p>
      <div data-portal-derived-groups></div>
    </section>
    <template data-portal-row="derived">
      <li class="athoor-portal__row" data-provenance="derived">
        <span data-slot="value"></span><span data-slot="evidence"></span>
        <button type="button" data-portal-promote data-slot="promote"></button>
      </li>
    </template>
    <template data-portal-row="derived-group">
      <div class="athoor-fragrance__derived-group">
        <h3 data-slot="legend"></h3>
        <ul class="athoor-fragrance__derived-list" role="list" data-slot="list"></ul>
      </div>
    </template>
    <section data-portal-recent aria-labelledby="AthoorFragranceRecentTitle" hidden>
      <h2 id="AthoorFragranceRecentTitle">Recently viewed</h2>
      <ul class="athoor-fragrance__recent" role="list" data-portal-recent-list></ul>
    </section>
    <template data-portal-row="recent">
      <li class="athoor-fragrance__recent-item" data-provenance="derived">
        <a data-slot="link" href="#"><span class="athoor-portal__image-box"><img data-slot="image" alt="" width="300" height="300"></span><span data-slot="title"></span></a>
      </li>
    </template>
    <div data-portal-empty-action>
      <p>Tell us your taste in three answers: which families you like, how strong you wear it, and when.</p>
    </div>
  </section>`;

let captured: ((el: HTMLElement) => void) | null = null;

async function boot(responses: Record<string, unknown>): Promise<Harness> {
  document.body.innerHTML = MARKUP;
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const requests: Recorded[] = [];
  const announced: string[] = [];

  const request = vi.fn((spec: { method: string; path: string; body?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, body: spec.body });
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return Promise.resolve(responses[key]);
    return Promise.resolve(fail("not_found", 404));
  });

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
  await import("../../../theme-src/portal/sections/fragrance.js");
  expect(captured, "no boot function registered").not.toBeNull();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 4));

  return { root, requests, announced };
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
  "GET /profile/preferences": ok(preferences()),
  "GET /profile": ok(profile()),
};

/* ========================================================================== *
 * The declared block
 * ========================================================================== */

describe("Fragrance: declared preferences (Requirements 12.1, 12.2, 12.7)", () => {
  it("renders the five dimensions as pill sets from the SERVER's vocabulary", async () => {
    h = await boot(BASE);
    const legends = [...h.root.querySelectorAll("legend")].map((l) => l.textContent);
    expect(legends).toEqual([
      "Scent families",
      "Favourite notes",
      "Preferred strength",
      "Occasions",
      "Seasons",
    ]);
    // Exactly the values the server offered, and nothing this asset invented.
    const families = [...h.root.querySelectorAll("fieldset")][0];
    expect([...(families?.querySelectorAll("[data-portal-pill]") ?? [])].map((p) => p.textContent)).toEqual([
      "Oud",
      "Amber",
      "Floral",
      "Woody",
    ]);
  });

  it("renders an underscored vocabulary value as words, never the identifier", async () => {
    // TWO paths, and they must both be covered. `orange_blossom` has an explicit
    // sentence-case entry in the label table; `oud_mubakhar` has none and must fall
    // through to the title-case splitter. Asserting only the first would leave the
    // splitter untested, because the table short-circuits it.
    h = await boot({
      ...BASE,
      "GET /profile/preferences": ok(
        preferences({
          vocabulary: { ...VOCABULARY, note: ["rose", "orange_blossom", "oud_mubakhar"] },
        }),
      ),
    });
    expect(h.root.textContent).toContain("Orange blossom");
    expect(h.root.textContent).toContain("Oud Mubakhar");
    expect(h.root.textContent).not.toContain("orange_blossom");
    expect(h.root.textContent).not.toContain("oud_mubakhar");
    // And no dimension identifier reaches the screen either.
    for (const id of ["scent_family", "recently_viewed"]) {
      expect(h.root.textContent).not.toContain(id);
    }
  });

  it("reflects the stored selection with aria-pressed, not colour alone (Req 17.8)", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/preferences": ok(
        preferences({ declared: { scent_family: ["oud", "woody"], note: [], intensity: "bold", occasion: [], season: [] } }),
      ),
    });
    const pressed = [...h.root.querySelectorAll("[data-portal-pill][aria-pressed='true']")].map(
      (p) => p.textContent,
    );
    expect(pressed).toEqual(["Oud", "Woody", "Bold"]);
  });

  it("an EMPTY dimension still renders its options with an invitation (Req 12.7)", async () => {
    h = await boot(BASE);
    // Never an error, and never a hidden block.
    const fieldsets = [...h.root.querySelectorAll("fieldset")];
    expect(fieldsets).toHaveLength(5);
    expect(h.root.textContent).toContain("Which families do you reach for?");
    expect(h.root.textContent).not.toContain("error");
    for (const set of fieldsets) {
      expect(set.hasAttribute("hidden")).toBe(false);
    }
  });

  it("each pill group carries its dimension as an accessible name", async () => {
    h = await boot(BASE);
    const groups = [...h.root.querySelectorAll("[role='group']")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Scent families",
      "Favourite notes",
      "Preferred strength",
      "Occasions",
      "Seasons",
    ]);
  });
});

/* ========================================================================== *
 * Writing
 * ========================================================================== */

describe("Fragrance: writing preferences (Requirement 12.2, task 24.2)", () => {
  const withWrite = (answer: unknown) => ({ ...BASE, "PUT /profile/preferences": answer });

  function pill(harness: Harness, text: string): HTMLButtonElement {
    const found = [...harness.root.querySelectorAll<HTMLButtonElement>("[data-portal-pill]")].find(
      (p) => p.textContent === text,
    );
    expect(found, `no pill labelled ${text}`).toBeDefined();
    return found as HTMLButtonElement;
  }

  it("sends the WHOLE set for the dimension, never a delta", async () => {
    h = await boot(
      withWrite(ok(preferences({ declared: { scent_family: ["oud", "amber"], note: [], intensity: null, occasion: [], season: [] } }))),
    );
    // Start from a stored set of one, then add a second.
    h = await boot({
      ...withWrite(ok(preferences({ declared: { scent_family: ["oud", "amber"], note: [], intensity: null, occasion: [], season: [] } }))),
      "GET /profile/preferences": ok(
        preferences({ declared: { scent_family: ["oud"], note: [], intensity: null, occasion: [], season: [] } }),
      ),
    });
    pill(h, "Amber").click();
    await new Promise((resolve) => setTimeout(resolve, 6));

    // A dimension write REPLACES the set, so sending `["amber"]` alone would have
    // deleted `oud`.
    expect(h.requests.find((r) => r.method === "PUT")?.body).toEqual({
      declared: { scent_family: ["oud", "amber"] },
    });
  });

  it("sends intensity as a bare STRING, and clears it with null", async () => {
    h = await boot(
      withWrite(ok(preferences({ declared: { scent_family: [], note: [], intensity: "bold", occasion: [], season: [] } }))),
    );
    pill(h, "Bold").click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    // An array would be rejected by the service; the dimension is single-valued.
    expect(h.requests.find((r) => r.method === "PUT")?.body).toEqual({ declared: { intensity: "bold" } });

    // Re-pressing the chosen one clears it.
    pill(h, "Bold").click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(h.requests.filter((r) => r.method === "PUT").pop()?.body).toEqual({
      declared: { intensity: null },
    });
  });

  it("paints the RESPONSE's stored state with NO follow-up read (task 24.2)", async () => {
    h = await boot(
      withWrite(
        // The server normalised: it dropped a value and kept vocabulary order.
        ok(preferences({ declared: { scent_family: ["oud"], note: [], intensity: null, occasion: [], season: [] } })),
      ),
    );
    pill(h, "Amber").click();
    await new Promise((resolve) => setTimeout(resolve, 6));

    // Exactly one read of each source, plus the write. No re-read afterwards.
    expect(h.requests.filter((r) => r.path === "/profile/preferences" && r.method === "GET")).toHaveLength(1);
    // And the screen shows what was STORED, not what was submitted.
    const pressed = [...h.root.querySelectorAll("[data-portal-pill][aria-pressed='true']")].map(
      (p) => p.textContent,
    );
    expect(pressed).toEqual(["Oud"]);
  });

  it("a repeated tap on one dimension sends ONE write", async () => {
    h = await boot(withWrite(ok(preferences())));
    const control = pill(h, "Oud");
    control.click();
    control.click();
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("a rejected write leaves the screen on the last CONFIRMED state", async () => {
    h = await boot(withWrite(fail("upstream_unavailable", 502)));
    pill(h, "Oud").click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    // Never optimistically flipped, so there is nothing to roll back and nothing
    // showing a preference the server did not store.
    expect(h.root.querySelectorAll("[data-portal-pill][aria-pressed='true']")).toHaveLength(0);
    expect(h.announced.join(" ")).toContain(copy.error("upstream_unavailable"));
  });

  it("refuses to exceed the server's cap, without spending a request", async () => {
    h = await boot({
      ...withWrite(ok(preferences())),
      "GET /profile/preferences": ok(
        preferences({
          declared: { scent_family: ["oud", "amber", "floral"], note: [], intensity: null, occasion: [], season: [] },
          limits: { ...LIMITS, scent_family: 3 },
        }),
      ),
    });
    pill(h, "Woody").click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(h.announced.join(" ")).toContain("up to 3");
  });
});

/* ========================================================================== *
 * The derived block
 * ========================================================================== */

describe("Fragrance: the derived block (Requirements 12.8, 12.6)", () => {
  const derived = (signal: Record<string, unknown>) => ({
    ...BASE,
    "GET /profile": ok(profile({ inferred: { basis: ["orders"], scent_family: [], note: [], season: null, occasion: null, insight: null, ...signal } })),
  });

  it("is ABSENT ENTIRELY when there is nothing to conclude (§12.6)", async () => {
    // The product taxonomy is unpopulated by default, so empty rankings are a
    // truthful "we can conclude nothing" — not an error, and not an empty block.
    h = await boot(BASE);
    expect(h.root.querySelector("[data-portal-derived]")?.hasAttribute("hidden")).toBe(true);
    expect(h.root.textContent).not.toContain("not enough");
  });

  it("renders rankings with the EVIDENCE count, never a confidence score", async () => {
    h = await boot(
      derived({ scent_family: [{ value: "oud", distinctProducts: 4 }, { value: "amber", distinctProducts: 1 }] }),
    );
    const block = h.root.querySelector("[data-portal-derived]");
    expect(block?.hasAttribute("hidden")).toBe(false);
    expect(block?.textContent).toContain("Oud");
    expect(block?.textContent).toContain("4 fragrances");
    // Singular, because "1 fragrances" is the kind of detail that reads as a bug.
    expect(block?.textContent).toContain("1 fragrance");
    // §12.7 excludes a match percentage deliberately.
    expect(block?.textContent).not.toContain("%");
  });

  it("names its inputs in one line, in words rather than identifiers", async () => {
    h = await boot(
      {
        ...BASE,
        "GET /profile": ok(
          profile({
            inferred: {
              basis: ["orders", "wishlist", "recently_viewed"],
              scent_family: [{ value: "oud", distinctProducts: 2 }],
              note: [],
              season: null,
              occasion: null,
              insight: null,
            },
          }),
        ),
      },
    );
    const basis = h.root.querySelector("[data-portal-basis]")?.textContent ?? "";
    expect(basis).toContain("orders");
    expect(basis).toContain("saved items");
    expect(basis).toContain("recent views");
    expect(basis).not.toContain("recently_viewed");
  });

  it("renders the insight through the copy map, with the family filled in", async () => {
    h = await boot(
      derived({
        scent_family: [{ value: "oud", distinctProducts: 3 }],
        insight: { kind: "family_concentration", value: "oud", distinctProducts: 3 },
      }),
    );
    const note = h.root.querySelector("[data-portal-insight]");
    expect(note?.hasAttribute("hidden")).toBe(false);
    expect(note?.textContent).toBe("Your collection leans toward Oud");
  });

  it("omits season SILENTLY when the server withholds it, with no apology", async () => {
    h = await boot(derived({ scent_family: [{ value: "oud", distinctProducts: 2 }], season: null }));
    const block = h.root.querySelector("[data-portal-derived]");
    expect(block?.textContent).not.toContain("Seasons");
    expect(block?.textContent).not.toContain("not enough");
    expect(block?.textContent).not.toContain("more orders");
  });

  it("renders season when the server DOES supply it", async () => {
    h = await boot(derived({ season: { value: "winter", distinctProducts: 3 } }));
    const block = h.root.querySelector("[data-portal-derived]");
    expect(block?.hasAttribute("hidden")).toBe(false);
    expect(block?.textContent).toContain("Winter");
  });

  it("an <img onerror> in a derived value creates no element (Requirement 26.2)", async () => {
    h = await boot(
      derived({ scent_family: [{ value: `<img src=x onerror="window.__pwned=true">`, distinctProducts: 1 }] }),
    );
    expect(h.root.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

/* ========================================================================== *
 * Promotion
 * ========================================================================== */

describe("Fragrance: promotion (§12.5 rule 4)", () => {
  const promotable = {
    ...BASE,
    "GET /profile": ok(
      profile({
        inferred: {
          basis: ["orders"],
          scent_family: [{ value: "oud", distinctProducts: 3 }],
          note: [],
          season: null,
          occasion: null,
          insight: null,
        },
      }),
    ),
    "PUT /profile/preferences": ok(
      preferences({ declared: { scent_family: ["amber", "oud"], note: [], intensity: null, occasion: [], season: [] } }),
    ),
  };

  it("offers the control, and writes the EXISTING set plus the new value", async () => {
    h = await boot({
      ...promotable,
      "GET /profile/preferences": ok(
        preferences({ declared: { scent_family: ["amber"], note: [], intensity: null, occasion: [], season: [] } }),
      ),
    });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-promote]");
    expect(control?.textContent).toBe("Add Oud to your preferences");
    control?.click();
    await new Promise((resolve) => setTimeout(resolve, 6));

    // Sending `["oud"]` alone would have deleted `amber`.
    expect(h.requests.find((r) => r.method === "PUT")?.body).toEqual({
      declared: { scent_family: ["amber", "oud"] },
    });
  });

  it("withdraws the control once the value IS declared", async () => {
    h = await boot({
      ...promotable,
      "GET /profile/preferences": ok(
        preferences({ declared: { scent_family: ["oud"], note: [], intensity: null, occasion: [], season: [] } }),
      ),
    });
    // Already the customer's own statement, so there is nothing to promote.
    expect(h.root.querySelector("[data-portal-promote]")).toBeNull();
  });

  it("offers NO control for a value outside the server's vocabulary", async () => {
    h = await boot({
      ...BASE,
      "GET /profile": ok(
        profile({
          inferred: {
            basis: ["orders"],
            // The product taxonomy is not constrained to the preference vocabulary,
            // so this can genuinely happen. The write would be rejected with
            // `unknown_value`, and a control that would be rejected is worse than
            // no control.
            scent_family: [{ value: "smoky_incense_accord", distinctProducts: 5 }],
            note: [],
            season: null,
            occasion: null,
            insight: null,
          },
        }),
      ),
    });
    expect(h.root.querySelector("[data-portal-derived]")?.hasAttribute("hidden")).toBe(false);
    expect(h.root.querySelector("[data-portal-promote]")).toBeNull();
  });
});

/* ========================================================================== *
 * Task 24.3 — provenance separation, asserted mechanically
 * ========================================================================== */

describe("Fragrance: provenance separation (task 24.3, Requirements 12.8, 17.8)", () => {
  const both = {
    "GET /profile/preferences": ok(
      preferences({ declared: { scent_family: ["amber"], note: [], intensity: "bold", occasion: [], season: [] } }),
    ),
    "GET /profile": ok(
      profile({
        inferred: {
          basis: ["orders", "wishlist"],
          scent_family: [{ value: "oud", distinctProducts: 3 }],
          note: [{ value: "rose", distinctProducts: 2 }],
          season: { value: "winter", distinctProducts: 3 },
          occasion: null,
          insight: { kind: "family_concentration", value: "oud", distinctProducts: 3 },
        },
        recentlyViewed: [{ productId: "1001", viewedAt: "2026-08-01T00:00:00.000Z" }],
      }),
    ),
    "GET /catalog/products": ok({
      products: [
        {
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
        },
      ],
      missing: [],
    }),
  };

  it("NO list, grid or sentence mixes declared with derived", async () => {
    h = await boot(both);
    await new Promise((resolve) => setTimeout(resolve, 6));

    // Every container that groups items must be single-provenance. This is the
    // assertion task 24.3 names, and it is stated over the DOM rather than over the
    // module's intentions.
    const containers = [
      ...h.root.querySelectorAll("ul, ol, fieldset, [role='group'], [role='list'], p, h1, h2, h3"),
    ];
    expect(containers.length).toBeGreaterThan(5);
    for (const container of containers) {
      const marked = [...container.querySelectorAll("[data-provenance]")];
      const kinds = new Set(marked.map((node) => node.getAttribute("data-provenance")));
      expect(
        kinds.size,
        `a ${container.tagName.toLowerCase()} mixed provenances: ${[...kinds].join(" + ")}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("every marked item sits inside the block matching its provenance", async () => {
    h = await boot(both);
    await new Promise((resolve) => setTimeout(resolve, 6));
    const declaredBlock = h.root.querySelector("[data-portal-declared]") as HTMLElement;
    const derivedNodes = [
      h.root.querySelector("[data-portal-derived]") as HTMLElement,
      h.root.querySelector("[data-portal-recent]") as HTMLElement,
    ];

    const marked = [...h.root.querySelectorAll("[data-provenance]")];
    expect(marked.length).toBeGreaterThan(5);
    for (const node of marked) {
      const kind = node.getAttribute("data-provenance");
      if (kind === "declared") {
        expect(declaredBlock.contains(node), "a declared item escaped its block").toBe(true);
        for (const derivedNode of derivedNodes) {
          expect(derivedNode.contains(node), "a declared item is inside a derived block").toBe(false);
        }
      } else {
        expect(
          derivedNodes.some((block) => block.contains(node)),
          "a derived item is outside every derived block",
        ).toBe(true);
        expect(declaredBlock.contains(node), "a derived item is inside the declared block").toBe(false);
      }
    }
  });

  it("each block's ACCESSIBLE NAME states its provenance", async () => {
    h = await boot(both);
    const named = (selector: string): string => {
      const block = h.root.querySelector<HTMLElement>(selector);
      const id = block?.getAttribute("aria-labelledby") ?? "";
      return h.root.querySelector(`#${id}`)?.textContent?.trim() ?? "";
    };
    // Not colour, not layout, not order — the name itself (Requirement 17.8).
    expect(named("[data-portal-declared]")).toBe(copy.provenance("declared"));
    expect(named("[data-portal-derived]")).toContain(copy.provenance("derived"));
    // And the derived block names its SOURCE, not just the fact of derivation.
    expect(named("[data-portal-derived]")).toContain("orders");
    expect(named("[data-portal-derived]")).toContain("saved items");
    expect(named("[data-portal-derived]")).toContain("recent views");
  });

  it("the derived block carries NO edit control", async () => {
    h = await boot(both);
    await new Promise((resolve) => setTimeout(resolve, 6));
    const derivedBlock = h.root.querySelector("[data-portal-derived]") as HTMLElement;
    // Editing an inference is meaningless: the customer would be correcting our
    // arithmetic rather than stating a preference. Promotion is the only control.
    expect(derivedBlock.querySelectorAll("[data-portal-pill]")).toHaveLength(0);
    expect(derivedBlock.querySelectorAll("input, select, textarea")).toHaveLength(0);
    for (const control of [...derivedBlock.querySelectorAll("button")]) {
      expect(
        control.hasAttribute("data-portal-promote"),
        `an unexpected control in the derived block: ${control.textContent ?? ""}`,
      ).toBe(true);
    }
  });

  it("the recently-viewed strip is derived, and carries no control at all", async () => {
    h = await boot(both);
    await new Promise((resolve) => setTimeout(resolve, 6));
    const strip = h.root.querySelector("[data-portal-recent]") as HTMLElement;
    expect(strip.hasAttribute("hidden")).toBe(false);
    expect(strip.textContent).toContain("Oud Royale 50ml");
    expect([...strip.querySelectorAll("[data-provenance]")].every((n) => n.getAttribute("data-provenance") === "derived")).toBe(true);
    expect(strip.querySelectorAll("button")).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Task 24.3 — the same rules, asserted against the SHIPPED Liquid
 * ========================================================================== */

describe("Fragrance: the shipped Liquid carries the provenance markers", () => {
  /**
   * Why this block exists.
   *
   * Every test above renders the hand-transcribed `MARKUP` constant, which is what
   * makes them fast and independent of Liquid. The cost is that they cannot see the
   * file that actually ships: a non-vacuity run proved that flipping the derived row
   * template's `data-provenance` to `declared` in `portal-section.liquid`, and
   * stripping the source out of the derived heading, both left the suite green.
   *
   * So the structural rules are asserted twice — once over the rendered DOM, and
   * once over the template that produces it in production.
   */
  const arm = ((): string => {
    const whole = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "theme", "snippets", "portal-section.liquid"),
      "utf8",
    );
    const start = whole.indexOf("{%- when 'fragrance' -%}");
    expect(start, "the fragrance arm is missing from portal-section.liquid").toBeGreaterThan(-1);
    const next = whole.indexOf("{%- when ", start + 1);
    return whole.slice(start, next === -1 ? undefined : next);
  })();

  /** One `<template data-portal-row="...">` block from the arm. */
  function rowTemplate(name: string): string {
    const marker = `<template data-portal-row="${name}">`;
    const start = arm.indexOf(marker);
    expect(start, `the ${name} row template is missing`).toBeGreaterThan(-1);
    const end = arm.indexOf("</template>", start);
    return arm.slice(start, end === -1 ? undefined : end);
  }

  it("marks the declared pill as declared and the derived rows as derived", () => {
    expect(rowTemplate("pill")).toContain('data-provenance="declared"');
    for (const name of ["derived", "recent"]) {
      const template = rowTemplate(name);
      expect(template, `${name} is not marked derived`).toContain('data-provenance="derived"');
      expect(template, `${name} is marked declared`).not.toContain('data-provenance="declared"');
    }
  });

  it("the derived heading names its SOURCE, not just the fact of derivation", () => {
    // §12.5 rule 2 — "From your own activity" alone does not tell the customer WHICH
    // activity, which is the part that makes an inference checkable.
    const heading = arm.slice(arm.indexOf("AthoorFragranceDerivedTitle"));
    for (const source of ["orders", "saved items", "recent views"]) {
      expect(heading, `the derived heading omits ${source}`).toContain(source);
    }
  });

  it("the declared heading is the customer's own words", () => {
    expect(arm).toContain(">You told us<");
  });

  it("both blocks declare an accessible name, and each carries its own marker", () => {
    for (const block of ["data-portal-declared", "data-portal-derived", "data-portal-recent"]) {
      const start = arm.indexOf(block);
      expect(start, `${block} is missing`).toBeGreaterThan(-1);
      const openingTag = arm.slice(arm.lastIndexOf("<section", start), arm.indexOf(">", start));
      expect(openingTag, `${block} has no accessible name`).toContain("aria-labelledby");
    }
  });

  it("the derived block's markup contains no edit control", () => {
    // Everything between the derived section's opening tag and the recent block.
    const from = arm.indexOf("data-portal-derived");
    const to = arm.indexOf("data-portal-recent");
    const derivedMarkup = arm.slice(from, to === -1 ? undefined : to);
    expect(derivedMarkup).not.toContain("data-portal-pill");
    expect(derivedMarkup).not.toContain("<input");
    expect(derivedMarkup).not.toContain("<select");
    expect(derivedMarkup).not.toContain("<textarea");
  });
});

/* ========================================================================== *
 * States
 * ========================================================================== */

describe("Fragrance: states (Requirements 12.6, 16.3)", () => {
  it("the EMPTY state leads with the three-question path, and keeps the pills", async () => {
    h = await boot(BASE);
    expect(h.root.getAttribute("data-state")).toBe("empty");
    const invitation = h.root.querySelector("[data-portal-empty-action]")?.textContent ?? "";
    expect(invitation).toContain("three answers");
    expect(invitation).toContain("families");
    expect(invitation).toContain("strong");
    // The pills ARE the invitation: an empty state with no way to act on it is an
    // apology, which Requirement 12.6 explicitly is not.
    expect(h.root.querySelector("[data-portal-declared]")?.hasAttribute("hidden")).toBe(false);
    expect(h.root.querySelectorAll("[data-portal-pill]").length).toBeGreaterThan(0);
  });

  it("degrades only when the VOCABULARY read fails — that one is fatal", async () => {
    h = await boot({ ...BASE, "GET /profile/preferences": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });

  it("a failed DERIVED read is not fatal — the customer can still state their taste", async () => {
    h = await boot({
      "GET /profile/preferences": ok(
        preferences({ declared: { scent_family: ["oud"], note: [], intensity: null, occasion: [], season: [] } }),
      ),
      "GET /profile": fail("upstream_unavailable", 502),
    });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector("[data-portal-declared]")?.hasAttribute("hidden")).toBe(false);
    expect(h.root.querySelector("[data-portal-derived]")?.hasAttribute("hidden")).toBe(true);
  });

  it("omits the recently-viewed strip when the catalogue cannot be read", async () => {
    h = await boot({
      ...BASE,
      "GET /profile": ok(
        profile({ recentlyViewed: [{ productId: "1001", viewedAt: "2026-08-01T00:00:00.000Z" }] }),
      ),
      "GET /catalog/products": fail("upstream_unavailable", 502),
    });
    await new Promise((resolve) => setTimeout(resolve, 6));
    // A row of bare product ids is not a fragrance.
    expect(h.root.querySelector("[data-portal-recent]")?.hasAttribute("hidden")).toBe(true);
    expect(h.root.textContent).not.toContain("1001");
  });

  it("sends no customer data to any third party (Requirement 12.5)", async () => {
    h = await boot(BASE);
    // Every request is a relative App Proxy path.
    for (const request of h.requests) {
      expect(request.path.startsWith("/")).toBe(true);
      expect(request.path).not.toContain("://");
    }
  });
});
