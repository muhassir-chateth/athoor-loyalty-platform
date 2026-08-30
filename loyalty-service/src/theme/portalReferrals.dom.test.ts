// @vitest-environment jsdom
/**
 * Spec task 23.2 — the Referrals section.
 *
 * Validates Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8, 10.9, 10.10,
 * 10.15, 10.16, 1.8, 16.3, 17.5, 26.2, 26.6.
 *
 * The harness is the one tasks 20-22 established: install a runtime carrying the
 * REAL task-18 primitives with only the network stubbed, import the section, capture
 * its boot function, invoke it. A fake copy map would let this module pass while
 * rendering a raw `friend_signup` — which is the exact string Requirement 10.15
 * forbids, so the real table has to be in play.
 *
 * SAFETY: jsdom only. `fetch` is never reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as announce from "../../../theme-src/portal/ui/announce.js";
import * as copy from "../../../theme-src/portal/ui/copy.js";
import * as focus from "../../../theme-src/portal/ui/focus.js";
import * as rows from "../../../theme-src/portal/render/rows.js";
import * as states from "../../../theme-src/portal/render/states.js";

const REF_KEY = "athoor_ref";
const DAY = 24 * 60 * 60 * 1000;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface Harness {
  root: HTMLElement;
  requests: Recorded[];
  announced: string[];
  readonly clipboardWrites: string[];
  readonly shares: unknown[];
  readonly execCommandCalls: number;
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

/** The service's own envelope shape — an inline literal, so mirrored here by hand. */
function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    referralCode: "ATHOOR-QY7",
    shareUrl: "https://myathoorlondon.co.uk/?ref=ATHOOR-QY7",
    wasReferred: true,
    referredSignups: 2,
    referredFirstPurchases: 1,
    totals: { successful: 2, pending: 1, creditedPoints: 400 },
    stages: [
      {
        key: "friend_signup",
        qualification: "friend_account_created",
        currentRewardPoints: 150,
        creditedPoints: 300,
        awardedCount: 2,
        pendingCount: 0,
        state: "awarded",
      },
      {
        key: "friend_first_purchase",
        qualification: "friend_first_paid_order",
        currentRewardPoints: 250,
        creditedPoints: 0,
        awardedCount: 0,
        pendingCount: 1,
        state: "pending",
      },
    ],
    ...over,
  };
}

const MARKUP = `
  <section class="athoor-portal__section" data-portal-section="referrals" data-state="loading" aria-busy="true">
    <p data-portal-live aria-live="polite"></p>
    <div class="athoor-portal__state">
      <p data-portal-state-message>Preparing your account</p>
      <p data-portal-reference hidden></p>
      <button type="button" data-portal-retry hidden>Try again</button>
    </div>
    <div data-portal-skeleton aria-hidden="true"></div>
    <div data-portal-body></div>
    <header class="athoor-referrals__invite">
      <p data-portal-referral-code></p>
      <p data-portal-referral-link hidden></p>
      <div>
        <button type="button" data-portal-referral-copy hidden>Copy your link</button>
        <button type="button" data-portal-referral-share hidden>Share</button>
      </div>
      <p data-portal-referral-copy-result hidden></p>
    </header>
    <ul data-portal-referral-totals role="list" hidden>
      <li><span data-slot="successful"></span></li>
      <li><span data-slot="pending"></span></li>
      <li><span data-slot="credited"></span></li>
    </ul>
    <h2 data-portal-referral-stages-heading hidden>How it works</h2>
    <template data-portal-row="stage">
      <li class="athoor-portal__row">
        <span data-slot="name"></span><span data-slot="qualification"></span>
        <span data-slot="state"></span><span data-slot="points"></span>
      </li>
    </template>
    <form data-portal-referral-claim hidden novalidate>
      <label for="AthoorReferralClaimInput">Enter your friend's code</label>
      <input id="AthoorReferralClaimInput" name="referralCode" type="text" maxlength="64">
      <button type="submit" data-portal-referral-claim-submit>Apply code</button>
      <p data-portal-referral-claim-message aria-live="polite" hidden></p>
    </form>
    <p data-portal-empty-action>Share your code and you will both be rewarded when your friend joins.</p>
  </section>`;

let captured: ((el: HTMLElement) => void) | null = null;

interface BootOptions {
  /** Query string, so `?ref=` capture can be exercised. */
  readonly search?: string;
  /** `undefined` removes `navigator.clipboard` entirely. */
  readonly clipboard?: "ok" | "reject" | "absent";
  /** `true` installs `navigator.share`. */
  readonly share?: boolean;
  /** What `document.execCommand("copy")` returns. */
  readonly execCommand?: boolean | "absent";
}

async function boot(responses: Record<string, unknown>, opts: BootOptions = {}): Promise<Harness> {
  window.history.replaceState({}, "", `/pages/my-athoor-referrals${opts.search ?? ""}`);
  document.body.innerHTML = MARKUP;
  const root = document.querySelector<HTMLElement>("[data-portal-section]") as HTMLElement;

  const requests: Recorded[] = [];
  const announced: string[] = [];
  const clipboardWrites: string[] = [];
  const shares: unknown[] = [];
  const counters = { execCommand: 0 };

  const request = vi.fn((spec: { method: string; path: string; body?: unknown }) => {
    requests.push({ method: spec.method, path: spec.path, body: spec.body });
    const key = `${spec.method} ${spec.path}`;
    if (Object.prototype.hasOwnProperty.call(responses, key)) return Promise.resolve(responses[key]);
    return Promise.resolve(fail("not_found", 404));
  });

  // `navigator.clipboard` is a read-only accessor in jsdom, so it is redefined
  // rather than assigned.
  const clipboardMode = opts.clipboard ?? "ok";
  if (clipboardMode === "absent") {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  } else {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          if (clipboardMode === "reject") return Promise.reject(new Error("denied"));
          clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
      configurable: true,
    });
  }
  Object.defineProperty(navigator, "share", {
    value:
      opts.share === true
        ? (data: unknown) => {
            shares.push(data);
            return Promise.resolve();
          }
        : undefined,
    configurable: true,
  });

  const execMode = opts.execCommand ?? true;
  if (execMode === "absent") {
    Object.defineProperty(document, "execCommand", { value: undefined, configurable: true });
  } else {
    Object.defineProperty(document, "execCommand", {
      value: () => {
        counters.execCommand += 1;
        return execMode;
      },
      configurable: true,
    });
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
      invalidateBalance: () => undefined,
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
      open: (d: HTMLDialogElement) => () => d.removeAttribute("open"),
      close: (d: HTMLDialogElement) => d.removeAttribute("open"),
      isOpen: (d: HTMLDialogElement) => d.hasAttribute("open"),
    },
    copy,
    cart: { addToCart: () => Promise.resolve({ ok: true, added: 1 }), isAdding: () => false },
  };

  vi.resetModules();
  await import("../../../theme-src/portal/sections/referrals.js");
  expect(captured, "no boot function registered").not.toBeNull();
  captured?.(root);
  await new Promise((resolve) => setTimeout(resolve, 3));

  return {
    root,
    requests,
    announced,
    clipboardWrites,
    shares,
    get execCommandCalls(): number {
      return counters.execCommand;
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

const READY = { "GET /referral": ok(summary()) };

/* ========================================================================== *
 * The invitation
 * ========================================================================== */

describe("Referrals: the code and its link (Requirements 10.1, 10.2, 10.3)", () => {
  it("renders the code and the server-built link, never a link it assembled", async () => {
    h = await boot(READY);
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(h.root.querySelector("[data-portal-referral-code]")?.textContent).toBe("ATHOOR-QY7");
    const link = h.root.querySelector("[data-portal-referral-link]");
    expect(link?.textContent).toBe("https://myathoorlondon.co.uk/?ref=ATHOOR-QY7");
    expect(link?.hasAttribute("hidden")).toBe(false);
  });

  it("offers NO copy control when there is no code yet", async () => {
    // A control that copies an empty string is worse than an absent one.
    h = await boot({ "GET /referral": ok(summary({ referralCode: null, shareUrl: null, stages: [] })) });
    expect(h.root.querySelector("[data-portal-referral-copy]")?.hasAttribute("hidden")).toBe(true);
    expect(h.root.querySelector("[data-portal-referral-link]")?.hasAttribute("hidden")).toBe(true);
    expect(h.root.querySelector("[data-portal-referral-code]")?.textContent).toBe("");
  });

  it("copies the link and both SHOWS and ANNOUNCES the confirmation", async () => {
    h = await boot(READY);
    h.root.querySelector<HTMLButtonElement>("[data-portal-referral-copy]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 4));
    expect(h.clipboardWrites).toEqual(["https://myathoorlondon.co.uk/?ref=ATHOOR-QY7"]);
    // A clipboard write is invisible, so a rendered-only tick tells a screen reader
    // nothing and an announced-only one leaves a sighted customer unsure.
    const shown = h.root.querySelector("[data-portal-referral-copy-result]");
    expect(shown?.hasAttribute("hidden")).toBe(false);
    expect(shown?.textContent).toContain("copied");
    expect(h.announced.join(" ")).toContain("copied");
  });

  it("falls back to execCommand when the clipboard API refuses", async () => {
    h = await boot(READY, { clipboard: "reject", execCommand: true });
    h.root.querySelector<HTMLButtonElement>("[data-portal-referral-copy]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 4));
    expect(h.execCommandCalls).toBe(1);
    expect(h.announced.join(" ")).toContain("copied");
    // The scratch input must not survive as a stray focusable node.
    expect(h.root.querySelectorAll("input")).toHaveLength(1);
  });

  it("says so honestly when copying is impossible, and keeps the link on screen", async () => {
    h = await boot(READY, { clipboard: "absent", execCommand: false });
    h.root.querySelector<HTMLButtonElement>("[data-portal-referral-copy]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 4));
    const said = h.announced.join(" ");
    expect(said).toContain("Copying is unavailable");
    expect(said).not.toContain("Link copied");
    expect(h.root.querySelector("[data-portal-referral-link]")?.textContent).toContain("ATHOOR-QY7");
  });

  it("shows the share control ONLY where navigator.share exists (Requirement 10.3)", async () => {
    h = await boot(READY, { share: false });
    expect(h.root.querySelector("[data-portal-referral-share]")?.hasAttribute("hidden")).toBe(true);

    h = await boot(READY, { share: true });
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-referral-share]");
    expect(control?.hasAttribute("hidden")).toBe(false);
    control?.click();
    await new Promise((resolve) => setTimeout(resolve, 4));
    expect(h.shares).toEqual([{ url: "https://myathoorlondon.co.uk/?ref=ATHOOR-QY7", title: "My Athoor" }]);
  });
});

/* ========================================================================== *
 * Totals and stages
 * ========================================================================== */

describe("Referrals: totals and stages (Requirements 10.4, 10.5, 10.9, 10.16)", () => {
  it("renders the three totals as given (Requirement 10.4)", async () => {
    h = await boot(READY);
    const totals = h.root.querySelector("[data-portal-referral-totals]");
    expect(totals?.hasAttribute("hidden")).toBe(false);
    expect(totals?.querySelector("[data-slot='successful']")?.textContent).toBe("2");
    expect(totals?.querySelector("[data-slot='pending']")?.textContent).toBe("1");
    expect(totals?.querySelector("[data-slot='credited']")?.textContent).toBe("400");
  });

  it("renders BOTH stages with name, qualification and state from the copy map", async () => {
    h = await boot(READY);
    const stageRows = [...h.root.querySelectorAll(".athoor-referrals__stages > li")];
    expect(stageRows).toHaveLength(2);
    const text = h.root.textContent ?? "";
    expect(text).toContain("When your friend joins");
    expect(text).toContain("Your friend creates a My Athoor account with your code");
    expect(text).toContain("When your friend's first order is placed");
    // Requirement 10.15 — never the raw identifiers.
    expect(text).not.toContain("friend_signup");
    expect(text).not.toContain("friend_first_purchase");
    expect(text).not.toContain("friend_account_created");
  });

  it("an AWARDED stage shows what was CREDITED, not today's amount (Req 10.16)", async () => {
    h = await boot(READY);
    const stageRows = [...h.root.querySelectorAll(".athoor-referrals__stages > li")];
    // Stage 1 was awarded twice: the ledger paid 300, the configured amount is 150.
    // A customer is owed the number they were actually credited.
    expect(stageRows[0]?.querySelector("[data-slot='points']")?.textContent).toBe("300 points");
    // Stage 2 is pending, so it shows what it WILL pay.
    expect(stageRows[1]?.querySelector("[data-slot='points']")?.textContent).toBe("250 points");
  });

  it("a stage with NO activity says so, rather than claiming progress", async () => {
    // `deriveStageState` returns a third value, `none`. Rendering it as "In
    // progress" was a statement about the account that was not true.
    h = await boot({
      "GET /referral": ok(
        summary({
          stages: [
            {
              key: "friend_signup",
              qualification: "friend_account_created",
              currentRewardPoints: 150,
              creditedPoints: 0,
              awardedCount: 0,
              pendingCount: 0,
              state: "none",
            },
          ],
        }),
      ),
    });
    const text = h.root.textContent ?? "";
    expect(text).toContain("No invitations used yet");
    expect(text).not.toContain("In progress");
  });

  it("an UNKNOWN stage key renders the neutral fallback rather than vanishing", async () => {
    h = await boot({
      "GET /referral": ok(
        summary({
          stages: [
            {
              key: "friend_third_order_2031",
              qualification: "whatever",
              currentRewardPoints: 90,
              creditedPoints: 0,
              awardedCount: 0,
              pendingCount: 1,
              state: "pending",
            },
          ],
        }),
      ),
    });
    // A third stage added to the programme must still render (Requirement 10.13).
    expect(h.root.querySelectorAll(".athoor-referrals__stages > li")).toHaveLength(1);
    expect(h.root.textContent).toContain("A referral reward");
    expect(h.root.textContent).not.toContain("friend_third_order_2031");
  });

  it("renders no referred person's identity, because the DTO carries none (Req 10.7)", async () => {
    h = await boot(READY);
    const text = h.root.textContent ?? "";
    for (const leak of ["@", "customer_", "gid://"]) {
      expect(text, `rendered output contained ${leak}`).not.toContain(leak);
    }
  });

  it("an <img onerror> in a stage key creates no element (Requirement 26.2)", async () => {
    h = await boot({
      "GET /referral": ok(
        summary({
          stages: [
            {
              key: `<img src=x onerror="window.__pwned=true">`,
              state: "pending",
              currentRewardPoints: 1,
              creditedPoints: 0,
            },
          ],
        }),
      ),
    });
    expect(h.root.querySelectorAll("img")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

/* ========================================================================== *
 * States
 * ========================================================================== */

describe("Referrals: states (Requirements 10.8, 16.3)", () => {
  it("the EMPTY state still carries the code and an invitation (Requirement 10.8)", async () => {
    h = await boot({ "GET /referral": ok(summary({ stages: [], totals: { successful: 0, pending: 0, creditedPoints: 0 } })) });
    expect(h.root.getAttribute("data-state")).toBe("empty");
    // The invite sits OUTSIDE `data-portal-body`, which is what the shared layer
    // hides when the state is not `ready`. So the code survives.
    expect(h.root.querySelector("[data-portal-referral-code]")?.textContent).toBe("ATHOOR-QY7");
    expect(h.root.querySelector("[data-portal-referral-copy]")?.hasAttribute("hidden")).toBe(false);
    expect(h.root.querySelector("[data-portal-empty-action]")?.textContent).toContain("Share your code");
    // `states.set` calls `announce.polite` DIRECTLY rather than through the runtime
    // wrapper, so the harness recorder never sees it. The live region is where the
    // announcement actually lands, and is what a screen reader would read.
    //
    // FLUSH FIRST. `announce.write` clears the region and then sets the message
    // inside `setTimeout(…, 0)` — deliberately a macrotask, so the accessibility
    // tree observes the empty value before the new one and a repeated message is
    // still re-announced. Two announcements therefore land here in sequence:
    // "Preparing your account" from the loading state, then this one from the empty
    // state. Asserting the moment `boot()` resolves races the second timer, and this
    // test intermittently read the LOADING text instead — it failed in CI as
    // `expected 'Preparing your account' to contain 'Share your code to begin'`
    // while passing locally. The other six live-region assertions in the suite
    // already flush; this one did not.
    await new Promise((resolve) => setTimeout(resolve, 4));
    expect(h.root.querySelector("[data-portal-live]")?.textContent).toContain("Share your code to begin");
  });

  it("degrades with a retry that re-reads", async () => {
    h = await boot({ "GET /referral": fail("upstream_unavailable", 502) });
    expect(h.root.getAttribute("data-state")).toBe("degraded");
    const retry = h.root.querySelector<HTMLButtonElement>("[data-portal-retry]");
    expect(retry?.hasAttribute("hidden")).toBe(false);
    retry?.click();
    await new Promise((resolve) => setTimeout(resolve, 4));
    expect(h.requests.filter((r) => r.path === "/referral")).toHaveLength(2);
  });

  it("makes exactly ONE read and adds no second referral store (Requirement 10.6)", async () => {
    h = await boot(READY);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ method: "GET", path: "/referral" });
  });
});

/* ========================================================================== *
 * The `?ref=` capture — the single permitted client-storage write
 * ========================================================================== */

describe("Referrals: the ?ref= capture (task 23.2, Requirement 1.8)", () => {
  it("captures a code from the URL into the ONE permitted key", async () => {
    h = await boot(READY, { search: "?ref=FRIEND-9" });
    const stored = JSON.parse(window.localStorage.getItem(REF_KEY) ?? "null");
    expect(stored.code).toBe("FRIEND-9");
    expect(typeof stored.capturedAt).toBe("number");
    // And nothing else, anywhere.
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("writes NO storage at all when there is no ?ref=", async () => {
    h = await boot(READY);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("leaves the theme's own wishlist key untouched (Requirement 1.8)", async () => {
    window.localStorage.setItem("shopify-wishlist", '["1001"]');
    h = await boot(READY, { search: "?ref=FRIEND-9" });
    expect(window.localStorage.getItem("shopify-wishlist")).toBe('["1001"]');
    expect(window.localStorage.length).toBe(2);
  });

  it("ignores an empty or over-long ?ref=", async () => {
    h = await boot(READY, { search: "?ref=" });
    expect(window.localStorage.getItem(REF_KEY)).toBeNull();

    h = await boot(READY, { search: `?ref=${"A".repeat(65)}` });
    expect(window.localStorage.getItem(REF_KEY)).toBeNull();
  });

  it("prefills the claim form from the capture, on wasReferred === false", async () => {
    h = await boot({ "GET /referral": ok(summary({ wasReferred: false })) }, { search: "?ref=FRIEND-9" });
    const form = h.root.querySelector("[data-portal-referral-claim]");
    expect(form?.hasAttribute("hidden")).toBe(false);
    expect(h.root.querySelector<HTMLInputElement>("input[name='referralCode']")?.value).toBe("FRIEND-9");
  });

  it("ENFORCES the 30-day expiry on read, and deletes the stale entry", async () => {
    window.localStorage.setItem(
      REF_KEY,
      JSON.stringify({ code: "OLD-CODE", capturedAt: Date.now() - 31 * DAY }),
    );
    h = await boot({ "GET /referral": ok(summary({ wasReferred: false })) });
    // Not offered...
    expect(h.root.querySelector<HTMLInputElement>("input[name='referralCode']")?.value).toBe("");
    // ...and not left to be re-parsed on every subsequent load.
    expect(window.localStorage.getItem(REF_KEY)).toBeNull();
  });

  it("accepts a capture that is still inside the window", async () => {
    window.localStorage.setItem(
      REF_KEY,
      JSON.stringify({ code: "FRESH-CODE", capturedAt: Date.now() - 29 * DAY }),
    );
    h = await boot({ "GET /referral": ok(summary({ wasReferred: false })) });
    expect(h.root.querySelector<HTMLInputElement>("input[name='referralCode']")?.value).toBe("FRESH-CODE");
  });

  it("survives a malformed stored value without throwing, and discards it", async () => {
    window.localStorage.setItem(REF_KEY, "{not json");
    h = await boot({ "GET /referral": ok(summary({ wasReferred: false })) });
    expect(h.root.getAttribute("data-state")).toBe("ready");
    expect(window.localStorage.getItem(REF_KEY)).toBeNull();
  });

  it("discards a well-formed value with a missing timestamp", async () => {
    // No `capturedAt` means the expiry can never be evaluated, so the entry is not
    // trustworthy — treating it as fresh would make the window unenforceable.
    window.localStorage.setItem(REF_KEY, JSON.stringify({ code: "NO-STAMP" }));
    h = await boot({ "GET /referral": ok(summary({ wasReferred: false })) });
    expect(h.root.querySelector<HTMLInputElement>("input[name='referralCode']")?.value).toBe("");
    expect(window.localStorage.getItem(REF_KEY)).toBeNull();
  });
});

/* ========================================================================== *
 * The claim
 * ========================================================================== */

describe("Referrals: the claim (Requirements 10.1, 16.3, 17.5)", () => {
  const claimed = (answer: unknown) => ({
    "GET /referral": ok(summary({ wasReferred: false })),
    "POST /referral": answer,
  });

  function submit(harness: Harness): void {
    harness.root.querySelector<HTMLFormElement>("[data-portal-referral-claim]")?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  }

  it("shows the form ONLY on an explicit wasReferred === false", async () => {
    h = await boot({ "GET /referral": ok(summary({ wasReferred: true })) });
    expect(h.root.querySelector("[data-portal-referral-claim]")?.hasAttribute("hidden")).toBe(true);

    // A MISSING field is not a licence to offer it either.
    h = await boot({ "GET /referral": ok(summary({ wasReferred: undefined })) });
    expect(h.root.querySelector("[data-portal-referral-claim]")?.hasAttribute("hidden")).toBe(true);

    h = await boot({ "GET /referral": ok(summary({ wasReferred: false })) });
    expect(h.root.querySelector("[data-portal-referral-claim]")?.hasAttribute("hidden")).toBe(false);
  });

  it("posts the typed code and reports success without inventing a figure", async () => {
    h = await boot(claimed(ok({ status: "rewarded", referralCode: "FRIEND-9" })));
    const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
    input.value = " friend-9 ";
    submit(h);
    await new Promise((resolve) => setTimeout(resolve, 6));

    const write = h.requests.find((r) => r.method === "POST");
    expect(write?.path).toBe("/referral");
    expect(write?.body).toEqual({ referralCode: "friend-9" });
    const said = h.announced.join(" ");
    expect(said).toContain("Code applied");
    expect(said).not.toMatch(/\d+ points/);
  });

  it("presents already_rewarded as settled, not as a failure", async () => {
    h = await boot(claimed(ok({ status: "already_rewarded", referralCode: "FRIEND-9" })));
    const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
    input.value = "FRIEND-9";
    submit(h);
    await new Promise((resolve) => setTimeout(resolve, 6));
    const said = h.announced.join(" ");
    expect(said).toContain("already applied");
    expect(said).not.toContain("could not");
  });

  it("a repeated submit sends ONE request", async () => {
    h = await boot(claimed(ok({ status: "rewarded", referralCode: "FRIEND-9" })));
    const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
    input.value = "FRIEND-9";
    submit(h);
    submit(h);
    submit(h);
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("refuses to submit an empty field, without calling the service", async () => {
    h = await boot(claimed(ok({ status: "rewarded" })));
    submit(h);
    await new Promise((resolve) => setTimeout(resolve, 4));
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(h.announced.join(" ")).toContain("Enter the code");
  });

  it("renders each determinate rejection in the customer's language", async () => {
    for (const [code, status] of [
      ["self_referral_rejected", 409],
      ["referral_already_claimed", 409],
      ["referral_not_eligible", 409],
      ["unknown_referral_code", 404],
    ] as const) {
      h = await boot(claimed(fail(code, status)));
      const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
      input.value = "FRIEND-9";
      submit(h);
      await new Promise((resolve) => setTimeout(resolve, 6));
      const message = h.root.querySelector("[data-portal-referral-claim-message]");
      expect(message?.hasAttribute("hidden"), `${code} left the message hidden`).toBe(false);
      expect(message?.textContent, `${code} was not rendered`).toBe(copy.error(code));
      // Never the server's own sentence, and never an identifier.
      expect(message?.textContent).not.toContain(code);
    }
  });

  it("CLEARS the capture on a determinate outcome — success or rejection", async () => {
    for (const answer of [
      ok({ status: "rewarded" }),
      fail("self_referral_rejected", 409),
      fail("referral_already_claimed", 409),
      fail("referral_not_eligible", 409),
      fail("unknown_referral_code", 404),
      fail("invalid_request", 400),
    ]) {
      h = await boot(claimed(answer), { search: "?ref=FRIEND-9" });
      expect(window.localStorage.getItem(REF_KEY), "capture missing before submit").not.toBeNull();
      submit(h);
      await new Promise((resolve) => setTimeout(resolve, 6));
      expect(window.localStorage.getItem(REF_KEY), "capture survived a determinate outcome").toBeNull();
    }
  });

  it("KEEPS the capture when the answer says nothing about the code", async () => {
    // A rate limit, a timeout and a 5xx are not answers about the code. Clearing
    // here would destroy the customer's one chance to apply a code they hold.
    for (const answer of [
      fail("rate_limit_exceeded", 429, { retryAfterSeconds: 30 }),
      fail("request_timeout", null),
      fail("upstream_unavailable", 502),
    ]) {
      h = await boot(claimed(answer), { search: "?ref=FRIEND-9" });
      submit(h);
      await new Promise((resolve) => setTimeout(resolve, 6));
      expect(window.localStorage.getItem(REF_KEY), "capture was cleared on an indeterminate answer").not.toBeNull();
      // And the control is usable again.
      expect(h.root.querySelector<HTMLButtonElement>("[data-portal-referral-claim-submit]")?.disabled).toBe(false);
    }
  });

  it("the submit control states its reason while in flight (§18.8)", async () => {
    h = await boot(claimed(ok({ status: "rewarded" })));
    const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
    input.value = "FRIEND-9";
    const control = h.root.querySelector<HTMLButtonElement>("[data-portal-referral-claim-submit]") as HTMLButtonElement;
    submit(h);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-label")).toContain("Applying");
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(control.disabled).toBe(false);
  });

  it("re-reads the programme after a successful claim rather than patching it", async () => {
    h = await boot(claimed(ok({ status: "rewarded" })));
    const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
    input.value = "FRIEND-9";
    submit(h);
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(h.requests.filter((r) => r.path === "/referral" && r.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("prefers what the customer TYPED over the stored capture", async () => {
    h = await boot(claimed(ok({ status: "rewarded" })), { search: "?ref=STORED-CODE" });
    const input = h.root.querySelector<HTMLInputElement>("input[name='referralCode']") as HTMLInputElement;
    // The prefill is a convenience, not a decision. A deliberate edit wins.
    input.value = "TYPED-CODE";
    submit(h);
    await new Promise((resolve) => setTimeout(resolve, 6));
    expect(h.requests.find((r) => r.method === "POST")?.body).toEqual({ referralCode: "TYPED-CODE" });
  });
});
