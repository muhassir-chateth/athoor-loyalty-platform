/**
 * Shared failure mapping for the N6–N9 profile write routes (spec task 14,
 * design §5.5/§13.4, Req 2.7, 5.5, 20.7).
 *
 * ── ONE MAPPING, BECAUSE THREE COPIES WOULD DRIFT ───────────────────────────
 * Identity, addresses and consent all talk to the same Shopify boundary and can
 * fail in exactly the same ways. Task 12 shipped a route that re-derived error
 * codes in parallel with a domain validator that already produced them, and the two
 * drifted within one task. Three route files each deciding what a throttle means
 * would be the same mistake three times.
 *
 * ── THE CLASSIFICATION THAT MATTERS: REFUSED vs UNKNOWN ─────────────────────
 * A `PortalWriteRejectedError` means Shopify was reached, understood the request and
 * declined it — the customer can fix it and retry, so `400`. Everything else means
 * we do not know whether the write happened, so `502` and the same request is safe
 * to send again. The routes handle the `400` themselves because each has its own
 * body to return alongside it; this function owns the rest.
 *
 * ── AN UNSCOPED DOCUMENT IS A LOUD 500, NEVER A 502 ─────────────────────────
 * Carried forward verbatim from `orders.ts`: a document rejected by one of the three
 * security guards is OUR defect, not Shopify having a bad afternoon. Mapping it to
 * `502 upstream_unavailable` would disguise a security-relevant bug as an outage,
 * and the degraded state the client shows would make it look handled.
 *
 * SAFETY: pure mapping. No I/O. Never places Shopify's message text, a field value,
 * or a token in a response body.
 */
import type { FastifyReply } from "fastify";
import { PortalResourceNotFoundError } from "../portal/repository/scopedQuery.js";
import { UnscopedShopifyQueryError } from "../portal/repository/shopifyScope.js";
import type { CustomerIdentityReadDeps } from "../portal/repository/customerIdentity.js";
import type { CustomerMutationDeps } from "../portal/repository/customerMutations.js";

/** The one dependency the N6–N9 routes need, or `null` when unwired. */
export interface ProfileWriteDeps {
  readonly source: (CustomerIdentityReadDeps & CustomerMutationDeps) | null;
}

/**
 * Maps a non-refusal failure to a response.
 *
 * `404` for a missing resource (Req 2.2: a foreign id is indistinguishable from a
 * nonexistent one), `502` for an upstream failure, and a RETHROW for anything else
 * so a defect stays loud and reaches the 500 handler.
 */
export function mapPortalWriteFailure(err: unknown, reply: FastifyReply): never | object {
  if (err instanceof UnscopedShopifyQueryError) {
    // OUR defect. Rethrow so it is a 500 and gets noticed.
    throw err;
  }
  if (err instanceof PortalResourceNotFoundError) {
    // No address attribute, no id, no count — the body names nothing about the
    // resource, so a foreign id and an absent one read identically (Req 2.2, 2.3).
    return reply.code(404).send({ error: "not_found", message: "Not found." });
  }
  // Everything left is the Shopify boundary failing or being unwired. Both mean the
  // portal cannot answer, and neither is the customer's fault.
  return reply.code(502).send({
    error: "upstream_unavailable",
    message: "This information is temporarily unavailable.",
    retryable: true,
  });
}
