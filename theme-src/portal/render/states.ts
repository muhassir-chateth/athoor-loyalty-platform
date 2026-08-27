/**
 * `render/states.ts` — the eight designed states (spec task 18.3, design §16.3,
 * §18.8, §22.9).
 *
 * Requirements 16.1–16.8, 15.2, 15.7.
 *
 * ── THE STATE IS AN ATTRIBUTE, NOT A VARIABLE ───────────────────────────────
 * `data-state` on the section root IS the state (design §16.3). A section reads
 * its own state back from the DOM rather than from a module variable, so the
 * accessibility attributes and the state machine are one representation instead of
 * two that can disagree. CSS selects on the same attribute, which is why no state
 * needs a class as well.
 *
 * ── WHY EIGHT AND NOT "AN ERROR STATE" ──────────────────────────────────────
 * §18.8 enumerates eight because they call for different things from the customer.
 * Offline and session-expired both mean "your input is safe" but only one is
 * fixed by signing in; degraded and error differ on whether anything changed;
 * disabled must state WHY or it reads as a bug. Collapsing them is how an account
 * area ends up saying "Something went wrong" — a string Requirement 16.8 forbids
 * outright, and which this module cannot produce because the wording comes from
 * `ui/copy.ts` keyed on the state name.
 *
 * ── A RETRY IS OFFERED ONLY WHERE IT CAN HELP (§22.9) ───────────────────────
 * Retry is rendered from `failure.retryable`, which is false for a determinate
 * answer. A retry button on a 404 is worse than no button: it invites the customer
 * to conclude the service is unreliable when the answer was correct and final.
 *
 * SAFETY: DOM only. No network, no storage. Every value written with
 * `textContent`, never `innerHTML` (§5.3), so nothing derived from an API response
 * or customer input can become markup.
 */
import * as copy from "../ui/copy.js";
import { polite, assertive } from "../ui/announce.js";

/** The vocabulary. Eight values, deliberately without an "unknown". */
export const STATES: readonly PortalSectionState[] = [
  "loading",
  "empty",
  "ready",
  "error",
  "disabled",
  "offline",
  "session-expired",
  "degraded",
];

const STATE_ATTRIBUTE = "data-state";

/** Where a state's prose is rendered, if the section provides the slot. */
const MESSAGE_SELECTOR = "[data-portal-state-message]";

/** Where the retry control is rendered, if the section provides the slot. */
const RETRY_SELECTOR = "[data-portal-retry]";

/** Where §22.9's request reference is rendered, if the section provides the slot. */
const REFERENCE_SELECTOR = "[data-portal-reference]";

/**
 * The states whose failure is worth announcing ASSERTIVELY.
 *
 * §20.6 reserves `assertive` for a failure that stops the flow the customer is
 * in. A degraded section is not that — the customer can keep reading the rest of
 * the page — so it is announced politely. A hard error in the flow they are in is.
 */
const ASSERTIVE_STATES: ReadonlySet<PortalSectionState> = new Set(["error"]);

/**
 * §22.9 — the reference is SHORTENED to eight characters.
 *
 * Eight is what a customer can read down a phone line without transcribing a
 * UUID, and it is enough for an operator to find the request in the log stream.
 * The full id is still in the response header for anyone with the network tab.
 */
function shortReference(requestId: string | null): string {
  if (!requestId) return "";
  return requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
}

/** Read the state back from the DOM (§16.3). */
export function current(root: HTMLElement): PortalSectionState | null {
  const value = root.getAttribute(STATE_ATTRIBUTE);
  if (!value) return null;
  for (let i = 0; i < STATES.length; i += 1) {
    if (STATES[i] === value) return STATES[i] as PortalSectionState;
  }
  return null;
}

/**
 * Render a state onto a root.
 *
 * `aria-busy` is set only for `loading`, because that is the one state where the
 * content is genuinely mid-change; leaving it set on a degraded section would tell
 * a screen reader to keep waiting for something that is not coming.
 */
export function set(
  root: HTMLElement,
  state: PortalSectionState,
  options: PortalStateOptions = {},
): void {
  root.setAttribute(STATE_ATTRIBUTE, state);
  if (state === "loading") {
    root.setAttribute("aria-busy", "true");
  } else {
    root.removeAttribute("aria-busy");
  }

  const message = messageFor(state, options);
  const slot = root.querySelector(MESSAGE_SELECTOR);
  if (slot) {
    // `textContent`, never `innerHTML` (§5.3). A product title carrying
    // `<img onerror>` therefore creates no element.
    slot.textContent = message;
  }

  renderReference(root, options);
  renderRetry(root, options);

  // Nothing is announced for a change the customer did not cause (§20.6), so an
  // announcement happens only when the caller asks for one or the state is a
  // failure the customer is waiting on.
  const announcement = options.announce ?? (state === "ready" ? "" : message);
  if (announcement) {
    if (ASSERTIVE_STATES.has(state)) assertive(root, announcement);
    else polite(root, announcement);
  }
}

/**
 * The prose for a state.
 *
 * A `disabled` state MUST state why (§18.8), so a caller that omits the reason
 * gets the generic disabled wording rather than an empty box — visibly disabled
 * with no explanation is the failure mode the requirement names.
 */
function messageFor(state: PortalSectionState, options: PortalStateOptions): string {
  if (state === "disabled" && options.reason) return options.reason;
  if ((state === "error" || state === "degraded") && options.failure) {
    return copy.error(options.failure.code);
  }
  return copy.state(state);
}

function renderReference(root: HTMLElement, options: PortalStateOptions): void {
  const slot = root.querySelector(REFERENCE_SELECTOR);
  if (!slot) return;
  const reference = shortReference(options.failure?.requestId ?? null);
  if (!reference) {
    slot.textContent = "";
    slot.setAttribute("hidden", "hidden");
    return;
  }
  slot.removeAttribute("hidden");
  slot.textContent = `Reference ${reference}`;
}

/**
 * Show or hide the retry control, and bind it to THIS section's loader.
 *
 * The handler is replaced wholesale via `onclick` rather than accumulated with
 * `addEventListener`, because a section that re-renders its error state three
 * times would otherwise fire three loads from one press. It is bound on the
 * control inside the root — never on `document` (§16.10).
 */
function renderRetry(root: HTMLElement, options: PortalStateOptions): void {
  const control = root.querySelector<HTMLButtonElement>(RETRY_SELECTOR);
  if (!control) return;
  const retry = options.retry;
  const helpful = retry !== undefined && (options.failure?.retryable ?? true);
  if (!helpful) {
    control.setAttribute("hidden", "hidden");
    control.onclick = null;
    return;
  }
  control.removeAttribute("hidden");
  control.onclick = () => retry();
}

/**
 * Map a failure onto the right state and render it.
 *
 * The three special cases are the ones §18.8 designs separately:
 *   - an authentication failure is `session-expired`, not an error, because the
 *     customer's input is intact and the next action is to sign in;
 *   - no answer at all while the browser reports itself offline is `offline`,
 *     for the same reason and a different next action;
 *   - everything else upstream is `degraded`, which states that nothing changed.
 */
export function degrade(root: HTMLElement, failure: PortalFailure, retry?: () => void): void {
  const state = stateForFailure(failure);
  const options: PortalStateOptions = {
    failure,
    ...(retry === undefined ? {} : { retry }),
  };
  set(root, state, options);
}

function stateForFailure(failure: PortalFailure): PortalSectionState {
  if (
    failure.code === "identity_resolution_failed" ||
    failure.code === "app_proxy_signature_invalid" ||
    failure.code === "app_proxy_verification_unavailable" ||
    failure.code === "app_proxy_request_expired"
  ) {
    return "session-expired";
  }
  if (failure.status === null) {
    // `navigator.onLine` is only trustworthy when it says FALSE: true means "a
    // network interface exists", which is not the same as reachability. So it is
    // used only to choose the offline wording, never to skip a request.
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (offline) return "offline";
    return "degraded";
  }
  if (failure.status >= 500) return "degraded";
  return "error";
}
