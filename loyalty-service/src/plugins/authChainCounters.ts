/**
 * Aggregate, identifier-free counters for where the identity-resolution chain
 * stopped — the readable form of the per-request `authChain` trace.
 *
 * WHY THIS EXISTS
 * ---------------
 * The per-request trace in `plugins/auth.ts` records the exact step that
 * stopped a request, but it goes to the process log. Reading the production log
 * needs dashboard access, so every single observation of a 401 became a manual
 * round trip: reload the storefront, open the hosting dashboard, find the line,
 * copy it back. Diagnosis was rate-limited by that loop, not by the problem.
 *
 * These counters make the SERVICE ITSELF answer the question. `/health` is
 * already public and already polled, so publishing a tally of stop points there
 * turns "which branch did the request die on?" into one HTTP GET. After a single
 * storefront reload the delta names the step.
 *
 * PRIVACY — the reason this is a separate module with a narrow input type.
 * A counter keyed by anything request-specific would quietly become a log of
 * customers. So this stores EXACTLY ONE THING per request: a label drawn from a
 * closed set of ten constants declared below. It does not store, and cannot
 * store, an id (not even the masked suffix), a route, a signature, a cookie, an
 * email, a token, a timestamp per request, or an IP — there is no field for any
 * of them. {@link classifyStopPoint} takes the trace's booleans and returns a
 * constant; the trace itself is never retained.
 *
 * WHAT IT IS NOT. In-process memory, so it is not durable and not a metrics
 * backend: a restart resets it, which is why {@link AuthChainCountersSnapshot}
 * publishes `since`. A tally that drops to zero means the process restarted, not
 * that the failures stopped. This is a diagnostic aid for Phase 0 and is
 * deliberately cheap enough to delete once the identity path is settled.
 */

/**
 * The step at which a gated request finished — the closed set of labels the
 * counters may key on.
 *
 * Ordered as the chain runs, so a snapshot reads top-to-bottom like the funnel:
 * credentials → verification → identity supplied → local row → resolution.
 */
export const AUTH_STOP_POINTS = [
  /** Neither an App Proxy signature nor a bearer token was presented. */
  "no_credentials_presented",
  /** An App Proxy request arrived but no shared secret is configured (fail closed). */
  "app_proxy_verification_unavailable",
  /** The App Proxy signature did not verify; any supplied id was ignored. */
  "app_proxy_signature_invalid",
  /** Signature verified, but Shopify supplied NO `logged_in_customer_id`. */
  "verified_but_no_customer_id",
  /** Signature verified, but the id was `0` — an anonymous storefront session. */
  "verified_but_anonymous_customer_id",
  /** A bearer token was presented and the verifier rejected it. */
  "bearer_token_rejected",
  /** Identity verified, no local row, and the lazy fallback was not wired. */
  "no_local_row_fallback_not_wired",
  /** Identity verified, no local row, the fallback ran and did not enrol. */
  "no_local_row_enrollment_failed",
  /** Resolved against an existing local row; no enrollment needed. */
  "resolved_existing_row",
  /** Resolved because the lazy fallback created the missing local row. */
  "resolved_via_enrollment",
] as const;

export type AuthStopPoint = (typeof AUTH_STOP_POINTS)[number];

/**
 * The subset of the auth-chain trace this module is allowed to see: booleans and
 * the outcome string, and nothing that could identify a person or a credential.
 * `AuthChainTrace` satisfies this structurally, so the narrow type is what keeps
 * the identifying fields out by construction rather than by discipline.
 */
export interface AuthChainOutcomeFacts {
  path: "app_proxy" | "bearer_token" | "none";
  signatureVerified: boolean;
  loggedInCustomerIdPresent: boolean;
  loggedInCustomerIdAnonymous: boolean;
  existingCustomerFound: boolean;
  enrollmentAttempted: boolean;
  enrollmentSucceeded: boolean;
  outcome: string;
}

/** What `/health` publishes. Counts only — see the module header. */
export interface AuthChainCountersSnapshot {
  /**
   * When this process began counting. A tally is only meaningful relative to
   * this: in-process memory resets on restart, and without `since` a reset is
   * indistinguishable from the failures having stopped.
   */
  since: string;
  /** Total gated requests classified since `since`. Public routes are not counted. */
  gatedRequests: number;
  /** Non-zero stop points only, so the common case stays a short, readable object. */
  stopPoints: Partial<Record<AuthStopPoint, number>>;
}

/**
 * Reduce a completed chain to the single step that decided it.
 *
 * The order of these checks IS the chain's order, and two of them are
 * load-bearing:
 *
 *  - anonymous is tested BEFORE absent, because Shopify's anonymous marker is
 *    `logged_in_customer_id=0`, which is *present*. Testing presence first would
 *    file every anonymous browse under "Shopify supplied no id" and manufacture
 *    exactly the false conclusion this diagnostic exists to prevent.
 *  - the local-row branches are reached only after identity is established, so
 *    `no_local_row_*` can never be attributed to a request that was never
 *    identified in the first place.
 */
export function classifyStopPoint(facts: AuthChainOutcomeFacts): AuthStopPoint {
  if (facts.outcome === "resolved") {
    return facts.enrollmentAttempted ? "resolved_via_enrollment" : "resolved_existing_row";
  }
  if (facts.outcome === "app_proxy_verification_unavailable") {
    return "app_proxy_verification_unavailable";
  }
  if (facts.outcome === "app_proxy_signature_invalid") {
    return "app_proxy_signature_invalid";
  }

  // Everything below is `identity_resolution_failed`, the ambiguous status this
  // whole module exists to disambiguate.
  if (facts.path === "none") {
    return "no_credentials_presented";
  }

  if (facts.path === "app_proxy") {
    if (facts.loggedInCustomerIdAnonymous) {
      return "verified_but_anonymous_customer_id";
    }
    if (!facts.loggedInCustomerIdPresent) {
      return "verified_but_no_customer_id";
    }
  }

  if (facts.path === "bearer_token" && !facts.loggedInCustomerIdPresent) {
    // On the bearer path the trace records presence only after the verifier
    // returned a subject, so "absent" here means the token was rejected.
    return "bearer_token_rejected";
  }

  // Identity was established; the request died on the local row.
  return facts.enrollmentAttempted
    ? "no_local_row_enrollment_failed"
    : "no_local_row_fallback_not_wired";
}

/**
 * In-process tally of stop points.
 *
 * Deliberately not injected with a clock per request: nothing here is
 * time-series data. `since` is captured once at construction so a snapshot can
 * be interpreted after a restart.
 */
export class AuthChainCounters {
  private readonly counts = new Map<AuthStopPoint, number>();
  private total = 0;
  private readonly startedAt: string;

  constructor(now: () => Date = () => new Date()) {
    this.startedAt = now().toISOString();
  }

  /**
   * Classify and count one completed chain. Returns the label so a caller can
   * assert on it; the `facts` object itself is not retained.
   */
  record(facts: AuthChainOutcomeFacts): AuthStopPoint {
    const stopPoint = classifyStopPoint(facts);
    this.counts.set(stopPoint, (this.counts.get(stopPoint) ?? 0) + 1);
    this.total += 1;
    return stopPoint;
  }

  /** Current tally. Emits stop points in chain order so the funnel reads in sequence. */
  snapshot(): AuthChainCountersSnapshot {
    const stopPoints: Partial<Record<AuthStopPoint, number>> = {};
    for (const stopPoint of AUTH_STOP_POINTS) {
      const count = this.counts.get(stopPoint);
      if (count !== undefined && count > 0) {
        stopPoints[stopPoint] = count;
      }
    }
    return { since: this.startedAt, gatedRequests: this.total, stopPoints };
  }
}
