/**
 * `sections/register.ts` — the error boundary (spec task 18.7, design §16.10,
 * §16.6).
 *
 * Requirements 15.1, 15.8, 20.3.
 *
 * ── WHAT THIS ADDS TO `core.ts`'s BOOT SCAN ─────────────────────────────────
 * `core.ts` already boots each root inside its own `try`/`catch` — task 7.1 did
 * that rather than leave a known Requirement 15.1 breach in place. What it
 * deliberately did NOT do is decide what the customer sees, because the `data-state`
 * vocabulary and the `section_render_failed` wording belong to 18.3 and here.
 *
 * This module supplies the two halves that were missing:
 *   1. `degrade(root)` — the designed `section_render_failed` presentation, so a
 *      root whose boot threw shows the degraded state instead of a server-rendered
 *      skeleton that will never be replaced.
 *   2. A window `error` listener that degrades the CLOSEST section root, catching
 *      the failures a `try`/`catch` around boot cannot see: a throw inside an event
 *      handler or a timer, which happens long after boot returned.
 *
 * ── WHY THE WINDOW LISTENER IS NOT A CATCH-ALL ──────────────────────────────
 * It degrades only the nearest `[data-portal-section]` ancestor of the event
 * target. An error with no section ancestor is left alone: degrading every section
 * because an unrelated theme script threw would take down the account area for a
 * fault that has nothing to do with it. §16.10's listener is scoped for that
 * reason, and this one keeps the scope.
 *
 * ── LISTENERS ON THEIR OWN ROOT, NEVER ON `document` ────────────────────────
 * `bindOnRoot` exists so a section has a correct way to bind that is easier than
 * the wrong way. A handler on `document` means a throw inside one section's
 * handler runs on every other section's events too — the exact coupling
 * Requirement 15.8 forbids. The window `error` listener is the single deliberate
 * exception, and it exists to CONTAIN failures rather than to handle interaction.
 *
 * ── NO CLIENT ROUTER ────────────────────────────────────────────────────────
 * Navigation is server-rendered `<a href>` (§16.6). There is no route table here
 * and no `history.pushState`, because navigation implemented in JavaScript is
 * navigation that a JavaScript error can disable — and Requirement 15.8 asks that
 * navigation keep working when a section has failed.
 *
 * SAFETY: DOM only. No network, no storage.
 */
import { degrade as renderDegraded } from "../render/states.js";

/** The section root selector, matching `core.ts` and the Liquid of task 19.4. */
const SECTION_SELECTOR = "[data-portal-section]";

/** Roots already degraded, so a burst of errors renders once. */
const degraded = new WeakSet<HTMLElement>();

/**
 * The failure a render fault is reported as.
 *
 * `section_render_failed` is design E.2's client-side row: the section degrades,
 * navigation and every other section are unaffected. It is not retryable —
 * re-running a boot function that threw deterministically would throw again, and
 * offering a button that cannot help is what §22.9 rules out.
 */
const RENDER_FAILURE: PortalFailure = {
  code: "section_render_failed",
  status: null,
  requestId: null,
  retryable: false,
};

/**
 * Degrade one root to the designed render-failure state.
 *
 * Idempotent per root. The exception is never passed in and never read (design
 * E.1 rule 2): it may carry upstream text, and nothing that could reach a customer
 * or a log is allowed to be derived from it.
 */
export function degradeSection(root: HTMLElement): void {
  if (degraded.has(root)) return;
  degraded.add(root);
  try {
    renderDegraded(root, RENDER_FAILURE);
  } catch {
    // The degraded renderer itself failed — the markup is not what it expects.
    // Fall back to the attribute alone so CSS can still show the designed state,
    // and stop: a second throw here would be an infinite regress.
    root.setAttribute("data-state", "degraded");
  }
}

/** The nearest section root at or above an element, if any. */
function closestSection(target: EventTarget | null): HTMLElement | null {
  if (!target) return null;
  // `Element.closest` is ES5-era DOM and present across the support matrix; the
  // guard is for a target that is `window`, a text node or a detached object.
  const element = target as { closest?: (selector: string) => Element | null };
  if (typeof element.closest !== "function") return null;
  const found = element.closest(SECTION_SELECTOR);
  return found instanceof HTMLElement ? found : null;
}

/**
 * Install the window-level containment listener. Idempotent.
 *
 * Bound in the capture phase so it observes an error even when a section's own
 * handler has already stopped propagation, and registered once — a second
 * registration would degrade twice for one fault.
 */
let installed = false;

export function installErrorBoundary(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    "error",
    (event: Event) => {
      const root = closestSection(event.target);
      if (root) degradeSection(root);
    },
    true,
  );
  // A rejected promise inside a section is the same class of fault as a throw, and
  // it is the likelier one now that every read is async. There is no target to
  // narrow on, so this cannot attribute the failure to a section — which is why it
  // deliberately does NOTHING but exists as the documented reason nothing happens.
  // Attributing an unattributable rejection to every section would take the whole
  // account area down for one section's bug.
}

/**
 * Bind a listener on a section's own root (§16.10).
 *
 * The handler is wrapped so a throw inside it degrades ONLY this root rather than
 * escaping to the window listener, where the target might resolve to a different
 * section — or to none, and be lost.
 */
export function bindOnRoot<K extends keyof HTMLElementEventMap>(
  root: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  root.addEventListener(type, (event: Event) => {
    try {
      handler(event as HTMLElementEventMap[K]);
    } catch {
      degradeSection(root);
    }
  });
}

/** Test seam: forget the once-per-root and once-per-window bookkeeping. */
export function resetErrorBoundary(root?: HTMLElement): void {
  installed = false;
  if (root) degraded.delete(root);
}
