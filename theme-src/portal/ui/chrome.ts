/**
 * `ui/chrome.ts` — the chrome's own behaviour (spec task 19.1, design §17.4, §19.8).
 *
 * Requirements 17.3, 17.4, 17.9, 15.8.
 *
 * ── WHY THIS IS IN CORE AND NOT IN A SECTION BUNDLE ──────────────────────────
 * The navigation is rendered by `portal-chrome`, which is on every portal page, so
 * its behaviour belongs to the bundle that is also on every page. Putting it in a
 * section bundle would mean the More button worked on the sections whose bundle had
 * loaded and silently did nothing on the others — and on a phone the bar is the only
 * way to leave a page.
 *
 * ── ONE BINDING, AND WHAT HAPPENS WITHOUT IT ─────────────────────────────────
 * The only scripted part of the navigation is opening the sheet. Everything else —
 * the eight links, the bar, `aria-current` — is Liquid and CSS, so a customer whose
 * bundle fails to execute can still navigate (task 19.1). If this binding never
 * runs, `<dialog>` stays closed and the four demoted entries are reachable because
 * `portal-more-sheet` renders the same hrefs inside the bar's overflow items.
 *
 * SAFETY: DOM only. No network, no storage.
 */
import { open } from "./sheet.js";

/** The button `portal-nav` renders as the bar's fifth target. */
const MORE_BUTTON = "[data-portal-more-open]";

/** The sheet `portal-more-sheet` renders. */
const MORE_SHEET = "#AthoorPortalMore";

/** Bound roots, so a second `boot()` does not double-bind. */
const bound = new WeakSet<HTMLElement>();

/**
 * Bind the More button within a portal root.
 *
 * The listener is attached to the BUTTON, not to `document` (§16.10): a document
 * listener would run for every click on the page, so a throw inside it would break
 * unrelated interaction rather than just this control.
 */
export function bindChrome(root: HTMLElement): void {
  if (bound.has(root)) return;
  bound.add(root);

  const button = root.querySelector<HTMLElement>(MORE_BUTTON);
  const sheet = root.querySelector<HTMLDialogElement>(MORE_SHEET);
  // Neither is an error. A page may legitimately render the chrome without the
  // sheet, and a future layout may drop the button — in both cases the eight links
  // are still in the DOM, so navigation is unaffected.
  if (!button || !sheet) return;

  button.addEventListener("click", () => {
    // `open` returns a closer and handles focus, `Esc`, the dismiss control and
    // focus restoration to this button. Nothing here duplicates that.
    open(sheet, button);
  });
}

/** Test seam: forget the bound-roots bookkeeping. */
export function resetChrome(root: HTMLElement): void {
  bound.delete(root);
}
