/**
 * The one global the portal is allowed to define, declared as a type contract
 * (spec task 7.1, design §16.7).
 *
 * WHY A GLOBAL AT ALL, IN A CODEBASE WITH MODULES
 * -----------------------------------------------
 * The build emits `athoor-portal-core.js` plus one `athoor-portal-<section>.js`
 * per section, each an independent IIFE (design §16.7). Independent IIFEs have
 * no shared module scope by construction, so the only channel between the core
 * bundle and a section bundle is a property on `window`. That is not a shortcut
 * around modules — it is the consequence of the per-section bundling that keeps
 * the 40 KB per-page budget comfortable (design §21.2): a customer on Orders
 * must not download the referral code, which means Orders cannot be in the same
 * module graph as Referrals.
 *
 * The cost is one global, and design §16.7 bounds it explicitly: the bundles
 * define "no global beyond a single namespaced entry", asserted by the smoke
 * test rather than trusted. This file is where that single entry is named and
 * typed, so a section bundle that reaches for a second global does not compile.
 *
 * WHY A `.d.ts` AND NOT A MODULE
 * ------------------------------
 * A shared module would be inlined into all eleven bundles by esbuild, paying
 * its bytes eleven times for a contract that has no runtime representation. An
 * ambient declaration costs zero bytes in every bundle and is checked in all of
 * them.
 *
 * SCOPE. This declares the boot/registration contract and nothing else. The
 * transport, cache, announcer, sheet and copy map that will also hang off this
 * namespace are tasks 18.1–18.6; each adds its own member here when it lands.
 * There is deliberately no placeholder for them: an optional member that no code
 * assigns is indistinguishable from a member that a future refactor dropped.
 */

/**
 * A section's entry point, invoked once with its own root element.
 *
 * Returns `void`, not a promise: the boot scan cannot await eleven sections
 * serially, and a section that needs asynchronous work owns that work — and its
 * own designed loading state — inside itself. A rejected promise returned from
 * here would escape the boot scan's `try`/`catch` entirely, which is precisely
 * the per-section isolation Requirement 15.1 asks for.
 */
type AthoorPortalSectionBoot = (root: HTMLElement) => void;

/**
 * The namespaced entry: `window.AthoorPortal`.
 *
 * Every member is non-optional. The core bundle either created this object
 * completely or a section bundle created the same shape before core arrived
 * (see `register` below), so a partially-populated namespace is not a state the
 * type system needs to admit.
 */
interface AthoorPortalRuntime {
  /**
   * The build's identity, written by the build script from the source it read —
   * see `scripts/build/portal-assets.mjs`.
   *
   * This exists so a page that is behaving oddly can be asked which bundle it
   * is running, without guessing from a CDN URL. It is not a cache key and
   * nothing branches on it.
   */
  readonly version: string;

  /**
   * Record a section's boot function under the name its root carries in
   * `data-portal-section`.
   *
   * CORE LOADS FIRST, AND THAT IS GUARANTEED RATHER THAN HOPED. Every portal
   * script is `defer` (Requirement 18.4), and the HTML spec executes `defer`
   * scripts in document order, so a Liquid template that emits the core tag
   * before the section tag has core's `register` defined by the time the section
   * bundle runs. `sections/registration.ts` therefore narrows
   * `window.AthoorPortal` and, if it is genuinely absent, warns and does
   * nothing — that state is a template-ordering bug, not a runtime condition to
   * design around, and a queue built to absorb it would be a mechanism
   * defending against a case `defer` already prevents.
   *
   * Registering the same name twice is the double-included-script case. The
   * first registration wins and the second is ignored, because the alternative —
   * last-one-wins — silently swaps behaviour depending on tag order.
   */
  register(name: string, boot: AthoorPortalSectionBoot): void;

  /**
   * Boot every `[data-portal-section]` root in the document whose name has a
   * registered boot function, each in isolation.
   *
   * Safe to call repeatedly: a root already booted is skipped, so core calling
   * it on `DOMContentLoaded` and a late-arriving section bundle calling it again
   * do not double-boot anything.
   */
  boot(): void;

  /**
   * The names registered so far, in registration order.
   *
   * Present for the bundle smoke test (design §16.7), which asserts that
   * loading `athoor-portal-orders.js` results in exactly one registration and
   * no second global. Returns a fresh array so a caller cannot mutate the
   * runtime's own bookkeeping.
   */
  registered(): string[];
}

interface Window {
  /**
   * Optional because a section bundle cannot prove at compile time that the
   * core tag preceded it in the document, so every reader must narrow. The
   * narrowing is not ceremony: it is the one place a template-ordering mistake
   * becomes visible instead of becoming a `TypeError` in a customer's browser.
   */
  AthoorPortal?: AthoorPortalRuntime;
}
