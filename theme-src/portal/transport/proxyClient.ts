/**
 * `transport/proxyClient.ts` — the ONLY `fetch` in the portal (spec task 18.1,
 * design §16.4, §22.3, §22.4).
 *
 * Requirements 1.6, 1.7, 1.8, 15.5, 15.7, 15.9, 8.7, 8.9.
 *
 * ── WHY EVERYTHING GOES THROUGH ONE FUNCTION ────────────────────────────────
 * Five separate guarantees are only checkable if there is one place to check:
 * the base path is relative (never the Render origin), no credential is attached,
 * a state-changing request always carries `Content-Type: application/json` and an
 * `Idempotency-Key`, the timeout budget is the right one of the two, and a failure
 * becomes an identifier rather than an exception. Spread over eleven sections,
 * each of those becomes a convention that one new call site can break silently.
 *
 * ── THE RELATIVE BASE IS A SECURITY CONTROL, NOT TIDINESS ───────────────────
 * `/apps/loyalty/v1` resolves against the storefront origin, so the request goes
 * through Shopify's App Proxy, which is what signs it and injects
 * `logged_in_customer_id`. A request to the Render origin would carry neither and
 * could not be authenticated at all — and it would send the customer's browser to
 * a third-party origin, which Requirement 1.7 forbids. There is no configuration
 * switch for this: the constant is the whole mechanism.
 *
 * ── NO CREDENTIAL IS SENT, DELIBERATELY ─────────────────────────────────────
 * No customer id, no token, no email (§3.2). The identity is established entirely
 * by the App Proxy signature. Anything this file added would be, by definition,
 * browser-supplied identity — the exact thing Requirement 1.2 and Property 7 exist
 * to reject, and the backend would ignore it anyway.
 *
 * ── NEVER FORM-ENCODED ──────────────────────────────────────────────────────
 * A cross-site HTML form can only send `application/x-www-form-urlencoded`,
 * `multipart/form-data` or `text/plain`. Because every portal write requires
 * `application/json` AND an `Idempotency-Key` header — neither producible by a
 * cross-site form — a simple-request CSRF cannot reach a handler (§5.3). That is
 * why the `Content-Type` here is a constant and not a parameter.
 *
 * SAFETY: reads no storage, writes no storage, and holds nothing across a page
 * load. `loyaltyWarm` and `sessionRef` are module-scoped and die with the page.
 */
import type { PortalErrorCode } from "../data/types.js";

/** The App Proxy subpath. Relative, always (Requirement 1.7). */
const BASE_PATH = "/apps/loyalty/v1";

/** Requirement 15.5. */
const ATTEMPT_BUDGET_MS = 8_000;

/** Requirement 15.9 — the Render cold start (§22.3). */
const COLD_START_BUDGET_MS = 60_000;

/** §22.3 — after this long on the cold-start budget, say the account is waking. */
const WAKING_AFTER_MS = 3_000;

/** §22.4 — reads retry at most twice, at these delays. */
const READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** Methods that carry a body and therefore an `Idempotency-Key`. */
const STATE_CHANGING: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE"]);

/**
 * Statuses worth retrying — a read only (§22.4).
 *
 * 502 and 503 mean "we did not get an answer"; every other 4xx/5xx we can see is
 * an answer. Note the deliberate absence of 429: retrying it deepens the limit,
 * and the wait state driven by `retryAfterSeconds` is the designed response.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503]);

/**
 * Whether the first Loyalty-backed response of this page session has arrived.
 *
 * Per page load and never stored (§22.3), so it carries no identity and cannot be
 * stale. Set on the first response of ANY status — a 500 still proves the
 * container is awake, and treating only a 200 as "warm" would give a customer who
 * hit one error a 60 s budget for the rest of the page.
 */
let loyaltyWarm = false;

/**
 * A non-identifying reference grouping this page load's requests (design §24.2).
 *
 * Random per page load, held in memory, never persisted and never derived from
 * anything about the customer — so it groups a cascade in the log stream without
 * becoming a client identifier that could be correlated across visits.
 */
const sessionRef = randomToken(8);

/** Exposed for the smoke test; there is no setter. */
export function currentSessionRef(): string {
  return sessionRef;
}

/** Test seam only: reset the page-session flag between cases. */
export function resetTransportSessionState(): void {
  loyaltyWarm = false;
}

/** Test seam only: report the flag without exposing a setter. */
export function isLoyaltyWarm(): boolean {
  return loyaltyWarm;
}

/**
 * A hex token from the platform CSPRNG, falling back to `Math.random`.
 *
 * `crypto.randomUUID` is deliberately not used: it is unavailable below Safari
 * 15.4 and the ES2019 floor (§16.7) rules out a polyfill. `getRandomValues` is
 * available everywhere in the support matrix. The fallback exists because an
 * idempotency key that cannot be minted would fail the write outright, and a
 * merely-unpredictable key is enough — the key is scoped per customer per route
 * by the server (§22.5), so it is not a secret and not a namespace others share.
 */
function randomToken(bytes: number): string {
  const source = typeof crypto !== "undefined" ? crypto : undefined;
  if (source && typeof source.getRandomValues === "function") {
    const buffer = new Uint8Array(bytes);
    source.getRandomValues(buffer);
    let out = "";
    for (let i = 0; i < buffer.length; i += 1) {
      // `padStart` is ES2017, inside the ES2019 lib floor.
      out += (buffer[i] ?? 0).toString(16).padStart(2, "0");
    }
    return out;
  }
  let out = "";
  while (out.length < bytes * 2) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, bytes * 2);
}

/** A fresh `Idempotency-Key`: within the server's 1–128 character bound. */
export function newIdempotencyKey(): string {
  return `p-${randomToken(16)}`;
}

/**
 * `METHOD path?sortedQuery` — the identity of a resource for §16.5's cache.
 *
 * Keys are SORTED so `?a=1&b=2` and `?b=2&a=1` are one resource. Without that,
 * Overview and the Orders tile asking for the same page in a different order
 * would be two Shopify reads, which is the exact duplication §16.5 exists to
 * remove.
 */
export function cacheKeyFor(spec: PortalRequestSpec): string {
  return `${spec.method} ${spec.path}${serialiseQuery(spec.query)}`;
}

function serialiseQuery(query: PortalRequestSpec["query"]): string {
  if (!query) return "";
  const names = Object.keys(query).sort();
  if (names.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === undefined) continue;
    const value = query[name];
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** The budget for one attempt (§22.3). */
function budgetFor(target: PortalUpstream): number {
  return target === "loyalty" && !loyaltyWarm ? COLD_START_BUDGET_MS : ATTEMPT_BUDGET_MS;
}

/**
 * The failure identifier for a status the service answered with.
 *
 * The BODY's `error` is preferred when it is present, because the service already
 * chose the identifier and second-guessing it here would create two vocabularies
 * for one condition. This mapping is the fallback for a response whose body could
 * not be read — a proxy error page, a truncated response — where the status is all
 * we have.
 */
function codeForStatus(status: number): PortalFailure["code"] {
  if (status === 401) return "identity_resolution_failed";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 400) return "invalid_request";
  if (status >= 500) return "upstream_unavailable";
  return "invalid_request";
}

/**
 * Whether offering a retry can plausibly help (§22.9).
 *
 * A determinate answer is not retryable: the same request produces the same
 * answer, and a retry control that changes nothing reads as an unreliable service.
 */
function isRetryable(status: number | null, code: PortalFailure["code"]): boolean {
  if (code === "network_unavailable" || code === "request_timeout") return true;
  if (status === null) return true;
  return RETRYABLE_STATUSES.has(status);
}

interface ErrorBodyShape {
  error?: unknown;
  fields?: unknown;
  retryAfterSeconds?: unknown;
  allowedFrom?: unknown;
}

/**
 * Build a failure from a response, taking the identifier from the body when the
 * service supplied one and NEVER taking the body's `message`.
 *
 * The `message` is dropped on purpose. It is a customer-safe fallback, not the
 * rendered sentence: the client owns the wording via `ui/copy.ts` keyed on the
 * identifier (design E.1 rule 3, §16.9). Passing it through would make the
 * service's wording appear in the UI and quietly defeat the split that lets a
 * future mobile app use its own.
 */
function failureFromBody(
  status: number,
  requestId: string | null,
  body: unknown,
): PortalFailure {
  const shape = (body ?? {}) as ErrorBodyShape;
  const declared = typeof shape.error === "string" ? shape.error : null;
  const code = (declared ?? codeForStatus(status)) as PortalFailure["code"];
  const failure: {
    code: PortalFailure["code"];
    status: number;
    requestId: string | null;
    retryable: boolean;
    fields?: readonly { field: string; code: string }[];
    retryAfterSeconds?: number;
    allowedFrom?: string;
  } = {
    code,
    status,
    requestId,
    retryable: isRetryable(status, code),
  };
  if (Array.isArray(shape.fields)) {
    const fields: { field: string; code: string }[] = [];
    for (let i = 0; i < shape.fields.length; i += 1) {
      const entry = shape.fields[i] as { field?: unknown; code?: unknown } | undefined;
      if (!entry) continue;
      fields.push({
        field: typeof entry.field === "string" ? entry.field : "",
        code: typeof entry.code === "string" ? entry.code : "rejected",
      });
    }
    failure.fields = fields;
  }
  if (typeof shape.retryAfterSeconds === "number") {
    failure.retryAfterSeconds = shape.retryAfterSeconds;
  }
  if (typeof shape.allowedFrom === "string") {
    failure.allowedFrom = shape.allowedFrom;
  }
  return failure as PortalFailure;
}

/** One attempt. Resolves a result; rejects only for a genuine programming fault. */
async function attempt<T>(
  spec: PortalRequestSpec,
  idempotencyKey: string | null,
): Promise<PortalResult<T>> {
  const target = spec.target ?? "loyalty";
  const budget = budgetFor(target);
  const controller = new AbortController();

  let wakingTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => controller.abort(), budget);
  // The waking state belongs to the cold-start budget only (§22.3).
  if (budget === COLD_START_BUDGET_MS && spec.onWaking) {
    const notify = spec.onWaking;
    wakingTimer = setTimeout(() => notify(), WAKING_AFTER_MS);
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    // Groups this page load's requests in the log stream (§24.2). Non-identifying.
    "x-athoor-session-ref": sessionRef,
  };
  if (STATE_CHANGING.has(spec.method)) {
    headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  }

  const url = `${BASE_PATH}${spec.path}${serialiseQuery(spec.query)}`;

  try {
    const response = await fetch(url, {
      method: spec.method,
      headers,
      // No cookies are read by our backend, and sending them would attach
      // ambient authority to a request whose only authority is the proxy
      // signature. `same-origin` is the default; stating it makes the choice
      // reviewable rather than inherited.
      credentials: "same-origin",
      // Never a cached read: a balance served from the HTTP cache would be
      // indistinguishable from a fresh one and could contradict §16.5's TTL.
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    });

    // ANY response proves the container is awake (§22.3).
    if (target === "loyalty") loyaltyWarm = true;

    const requestId = response.headers.get("x-request-id");

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A body that is not JSON is not an exception to propagate. Every portal
      // response is JSON, so this is a proxy page or a truncated response, and
      // the status still tells us what to render.
      body = null;
    }

    if (!response.ok) {
      return { ok: false, error: failureFromBody(response.status, requestId, body) };
    }
    // ── A SUCCESS STATUS IS NOT A USABLE ANSWER ON ITS OWN ────────────────────
    // The `catch` above is right for a FAILURE status: a 500 carrying an HTML
    // error page tells us what to render from the status alone. It is wrong for a
    // success status. `body` is still `null` there, and `null as T` hands the
    // section a value its DTO forbids — so `paintBirthday` reads `.day` off
    // nothing and throws.
    //
    // That throw is not caught. Every section's boot ends in `void load()`, so the
    // rejection surfaces AFTER the task-18.7 error boundary's `try` has already
    // returned. The section is left in `loading` for ever: no error state, no
    // retry, no announcement. A blank panel that never resolves is the worst of
    // §18.8's outcomes, because it is the one the customer cannot act on.
    //
    // The check is on the VALUE, not on whether parsing threw. `JSON.parse("null")`
    // returns `null` without throwing, and a bare `"text"` or `42` parses cleanly
    // while satisfying no response contract. Every portal response DTO is an
    // `interface` — a JSON object — so a non-object success body is unusable by
    // definition. Verified: no portal route answers 204 or an empty body, and no
    // response type is aliased to an array or a primitive.
    if (body === null || typeof body !== "object") {
      return {
        ok: false,
        error: {
          // The established code for "we could not obtain the data" — the same one
          // `codeForStatus` gives a 5xx. Its wording ("That part of your account is
          // not available just now.") is true here: we reached the service, and we
          // still have nothing to show.
          code: "upstream_unavailable",
          // The REAL status, not `null`. `stateForFailure` maps `null` to `offline`
          // when `navigator.onLine` is false, which would tell a customer they are
          // offline immediately after we demonstrably reached the server. Reporting
          // 200 keeps the claim true and yields the `error` state instead.
          status: response.status,
          requestId,
          // Not derived from the status: `isRetryable` would return false for 200.
          // A truncated or proxy-substituted body is plausibly transient, and every
          // mutation already carries an Idempotency-Key, so offering the retry is
          // both useful and safe.
          retryable: true,
        },
      };
    }
    return { ok: true, value: body as T, requestId };
  } catch (err) {
    // `loyaltyWarm` is DELIBERATELY NOT SET HERE. §22.3 sets it "on the first
    // response of any status", and a timeout or a network failure is not a
    // response — nothing was learned about whether the container is awake.
    //
    // The consequence is accepted: a cold start that exhausts the 60 s budget
    // gives its automatic retry another 60 s. The alternative — treating a
    // timeout as proof of warmth — would hand the retry an 8 s budget on the one
    // occasion we have positive evidence the service is slow, which is the wrong
    // way round.
    //
    // An abort is our own timeout: `signal` has no other source here.
    const aborted = isAbort(err);
    const code: PortalFailure["code"] = aborted ? "request_timeout" : "network_unavailable";
    return {
      ok: false,
      error: { code, status: null, requestId: null, retryable: true },
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (wakingTimer !== undefined) clearTimeout(wakingTimer);
  }
}

/**
 * Whether a thrown value is an abort.
 *
 * Matched on `name`, not `instanceof DOMException`: jsdom and some browsers throw
 * shapes that are not the same class, and a false negative here would report our
 * own timeout as a network failure — which retries with a different delay and
 * reports different copy.
 */
function isAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The portal's request function (design §16.4).
 *
 * Retry policy, exactly as §22.4 states it:
 *   - a READ retries at most twice, after 1 s then 3 s, and only for a network
 *     failure, a timeout, a 502 or a 503;
 *   - a WRITE is never retried automatically EXCEPT on network failure or
 *     timeout, where the retry carries the SAME `Idempotency-Key` so the server
 *     replays rather than repeats (Requirement 8.9). A fresh submission mints a
 *     new key by not passing `idempotencyKey`.
 */
export async function proxyFetch<T>(spec: PortalRequestSpec): Promise<PortalResult<T>> {
  const stateChanging = STATE_CHANGING.has(spec.method);
  // One key per INTENT. Minted once, outside the retry loop, so every retry of
  // this intent carries the same one.
  const idempotencyKey = stateChanging
    ? (spec.idempotencyKey ?? newIdempotencyKey())
    : null;

  let result = await attempt<T>(spec, idempotencyKey);
  if (result.ok) return result;

  for (let i = 0; i < READ_RETRY_DELAYS_MS.length; i += 1) {
    const failure = result.error;
    const noAnswer = failure.status === null;
    // A write retries only when we never got an answer; a read also retries a
    // 502/503. Anything determinate stops here.
    const mayRetry = stateChanging ? noAnswer : noAnswer || RETRYABLE_STATUSES.has(failure.status);
    if (!mayRetry) return result;

    await delay(READ_RETRY_DELAYS_MS[i] ?? 0);
    result = await attempt<T>(spec, idempotencyKey);
    if (result.ok) return result;
  }
  return result;
}
