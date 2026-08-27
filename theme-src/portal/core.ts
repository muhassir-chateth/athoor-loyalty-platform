/**
 * `athoor-portal-core.js` — the core bundle's entry point (spec task 7.1,
 * design §16.7).
 *
 * WHAT THIS FILE IS
 * -----------------
 * The one place `window.AthoorPortal` is created, and the boot scan that turns a
 * server-rendered `[data-portal-section]` root into a running section. It is the
 * *bundling contract*: eleven independent IIFEs (design §16.7) can only
 * cooperate through a named entry on `window`, and this is that entry.
 *
 * WHY THE ENTRY FILE IS NOT IN DESIGN §16.2's TREE
 * -----------------------------------------------
 * §16.2 enumerates the portal's modules; it does not name the two *entry* files
 * a multi-entry bundler needs (one core entry, one per section). `core.ts` is the
 * single file added beyond that tree, and it is added because esbuild bundles
 * what is reachable from an entry point — without one, "core" is a set of modules
 * with no output. Recorded here rather than left as an unexplained extra file.
 *
 * WHAT THIS FILE IS NOT — AND WHICH TASK OWNS IT
 * ----------------------------------------------
 * Task 7.1 builds the pipeline. It does not implement the portal. Deliberately
 * absent, each with its owner:
 *
 *   `transport/proxyClient.ts`  the only `fetch`, `Result<T>`, budgets   task 18.1
 *   `state/requestCache.ts`     coalescing + the 60 s balance TTL        task 18.2
 *   `state/draft.ts`            in-memory draft input                    task 18.2
 *   `render/states.ts`          the eight designed states of §18.8       task 18.3
 *   `render/*Row.ts`            `(dto) => DocumentFragment` renderers    task 18.3
 *   `ui/announce.ts` `focus.ts` live region and focus movement           task 18.4
 *   `ui/sheet.ts`               the one `<dialog>` sheet                 task 18.5
 *   `ui/copy.ts`                every customer-facing string             task 18.6
 *   `sections/register.ts`      the full error boundary (see `boot` below) task 18.7
 *
 * Each of those will be imported from here as it lands, which is what grows this
 * bundle toward the ~7–9 KB §21.2 expects. Nothing is stubbed in advance: an
 * empty module that pretends to be one of the above is worse than its absence,
 * because absence is legible and a stub is not.
 *
 * SAFETY. Importing this module reads no storage, issues no network request and
 * touches no element until `boot()` runs. It defines exactly one property on
 * `window` and nothing else — asserted by the smoke test, not asserted here.
 */
import { PORTAL_BUILD_VERSION } from "./version.js";

/** Marks a root as booted so a second `boot()` call is a no-op for it. */
const BOOTED_ATTRIBUTE = "data-portal-booted";

/**
 * Marks a root whose boot function threw.
 *
 * WHY THIS IS NOT `data-state="error"`. The eight designed states of §18.8 —
 * and the `data-state` vocabulary that drives them — belong to `render/states.ts`
 * (task 18.3), and `section_render_failed` belongs to the error boundary of task
 * 18.7. Writing either from here would fix half of someone else's vocabulary
 * before they define it. `data-portal-booted="failed"` records the mechanical
 * fact this file is entitled to know — *this root's boot function threw* — and
 * leaves what the customer sees to the tasks that design it.
 */
const BOOT_FAILED = "failed";

/** The selector Liquid renders on every section root (design §16.2, task 19.4). */
const SECTION_SELECTOR = "[data-portal-section]";

const boots = new Map<string, AthoorPortalSectionBoot>();
const order: string[] = [];

function register(name: string, boot: AthoorPortalSectionBoot): void {
  // First registration wins — see the contract note in `portal.d.ts`.
  if (boots.has(name)) return;
  boots.set(name, boot);
  order.push(name);
}

function boot(): void {
  const roots = document.querySelectorAll<HTMLElement>(SECTION_SELECTOR);

  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    // `noUncheckedIndexedAccess` is on, and it is right to be: a NodeList index
    // is only provably in range to a human.
    if (!root) continue;
    if (root.hasAttribute(BOOTED_ATTRIBUTE)) continue;

    const name = root.getAttribute("data-portal-section");
    if (!name) continue;

    const sectionBoot = boots.get(name);
    // Not an error. A page carries roots for sections whose bundle it did not
    // load — that is the point of per-section bundling (design §21.2). The root
    // keeps its server-rendered content and is revisited if that bundle arrives.
    if (!sectionBoot) continue;

    // Set BEFORE invoking, so a boot function that throws is not retried on the
    // next `boot()` call. A retry loop over a deterministic failure would turn
    // one broken section into a busy main thread, and Requirement 18's TBT
    // baseline of 0 ms means any main-thread block is a regression.
    root.setAttribute(BOOTED_ATTRIBUTE, "true");

    // PER-SECTION ISOLATION (Requirement 15.1). One `try` per root, so a section
    // that throws cannot prevent the next one from booting. Task 18.7 extends
    // this into the full error boundary — the `section_render_failed` state, the
    // window `error` listener, and per-root listener binding. It is implemented
    // here and not deferred because shipping a boot scan where the first throw
    // stops every later section would be a known Requirement 15.1 breach left in
    // place for a later task to notice.
    try {
      sectionBoot(root);
    } catch {
      // The exception itself is deliberately not read. It may carry an upstream
      // message, and design E.1 rule 2 keeps upstream text out of anything that
      // can reach a customer or a log. Task 18.7 owns what is reported.
      root.setAttribute(BOOTED_ATTRIBUTE, BOOT_FAILED);
    }
  }
}

const runtime: AthoorPortalRuntime = {
  version: PORTAL_BUILD_VERSION,
  register,
  boot,
  registered: () => order.slice(),
};

// Idempotent. A template that includes the core tag twice must not replace a
// runtime that already holds registrations — the replacement would silently
// discard every section that had already booted against the first copy.
if (!window.AthoorPortal) {
  window.AthoorPortal = runtime;
}

// `defer` scripts run after parsing, before `DOMContentLoaded` (HTML spec), so
// the section roots are already in the document and there is nothing to wait
// for. Listening for `DOMContentLoaded` here would delay every section by a
// task for no gain. `readyState` is still checked because a bundle injected
// dynamically — a preview tool, a test harness — arrives after the event.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
