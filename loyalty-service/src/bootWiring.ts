/**
 * Boot-time wiring predicates.
 *
 * `index.ts` is boot glue: it needs a live Postgres, pg-boss and Shopify to run,
 * so it is not exercised by the unit suite and its correctness is a type-level
 * plus static-review concern. That is tolerable for construction, but NOT for
 * the CONDITIONS under which optional components get constructed — a wrong
 * condition there is invisible, silent, and indistinguishable in production from
 * the bug the component was added to fix.
 *
 * So each such condition lives here, as a named pure function with a test that
 * states the invariant. The point is not that the boolean is hard to compute; it
 * is that the invariant becomes something the suite defends rather than
 * something a reviewer has to notice.
 */
import type { AppConfig } from "./config.js";

/**
 * Whether to construct the lazy-enrollment fallback
 * (`enrollment/ensureCustomerEnrollment.ts` → `LazyEnrollmentGate`).
 *
 * THE INVARIANT: this depends on `ENROLLMENT_LAZY_FALLBACK_ENABLED` and on
 * NOTHING ELSE.
 *
 * It is a function because the original code got this wrong. The gate was
 * constructed inside `index.ts`'s `if (adminApiToken)` block, next to the
 * discount-code and metafield-cache workers. Those two are correctly gated on
 * the Admin token: their transport is constructed from it, so without one there
 * is nothing to build. The enrollment gate is different in kind — it takes a
 * ledger repository and a transactor, issues SQL, and calls no Shopify API at
 * all. Gating it on an unrelated credential meant an operator could set the flag
 * to `true`, watch config parse it correctly, and still get no enroller.
 *
 * That failure mode is unusually nasty: the symptom is a verified customer
 * receiving 401 `identity_resolution_failed`, which is precisely the symptom the
 * flag exists to remove. The fix therefore looks like it did not work, and the
 * investigation goes hunting upstream for a Shopify identity problem instead.
 *
 * `/health` publishes `runtime.lazyEnrollerWired` — the result of this decision
 * at the wiring site — so the flag and the wiring can be compared from outside
 * rather than assumed to agree.
 */
export function shouldWireLazyEnrollment(config: AppConfig): boolean {
  return config.enrollment.lazyFallbackEnabled;
}
