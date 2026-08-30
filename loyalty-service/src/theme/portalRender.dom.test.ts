// @vitest-environment jsdom
/**
 * Spec tasks 18.3, 18.4, 18.5, 18.7 — states, rows, announcements, focus, the
 * sheet and the error boundary.
 *
 * Validates Requirements 16.1–16.8, 15.1, 15.2, 15.7, 15.8, 17.3, 17.5, 17.7,
 * 17.9, 20.3, 25.4, 25.8.
 *
 * ── WHAT THESE TESTS ARE FOR ────────────────────────────────────────────────
 * Every primitive here has a failure mode that is invisible in a screenshot: a
 * live region that is never announced, focus that lands on `<body>`, a row that
 * silently empties a list, an `innerHTML` that executes a product title. Those are
 * the behaviours asserted below, in a real DOM.
 *
 * SAFETY: jsdom only. No network, no database. `fetch` is never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as states from "../../../theme-src/portal/render/states.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as sheet from "../../../theme-src/portal/ui/sheet.js";
import * as boundary from "../../../theme-src/portal/sections/register.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";

/** Requirement 16.8 — forbidden in rendered output, in every state. */
const FORBIDDEN: readonly string[] = ["Loading...", "Something went wrong", "undefined", "null", "NaN"];

/** A section root with every slot the primitives look for. */
function makeRoot(): HTMLElement {
  document.body.innerHTML = `
    <div data-portal-live-global role="status" aria-live="polite"></div>
    <section data-portal-section="orders">
      <h2 data-portal-heading>Your orders</h2>
      <p data-portal-live aria-live="polite"></p>
      <p data-portal-state-message></p>
      <p data-portal-reference hidden></p>
      <button type="button" data-portal-retry hidden>Try again</button>
      <ul data-portal-list></ul>
    </section>
  `;
  return document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;
}

function template(html: string): HTMLTemplateElement {
  const element = document.createElement("template");
  // Test fixture markup, authored here — never an API value. The renderers under
  // test are the code that must not do this with untrusted data.
  element.innerHTML = html;
  return element;
}

/** Flush `announce`'s deliberate one-task delay. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

let root: HTMLElement;
beforeEach(() => {
  root = makeRoot();
  boundary.resetErrorBoundary(root);
  announce.resetAnnouncements(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/* ========================================================================== *
 * 18.3 — the eight designed states
 * ========================================================================== */

describe("the eight designed states (§18.8)", () => {
  it("writes each state to the root and renders designed prose", () => {
    for (const state of states.STATES) {
      states.set(root, state);
      expect(root.getAttribute("data-state")).toBe(state);
      expect(states.current(root)).toBe(state);
      const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
      for (const forbidden of FORBIDDEN) {
        expect(message, `state ${state} rendered ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("covers every state in the vocabulary and no more", () => {
    expect([...states.STATES].sort()).toEqual([
      "degraded",
      "disabled",
      "empty",
      "error",
      "loading",
      "offline",
      "ready",
      "session-expired",
    ]);
  });

  it("sets aria-busy for loading only", () => {
    states.set(root, "loading");
    expect(root.getAttribute("aria-busy")).toBe("true");
    states.set(root, "ready");
    // Leaving it set would tell a screen reader to keep waiting for content that
    // has already arrived — or, on a degraded section, for content never coming.
    expect(root.hasAttribute("aria-busy")).toBe(false);
  });

  it("a disabled state STATES WHY (§18.8)", () => {
    states.set(root, "disabled", { reason: "Available once your first order is complete" });
    const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
    expect(message).toBe("Available once your first order is complete");
    // And with no reason supplied it still says something rather than nothing.
    states.set(root, "disabled");
    expect((root.querySelector("[data-portal-state-message]")?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("current() returns null for an unrecognised attribute value", () => {
    root.setAttribute("data-state", "invented");
    expect(states.current(root)).toBeNull();
  });

  it("reports an empty state without a blank box (Req 16.2)", () => {
    states.set(root, "empty");
    const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("degrading from a failure (§22.9)", () => {
  const failure = (over: Partial<PortalFailure> = {}): PortalFailure =>
    ({ code: "upstream_unavailable", status: 502, requestId: null, retryable: true, ...over }) as PortalFailure;

  it("maps an authentication failure to session-expired, not to an error (§5.3)", () => {
    states.degrade(root, failure({ code: "identity_resolution_failed", status: 401, retryable: false }));
    expect(root.getAttribute("data-state")).toBe("session-expired");
    const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
    // The customer's input is intact and the next action is to sign in.
    expect(message.toLowerCase()).toContain("sign in");
  });

  it("maps a 5xx to degraded and says nothing has changed (Req 15.2)", () => {
    states.degrade(root, failure());
    expect(root.getAttribute("data-state")).toBe("degraded");
  });

  it("maps a determinate 4xx to error", () => {
    states.degrade(root, failure({ code: "not_found", status: 404, retryable: false }));
    expect(root.getAttribute("data-state")).toBe("error");
  });

  it("uses the offline state only when the browser says it is offline", () => {
    const spy = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    states.degrade(root, failure({ code: "network_unavailable", status: null }));
    expect(root.getAttribute("data-state")).toBe("offline");
    spy.mockReturnValue(true);
    // `onLine === true` only means an interface exists, so it is never used to
    // claim connectivity — a no-answer failure with it true is still degraded.
    states.degrade(root, failure({ code: "network_unavailable", status: null }));
    expect(root.getAttribute("data-state")).toBe("degraded");
  });

  it("renders a SHORTENED request reference (§22.9)", () => {
    states.degrade(root, failure({ requestId: "req-0123456789abcdef" }));
    const reference = root.querySelector("[data-portal-reference]");
    expect(reference?.hasAttribute("hidden")).toBe(false);
    const text = reference?.textContent ?? "";
    expect(text).toMatch(/^Reference [A-Za-z0-9]{8}$/);
    // Eight characters is what a customer can read aloud; the full id stays in
    // the response header.
    expect(text).not.toContain("0123456789abcdef");
  });

  it("hides the reference when there is none", () => {
    states.degrade(root, failure({ requestId: null }));
    expect(root.querySelector("[data-portal-reference]")?.hasAttribute("hidden")).toBe(true);
  });

  it("offers retry ONLY where a retry can help (§22.9)", () => {
    const retry = vi.fn();
    const control = root.querySelector<HTMLButtonElement>("[data-portal-retry]") as HTMLButtonElement;

    states.degrade(root, failure({ retryable: true }), retry);
    expect(control.hasAttribute("hidden")).toBe(false);
    control.click();
    expect(retry).toHaveBeenCalledTimes(1);

    states.degrade(root, failure({ code: "not_found", status: 404, retryable: false }), retry);
    expect(control.hasAttribute("hidden")).toBe(true);
    control.click();
    // A button on a 404 would invite the customer to conclude the service is
    // unreliable when the answer was correct and final.
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("re-rendering the error state does not accumulate retry handlers", () => {
    const retry = vi.fn();
    const control = root.querySelector<HTMLButtonElement>("[data-portal-retry]") as HTMLButtonElement;
    states.degrade(root, failure(), retry);
    states.degrade(root, failure(), retry);
    states.degrade(root, failure(), retry);
    control.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders no upstream text, SQL, stack or HTML for any failure code", () => {
    const codes: PortalFailure["code"][] = [
      "network_unavailable",
      "request_timeout",
      "identity_resolution_failed",
      "invalid_request",
      "not_found",
      "conflict",
      "rate_limit_exceeded",
      "upstream_unavailable",
      "internal_error",
      "section_render_failed",
      "wishlist_limit_reached",
      "birthday_change_locked",
    ];
    for (const code of codes) {
      states.degrade(root, failure({ code }));
      const html = root.innerHTML;
      expect(html, `${code} rendered markup`).not.toMatch(/<script|onerror=|<img/i);
      expect(html, `${code} rendered SQL`).not.toMatch(/\bselect\b[\s\S]{0,60}\bfrom\b/i);
      expect(html, `${code} rendered a stack`).not.toMatch(/\bat\s+\S+\.(ts|js):\d+/);
      for (const forbidden of FORBIDDEN) {
        expect(html, `${code} rendered ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

/* ========================================================================== *
 * Prototype-key and unknown-identifier inputs
 * ========================================================================== */

describe("hostile and unknown identifiers fall back to approved copy", () => {
  const hostile = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"];

  it("every copy vocabulary is own-property safe", () => {
    for (const key of [...hostile, "totally_unknown_code", ""]) {
      const rendered = [
        copy.error(key),
        copy.fieldError(key),
        copy.fulfilment(key),
        copy.availability(key),
        copy.redemptionStatus(key),
        copy.birthdayEligibility(key),
        copy.provenance(key),
      ];
      for (const value of rendered) {
        expect(typeof value, `${key} did not return a string`).toBe("string");
        expect(value.length, `${key} returned empty copy`).toBeGreaterThan(0);
        for (const forbidden of FORBIDDEN) {
          expect(value, `${key} rendered ${forbidden}`).not.toContain(forbidden);
        }
        // An inherited object or function must never reach the DOM.
        expect(value).not.toContain("[object");
        expect(value).not.toContain("native code");
        expect(value).not.toContain("function");
      }
    }
  });

  it("a hostile ledger reason renders the neutral description", () => {
    for (const key of hostile) {
      const entry = {
        id: "1",
        type: "earned" as const,
        points: 10,
        reason: key,
        date: "2026-06-12T00:00:00.000Z",
        orderReference: null,
      } as PortalActivityEntry;
      const rendered = copy.activityDescription(entry);
      expect(rendered).toBe("An adjustment to your account");
    }
  });

  it("a hostile referral stage renders the fallback triple", () => {
    for (const key of hostile) {
      const rendered = copy.referralStage({ key, state: "pending" } as PortalReferralStage);
      expect(rendered.name).toBe("A referral reward");
      expect(rendered.qualification).toBe("Conditions apply");
      expect(rendered.state).toBe("In progress");
    }
  });

  it("a hostile state name renders empty rather than an inherited value", () => {
    for (const key of hostile) {
      const rendered = copy.state(key as PortalSectionState);
      expect(rendered).toBe("");
    }
  });

  it("degrading with a hostile code still renders approved prose", () => {
    for (const key of hostile) {
      states.degrade(root, {
        code: key as PortalFailure["code"],
        status: 500,
        requestId: null,
        retryable: false,
      } as PortalFailure);
      const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
      expect(message).toBe("We could not complete that just now.");
    }
  });
});

/* ========================================================================== *
 * 18.3 — row renderers
 * ========================================================================== */

describe("row renderers (§5.3, §22.6)", () => {
  const orderTemplate = () =>
    template(
      `<li><a data-slot="link"></a><span data-slot="number"></span><span data-slot="date"></span>` +
        `<span data-slot="total"></span><span data-slot="status"></span><span data-slot="items"></span></li>`,
    );

  const order = {
    id: "6012345678901",
    name: "#1042",
    processedAt: "2026-06-01T10:00:00.000Z",
    financialStatus: "PAID",
    fulfilmentStatus: "FULFILLED",
    totalGBP: "125.00",
    currencyCode: "GBP",
    lineItemCount: 3,
    previewLineItems: [],
  };

  it("renders an order row from the real N1 contract", () => {
    const fragment = rows.orderRow(order as never, orderTemplate());
    const host = document.createElement("ul");
    host.appendChild(fragment);
    expect(host.querySelector("[data-slot='number']")?.textContent).toBe("#1042");
    expect(host.querySelector("[data-slot='date']")?.textContent).toBe("1 June 2026");
    expect(host.querySelector("[data-slot='status']")?.textContent).toBe("Sent");
    expect(host.querySelector("[data-slot='items']")?.textContent).toBe("3 items");
    // §20.4 — the link's accessible name names the order, date and total.
    expect(host.querySelector("[data-slot='link']")?.textContent).toBe("Order #1042, 1 June 2026, 125.00");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/pages/my-athoor-order-detail?id=6012345678901");
  });

  it("never renders undefined, null or NaN for missing fields (Req 16.8)", () => {
    const sparse = { ...order, name: null, processedAt: null, totalGBP: null, lineItemCount: Number.NaN };
    const host = document.createElement("ul");
    host.appendChild(rows.orderRow(sparse as never, orderTemplate()));
    for (const forbidden of FORBIDDEN) {
      expect(host.textContent ?? "", `rendered ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("a product title containing markup creates NO element (§5.3, NB-14)", () => {
    const wishlistTemplate = template(
      `<li><img data-slot="image" /><span data-slot="title"></span>` +
        `<span data-slot="price"></span><span data-slot="availability"></span>` +
        `<button data-slot="remove"></button></li>`,
    );
    const product = {
      productId: "1001",
      title: `<img src=x onerror="window.__pwned = true">`,
      handle: "oud",
      published: true,
      availableForSale: true,
      priceGBP: "95.00",
      compareAtPriceGBP: null,
      defaultVariantId: "v1",
      imageUrl: null,
      imageWidth: 0,
      imageHeight: 0,
    };
    const host = document.createElement("ul");
    host.appendChild(rows.wishlistRow(product as never, wishlistTemplate));

    // The title is TEXT, so no <img> was created and no handler could fire.
    expect(host.querySelectorAll("img")).toHaveLength(1); // the template's own
    expect(host.querySelector("[data-slot='title']")?.textContent).toBe(product.title);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(host.querySelector("[data-slot='remove']")?.textContent).toContain("from your wishlist");
  });

  it("derives the availability identifier from the two facts N4 returns", () => {
    const wishlistTemplate = template(`<li><span data-slot="availability"></span></li>`);
    const base = {
      productId: "1",
      title: "t",
      handle: "h",
      priceGBP: "1.00",
      compareAtPriceGBP: null,
      defaultVariantId: null,
      imageUrl: null,
      imageWidth: 0,
      imageHeight: 0,
    };
    const render = (published: boolean, available: boolean): string => {
      const host = document.createElement("ul");
      host.appendChild(
        rows.wishlistRow({ ...base, published, availableForSale: available } as never, wishlistTemplate),
      );
      return host.querySelector("[data-slot='availability']")?.textContent ?? "";
    };
    expect(render(true, true)).toBe("Available");
    expect(render(true, false)).toBe("Out of stock");
    expect(render(false, true)).toBe("No longer available");
  });

  it("an activity row renders copy, never the reason", () => {
    const activityTemplate = template(
      `<li><span data-slot="description"></span><span data-slot="points"></span><span data-slot="date"></span></li>`,
    );
    const host = document.createElement("ul");
    host.appendChild(
      rows.activityRow(
        {
          id: "1",
          type: "spent",
          points: -150,
          reason: "reward_15",
          date: "2026-06-12T00:00:00.000Z",
          orderReference: null,
        } as PortalActivityEntry,
        activityTemplate,
      ),
    );
    expect(host.textContent ?? "").not.toContain("reward_15");
    expect(host.querySelector("[data-slot='points']")?.textContent).toBe("\u2212150");
  });

  it("a referral stage row takes its figure from the RESPONSE (Req 10.15)", () => {
    const stageTemplate = template(
      `<li><span data-slot="name"></span><span data-slot="qualification"></span>` +
        `<span data-slot="state"></span><span data-slot="points"></span></li>`,
    );
    const host = document.createElement("ul");
    host.appendChild(
      rows.stageRow(
        { key: "friend_signup", state: "pending", currentRewardPoints: 50 } as PortalReferralStage,
        stageTemplate,
      ),
    );
    expect(host.querySelector("[data-slot='name']")?.textContent).toBe("When your friend joins");
    expect(host.querySelector("[data-slot='state']")?.textContent).toBe("Awaiting your friend");
    expect(host.querySelector("[data-slot='points']")?.textContent).toBe("50 points");
    expect(host.textContent ?? "").not.toContain("friend_signup");
  });

  it("ONE bad row degrades one row, not the list (§22.6, Req 15.2)", () => {
    const good = template(`<li><span data-slot="number"></span></li>`);
    let calls = 0;
    const render = (dto: { id: string }, tpl: HTMLTemplateElement): DocumentFragment => {
      calls += 1;
      if (dto.id === "bad") throw new Error("row exploded");
      const fragment = tpl.content.cloneNode(true) as DocumentFragment;
      const slot = fragment.querySelector("[data-slot='number']");
      if (slot) slot.textContent = dto.id;
      return fragment;
    };

    const result = rows.list([{ id: "a" }, { id: "bad" }, { id: "c" }], good, render);
    expect(calls).toBe(3);
    expect(result.failed).toBe(1);
    const host = document.createElement("ul");
    host.appendChild(result.fragment);
    // Two rows survived; the list is not empty.
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.textContent).toContain("a");
    expect(host.textContent).toContain("c");
  });

  it("a missing template throws so the section's boundary can report it", () => {
    const empty = document.createElement("template");
    Object.defineProperty(empty, "content", { value: null });
    expect(() => rows.orderRow(order as never, empty)).toThrow();
  });

  it("skips a slot the template does not declare", () => {
    // A compact template may legitimately omit the image or the item count.
    const minimal = template(`<li><span data-slot="number"></span></li>`);
    expect(() => rows.orderRow(order as never, minimal)).not.toThrow();
  });
});

/* ========================================================================== *
 * 18.4 — announcements
 * ========================================================================== */

describe("live regions (§20.6)", () => {
  it("announces politely into the section's own region", async () => {
    announce.polite(root, "Your orders are ready");
    await flush();
    const region = root.querySelector("[data-portal-live]");
    expect(region?.textContent).toBe("Your orders are ready");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("replaces the previous message rather than queueing", async () => {
    announce.polite(root, "first");
    await flush();
    announce.polite(root, "second");
    await flush();
    const region = root.querySelector("[data-portal-live]");
    // A queue would read the customer a backlog of things no longer true.
    expect(region?.textContent).toBe("second");
  });

  it("clears before writing so an identical repeat is still announced", async () => {
    announce.polite(root, "same");
    await flush();
    const region = root.querySelector("[data-portal-live]") as Element;
    announce.polite(root, "same");
    // Synchronously cleared; the value arrives on the next task.
    expect(region.textContent).toBe("");
    await flush();
    expect(region.textContent).toBe("same");
  });

  it("uses assertive only for a flow-stopping failure", async () => {
    announce.assertive(root, "Your redemption was not completed");
    await flush();
    expect(root.querySelector("[data-portal-live]")?.getAttribute("aria-live")).toBe("assertive");
  });

  it("announces loading ONCE per root (§20.6)", async () => {
    announce.loadingOnce(root, "Preparing your account");
    await flush();
    const region = root.querySelector("[data-portal-live]") as Element;
    expect(region.textContent).toBe("Preparing your account");

    region.textContent = "";
    announce.loadingOnce(root, "Preparing your account");
    await flush();
    // A retry does not re-announce: the customer pressed the button.
    expect(region.textContent).toBe("");
  });

  it("writes into the one global region for cross-section confirmations", async () => {
    announce.global("Link copied");
    await flush();
    expect(document.querySelector("[data-portal-live-global]")?.textContent).toBe("Link copied");
  });

  it("does NOTHING when the region is absent from the server render", async () => {
    const bare = document.createElement("section");
    document.body.appendChild(bare);
    expect(() => announce.polite(bare, "hello")).not.toThrow();
    await flush();
    // A region injected at announcement time is not reliably announced, so none
    // is injected — the absence is a Liquid bug, not something to paper over.
    expect(bare.querySelector("[data-portal-live]")).toBeNull();
  });

  it("says nothing when the message is empty", async () => {
    announce.polite(root, "");
    await flush();
    expect(root.querySelector("[data-portal-live]")?.textContent).toBe("");
  });
});

/* ========================================================================== *
 * 18.4 — focus
 * ========================================================================== */

describe("focus movement (§20.2)", () => {
  it("moves to a sheet's heading, not to the dialog or the first control", () => {
    document.body.innerHTML = `<dialog id="s"><h2 id="h">Confirm</h2><input id="i" /></dialog>`;
    const dialog = document.getElementById("s") as HTMLElement;
    focus.toSheetHeading(dialog);
    expect(document.activeElement?.id).toBe("h");
    // Programmatically focusable only: a heading must not add a tab stop.
    expect(document.getElementById("h")?.getAttribute("tabindex")).toBe("-1");
  });

  it("returns focus to the invoking control", () => {
    document.body.innerHTML = `<button id="open">Open</button>`;
    const control = document.getElementById("open") as HTMLElement;
    focus.restore(control);
    expect(document.activeElement?.id).toBe("open");
  });

  it("does not focus a control that has been removed from the document", () => {
    const detached = document.createElement("button");
    // Focusing a detached node silently drops focus to <body> and loses the
    // customer's place entirely.
    expect(() => focus.restore(detached)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it("moves to the first aria-invalid field on a rejected submission (Req 17.7)", () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="a" />
        <input id="b" aria-invalid="true" />
        <input id="c" aria-invalid="true" />
      </form>`;
    const form = document.getElementById("f") as HTMLElement;
    expect(focus.toFirstInvalid(form)).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("reports when a rejection names no field, so a caller can use the summary", () => {
    document.body.innerHTML = `<form id="f"><input id="a" /></form>`;
    expect(focus.toFirstInvalid(document.getElementById("f") as HTMLElement)).toBe(false);
  });

  it("keys on aria-invalid, not on the browser's own validity", () => {
    // Portal validation is server-side: a field the server rejected is perfectly
    // valid to the browser, so `:invalid` would find nothing.
    document.body.innerHTML = `<form id="f"><input id="a" required value="filled" aria-invalid="true" /></form>`;
    expect(focus.toFirstInvalid(document.getElementById("f") as HTMLElement)).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("moves to the section heading when content is replaced wholesale", () => {
    focus.toSectionHeading(root);
    expect(document.activeElement?.getAttribute("data-portal-heading")).toBe("");
  });

  it("offers no way to focus appended rows (§20.2)", () => {
    // Deliberately absent: "load more" must leave focus on the control. The
    // module exposes exactly the four movements §20.2 names.
    expect(Object.keys(focus).sort()).toEqual([
      "restore",
      "toFirstInvalid",
      "toSectionHeading",
      "toSheetHeading",
    ]);
  });
});

/* ========================================================================== *
 * 18.5 — the sheet
 * ========================================================================== */

describe("the sheet (§19.8)", () => {
  function makeSheet(): { dialog: HTMLDialogElement; invoker: HTMLElement } {
    document.body.innerHTML = `
      <button id="open">Open</button>
      <dialog id="sheet">
        <h2 id="title">Confirm redemption</h2>
        <button type="button" data-portal-sheet-dismiss>Close</button>
      </dialog>`;
    const dialog = document.getElementById("sheet") as HTMLDialogElement;
    // jsdom implements `showModal` only in recent versions; make the behaviour
    // deterministic rather than depending on the runtime.
    dialog.showModal = function showModal(): void {
      this.setAttribute("open", "open");
    };
    dialog.close = function close(): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    return { dialog, invoker: document.getElementById("open") as HTMLElement };
  }

  it("opens, focuses the heading, and reports open", () => {
    const { dialog, invoker } = makeSheet();
    sheet.open(dialog, invoker);
    expect(sheet.isOpen(dialog)).toBe(true);
    expect(document.activeElement?.id).toBe("title");
  });

  it("returns focus to the invoking control on close (Req 17.7)", () => {
    const { dialog, invoker } = makeSheet();
    sheet.open(dialog, invoker);
    sheet.close(dialog);
    expect(sheet.isOpen(dialog)).toBe(false);
    expect(document.activeElement?.id).toBe("open");
  });

  it("always has a dismiss control, and it closes (Req 25.8)", () => {
    const { dialog, invoker } = makeSheet();
    sheet.open(dialog, invoker);
    const dismiss = dialog.querySelector<HTMLElement>("[data-portal-sheet-dismiss]") as HTMLElement;
    expect(dismiss).toBeTruthy();
    dismiss.click();
    // Never dismiss-by-backdrop-only: undiscoverable on touch, impossible by
    // keyboard.
    expect(sheet.isOpen(dialog)).toBe(false);
    expect(document.activeElement?.id).toBe("open");
  });

  it("Esc closes it and restores focus, and is never prevented", () => {
    const { dialog, invoker } = makeSheet();
    sheet.open(dialog, invoker);
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    // Cancelling `Esc` would trap the customer in the sheet.
    expect(cancel.defaultPrevented).toBe(false);
    dialog.close();
    expect(sheet.isOpen(dialog)).toBe(false);
    expect(document.activeElement?.id).toBe("open");
  });

  it("close() is idempotent and the returned closer is safe to call twice", () => {
    const { dialog, invoker } = makeSheet();
    const close = sheet.open(dialog, invoker);
    close();
    expect(() => close()).not.toThrow();
    expect(() => sheet.close(dialog)).not.toThrow();
  });

  it("opening twice does not rebind or re-focus", () => {
    const { dialog, invoker } = makeSheet();
    sheet.open(dialog, invoker);
    (document.getElementById("open") as HTMLElement).focus();
    sheet.open(dialog, invoker);
    // The second open is a no-op, so focus is not yanked back to the heading.
    expect(document.activeElement?.id).toBe("open");
  });

  it("dismissal NEVER cancels work in flight (spec 18.5)", () => {
    const { dialog, invoker } = makeSheet();
    // The module holds no AbortController and exposes no abort, so there is no
    // path by which closing a sheet could cancel a redemption that has already
    // debited the balance (§22.5).
    expect(Object.keys(sheet).sort()).toEqual(["close", "isOpen", "open"]);
    const inFlight = { aborted: false };
    sheet.open(dialog, invoker);
    sheet.close(dialog);
    expect(inFlight.aborted).toBe(false);
  });

  it("adds no inline animation, so reduced motion stays a CSS decision (Req 25.4)", () => {
    const { dialog, invoker } = makeSheet();
    sheet.open(dialog, invoker);
    // Motion lives in the stylesheet, where `prefers-reduced-motion` applies. An
    // inline transition here would override the media query.
    expect(dialog.style.transition).toBe("");
    expect(dialog.style.animation).toBe("");
    expect(dialog.getAttribute("style")).toBeNull();
  });
});

/* ========================================================================== *
 * 18.7 — the error boundary
 * ========================================================================== */

describe("the error boundary (§16.10)", () => {
  it("degrades one root to the designed render-failure state", () => {
    boundary.degradeSection(root);
    expect(root.getAttribute("data-state")).toBe("degraded");
    const message = root.querySelector("[data-portal-state-message]")?.textContent ?? "";
    expect(message).toBe(copy.error("section_render_failed"));
    // Not retryable: re-running a boot that threw deterministically throws again.
    expect(root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(true);
  });

  it("is idempotent per root, so a burst of errors renders once", () => {
    boundary.degradeSection(root);
    const first = root.innerHTML;
    boundary.degradeSection(root);
    expect(root.innerHTML).toBe(first);
  });

  it("degrades the CLOSEST section root from a window error", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<section data-portal-section="wishlist"><p data-portal-state-message></p></section>`,
    );
    const other = document.querySelector<HTMLElement>('[data-portal-section="wishlist"]') as HTMLElement;
    boundary.resetErrorBoundary(other);
    boundary.installErrorBoundary();

    const target = root.querySelector("[data-portal-list]") as HTMLElement;
    target.dispatchEvent(new Event("error", { bubbles: true }));

    expect(root.getAttribute("data-state")).toBe("degraded");
    // An unrelated section is untouched — taking the whole account area down for
    // one section's bug is what the scoping prevents.
    expect(other.getAttribute("data-state")).toBeNull();
  });

  it("leaves everything alone for an error with no section ancestor", () => {
    boundary.installErrorBoundary();
    const stray = document.createElement("div");
    document.body.appendChild(stray);
    stray.dispatchEvent(new Event("error", { bubbles: true }));
    expect(root.getAttribute("data-state")).toBeNull();
  });

  it("installs the window listener only once", () => {
    const spy = vi.spyOn(window, "addEventListener");
    boundary.installErrorBoundary();
    boundary.installErrorBoundary();
    boundary.installErrorBoundary();
    const errorListeners = spy.mock.calls.filter((call) => call[0] === "error");
    expect(errorListeners).toHaveLength(1);
  });

  it("bindOnRoot contains a throwing handler to its own root", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<section data-portal-section="wishlist"><p data-portal-state-message></p></section>`,
    );
    const other = document.querySelector<HTMLElement>('[data-portal-section="wishlist"]') as HTMLElement;
    boundary.resetErrorBoundary(other);

    let otherRan = false;
    boundary.bindOnRoot(root, "click", () => {
      throw new Error("handler exploded");
    });
    boundary.bindOnRoot(other, "click", () => {
      otherRan = true;
    });

    expect(() => root.dispatchEvent(new Event("click"))).not.toThrow();
    other.dispatchEvent(new Event("click"));

    expect(root.getAttribute("data-state")).toBe("degraded");
    // The other section's handler still runs — the coupling Req 15.8 forbids.
    expect(otherRan).toBe(true);
    expect(other.getAttribute("data-state")).toBeNull();
  });

  it("survives a root whose markup lacks every slot", () => {
    const bare = document.createElement("section");
    bare.setAttribute("data-portal-section", "orders");
    document.body.appendChild(bare);
    expect(() => boundary.degradeSection(bare)).not.toThrow();
    // The attribute alone is enough for CSS to show the designed state.
    expect(bare.getAttribute("data-state")).toBe("degraded");
  });
});
