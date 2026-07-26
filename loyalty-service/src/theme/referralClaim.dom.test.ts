// @vitest-environment jsdom
/**
 * Referral claim flow — BEHAVIOURAL tests of the shipped theme script
 * (docs/ops/referral-claim-proposal.md).
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT ANOTHER SOURCE-GREP: the sibling
 * `referralCodeSource.test.ts` reads theme text, which can prove a fabrication
 * is gone but can prove nothing about behaviour. The claim flow is all
 * behaviour — which response maps to which message, what stays usable, what is
 * disabled, what headers the request carries, what happens on a double-click —
 * so these tests build a real DOM, stub `window.fetch`, and then EXECUTE
 * `theme/assets/athoor-loyalty.js` itself, read from disk. There is no copy of
 * the script here: if the shipped file changes, these tests change with it.
 *
 * The strings the assertions expect are read from `theme/locales/en.default.json`
 * (the only locale carrying the `loyalty.*` block) and injected exactly as the
 * Liquid `data-loyalty-strings` block injects them, so a copy change in the
 * locale file cannot silently diverge from what the script writes.
 *
 * SCOPE LIMIT, stated plainly: jsdom is not a browser and this is not the
 * rendered storefront. The staging storefront returns `302 → /password` and the
 * staging Admin token lacks `read_themes`, so no rendered page can be reached
 * and no theme can be pushed. The `POST /v1/referral` CONTRACT was verified live
 * against the deployed service with signed App Proxy requests; everything about
 * the theme's behaviour is covered here and nowhere else.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** repo-root/theme (this file lives at repo-root/loyalty-service/src/theme). */
const THEME_DIR = join(__dirname, "..", "..", "..", "theme");
const SCRIPT_PATH = join(THEME_DIR, "assets", "athoor-loyalty.js");
const DASHBOARD_PATH = join(THEME_DIR, "sections", "loyalty-dashboard.liquid");
const LOCALE_PATH = join(THEME_DIR, "locales", "en.default.json");

/** The shipped script, executed verbatim by every test below. */
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");
const DASHBOARD_SOURCE = readFileSync(DASHBOARD_PATH, "utf8");

/**
 * Shopify locale files open with an auto-generated comment banner, so they are
 * not strict JSON. Strip it, then read the real copy.
 */
function readLocale(): Record<string, any> {
  const raw = readFileSync(LOCALE_PATH, "utf8");
  return JSON.parse(raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
}

const REFERRAL_COPY = readLocale().loyalty.referral as Record<string, string>;

/** The claim copy, keyed exactly as the script's `t()` keys. */
const COPY = {
  claim_success: REFERRAL_COPY.claim_success,
  claim_already: REFERRAL_COPY.claim_already,
  claim_self: REFERRAL_COPY.claim_self,
  claim_unknown: REFERRAL_COPY.claim_unknown,
  claim_ineligible: REFERRAL_COPY.claim_ineligible,
  claim_invalid: REFERRAL_COPY.claim_invalid,
  claim_failed: REFERRAL_COPY.claim_failed,
};

/**
 * The dashboard fixture: the root, the two JSON blocks and the claim markup —
 * the same `data-loyalty` hooks the Liquid section renders (asserted below, so
 * this fixture cannot drift from the shipped markup).
 */
function fixture(): string {
  return `
<div class="loyalty-dashboard" data-loyalty-dashboard data-loyalty-customer="true" data-loyalty-proxy-base="/apps/loyalty">
  <script type="application/json" data-loyalty-config>
    {"proxyBase":"/apps/loyalty","loggedIn":true,"customerId":123,"currency":"GBP","timeoutMs":3000,"cacheAvailable":true}
  </script>
  <script type="application/json" data-loyalty-strings>
    ${JSON.stringify(COPY)}
  </script>
  <div class="loyalty-error-state" data-loyalty="error-state" role="status" aria-live="polite" hidden></div>
  <div class="referral-section">
    <div class="referral-code">
      <span id="ref-code" data-loyalty="referral-code" data-loyalty-code-pending="true">${REFERRAL_COPY.code_pending}</span>
      <button type="button" data-loyalty="referral-copy" disabled>Copy</button>
    </div>
    <form class="referral-claim" data-loyalty="referral-claim" novalidate hidden>
      <p><label for="referral-claim-input">${REFERRAL_COPY.claim_label}</label></p>
      <div class="referral-code">
        <input id="referral-claim-input" name="referralCode" type="text" maxlength="64" required
               data-loyalty="referral-claim-input" aria-describedby="referral-claim-status">
        <button type="submit" data-loyalty="referral-claim-submit">${REFERRAL_COPY.claim_submit}</button>
      </div>
      <p id="referral-claim-status" data-loyalty="referral-claim-status" role="status" aria-live="polite"></p>
    </form>
  </div>
</div>`;
}

/** A minimal `Response`-like object for the fetch stub. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** A non-OK response whose body is NOT JSON — the defensive-parse case. */
function brokenBodyResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  };
}

interface Routes {
  /** `GET /v1/referral` payload, or a rejection when `null`. */
  referral?: unknown | null;
  /** Handler for `POST /v1/referral`. */
  claim?: (init: RequestInit) => Promise<unknown>;
}

type FetchCall = [string, RequestInit];

/**
 * Installs the fetch stub, renders the fixture and EXECUTES the shipped script.
 * Returns the recorded fetch calls so a test can assert on the real request.
 */
async function boot(routes: Routes): Promise<{ calls: FetchCall[] }> {
  const calls: FetchCall[] = [];
  const fetchStub = vi.fn((url: string, init: RequestInit = {}) => {
    calls.push([url, init]);
    const method = (init.method ?? "GET").toUpperCase();

    if (url.endsWith("/v1/referral") && method === "GET") {
      if (routes.referral === null || routes.referral === undefined) {
        return Promise.reject(new TypeError("network error"));
      }
      return Promise.resolve(jsonResponse(200, routes.referral));
    }
    if (url.endsWith("/v1/referral") && method === "POST") {
      if (!routes.claim) return Promise.reject(new TypeError("network error"));
      return routes.claim(init);
    }
    // The other dashboard reads are not under test here; answer them plausibly
    // so the script's other sections behave exactly as they do in production.
    if (url.includes("/v1/balance")) {
      return Promise.resolve(jsonResponse(200, { spendableBalance: 250, tier: "bronze" }));
    }
    if (url.includes("/v1/history")) {
      return Promise.resolve(jsonResponse(200, { entries: [] }));
    }
    if (url.includes("/v1/profile/visit")) {
      return Promise.resolve(jsonResponse(200, { firstVisit: false }));
    }
    return Promise.reject(new TypeError("unexpected url " + url));
  });

  (window as any).fetch = fetchStub;
  document.body.innerHTML = fixture();

  // Execute the shipped file. `document` / `window` resolve to jsdom's globals,
  // so this is the real script running against a real DOM.
  new Function(SCRIPT_SOURCE)();

  await flush();
  return { calls };
}

/** Drain the microtask/macrotask queues so fetch chains settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const form = () => document.querySelector('[data-loyalty="referral-claim"]') as HTMLFormElement;
const input = () =>
  document.querySelector('[data-loyalty="referral-claim-input"]') as HTMLInputElement;
const submitBtn = () =>
  document.querySelector('[data-loyalty="referral-claim-submit"]') as HTMLButtonElement;
const statusEl = () =>
  document.querySelector('[data-loyalty="referral-claim-status"]') as HTMLParagraphElement;

/** Submits the form the way a member's click does (the form owns the handler). */
function submitForm(): void {
  form().dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

/** Types a code and submits, then lets the request settle. */
async function claim(code: string): Promise<void> {
  input().value = code;
  submitForm();
  await flush();
}

/** POST calls to the claim endpoint, in order. */
function postCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter(
    ([url, init]) => url.endsWith("/v1/referral") && (init.method ?? "GET").toUpperCase() === "POST",
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the fixture matches the shipped Liquid markup", () => {
  // The DOM tests are only meaningful if the hooks they drive are the hooks the
  // section actually renders. Asserted here so the fixture cannot drift.
  it.each([
    "referral-claim",
    "referral-claim-input",
    "referral-claim-submit",
    "referral-claim-status",
  ])('loyalty-dashboard.liquid renders data-loyalty="%s"', (hook) => {
    expect(DASHBOARD_SOURCE).toContain(`data-loyalty="${hook}"`);
  });

  it("renders the claim form HIDDEN (Liquid cannot know wasReferred)", () => {
    const formMarkup = /<form[^>]*data-loyalty="referral-claim"[^>]*>/.exec(DASHBOARD_SOURCE)?.[0];
    expect(formMarkup).toBeDefined();
    expect(formMarkup).toMatch(/\bhidden\b/);
  });

  it("sources every claim string from the locale file, not hardcoded English", () => {
    for (const key of Object.keys(COPY)) {
      expect(COPY[key as keyof typeof COPY]).toBeTruthy();
      expect(DASHBOARD_SOURCE).toContain(`'loyalty.referral.${key}' | t`);
    }
    expect(DASHBOARD_SOURCE).toContain("'loyalty.referral.claim_label' | t");
    expect(DASHBOARD_SOURCE).toContain("'loyalty.referral.claim_submit' | t");
  });
});

describe("reveal: the form appears only for a member with no referrer", () => {
  it("is revealed when wasReferred === false", async () => {
    await boot({ referral: { referralCode: "ATH-AAAA-BBBB", wasReferred: false } });
    expect(form().hidden).toBe(false);
  });

  it("stays hidden when wasReferred === true", async () => {
    await boot({ referral: { referralCode: "ATH-AAAA-BBBB", wasReferred: true } });
    expect(form().hidden).toBe(true);
  });

  it("stays hidden when GET /v1/referral fails (no guessing the referred state)", async () => {
    await boot({ referral: null });
    expect(form().hidden).toBe(true);
  });

  it("stays hidden when wasReferred is absent from the payload", async () => {
    await boot({ referral: { referralCode: "ATH-AAAA-BBBB" } });
    expect(form().hidden).toBe(true);
  });

  it("stays hidden when wasReferred is a truthy non-boolean", async () => {
    await boot({ referral: { referralCode: "ATH-AAAA-BBBB", wasReferred: "false" } });
    expect(form().hidden).toBe(true);
  });
});

describe("the request itself", () => {
  it("carries Idempotency-Key, Content-Type: application/json and the TRIMMED code", async () => {
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "rewarded" })),
    });

    await claim("  ath-friend-0002  ");

    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0];
    expect(url).toBe("/apps/loyalty/v1/referral");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(typeof headers["Idempotency-Key"]).toBe("string");
    expect(headers["Idempotency-Key"].length).toBeGreaterThan(0);
    expect(headers["Idempotency-Key"].length).toBeLessThanOrEqual(128);
    // Prefixed per operation, so a claim key can never collide with a visit key.
    expect(headers["Idempotency-Key"]).toMatch(/^claim-/);
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({ referralCode: "ath-friend-0002" });
  });

  it("sends NO customer id, email or token — identity comes from the App Proxy", async () => {
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "rewarded" })),
    });
    await claim("ATH-FRIEND-0002");

    const [, init] = postCalls(calls)[0];
    expect(JSON.parse(String(init.body))).toEqual({ referralCode: "ATH-FRIEND-0002" });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "Accept",
      "Content-Type",
      "Idempotency-Key",
    ]);
  });

  it("keeps the no-body /v1/profile/visit call exactly as it was", async () => {
    const { calls } = await boot({ referral: { wasReferred: true } });
    const visit = calls.find(([url]) => url.includes("/v1/profile/visit"));
    expect(visit).toBeDefined();
    const [, init] = visit as FetchCall;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["Idempotency-Key"]).toMatch(/^visit-/);
  });

  it("submits nothing for an empty or whitespace-only input", async () => {
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "rewarded" })),
    });

    await claim("");
    await claim("   ");
    await claim("\t\n ");

    expect(postCalls(calls)).toHaveLength(0);
    expect(statusEl().textContent).toBe(""); // Nothing to report yet.
    expect(submitBtn().disabled).toBe(false);
  });

  it("rejects a >64 char code locally, without a request", async () => {
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "rewarded" })),
    });

    await claim("X".repeat(65));

    expect(postCalls(calls)).toHaveLength(0);
    expect(statusEl().textContent).toBe(COPY.claim_invalid);
    expect(submitBtn().disabled).toBe(false); // Correctable.
  });
});

describe("success states", () => {
  it("200 rewarded → success copy, input and button disabled permanently", async () => {
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "rewarded" })),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_success);
    expect(input().disabled).toBe(true);
    expect(submitBtn().disabled).toBe(true);

    // Permanently: a further submit changes nothing and sends nothing.
    await claim("ATH-OTHER-0003");
    expect(postCalls(calls)).toHaveLength(1);
    expect(submitBtn().disabled).toBe(true);
  });

  it("200 already_rewarded is treated as success, not an error, and also disables", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "already_rewarded" })),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_already);
    expect(statusEl().textContent).not.toBe(COPY.claim_failed);
    expect(input().disabled).toBe(true);
    expect(submitBtn().disabled).toBe(true);
  });
});

describe("error states, each distinguished from the others", () => {
  it("409 self_referral_rejected → its own message, form stays usable", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () =>
        Promise.resolve(jsonResponse(409, { error: "self_referral_rejected", message: "no" })),
    });

    await claim("ATH-MINE-0001");

    expect(statusEl().textContent).toBe(COPY.claim_self);
    expect(input().disabled).toBe(false);
    expect(submitBtn().disabled).toBe(false);
  });

  it("404 unknown_referral_code → its own message, value retained so a typo can be fixed", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () =>
        Promise.resolve(jsonResponse(404, { error: "unknown_referral_code", message: "no" })),
    });

    await claim("ATH-TYP0-0002");

    expect(statusEl().textContent).toBe(COPY.claim_unknown);
    expect(input().value).toBe("ATH-TYP0-0002");
    expect(input().disabled).toBe(false);
    expect(submitBtn().disabled).toBe(false);
  });

  it("409 referral_not_eligible → its own message, form DISABLED (it can never succeed)", async () => {
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () =>
        Promise.resolve(jsonResponse(409, { error: "referral_not_eligible", message: "no" })),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_ineligible);
    expect(input().disabled).toBe(true);
    expect(submitBtn().disabled).toBe(true);

    await claim("ATH-FRIEND-0002");
    expect(postCalls(calls)).toHaveLength(1);
  });

  it("400 invalid_request → validation message, form stays usable", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(400, { error: "invalid_request", message: "no" })),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_invalid);
    expect(input().disabled).toBe(false);
    expect(submitBtn().disabled).toBe(false);
  });

  it("the four error states produce four DIFFERENT messages", () => {
    const messages = [COPY.claim_self, COPY.claim_unknown, COPY.claim_ineligible, COPY.claim_invalid];
    expect(new Set(messages).size).toBe(4);
    expect(messages).not.toContain(COPY.claim_failed);
  });

  it("a network failure → neutral message, form stays usable", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_failed);
    expect(input().disabled).toBe(false);
    expect(submitBtn().disabled).toBe(false);
  });

  it("an unmapped status (500) → neutral message, form stays usable", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(500, { error: "internal_error" })),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_failed);
    expect(submitBtn().disabled).toBe(false);
  });

  it("a non-JSON error body still rejects cleanly with the neutral message", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(brokenBodyResponse(502)),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_failed);
    expect(submitBtn().disabled).toBe(false);
  });

  it("a 200 with an unrecognised status is reported neutrally, never echoed", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "something_new" })),
    });

    await claim("ATH-FRIEND-0002");

    expect(statusEl().textContent).toBe(COPY.claim_failed);
    expect(document.body.textContent).not.toContain("something_new");
  });
});

describe("one submission per press", () => {
  it("disables the button for the duration of the request and re-enables it after a failure", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });

    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => pending.then(() => jsonResponse(409, { error: "self_referral_rejected" })),
    });

    input().value = "ATH-MINE-0001";
    submitForm();
    await flush(1);

    // In flight: the control is disabled and announced as disabled.
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().getAttribute("aria-disabled")).toBe("true");

    release(null);
    await flush();

    // Recoverable failure: usable again, and no longer announced as disabled.
    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().getAttribute("aria-disabled")).toBeNull();
    expect(statusEl().textContent).toBe(COPY.claim_self);
  });

  it("two rapid submits produce exactly ONE in-flight request", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });

    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => pending.then(() => jsonResponse(200, { status: "rewarded" })),
    });

    input().value = "ATH-FRIEND-0002";
    submitForm();
    submitForm(); // double-click, same submission
    submitForm();

    expect(postCalls(calls)).toHaveLength(1);

    release(null);
    await flush();
    expect(postCalls(calls)).toHaveLength(1);
    expect(statusEl().textContent).toBe(COPY.claim_success);
  });

  it("a retry after a genuine failure is a NEW operation with a NEW key", async () => {
    let attempt = 0;
    const { calls } = await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(jsonResponse(200, { status: "rewarded" }));
      },
    });

    await claim("ATH-FRIEND-0002");
    expect(statusEl().textContent).toBe(COPY.claim_failed);
    await claim("ATH-FRIEND-0002");
    expect(statusEl().textContent).toBe(COPY.claim_success);

    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    const keys = posts.map(([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("nothing is ever fabricated", () => {
  it("writes no code of its own and echoes no raw status or error token", async () => {
    await boot({
      referral: { referralCode: "ATH-REAL-CODE", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(200, { status: "rewarded", referralCode: "x" })),
    });

    await claim("ATH-FRIEND-0002");

    const text = document.body.textContent ?? "";
    // The member's own code is the API's value, verbatim.
    expect(
      document.querySelector('[data-loyalty="referral-code"]')?.textContent,
    ).toBe("ATH-REAL-CODE");
    expect(text).not.toContain("ATHOOR-");
    for (const token of [
      "rewarded",
      "already_rewarded",
      "self_referral_rejected",
      "unknown_referral_code",
      "referral_not_eligible",
      "invalid_request",
      "HTTP 4",
      "HTTP 5",
    ]) {
      expect(text).not.toContain(token);
    }
  });

  it("leaves the referral code placeholder untouched when the API says nothing", async () => {
    await boot({ referral: null });
    const el = document.querySelector('[data-loyalty="referral-code"]') as HTMLElement;
    expect(el.textContent).toBe(REFERRAL_COPY.code_pending);
    expect(el.hasAttribute("data-loyalty-code-pending")).toBe(true);
    expect(statusEl().textContent).toBe("");
  });

  it("shows one of the locale strings and nothing else in the status element", async () => {
    await boot({
      referral: { referralCode: "ATH-MINE-0001", wasReferred: false },
      claim: () => Promise.resolve(jsonResponse(404, { error: "unknown_referral_code" })),
    });
    await claim("nope");
    expect(Object.values(COPY)).toContain(statusEl().textContent);
  });
});
