/**
 * `GET /v1/profile/export` (N14) and `POST /v1/profile/erasure-request` (N15) —
 * spec tasks 15.1/15.2, design §15.4/§15.5, Req 13.8, 23.3, 23.4, 23.5, 2.4, 2.6.
 *
 * ── THE ERASURE ROUTE DELETES NOTHING, AND THAT IS THE DESIGN ───────────────
 * §15.5: erasure is irreversible, spans nine tables, must be coordinated with
 * Shopify's own erasure which this service does not control, requires unredeemed
 * discount codes to be voided, and must be auditable. So this route records intent
 * and returns a reference. The destructive half is the operator-run procedure in
 * `privacy/redaction.ts`, which is not reachable from any route — there is no
 * import of it here, and a test asserts that.
 *
 * A self-service button that irreversibly deleted on click, with no confirmation
 * path and no coordination, would be the wrong design for a right this important.
 * The customer-facing commitment is the acknowledgement and the reference.
 *
 * ── THE EXPORT IS AN ATTACHMENT, WHICH IS A PRIVACY DECISION ────────────────
 * `Content-Disposition: attachment` makes the browser save the file rather than
 * render it. Getting that wrong would paint a customer's full personal record into
 * a tab — which then lives in scroll position, browser cache and any screenshot
 * taken of it. The filename carries no identifier for the same reason.
 *
 * SAFETY: no destructive statement on any path. The single write is one INSERT
 * into `customer_erasure_requests`.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import type { Queryable } from "../ledger/repository.js";
import { recordErasureRequest } from "../portal/repository/erasure.js";
import {
  buildCustomerDataExport,
  exportFilename,
  type ExportClock,
  type ExportReaders,
} from "../privacy/export.js";
import { PORTAL_EXPORT_CONTENT_TYPE, type PortalErasureRequestResponse } from "../portal/types.js";
import { createRedemptionRateLimiter, type RedemptionRateLimiterOptions } from "../plugins/rateLimit.js";

/** `GET /v1/profile/export`: 1 per hour (§23.3, task 15.1). */
export const EXPORT_RATE_LIMIT_MAX_REQUESTS = 1 as const;
export const EXPORT_RATE_LIMIT_WINDOW_MS = 3_600_000 as const;
/** `POST /v1/profile/erasure-request`: 1 per day (task 15.2). */
export const ERASURE_RATE_LIMIT_MAX_REQUESTS = 1 as const;
export const ERASURE_RATE_LIMIT_WINDOW_MS = 86_400_000 as const;

/** Raised when no executor is wired. Surfaces as `502`, never as an empty export. */
export class PrivacyStoreUnconfiguredError extends Error {
  readonly code = "privacy_store_unconfigured" as const;
  constructor() {
    super("No database executor is configured for the privacy routes.");
    this.name = "PrivacyStoreUnconfiguredError";
  }
}

/** Options accepted by {@link registerPrivacyRoutes}. */
export interface PrivacyRouteOptions {
  /** Backs the erasure-request INSERT. Absent → the route answers `502`. */
  db?: Queryable;
  /**
   * The export's scope-typed readers. Absent → the export answers `502`.
   *
   * Separate from `db` because the export composes Shopify-backed readers as well
   * as database ones, and an erasure request must remain recordable even if a
   * Shopify credential is missing — a customer's right to ask does not depend on
   * whether their identity panel is reachable.
   */
  exportReaders?: ExportReaders;
  clock?: ExportClock;
  exportRateLimit?: RedemptionRateLimiterOptions;
  erasureRateLimit?: RedemptionRateLimiterOptions;
  exportRateLimiter?: preHandlerAsyncHookHandler;
  erasureRateLimiter?: preHandlerAsyncHookHandler;
}

/**
 * Builds the customer-facing reference for an erasure request.
 *
 * DERIVED FROM THE REQUEST ID, NOT THE CUSTOMER. The request's own UUID is already
 * a random opaque value, so its leading segment is a short handle a customer can
 * quote to support without the handle revealing who they are. Embedding the
 * customer id — the obvious alternative — would put a durable identifier into
 * emails and support tickets.
 *
 * Upper-cased and prefixed so it is unmistakably a reference rather than a value to
 * be pasted somewhere as an id.
 */
export function erasureReference(requestId: string): string {
  const head = requestId.replace(/-/g, "").slice(0, 12).toUpperCase();
  return `ERASE-${head}`;
}

/**
 * Registers N14 and N15. MUST be called inside the `/v1` router scope so auth and
 * idempotency have already run.
 */
export function registerPrivacyRoutes(
  app: FastifyInstance,
  opts: PrivacyRouteOptions = {},
): void {
  // REGISTERED UNCONDITIONALLY. A route that vanishes when a dependency is absent
  // leaves the unauthenticated route census and answers `404` — which for an
  // erasure endpoint would read as "this account cannot be erased".
  const clock: ExportClock = opts.clock ?? { now: () => new Date() };

  const exportLimiter =
    opts.exportRateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: EXPORT_RATE_LIMIT_MAX_REQUESTS,
      windowMs: EXPORT_RATE_LIMIT_WINDOW_MS,
      subject: "export",
      ...(opts.exportRateLimit ?? {}),
    });
  const erasureLimiter =
    opts.erasureRateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: ERASURE_RATE_LIMIT_MAX_REQUESTS,
      windowMs: ERASURE_RATE_LIMIT_WINDOW_MS,
      subject: "erasure request",
      ...(opts.erasureRateLimit ?? {}),
    });

  /* ------------------------------ N14 — export ----------------------------- */
  app.get(
    "/profile/export",
    { preHandler: [exportLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Identity FIRST. An unauthenticated caller learns nothing at all.
      const scope: CustomerScope = requireCustomerScope(req);

      const readers = opts.exportReaders;
      if (readers === undefined) {
        // Loud, not an empty document. An export with every section null would
        // read to a customer as "the brand holds nothing about me", which is a
        // false statement about a data-access right.
        return reply.code(502).send({
          error: "upstream_unavailable",
          message: "Your data export is temporarily unavailable.",
          retryable: true,
        });
      }

      const document = await buildCustomerDataExport(readers, scope, clock);

      return reply
        .header("content-type", PORTAL_EXPORT_CONTENT_TYPE)
        // The attachment header is the whole reason this is not a normal JSON
        // response — see the module header.
        .header("content-disposition", `attachment; filename="${exportFilename(document.generatedAt)}"`)
        // Never cached by a shared cache, and never stored by the browser: this is
        // the most sensitive single response the service produces.
        .header("cache-control", "no-store, private")
        .send(document);
    },
  );

  /* -------------------------- N15 — erasure request ------------------------- */
  app.post(
    "/profile/erasure-request",
    { preHandler: [erasureLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const scope: CustomerScope = requireCustomerScope(req);

      const db = opts.db;
      if (db === undefined) {
        return reply.code(502).send({
          error: "upstream_unavailable",
          message: "Your request could not be recorded. Please try again.",
          retryable: true,
        });
      }

      // `source = 'portal'`, always, on this route. A caller cannot choose the
      // source: `'shopify_redaction'` and `'operator'` describe how a request
      // ARRIVED, and a customer-facing endpoint can only ever attest to one of the
      // three. The body is not read at all.
      const { request } = await recordErasureRequest(db, scope, "portal");

      // A duplicate returns the SAME reference and the SAME requestedAt, so a
      // customer who taps twice sees one request rather than two.
      return {
        requestedAt: request.requestedAt,
        reference: erasureReference(request.id),
      } satisfies PortalErasureRequestResponse;
    },
  );
}
