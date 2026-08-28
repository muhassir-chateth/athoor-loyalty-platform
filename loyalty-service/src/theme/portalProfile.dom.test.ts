// @vitest-environment jsdom
/**
 * Spec tasks 25.2–25.5 — the Profile section, including the Birthday panel.
 *
 * Validates Requirements 5.1–5.8, 11.1, 11.2, 11.3, 11.5, 11.9, 11.10, 13.7, 16.4,
 * 16.7, 17.4, 17.6, 17.7, 17.8, 23.8, 25.7, 1.8, 26.2.
 *
 * The harness installs the REAL task-18 primitives — including the REAL draft store,
 * because draft retention across a failure is one of the behaviours under test and a
 * stubbed store would let the module pass while retaining nothing. Only the network
 * is stubbed.
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

function identity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: "Layla",
    lastName: "Haddad",
    email: "layla@example.com",
    phone: "+44 7700 900123",
    emailEditable: false,
    ...over,
  };
}

function address(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gid://shopify/MailingAddress/8001",
    isDefault: true,
    firstName: "Layla",
    lastName: "Haddad",
    address1: "12 Mount Street",
    address2: null,
    city: "London",
    province: null,
    zip: "W1K 2TX",
    countryCode: "GB",
    phone: null,
    ...over,
  };
}

function birthdayBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    birthday: { month: 6, day: 12 },
    eligibility: { state: "outside_window", windowOpensOn: "2026-05-29", windowDays: 14 },
    changeable: { allowed: true, allowedFrom: null },
    ...over,
  };
}

const PREFERENCES = {
  vocabulary: { scent_family: [], note: [], intensity: [], occasion: [], season: [] },
  declared: { scent_family: [], note: [], intensity: null, occasion: [], season: [] },
  communication: {
    productLaunches: true,
    restockAlerts: false,
    birthdayMessages: true,
    referralUpdates: false,
  },
  limits: {},
};

/**
 * The real Liquid arm, rendered.
 *
 * Task 24's non-vacuity run proved that a hand-transcribed markup constant cannot see
 * the file that ships: flipping an attribute in the Liquid left that suite green. So
 * this harness EXTRACTS the `profile` arm from `portal-section.liquid` and strips the
 * Liquid comments, rather than restating it. A structural change to the shipped
 * template therefore reaches these tests.
 */
function markup(): string {
  const whole = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "theme", "snippets", "portal-section.liquid"),
    "utf8",
  );
  const start = whole.indexOf("{%- when 'profile' -%}");
  expect(start, "the profile arm is missing from portal-section.liquid").toBeGreaterThan(-1);
  const end = whole.indexOf("{%- when ", start + 1);
  const arm = whole.slice(start + "{%- when 'profile' -%}".length, end === -1 ? undefined : end);
  const withoutComments = arm.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
  return `
    <section class="athoor-portal__section" data-portal-section="profile" data-state="loading" aria-busy="true">
      <p data-portal-live aria-live="polite"></p>
      <div class="athoor-portal__state">
        <p data-portal-state-message>Preparing your account</p>
        <p data-portal-reference hidden></p>
        <button type="button" data-portal-retry hidden>Try again</button>
      </div>
      <div data-portal-skeleton aria-hidden="true"></div>
      <div data-portal-body></div>
      ${withoutComments}
    </section>`;
}

let captured: ((el: HTMLElement) => void) | null = null;

async function boot(responses: Record<string, unknown>): Promise<Harness> {
  document.body.innerHTML = markup();
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const requests: Recorded[] = [];
  const announced: string[] = [];

  const request = vi.fn((spec: { method: string; path: string; body?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, body: spec.body });
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return Promise.resolve(responses[key]);
    return Promise.resolve(fail("not_found", 404));
  });

  // jsdom implements neither, and the sheet primitive falls back to the attribute.
  for (const dialog of root.querySelectorAll<HTMLDialogElement>("dialog")) {
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
    cache: { read: request, invalidateBalance: () => undefined, clear: () => undefined, size: () => 0 },
    // THE REAL draft store: retention across a failure is under test.
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
  await import("../../../theme-src/portal/sections/profile.js");
  expect(captured, "no boot function registered").not.toBeNull();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 4));

  return { root, requests, announced };
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
  draft.clearAll();
});

const BASE = {
  "GET /profile/identity": ok(identity()),
  "GET /profile/addresses": ok({ addresses: [address()] }),
  "GET /profile/birthday": ok(birthdayBody()),
  "GET /profile/preferences": ok(PREFERENCES),
};

const field = (form: HTMLElement, name: string): HTMLInputElement =>
  form.querySelector<HTMLInputElement>(`[name="${name}"]`) as HTMLInputElement;

const idForm = (harness: Harness): HTMLFormElement =>
  harness.root.querySelector<HTMLFormElement>("[data-portal-identity-form]") as HTMLFormElement;

function submit(form: HTMLElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

/* ========================================================================== *
 * The single view
 * ========================================================================== */

describe("Profile: one view over four sources (Requirements 5.1, 5.6)", () => {
  it("renders identity, addresses, birthday and preferences together", async () => {
    h = await boot(BASE);
    expect(h.root.getAttribute("data-state")).toBe("ready");
    const form = idForm(h);
    expect(field(form, "firstName").value).toBe("Layla");
    expect(field(form, "lastName").value).toBe("Haddad");
    expect(field(form, "phone").value).toBe("+44 7700 900123");
    expect(field(form, "email").value).toBe("layla@example.com");
    // Addresses.
    expect(h.root.textContent).toContain("12 Mount Street");
    expect(h.root.textContent).toContain("United Kingdom");
    // Birthday.
    expect(h.root.querySelector("[data-portal-birthday-stored]")?.textContent).toBe("12 June");
    // Requirement 5.6 — Loyalty_Service preference values in the SAME view.
    expect(h.root.querySelector("[data-portal-communication]")?.hasAttribute("hidden")).toBe(false);
    expect(h.root.textContent).toContain("New fragrance launches");
  });

  it("reads each source exactly once", async () => {
    h = await boot(BASE);
    for (const path of ["/profile/identity", "/profile/addresses", "/profile/birthday", "/profile/preferences"]) {
      expect(h.requests.filter((r) => r.path === path && r.method === "GET"), path).toHaveLength(1);
    }
  });

  it("renders the country NAME from its code, never the identifier alone", async () => {
    h = await boot({ ...BASE, "GET /profile/addresses": ok({ addresses: [address({ countryCode: "AE" })] }) });
    expect(h.root.textContent).toContain("United Arab Emirates");
  });

  it("writes NOTHING to client storage (Requirement 1.8)", async () => {
    h = await boot(BASE);
    const form = idForm(h);
    field(form, "firstName").value = "Layla-Rose";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

/* ========================================================================== *
 * Requirements 5.7 and 5.8 — no password, no email edit
 * ========================================================================== */

describe("Profile: credentials are not managed here (Requirements 5.7, 5.8)", () => {
  it("renders NO password control of any kind", async () => {
    h = await boot(BASE);
    expect(h.root.querySelectorAll("input[type='password']")).toHaveLength(0);
    for (const control of h.root.querySelectorAll("input, button, a")) {
      const text = `${control.getAttribute("name") ?? ""} ${control.getAttribute("id") ?? ""} ${control.textContent ?? ""}`;
      expect(text.toLowerCase()).not.toContain("password");
    }
  });

  it("renders the email READ-ONLY, and routes elsewhere to change it", async () => {
    h = await boot(BASE);
    const email = field(idForm(h), "email");
    // `readonly`, not `disabled`: a disabled input is skipped by keyboard navigation
    // and its value is not announced, so the customer cannot read their own address.
    expect(email.readOnly).toBe(true);
    expect(email.disabled).toBe(false);
    const route = h.root.querySelector("[data-portal-email-route]");
    expect(route?.getAttribute("href")).toBe("/account");
  });

  it("never sends the email in an identity write", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity()) });
    submit(idForm(h));
    await new Promise((resolve) => setTimeout(resolve, 6));
    const body = h.requests.find((r) => r.method === "PUT")?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["firstName", "lastName", "phone"]);
  });
});

/* ========================================================================== *
 * The identity write
 * ========================================================================== */

describe("Profile: the identity write (Requirements 5.2, 5.3, 5.5)", () => {
  it("displays the value SHOPIFY STORED, not the one submitted (Req 5.3)", async () => {
    h = await boot({
      ...BASE,
      // Shopify normalises the phone number.
      "PUT /profile/identity": ok(identity({ phone: "+447700900123" })),
    });
    const form = idForm(h);
    field(form, "phone").value = "07700 900123";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));

    expect(field(form, "phone").value).toBe("+447700900123");
    expect(h.announced.join(" ")).toContain("saved");
  });

  it("clears a phone with null rather than an empty string", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity({ phone: null })) });
    const form = idForm(h);
    field(form, "phone").value = "";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    // An empty string is rejected by the schema; `null` is how the field is cleared.
    expect((h.requests.find((r) => r.method === "PUT")?.body as Record<string, unknown>).phone).toBeNull();
  });

  it("on FAILURE restores the stored value, says so, and keeps the draft (Req 5.5, 16.7)", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": fail("upstream_unavailable", 502) });
    const form = idForm(h);
    field(form, "firstName").value = "Layla-Rose";
    field(form, "phone").value = "07999 111222";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));

    // The PREVIOUSLY STORED value is back on screen.
    expect(field(form, "firstName").value).toBe("Layla");
    // It says the change was not saved, and offers a retry by leaving the control live.
    const result = h.root.querySelector("[data-portal-identity-result]");
    expect(result?.hasAttribute("hidden")).toBe(false);
    expect(result?.textContent).toContain("not saved");
    expect(h.root.querySelector<HTMLButtonElement>("[data-portal-identity-submit]")?.disabled).toBe(false);
    // And the typing survives IN MEMORY, so a retry is not a retype.
    expect(draft.get("profile:identity").firstName).toBe("Layla-Rose");
    expect(draft.get("profile:identity").phone).toBe("07999 111222");
  });

  it("clears the draft only after a SUCCESSFUL save", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity({ firstName: "Layla-Rose" })) });
    const form = idForm(h);
    field(form, "firstName").value = "Layla-Rose";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(draft.has("profile:identity")).toBe(false);
  });

  it("a repeated submit sends ONE write", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity()) });
    const form = idForm(h);
    submit(form);
    submit(form);
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("the submit control states its reason while in flight (§18.8)", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity()) });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-identity-submit]") as HTMLButtonElement;
    submit(idForm(h));
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-label")).toContain("Saving");
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(control.disabled).toBe(false);
  });
});

/* ========================================================================== *
 * Validation and error presentation — task 25.4
 * ========================================================================== */

describe("Profile: validation (Requirements 5.4, 16.4, 17.6, 17.7, 17.8)", () => {
  it("a rejected submission RETAINS other values and moves focus (Req 5.4)", async () => {
    h = await boot({
      ...BASE,
      "PUT /profile/identity": fail("invalid_request", 400, {
        fields: [{ field: "phone", code: "invalid_phone" }],
      }),
    });
    const form = idForm(h);
    field(form, "firstName").value = "Layla-Rose";
    field(form, "phone").value = "nonsense";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));

    // The other entered value is retained.
    expect(field(form, "firstName").value).toBe("Layla-Rose");
    // `aria-invalid` on the failing control, message linked below it.
    const phone = field(form, "phone");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    const message = form.querySelector("[data-portal-field-error='phone']");
    expect(message?.hasAttribute("hidden")).toBe(false);
    // The wording is the CLIENT's, from the copy map — never the server's text.
    expect(message?.textContent).toBe(copy.fieldError("invalid_phone"));
    expect(phone.getAttribute("aria-describedby")).toContain(message?.getAttribute("id") ?? "");
    // Focus moved to the first failing input.
    expect(document.activeElement).toBe(phone);
  });

  it("renders an error SUMMARY of links to the failing fields", async () => {
    h = await boot({
      ...BASE,
      "PUT /profile/identity": fail("invalid_request", 400, {
        fields: [
          { field: "firstName", code: "too_long" },
          { field: "phone", code: "invalid_phone" },
        ],
      }),
    });
    submit(idForm(h));
    await new Promise((resolve) => setTimeout(resolve, 6));
    const summary = h.root.querySelector("[data-portal-error-summary]");
    expect(summary?.hasAttribute("hidden")).toBe(false);
    const links = [...(summary?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["#AthoorProfileFirstName", "#AthoorProfilePhone"]);
  });

  it("a rejection naming a field this form has NOT got still reaches the customer", async () => {
    // Shopify can name `countryCodeV2`, which is no input here. Silently dropping it
    // would leave the customer with a failed save and no reason.
    h = await boot({
      ...BASE,
      "PUT /profile/identity": fail("invalid_request", 400, {
        fields: [{ field: "countryCodeV2", code: "invalid_country" }],
      }),
    });
    submit(idForm(h));
    await new Promise((resolve) => setTimeout(resolve, 6));
    const summary = h.root.querySelector("[data-portal-error-summary]");
    expect(summary?.hasAttribute("hidden")).toBe(false);
    expect(summary?.textContent).toContain(copy.fieldError("invalid_country"));
    // Nothing to focus, so focus goes to the summary rather than nowhere.
    expect(document.activeElement).toBe(summary);
  });

  it("validates locally before spending a request", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity()) });
    const form = idForm(h);
    field(form, "firstName").value = "";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(field(form, "firstName").getAttribute("aria-invalid")).toBe("true");
  });

  it("does NOT validate on blur before a first failed submit (§17.7)", async () => {
    h = await boot(BASE);
    const form = idForm(h);
    const first = field(form, "firstName");
    first.value = "";
    first.dispatchEvent(new Event("blur", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 3));
    // Punishing a customer for moving through a form they have not finished.
    expect(first.getAttribute("aria-invalid")).toBeNull();
  });

  it("DOES validate on blur once a submit has been rejected (§17.7)", async () => {
    h = await boot({ ...BASE, "PUT /profile/identity": ok(identity()) });
    const form = idForm(h);
    const first = field(form, "firstName");
    first.value = "";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    first.removeAttribute("aria-invalid");
    first.dispatchEvent(new Event("blur", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(first.getAttribute("aria-invalid")).toBe("true");
  });
});

/* ========================================================================== *
 * The Birthday panel — task 25.3
 * ========================================================================== */

describe("Profile: the Birthday panel (Requirements 11.1, 11.2, 11.3, 11.9, 11.10)", () => {
  const bForm = (harness: Harness): HTMLFormElement =>
    harness.root.querySelector<HTMLFormElement>("[data-portal-birthday-form]") as HTMLFormElement;

  it("offers two SELECTS and no date input, and no year anywhere (Req 11.1, 11.2)", async () => {
    h = await boot(BASE);
    expect(h.root.querySelector("[data-portal-birthday-day]")?.tagName).toBe("SELECT");
    expect(h.root.querySelector("[data-portal-birthday-month]")?.tagName).toBe("SELECT");
    expect(h.root.querySelectorAll("input[type='date']")).toHaveLength(0);
    // Requirement 11.2 — no birth year CONTROL, by any spelling. Deliberately not a
    // scan for the word: the purpose statement says "never the year", and that
    // sentence is required by Requirement 11.10.
    expect(h.root.querySelectorAll("[autocomplete='bday-year']")).toHaveLength(0);
    expect(h.root.querySelectorAll("[autocomplete='bday']")).toHaveLength(0);
    expect(h.root.querySelectorAll("[name='year']")).toHaveLength(0);
    // Exactly two selects in the birthday form, and they are day and month.
    const birthdayForm = h.root.querySelector("[data-portal-birthday-form]") as HTMLElement;
    expect([...birthdayForm.querySelectorAll("select")].map((s) => s.getAttribute("name"))).toEqual([
      "day",
      "month",
    ]);
  });

  it("states what the birthday is used for BEFORE submission (Req 11.10)", async () => {
    h = await boot(BASE);
    const purpose = h.root.querySelector("[data-portal-birthday-purpose]")?.textContent ?? "";
    expect(purpose).toContain("day and month only");
    expect(purpose).toContain("never the year");
    expect(purpose.toLowerCase()).toContain("gift");
  });

  it("presents the stored birthday, the eligibility state and the change date (Req 11.9)", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/birthday": ok(
        birthdayBody({
          eligibility: { state: "eligible", windowOpensOn: "2026-06-05", windowDays: 14 },
          changeable: { allowed: false, allowedFrom: "2027-03-01" },
        }),
      ),
    });
    expect(h.root.querySelector("[data-portal-birthday-stored]")?.textContent).toBe("12 June");
    // Every state word from the copy map, keyed on the server's identifier.
    expect(h.root.querySelector("[data-portal-birthday-eligibility]")?.textContent).toBe(
      copy.birthdayEligibility("eligible"),
    );
    const lock = h.root.querySelector("[data-portal-birthday-lock]");
    expect(lock?.hasAttribute("hidden")).toBe(false);
    expect(lock?.textContent).toBe("You can change this from 1 March 2027");
  });

  it("disables the change control while locked, WITH its reason (§18.8)", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/birthday": ok(birthdayBody({ changeable: { allowed: false, allowedFrom: "2027-03-01" } })),
    });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-birthday-open]");
    expect(control?.disabled).toBe(true);
    expect(control?.getAttribute("aria-label")).toContain("1 March 2027");
  });

  it("ACCEPTS 29 February at the client (Requirement 11.5)", async () => {
    h = await boot({ ...BASE, "PUT /profile/birthday": ok(birthdayBody({ birthday: { month: 2, day: 29 } })) });
    const form = bForm(h);
    (form.querySelector("[data-portal-birthday-month]") as HTMLSelectElement).value = "2";
    (form.querySelector("[data-portal-birthday-day]") as HTMLSelectElement).value = "29";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    // A real birthday, so the request is sent.
    expect(h.requests.find((r) => r.method === "PUT")?.body).toEqual({ month: 2, day: 29 });
    expect(h.root.querySelector("[data-portal-birthday-stored]")?.textContent).toBe("29 February");
  });

  it("REJECTS 31 February at the client, changing no stored record (Req 11.3)", async () => {
    h = await boot({ ...BASE, "PUT /profile/birthday": ok(birthdayBody()) });
    const form = bForm(h);
    (form.querySelector("[data-portal-birthday-month]") as HTMLSelectElement).value = "2";
    (form.querySelector("[data-portal-birthday-day]") as HTMLSelectElement).value = "31";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));

    // No request at all, so no stored Birthday_Record can have changed.
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    const message = form.querySelector("[data-portal-field-error='birthday']");
    expect(message?.hasAttribute("hidden")).toBe(false);
    expect(message?.textContent).toBe(copy.fieldError("invalid_day_for_month"));
  });

  it("rejects 31 April too, and accepts 30 April", async () => {
    h = await boot({ ...BASE, "PUT /profile/birthday": ok(birthdayBody()) });
    const form = bForm(h);
    const month = form.querySelector("[data-portal-birthday-month]") as HTMLSelectElement;
    const day = form.querySelector("[data-portal-birthday-day]") as HTMLSelectElement;
    month.value = "4";
    day.value = "31";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(0);

    day.value = "30";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("renders a 409 change-lock with its reopening date (Requirement 23.8)", async () => {
    h = await boot({
      ...BASE,
      "PUT /profile/birthday": fail("birthday_change_locked", 409, { allowedFrom: "2027-03-01" }),
    });
    const form = bForm(h);
    (form.querySelector("[data-portal-birthday-month]") as HTMLSelectElement).value = "6";
    (form.querySelector("[data-portal-birthday-day]") as HTMLSelectElement).value = "12";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));

    const message = form.querySelector("[data-portal-field-error='birthday']");
    // NOT through `copy.error`, which would leave a literal `{date}` on screen.
    expect(message?.textContent).toBe("You can change this from 1 March 2027");
    expect(message?.textContent).not.toContain("{date}");
  });

  it("renders a locked 409 with no date without printing an empty gap", async () => {
    h = await boot({ ...BASE, "PUT /profile/birthday": fail("birthday_change_locked", 409) });
    const form = bForm(h);
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    const message = form.querySelector("[data-portal-field-error='birthday']");
    expect(message?.textContent).toBe("You can change this once a year");
  });

  it("renders the server's own field codes as sentences", async () => {
    h = await boot({
      ...BASE,
      "PUT /profile/birthday": fail("invalid_request", 400, {
        fields: [{ field: "day", code: "invalid_day_for_month" }],
      }),
    });
    const form = bForm(h);
    (form.querySelector("[data-portal-birthday-month]") as HTMLSelectElement).value = "6";
    (form.querySelector("[data-portal-birthday-day]") as HTMLSelectElement).value = "12";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    const message = form.querySelector("[data-portal-field-error='birthday']");
    expect(message?.textContent).toBe("That day does not exist in that month.");
    expect(message?.textContent).not.toContain("invalid_day_for_month");
  });
});

/* ========================================================================== *
 * Addresses
 * ========================================================================== */

describe("Profile: addresses (Requirements 5.2, 5.5, 13.5, 16.4)", () => {
  const aForm = (harness: Harness): HTMLFormElement =>
    harness.root.querySelector<HTMLFormElement>("[data-portal-address-form]") as HTMLFormElement;

  function openAdd(harness: Harness): void {
    harness.root.querySelector<HTMLButtonElement>("[data-portal-address-add]")?.click();
  }

  it("adds through POST and repaints from the response", async () => {
    h = await boot({
      ...BASE,
      "POST /profile/addresses": ok({
        addresses: [address(), address({ id: "gid://shopify/MailingAddress/8002", isDefault: false, address1: "5 Bruton Street" })],
      }),
    });
    openAdd(h);
    const form = aForm(h);
    field(form, "address1").value = "5 Bruton Street";
    field(form, "city").value = "London";
    field(form, "zip").value = "W1J 6PU";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));

    expect(h.requests.find((r) => r.method === "POST")?.path).toBe("/profile/addresses");
    expect(h.root.textContent).toContain("5 Bruton Street");
    expect(h.root.querySelectorAll("[data-portal-address]")).toHaveLength(2);
  });

  it("edits through PUT against the address's own id", async () => {
    h = await boot({ ...BASE, "PUT /profile/addresses/gid%3A%2F%2Fshopify%2FMailingAddress%2F8001": ok({ addresses: [address({ city: "Bath" })] }) });
    h.root.querySelector<HTMLButtonElement>("[data-portal-address-edit]")?.click();
    const form = aForm(h);
    // The sheet is prefilled from the stored address.
    expect(field(form, "address1").value).toBe("12 Mount Street");
    field(form, "city").value = "Bath";
    submit(form);
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(h.requests.find((r) => r.method === "PUT")?.path).toBe(
      "/profile/addresses/gid%3A%2F%2Fshopify%2FMailingAddress%2F8001",
    );
    expect(h.root.textContent).toContain("Bath");
  });

  it("requires the fields that make an address deliverable", async () => {
    h = await boot({ ...BASE, "POST /profile/addresses": ok({ addresses: [] }) });
    openAdd(h);
    submit(aForm(h));
    await new Promise((resolve) => setTimeout(resolve, 6));
    // The server makes every field optional, so an address with no line 1 would be
    // stored and then be undeliverable.
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(field(aForm(h), "address1").getAttribute("aria-invalid")).toBe("true");
  });

  it("an EDIT refusal with no field codes still says the address was not saved", async () => {
    // N8 turns a Shopify field-level refusal on the edit path into a bare 404 with no
    // `fields`, so there is nothing to attach to a control.
    h = await boot({
      ...BASE,
      "PUT /profile/addresses/gid%3A%2F%2Fshopify%2FMailingAddress%2F8001": fail("address_not_found", 404),
    });
    h.root.querySelector<HTMLButtonElement>("[data-portal-address-edit]")?.click();
    submit(aForm(h));
    await new Promise((resolve) => setTimeout(resolve, 6));
    const formError = h.root.querySelector("[data-portal-address-form-error]");
    expect(formError?.hasAttribute("hidden")).toBe(false);
    expect(formError?.textContent).toContain("not saved");
    // The sheet stays open rather than closing as though it had succeeded.
    expect(h.root.querySelector("[data-portal-address-sheet]")?.hasAttribute("open")).toBe(true);
  });

  it("a failed delete NAMES the address that failed, in its own row", async () => {
    h = await boot({
      ...BASE,
      "DELETE /profile/addresses/gid%3A%2F%2Fshopify%2FMailingAddress%2F8001": fail("upstream_unavailable", 502),
    });
    const remove = h.root.querySelector<HTMLButtonElement>("[data-portal-address-delete]") as HTMLButtonElement;
    remove.click();
    await new Promise((resolve) => setTimeout(resolve, 6));
    const row = remove.closest("[data-portal-address]");
    const slot = row?.querySelector("[data-portal-address-error]");
    expect(slot?.hasAttribute("hidden")).toBe(false);
    expect(slot?.textContent).toContain("not changed");
    // The row is still there: nothing was removed.
    expect(h.root.querySelectorAll("[data-portal-address]")).toHaveLength(1);
    expect(remove.disabled).toBe(false);
  });

  it("every per-address control names WHICH address it acts on (§17.8)", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/addresses": ok({
        addresses: [address(), address({ id: "gid://shopify/MailingAddress/8002", isDefault: false, address1: "5 Bruton Street" })],
      }),
    });
    const labels = [...h.root.querySelectorAll("[data-portal-address-edit]")].map((c) =>
      c.getAttribute("aria-label"),
    );
    expect(labels[0]).toContain("12 Mount Street");
    expect(labels[1]).toContain("5 Bruton Street");
  });

  it("offers no make-default control on the address that already is", async () => {
    h = await boot(BASE);
    const row = h.root.querySelector("[data-portal-address]");
    expect(row?.querySelector("[data-portal-address-default]")).toBeNull();
  });

  it("an <img onerror> in an address line creates no element (Requirement 26.2)", async () => {
    h = await boot({
      ...BASE,
      "GET /profile/addresses": ok({
        addresses: [address({ address1: `<img src=x onerror="window.__pwned=true">` })],
      }),
    });
    expect(h.root.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

/* ========================================================================== *
 * Communication preferences
 * ========================================================================== */

describe("Profile: communication preferences (Requirement 5.6)", () => {
  it("reflects the stored booleans", async () => {
    h = await boot(BASE);
    const toggles = [...h.root.querySelectorAll<HTMLInputElement>("[data-portal-comms-toggle]")];
    expect(toggles.map((t) => t.dataset.key)).toEqual([
      "productLaunches",
      "restockAlerts",
      "birthdayMessages",
      "referralUpdates",
    ]);
    expect(toggles.map((t) => t.checked)).toEqual([true, false, true, false]);
  });

  it("writes only the toggled key, and never marketing consent", async () => {
    h = await boot({
      ...BASE,
      "PUT /profile/preferences": ok({ ...PREFERENCES, communication: { ...PREFERENCES.communication, restockAlerts: true } }),
    });
    const toggle = h.root.querySelector<HTMLInputElement>("[data-portal-comms-toggle][data-key='restockAlerts']") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));

    const body = h.requests.find((r) => r.method === "PUT")?.body as Record<string, unknown>;
    expect(body).toEqual({ communication: { restockAlerts: true } });
    // Marketing consent is Shopify's, with its own endpoint and its own legal
    // meaning. It must never be written through the preferences block.
    expect(JSON.stringify(body)).not.toContain("marketingConsent");
    expect(JSON.stringify(body)).not.toContain("emailMarketing");
  });

  it("a failed toggle goes back to the server's last confirmed value", async () => {
    h = await boot({ ...BASE, "PUT /profile/preferences": fail("upstream_unavailable", 502) });
    const toggle = h.root.querySelector<HTMLInputElement>("[data-portal-comms-toggle][data-key='restockAlerts']") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 6));
    // Not left showing a preference that was never stored.
    expect(toggle.checked).toBe(false);
    expect(h.announced.join(" ")).toContain("not saved");
  });
});

/* ========================================================================== *
 * States and containment
 * ========================================================================== */

describe("Profile: states (Requirements 16.1, 16.3)", () => {
  it("degrades only when IDENTITY fails — that one is fatal", async () => {
    h = await boot({ ...BASE, "GET /profile/identity": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    expect(h.root.querySelector("[data-portal-retry]")?.hasAttribute("hidden")).toBe(false);
  });

  it("a BIRTHDAY outage does not cost the customer their delivery details", async () => {
    h = await boot({ ...BASE, "GET /profile/birthday": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector("[data-portal-birthday]")?.hasAttribute("hidden")).toBe(true);
    // The identity form is still usable.
    expect(field(idForm(h), "phone").value).toBe("+44 7700 900123");
  });

  it("an ADDRESS outage hides that block alone and says so", async () => {
    h = await boot({ ...BASE, "GET /profile/addresses": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector("[data-portal-addresses]")?.hasAttribute("hidden")).toBe(true);
    expect(h.announced.join(" ")).toContain("unavailable");
  });

  it("hides the preference block when it cannot be read, rather than defaulting it", async () => {
    h = await boot({ ...BASE, "GET /profile/preferences": fail("upstream_unavailable", 502) });
    // Reporting "not subscribed" for a customer who is subscribed would be inventing
    // a fact about their consent.
    expect(h.root.querySelector("[data-portal-communication]")?.hasAttribute("hidden")).toBe(true);
  });

  it("every request is a relative App Proxy path", async () => {
    h = await boot(BASE);
    for (const request of h.requests) {
      expect(request.path.startsWith("/")).toBe(true);
      expect(request.path).not.toContain("://athoor");
      expect(request.path).not.toContain("onrender.com");
    }
  });
});

/* ========================================================================== *
 * The shipped Liquid — the same rules, asserted against the file
 * ========================================================================== */

describe("Profile: the shipped Liquid carries the accessibility contract", () => {
  const arm = ((): string => {
    const whole = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "theme", "snippets", "portal-section.liquid"),
      "utf8",
    );
    const start = whole.indexOf("{%- when 'profile' -%}");
    expect(start, "the profile arm is missing").toBeGreaterThan(-1);
    const next = whole.indexOf("{%- when ", start + 1);
    return whole.slice(start, next === -1 ? undefined : next);
  })();

  it("gives every input a persistent label and an autocomplete token (§19.7)", async () => {
    h = await boot(BASE);
    const controls = [
      ...h.root.querySelectorAll<HTMLElement>("input[name], select[name]"),
    ].filter((c) => c.getAttribute("type") !== "checkbox");
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      const id = control.getAttribute("id");
      expect(id, `a control has no id: ${control.outerHTML.slice(0, 80)}`).toBeTruthy();
      const label = h.root.querySelector(`label[for="${id}"]`);
      expect(label, `no label for ${id ?? "?"}`).not.toBeNull();
      // A visible label, not a placeholder standing in for one.
      expect(label?.textContent?.trim()).not.toBe("");
      expect(control.getAttribute("placeholder"), `${id ?? "?"} uses a placeholder`).toBeNull();
      expect(control.getAttribute("autocomplete"), `${id ?? "?"} has no autocomplete`).toBeTruthy();
    }
  });

  it("uses a fieldset and legend for the birthday pair and the address block (§19.7)", () => {
    expect(arm).toContain("athoor-profile__birthday-pair");
    const birthdayFieldset = arm.slice(arm.indexOf("athoor-profile__birthday-pair"));
    expect(birthdayFieldset.slice(0, 400)).toContain("<legend");
    const addressForm = arm.slice(arm.indexOf("data-portal-address-form"));
    expect(addressForm.slice(0, 600)).toContain("<fieldset");
    expect(addressForm.slice(0, 600)).toContain("<legend");
  });

  it("declares a visible dismiss control on every sheet (Requirement 25.8)", () => {
    const sheets = arm.split("<dialog").slice(1);
    expect(sheets).toHaveLength(2);
    for (const dialogMarkup of sheets) {
      expect(dialogMarkup).toContain("data-portal-sheet-dismiss");
      expect(dialogMarkup).toContain("aria-labelledby");
    }
  });

  it("contains no password control and no birth-year control", () => {
    expect(arm).not.toContain('type="password"');
    expect(arm).not.toContain('autocomplete="bday-year"');
    expect(arm).not.toContain('autocomplete="bday"');
    expect(arm).not.toContain('name="year"');
    // The email is read-only in the markup itself, not only at runtime.
    const emailBlock = arm.slice(arm.indexOf('id="AthoorProfileEmail"'));
    expect(emailBlock.slice(0, 300)).toContain("readonly");
  });

  it("links every field message to its control with aria-describedby", async () => {
    h = await boot(BASE);
    for (const slot of h.root.querySelectorAll<HTMLElement>("[data-portal-field-error]")) {
      const name = slot.getAttribute("data-portal-field-error");
      if (name === "birthday") continue;
      const id = slot.getAttribute("id");
      expect(id, `a field message has no id for ${name ?? "?"}`).toBeTruthy();
      const form = slot.closest("form");
      const control = form?.querySelector(`[name="${name ?? ""}"]`);
      expect(control?.getAttribute("aria-describedby"), `${name ?? "?"} is not linked`).toContain(id ?? "");
    }
  });
});
