// @vitest-environment jsdom
/**
 * Spec task 26.4 — the Settings section.
 *
 * Validates Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 16.3,
 * 16.5, 23.3, 23.5, 23.8, 5.7, 26.2.
 *
 * The harness renders the REAL Liquid arm, extracted from `portal-section.liquid`
 * rather than transcribed. Task 24's non-vacuity run proved a hand-written markup
 * constant cannot see an attribute change in the file that actually ships.
 *
 * SAFETY: jsdom only. `fetch` is never reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as draft from "../../../theme-src/portal/state/draft.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as sheet from "../../../theme-src/portal/ui/sheet.js";
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
  readonly downloads: { name: string; type: string }[];
}

const ok = (value: unknown) => ({ ok: true, value, requestId: "req-abcdef123456" });
const fail = (code: string, status: number | null, extra: Record<string, unknown> = {}) => ({
  ok: false,
  error: {
    code,
    status,
    requestId: "req-abcdef123456",
    retryable: status === null || status >= 500,
    ...extra,
  },
});

const COMMUNICATION = {
  productLaunches: true,
  restockAlerts: false,
  birthdayMessages: true,
  referralUpdates: false,
};

const PREFERENCES = {
  vocabulary: { scent_family: [], note: [], intensity: [], occasion: [], season: [] },
  declared: { scent_family: [], note: [], intensity: null, occasion: [], season: [] },
  communication: COMMUNICATION,
  limits: {},
};

const CONSENT = { emailMarketing: true, updatedAt: "2026-06-12T09:30:00.000Z" };

const ADDRESSES = { addresses: [{ id: "gid://shopify/MailingAddress/8001" }, { id: "gid://shopify/MailingAddress/8002" }] };

/** The shipped Liquid arm, with its comments stripped. */
function armSource(): string {
  const whole = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "theme", "snippets", "portal-section.liquid"),
    "utf8",
  );
  const start = whole.indexOf("{%- when 'settings' -%}");
  expect(start, "the settings arm is missing from portal-section.liquid").toBeGreaterThan(-1);
  const end = whole.indexOf("{%- endcase -%}", start);
  return whole.slice(start + "{%- when 'settings' -%}".length, end === -1 ? undefined : end);
}

function markup(): string {
  const arm = armSource()
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    // The one Liquid object in the arm. Shopify resolves it; the harness substitutes
    // a stand-in so the anchor is still assertable.
    .replace(/\{\{\s*routes\.account_logout_url\s*\}\}/g, "/account/logout");
  return `
    <section class="athoor-portal__section" data-portal-section="settings" data-state="loading" aria-busy="true">
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
  opts: { objectUrl?: boolean } = {},
): Promise<Harness> {
  document.body.innerHTML = markup();
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const requests: Recorded[] = [];
  const announced: string[] = [];
  const downloads: { name: string; type: string }[] = [];

  const request = vi.fn((spec: { method: string; path: string; body?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, body: spec.body });
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return Promise.resolve(responses[key]);
    return Promise.resolve(fail("not_found", 404));
  });

  for (const dialog of root.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.showModal = function showModal(): void {
      this.setAttribute("open", "open");
    };
    dialog.close = function close(): void {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }

  // jsdom has no object-URL support, so the download is observed rather than made.
  if (opts.objectUrl === false) {
    Object.defineProperty(window, "URL", { value: undefined, configurable: true });
  } else {
    Object.defineProperty(window, "URL", {
      value: {
        createObjectURL: (blob: Blob) => {
          downloads.push({ name: "", type: blob.type });
          return "blob:stub";
        },
        revokeObjectURL: () => undefined,
      },
      configurable: true,
    });
  }
  // Capture the filename off the anchor as it is clicked.
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(): void {
    if (this.hasAttribute("download")) {
      const last = downloads[downloads.length - 1];
      if (last) last.name = this.getAttribute("download") ?? "";
    }
    // Never navigate in jsdom.
    void anchorClick;
  };

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
    sheet: { open: sheet.open, close: sheet.close, isOpen: sheet.isOpen },
    copy,
    cart: { addToCart: () => Promise.resolve({ ok: true, added: 1 }), isAdding: () => false },
  };

  vi.resetModules();
  await import("../../../theme-src/portal/sections/settings.js");
  expect(captured, "no boot function registered").not.toBeNull();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 4));

  return { root, requests, announced, downloads };
}

let h: Harness;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  draft.clearAll();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (window as unknown as { AthoorPortal?: unknown }).AthoorPortal;
});

const BASE = {
  "GET /profile/preferences": ok(PREFERENCES),
  "GET /profile/consent": ok(CONSENT),
  "GET /profile/addresses": ok(ADDRESSES),
};

const toggle = (harness: Harness, key: string): HTMLInputElement =>
  harness.root.querySelector<HTMLInputElement>(`[data-portal-comms-toggle][data-key="${key}"]`) as HTMLInputElement;

/* ========================================================================== *
 * Requirement 13.7 / 5.7 — no credential control
 * ========================================================================== */

describe("Settings: credentials are not managed here (Requirements 13.7, 5.7)", () => {
  it("renders NO password input and NO email input", async () => {
    h = await boot(BASE);
    expect(h.root.querySelectorAll("input[type='password']")).toHaveLength(0);
    expect(h.root.querySelectorAll("input[type='email']")).toHaveLength(0);
    // And nothing named or labelled as either.
    for (const control of h.root.querySelectorAll("input, button, a")) {
      const text = `${control.getAttribute("name") ?? ""} ${control.getAttribute("id") ?? ""} ${control.textContent ?? ""}`.toLowerCase();
      expect(text).not.toContain("password");
    }
  });

  it("renders only CHECKBOX inputs — no free-text field anywhere", async () => {
    h = await boot(BASE);
    const types = [...h.root.querySelectorAll("input")].map((i) => i.getAttribute("type"));
    expect(new Set(types)).toEqual(new Set(["checkbox"]));
    expect(h.root.querySelectorAll("textarea, select")).toHaveLength(0);
  });

  it("the shipped Liquid contains no credential control either", () => {
    const arm = armSource();
    const forbidden = [
      'type="password"',
      'type="email"',
      'name="password"',
      'name="email"',
      'autocomplete="new-password"',
      'autocomplete="current-password"',
    ];
    for (const token of forbidden) {
      expect(arm, `the settings arm contains ${token}`).not.toContain(token);
    }
  });
});

/* ========================================================================== *
 * Requirement 13.1 / 13.2 / 23.8 — preferences
 * ========================================================================== */

describe("Settings: communication preferences (Requirements 13.1, 13.2, 23.8)", () => {
  it("renders the four toggles reflecting the stored state", async () => {
    h = await boot(BASE);
    expect(h.root.getAttribute("data-state")).toBe("ready");
    const toggles = [...h.root.querySelectorAll<HTMLInputElement>("[data-portal-comms-toggle]")];
    expect(toggles.map((t) => t.dataset.key)).toEqual([
      "productLaunches",
      "restockAlerts",
      "birthdayMessages",
      "referralUpdates",
    ]);
    expect(toggles.map((t) => t.checked)).toEqual([true, false, true, false]);
  });

  it("states each preference's PURPOSE, linked to its control (Requirement 23.8)", async () => {
    h = await boot(BASE);
    for (const control of h.root.querySelectorAll<HTMLInputElement>("[data-portal-comms-toggle]")) {
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy, `${control.dataset.key ?? "?"} has no purpose linked`).toBeTruthy();
      const purpose = h.root.querySelector(`#${describedBy ?? ""}`);
      expect(purpose?.textContent?.trim().length, `${control.dataset.key ?? "?"} purpose is empty`).toBeGreaterThan(20);
    }
  });

  it("persists a toggle and repaints from the RE-READ (Requirement 13.2)", async () => {
    h = await boot({
      ...BASE,
      // The response is a re-read, so the server can normalise. Here it reports
      // restockAlerts on AND birthdayMessages off, which the submission did not say.
      "PUT /profile/preferences": ok({
        ...PREFERENCES,
        communication: { ...COMMUNICATION, restockAlerts: true, birthdayMessages: false },
      }),
    });
    const control = toggle(h, "restockAlerts");
    control.checked = true;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));

    expect(h.requests.find((r) => r.method === "PUT")?.body).toEqual({
      communication: { restockAlerts: true },
    });
    // The stored state won, not the submission.
    expect(toggle(h, "restockAlerts").checked).toBe(true);
    expect(toggle(h, "birthdayMessages").checked).toBe(false);
  });

  it("never writes marketing consent through the preferences block", async () => {
    h = await boot({ ...BASE, "PUT /profile/preferences": ok(PREFERENCES) });
    const control = toggle(h, "productLaunches");
    control.checked = false;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));
    const body = JSON.stringify(h.requests.find((r) => r.method === "PUT")?.body);
    // The service rejects this key by name; sending it would be a 400 we caused.
    expect(body).not.toContain("marketingConsent");
    expect(body).not.toContain("emailMarketing");
  });

  it("a failed toggle returns to the server's last confirmed value", async () => {
    h = await boot({ ...BASE, "PUT /profile/preferences": fail("upstream_unavailable", 502) });
    const control = toggle(h, "restockAlerts");
    control.checked = true;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(toggle(h, "restockAlerts").checked).toBe(false);
    expect(h.announced.join(" ")).toContain("not saved");
  });

  it("a repeated toggle of one key sends ONE write", async () => {
    h = await boot({ ...BASE, "PUT /profile/preferences": ok(PREFERENCES) });
    const control = toggle(h, "restockAlerts");
    for (let i = 0; i < 3; i += 1) control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });
});

/* ========================================================================== *
 * Requirement 13.3 / 13.4 — marketing consent
 * ========================================================================== */

describe("Settings: marketing consent (Requirements 13.3, 13.4)", () => {
  it("presents the state AND the date it was last changed (Requirement 13.3)", async () => {
    h = await boot(BASE);
    const state = h.root.querySelector("[data-portal-consent-state]");
    expect(state?.textContent).toBe("You are subscribed. Last changed 12 June 2026");
    expect(h.root.querySelector<HTMLInputElement>("[data-portal-consent-toggle]")?.checked).toBe(true);
  });

  it("says so plainly when consent has NEVER been set", async () => {
    // N9 reports `updatedAt` as the empty string for a customer who has never set
    // one. "Last changed " with nothing after it would state a date that does not
    // exist.
    h = await boot({ ...BASE, "GET /profile/consent": ok({ emailMarketing: false, updatedAt: "" }) });
    const state = h.root.querySelector("[data-portal-consent-state]");
    expect(state?.textContent).toBe("You have not set a preference yet");
    expect(state?.textContent).not.toContain("Last changed");
  });

  it("WITHDRAWS consent and presents the withdrawn state (Requirement 13.4)", async () => {
    h = await boot({
      ...BASE,
      "PUT /profile/consent": ok({ emailMarketing: false, updatedAt: "2026-08-27T12:00:00.000Z" }),
    });
    const control = h.root.querySelector<HTMLInputElement>("[data-portal-consent-toggle]") as HTMLInputElement;
    control.checked = false;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));

    expect(h.requests.find((r) => r.path === "/profile/consent" && r.method === "PUT")?.body).toEqual({
      emailMarketing: false,
    });
    // The WITHDRAWN state, with SHOPIFY's timestamp — not this asset's clock.
    expect(h.root.querySelector("[data-portal-consent-state]")?.textContent).toBe(
      "You are not subscribed. Last changed 27 August 2026",
    );
    expect(control.checked).toBe(false);
    expect(h.announced.join(" ")).toContain("no longer subscribed");
  });

  it("a failed consent write reverts the control and says nothing was saved", async () => {
    h = await boot({ ...BASE, "PUT /profile/consent": fail("upstream_unavailable", 502) });
    const control = h.root.querySelector<HTMLInputElement>("[data-portal-consent-toggle]") as HTMLInputElement;
    control.checked = false;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(control.checked).toBe(true);
    expect(control.disabled).toBe(false);
    expect(h.announced.join(" ")).toContain("not saved");
  });

  it("hides the consent block when it cannot be read, rather than defaulting it", async () => {
    h = await boot({ ...BASE, "GET /profile/consent": fail("upstream_unavailable", 502) });
    // Guessing a consent state would be inventing a compliance-relevant fact.
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector("[data-portal-consent]")?.hasAttribute("hidden")).toBe(true);
  });
});

/* ========================================================================== *
 * Requirement 13.5 — the address count and its route
 * ========================================================================== */

describe("Settings: addresses (Requirement 13.5)", () => {
  it("states the COUNT and routes to the Profile editor", async () => {
    h = await boot(BASE);
    expect(h.root.querySelector("[data-portal-address-count]")?.textContent).toBe("2 saved addresses.");
    expect(h.root.querySelector("[data-portal-address-route]")?.getAttribute("href")).toBe(
      "/pages/my-athoor-profile",
    );
  });

  it("uses the singular for one address, and says so for none", async () => {
    h = await boot({ ...BASE, "GET /profile/addresses": ok({ addresses: [{ id: "1" }] }) });
    expect(h.root.querySelector("[data-portal-address-count]")?.textContent).toBe("1 saved address.");

    h = await boot({ ...BASE, "GET /profile/addresses": ok({ addresses: [] }) });
    expect(h.root.querySelector("[data-portal-address-count]")?.textContent).toBe("You have no saved addresses.");
  });

  it("carries NO address editor — the Profile section owns it", async () => {
    h = await boot(BASE);
    const block = h.root.querySelector("[data-portal-addresses]") as HTMLElement;
    // A second implementation of one form is the one that drifts.
    expect(block.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(block.querySelectorAll("[data-portal-address-edit], [data-portal-address-delete]")).toHaveLength(0);
  });

  it("keeps the route when the count cannot be read", async () => {
    h = await boot({ ...BASE, "GET /profile/addresses": fail("upstream_unavailable", 502) });
    expect(h.root.querySelector("[data-portal-address-count]")?.textContent).toBe("");
    expect(h.root.querySelector("[data-portal-address-route]")?.getAttribute("href")).toBe(
      "/pages/my-athoor-profile",
    );
  });
});

/* ========================================================================== *
 * Requirement 13.8 / 23.3 — the export
 * ========================================================================== */

describe("Settings: the data export (Requirements 13.8, 23.3, 16.5)", () => {
  it("downloads the document with the server's filename shape", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/export": ok({ generatedAt: "2026-08-27T12:00:00.000Z", ledger: [] }),
    });
    h.root.querySelector<HTMLButtonElement>("[data-portal-export]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 6));

    expect(h.requests.filter((r) => r.path === "/profile/export")).toHaveLength(1);
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]?.name).toBe("athoor-data-export-2026-08-27.json");
    expect(h.downloads[0]?.type).toBe("application/json");
    expect(h.root.querySelector("[data-portal-export-result]")?.textContent).toContain("downloading");
  });

  it("renders the 1/h limit as a designed WAIT STATE with a duration", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/export": fail("rate_limit_exceeded", 429, { retryAfterSeconds: 1800 }),
    });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-export]") as HTMLButtonElement;
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 6));

    const message = h.root.querySelector("[data-portal-export-result]")?.textContent ?? "";
    expect(message).toContain("request another shortly");
    expect(message).toContain("30 minutes");
    // Design E.2 — the rendered output names neither the limit nor the limiter.
    expect(message.toLowerCase()).not.toContain("rate limit");
    expect(message.toLowerCase()).not.toContain("limiter");
    expect(message).not.toContain("1 per hour");
    // The control stays disabled while the window is open, so a second press cannot
    // deepen the limit.
    expect(control.disabled).toBe(true);
    // Nothing was downloaded.
    expect(h.downloads).toHaveLength(0);
  });

  it("re-enables the control when the window elapses", async () => {
    // Boot on REAL timers — the harness settles the initial load with a real
    // `setTimeout`, and a fake clock installed before it would strand that await.
    // Only the re-enable delay needs advancing, and it starts on the press.
    h = await boot({
      ...BASE,
      "GET /profile/export": fail("rate_limit_exceeded", 429, { retryAfterSeconds: 5 }),
    });
    vi.useFakeTimers();
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-export]") as HTMLButtonElement;
    control.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(control.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(control.disabled).toBe(false);
  });

  it("re-enables immediately when the server sent no countdown", async () => {
    h = await boot({ ...BASE, "GET /profile/export": fail("rate_limit_exceeded", 429) });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-export]") as HTMLButtonElement;
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    // Leaving it dead forever would be worse than one rejected attempt.
    expect(control.disabled).toBe(false);
    expect(h.root.querySelector("[data-portal-export-result]")?.textContent).toContain("shortly");
  });

  it("reports honestly when the device cannot save the file", async () => {
    h = await boot(
      { ...BASE, "GET /profile/export": ok({ generatedAt: "2026-08-27T12:00:00.000Z" }) },
      { objectUrl: false },
    );
    h.root.querySelector<HTMLButtonElement>("[data-portal-export]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    const message = h.root.querySelector("[data-portal-export-result]")?.textContent ?? "";
    expect(message).toContain("could not be saved");
    expect(message).not.toContain("downloading");
  });

  it("states its reason while preparing, and leaves no stray anchor behind", async () => {
    h = await boot({ ...BASE, "GET /profile/export": ok({ generatedAt: "2026-08-27T00:00:00.000Z" }) });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-export]") as HTMLButtonElement;
    control.click();
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-label")).toContain("Preparing");
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(control.disabled).toBe(false);
    expect(h.root.querySelectorAll("a[download]")).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Requirement 13.8 / 23.5 — the erasure request
 * ========================================================================== */

describe("Settings: the erasure request (Requirements 13.8, 23.5, 16.3)", () => {
  function confirmErasure(harness: Harness): void {
    harness.root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]")?.click();
    harness.root.querySelector<HTMLButtonElement>("[data-portal-erasure-confirm]")?.click();
  }

  it("confirms in the sheet before recording anything", async () => {
    h = await boot({
      ...BASE,
      "POST /profile/erasure-request": ok({ requestedAt: "2026-08-27T12:00:00.000Z", reference: "ERASE-3F2A9C8B1D4E" }),
    });
    h.root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(h.root.querySelector("[data-portal-erasure-sheet]")?.hasAttribute("open")).toBe(true);
    // Nothing recorded on merely opening the sheet.
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("records the request and states that a PERSON will action it (Req 23.5)", async () => {
    h = await boot({
      ...BASE,
      "POST /profile/erasure-request": ok({ requestedAt: "2026-08-27T12:00:00.000Z", reference: "ERASE-3F2A9C8B1D4E" }),
    });
    confirmErasure(h);
    await new Promise((resolve) => setTimeout(resolve, 8));

    expect(h.requests.find((r) => r.method === "POST")?.path).toBe("/profile/erasure-request");
    const message = h.root.querySelector("[data-portal-erasure-result]")?.textContent ?? "";
    expect(message).toContain("recorded your request");
    expect(message).toContain("will action it");
    expect(message).toContain("ERASE-3F2A9C8B1D4E");
    // NEVER implying the data has already gone.
    expect(message).not.toContain("deleted");
    expect(message).not.toContain("has been removed");
  });

  it("sends NO body — the source is the server's to decide", async () => {
    h = await boot({
      ...BASE,
      "POST /profile/erasure-request": ok({ requestedAt: "2026-08-27T12:00:00.000Z", reference: "ERASE-1" }),
    });
    confirmErasure(h);
    await new Promise((resolve) => setTimeout(resolve, 8));
    // A caller cannot claim the request arrived by another route.
    expect(h.requests.find((r) => r.method === "POST")?.body).toBeUndefined();
  });

  it("closes the sheet and withdraws the control once recorded", async () => {
    h = await boot({
      ...BASE,
      "POST /profile/erasure-request": ok({ requestedAt: "2026-08-27T12:00:00.000Z", reference: "ERASE-1" }),
    });
    confirmErasure(h);
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.root.querySelector("[data-portal-erasure-sheet]")?.hasAttribute("open")).toBe(false);
    const open = h.root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]");
    expect(open?.disabled).toBe(true);
    expect(open?.getAttribute("aria-label")).toContain("already requested");
  });

  it("a repeated confirm sends ONE request", async () => {
    h = await boot({
      ...BASE,
      "POST /profile/erasure-request": ok({ requestedAt: "2026-08-27T12:00:00.000Z", reference: "ERASE-1" }),
    });
    h.root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]")?.click();
    const confirm = h.root.querySelector<HTMLButtonElement>("[data-portal-erasure-confirm]") as HTMLButtonElement;
    confirm.click();
    confirm.click();
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("a 429 says the request already stands, not that it failed", async () => {
    // The 1/day limit here means "you already asked", which is not an error.
    h = await boot({
      ...BASE,
      "POST /profile/erasure-request": fail("rate_limit_exceeded", 429, { retryAfterSeconds: 86_400 }),
    });
    confirmErasure(h);
    await new Promise((resolve) => setTimeout(resolve, 8));
    const message = h.root.querySelector("[data-portal-erasure-result]")?.textContent ?? "";
    expect(message).toContain("already asked us to delete");
    expect(message).toContain("working on it");
    expect(message.toLowerCase()).not.toContain("rate limit");
    expect(message.toLowerCase()).not.toContain("too many");
    expect(h.root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]")?.disabled).toBe(true);
  });

  it("a real failure is reported, and the control stays usable", async () => {
    h = await boot({ ...BASE, "POST /profile/erasure-request": fail("upstream_unavailable", 502) });
    confirmErasure(h);
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.root.querySelector("[data-portal-erasure-result]")?.textContent).toBe(
      copy.error("upstream_unavailable"),
    );
    expect(h.root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]")?.disabled).toBe(false);
  });
});

/* ========================================================================== *
 * Requirement 13.6 — logout
 * ========================================================================== */

describe("Settings: the logout control (Requirement 13.6)", () => {
  it("uses Shopify's own logout route rather than a hardcoded path", () => {
    const arm = armSource();
    // `routes.account_logout_url` is the Liquid indirection that resolves correctly
    // under new customer accounts; `/account/logout` would not.
    expect(arm).toContain("{{ routes.account_logout_url }}");
    expect(arm).not.toContain('href="/account/logout"');
  });

  it("renders exactly one logout control in the section", async () => {
    h = await boot(BASE);
    const controls = [...h.root.querySelectorAll("[data-portal-logout]")];
    expect(controls).toHaveLength(1);
    expect(controls[0]?.textContent?.trim()).toBe("Sign out");
  });
});

/* ========================================================================== *
 * States and containment
 * ========================================================================== */

describe("Settings: states (Requirements 16.1, 16.3)", () => {
  it("degrades only when PREFERENCES fail — that one is fatal", async () => {
    h = await boot({ ...BASE, "GET /profile/preferences": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });

  it("reads each source exactly once", async () => {
    h = await boot(BASE);
    for (const path of ["/profile/preferences", "/profile/consent", "/profile/addresses"]) {
      expect(h.requests.filter((r) => r.path === path && r.method === "GET"), path).toHaveLength(1);
    }
  });

  it("writes nothing to client storage", async () => {
    h = await boot(BASE);
    const control = h.root.querySelector<HTMLInputElement>("[data-portal-consent-toggle]") as HTMLInputElement;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("every request is a relative App Proxy path", async () => {
    h = await boot(BASE);
    for (const request of h.requests) {
      expect(request.path.startsWith("/")).toBe(true);
      expect(request.path).not.toContain("onrender.com");
      expect(request.path).not.toContain("://");
    }
  });
});
