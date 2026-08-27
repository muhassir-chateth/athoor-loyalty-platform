/**
 * `ui/announce.ts` — live-region announcements (spec task 18.4, design §20.6).
 *
 * Requirements 17.5, 17.7.
 *
 * ── THE REGION MUST ALREADY EXIST ───────────────────────────────────────────
 * §20.6: "the region exists in the DOM from the server render (a region injected
 * at announcement time is not reliably announced)". Screen readers subscribe to a
 * live region when it enters the accessibility tree; a region created and filled in
 * the same task is frequently missed entirely. So this module FINDS regions and
 * never creates them — and when one is absent it does nothing rather than inject a
 * substitute that would appear to work in a test and fail on a real device.
 *
 * ── ONE MESSAGE AT A TIME ───────────────────────────────────────────────────
 * Each announcement REPLACES the region's content. A queue would read a customer a
 * backlog of things that are no longer true — the worst version being a section
 * that failed, retried and succeeded announcing all three.
 *
 * ── `assertive` IS RATIONED ─────────────────────────────────────────────────
 * §20.6 reserves it for a failure that stops the flow the customer is in: a
 * rejected redemption, a rejected submission. Everything else is `polite`, because
 * `assertive` interrupts whatever the customer is reading, and a service that
 * interrupts for a background event is a service people turn off.
 *
 * SAFETY: DOM only, `textContent` only, no network, no storage.
 */

/** The section-scoped polite region, rendered by Liquid inside each root. */
const SECTION_REGION = "[data-portal-live]";

/** The one global `role="status"` region for cross-section confirmations. */
const GLOBAL_REGION = "[data-portal-live-global]";

/** Roots whose loading has already been announced (§20.6: announced once). */
const loadingAnnounced = new WeakSet<HTMLElement>();

/**
 * Write into a region.
 *
 * The region is cleared first, then filled on a subsequent task. Setting identical
 * text twice is otherwise a no-op to the accessibility tree, so a section that
 * fails, retries and fails again with the same wording would announce only the
 * first — and the customer pressing retry would get silence.
 */
function write(region: Element, message: string): void {
  region.textContent = "";
  // A macrotask, not a microtask: the tree must observe the empty value before the
  // new one, and a microtask can be coalesced into the same rendering step.
  setTimeout(() => {
    region.textContent = message;
  }, 0);
}

/** Politely announce inside a section's own region (§20.6). */
export function polite(root: HTMLElement, message: string): void {
  if (!message) return;
  const region = root.querySelector(SECTION_REGION);
  if (!region) return;
  region.setAttribute("aria-live", "polite");
  write(region, message);
}

/**
 * Announce assertively — a failure that stops the current flow.
 *
 * The politeness is set on the same region rather than on a second one, because
 * two overlapping regions on one root produce double announcements on several
 * screen reader / browser pairs.
 */
export function assertive(root: HTMLElement, message: string): void {
  if (!message) return;
  const region = root.querySelector(SECTION_REGION);
  if (!region) return;
  region.setAttribute("aria-live", "assertive");
  write(region, message);
}

/** The one global region: copied to clipboard, balance updated after a redemption. */
export function global(message: string): void {
  if (!message) return;
  const region = document.querySelector(GLOBAL_REGION);
  if (!region) return;
  write(region, message);
}

/**
 * Announce that a section is loading — at most once per root.
 *
 * §20.6: "loading is announced once, not per skeleton". A section that re-enters
 * its loading state on retry deliberately does NOT announce again: the customer
 * pressed the button, so they already know, and the outcome will be announced.
 */
export function loadingOnce(root: HTMLElement, message: string): void {
  if (loadingAnnounced.has(root)) return;
  loadingAnnounced.add(root);
  polite(root, message);
}

/** Test seam: forget the once-per-root bookkeeping. */
export function resetAnnouncements(root: HTMLElement): void {
  loadingAnnounced.delete(root);
}
