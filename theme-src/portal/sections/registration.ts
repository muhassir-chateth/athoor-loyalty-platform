/**
 * The section side of the bundling contract (spec task 7.1, design §16.7).
 *
 * Every `athoor-portal-<section>.js` bundle is an independent IIFE, so its only
 * route to the core runtime is the single namespaced entry on `window`
 * (`portal.d.ts`). This module is that route, in one function, so the narrowing
 * and the failure message exist once rather than eleven times.
 *
 * NOT `sections/register.ts` — THAT IS TASK 18.7
 * ----------------------------------------------
 * Design §16.2 names `sections/register.ts`, which "finds
 * `[data-portal-section]`, boots the matching module" and, per task 18.7, owns
 * the error boundary: the `section_render_failed` state, the window `error`
 * listener, and per-root listener binding. That file does not exist yet and this
 * one is not it.
 *
 * The two are different sides of the same handshake. `register.ts` will run in
 * the CORE bundle and answer "which roots exist, and how does a failure
 * degrade?". This module runs in EACH SECTION bundle and answers only "how does
 * a section announce itself to core?". Naming them apart keeps task 18.7 free to
 * write `register.ts` without first unpicking a file that had taken its name.
 *
 * COST OF LIVING IN EVERY BUNDLE. esbuild inlines this into all ten section
 * bundles — around a hundred bytes each after minification. That is the accepted
 * price of per-section bundling (design §21.2): the alternative is a shared
 * chunk, which means a second network request per section page to save a hundred
 * bytes.
 */

/**
 * Announce a section to the core runtime and boot it.
 *
 * `name` must equal the `data-portal-section` attribute value on the section's
 * root, which Liquid renders (task 19.4). A mismatch is not an error here — core
 * simply finds no boot function for that root and leaves the server-rendered
 * content in place — so the failure mode of a typo is a section that never
 * enhances, not a broken page.
 *
 * `boot()` is called immediately after registering rather than left to core's own
 * scan. Core's scan runs when core executes, which under `defer` document order
 * is BEFORE this bundle — so at that moment this section had not registered and
 * its root was skipped. Calling `boot()` here is what picks the root up. It is
 * safe because `boot()` is idempotent per root: every already-booted root is
 * skipped, so this costs one `querySelectorAll` and nothing else.
 */
export function registerSection(name: string, boot: AthoorPortalSectionBoot): void {
  const runtime = window.AthoorPortal;

  if (!runtime) {
    // A TEMPLATE BUG, NOT A RUNTIME CONDITION. Under `defer` (Requirement 18.4)
    // scripts execute in document order, so reaching here means the section's
    // `script` tag preceded the core tag — or the core tag is missing. Warning
    // matches the shipped convention in `theme/assets/athoor-loyalty.js`, which
    // reports its own diagnostics through a `[athoor-loyalty]`-prefixed console
    // line. The message carries a section name and nothing else: no customer
    // identifier, no URL, no storage value.
    //
    // Returning rather than throwing keeps the failure confined. A throw here
    // would surface as an uncaught error on the page and, once task 18.7 adds
    // its window `error` listener, would degrade whichever section root happened
    // to be closest — blaming a working section for a template's mistake.
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[athoor-portal] core bundle absent; section not booted:", name);
    }
    return;
  }

  runtime.register(name, boot);
  runtime.boot();
}
