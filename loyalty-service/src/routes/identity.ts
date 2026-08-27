/**
 * `GET`/`PUT /v1/profile/identity` (N6, N7) and `GET`/`PUT /v1/profile/consent`
 * (N9) — spec tasks 14.2 and 14.4, design §13.1/§13.3/§13.4, Req 5.1, 5.2, 5.3,
 * 5.5, 5.8, 13.3, 13.4, 3.1, 3.2, 3.5, 21.7.
 *
 * ── SHOPIFY IS THE SOURCE OF TRUTH, WITH NO LOCAL COPY ANYWHERE ─────────────
 * Nothing here writes a database. Identity and consent are read from Shopify at
 * request time and written back to Shopify, and every value the client sees comes
 * from Shopify's own response. `updatedAt` on a consent change is Shopify's
 * `consentUpdatedAt`, never our clock — so there is exactly one record of when
 * consent changed (Req 3.2, 13.4). A second copy of consent is the one divergence
 * that would be a compliance failure rather than a bug.
 *
 * ── EMAIL IS UNWRITEABLE BY CONTRACT, NOT BY CHECK (Req 5.8) ────────────────
 * `IDENTITY_BODY_SCHEMA` has no `email` key and `.strip()`s unknown ones, so a body
 * containing an email arrives at the handler without it. There is no `if (email)`
 * anywhere to forget, and the mutation document has no email field to write it to.
 * §13.3: email is the login identifier, so changing it changes who the customer is
 * to Shopify.
 *
 * ── A REFUSAL IS A 400; NOT KNOWING IS A 502 ────────────────────────────────
 * A Shopify `userError` means Shopify was reached, understood the request and
 * declined it — the customer can fix it, so `400` with field codes. A transport
 * failure means we do not know whether anything happened — `502`, and the same
 * request is safe to retry. Collapsing the two would tell a customer with an
 * unparseable phone number that the service is down.
 *
 * SAFETY: no SQL. Every write goes through the six-name allowlist client.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { z } from "zod";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import {
  readCustomerConsent,
  readCustomerIdentity,
  type CustomerIdentityReadDeps,
} from "../portal/repository/customerIdentity.js";
import {
  CONSENT_STATE_SUBSCRIBED,
  updateCustomerConsent,
  updateCustomerIdentity,
  type CustomerMutationDeps,
} from "../portal/repository/customerMutations.js";
import { PortalWriteRejectedError } from "../portal/userErrorCodes.js";
import type { PortalConsentResponse, PortalIdentityResponse } from "../portal/types.js";
import { createRedemptionRateLimiter, type RedemptionRateLimiterOptions } from "../plugins/rateLimit.js";
import { mapPortalWriteFailure, type ProfileWriteDeps } from "./profileWriteSupport.js";

/** `PUT /v1/profile/identity` rate limit: 10 per hour (task 14.2). */
export const IDENTITY_RATE_LIMIT_MAX_REQUESTS = 10 as const;
/** `PUT /v1/profile/consent` rate limit: 10 per hour (task 14.4). */
export const CONSENT_RATE_LIMIT_MAX_REQUESTS = 10 as const;
export const PROFILE_WRITE_RATE_LIMIT_WINDOW_MS = 3_600_000 as const;

/**
 * The N7 body (§6.3).
 *
 * `.strip()` IS LOAD-BEARING. Requirement 5.8 forbids writing the email, and a key
 * that cannot reach the handler cannot be written by accident. `phone` accepts
 * `null` so a customer can CLEAR it; `firstName`/`lastName` do not, because Shopify
 * treats a null name as a clear and a nameless customer is not a state the portal
 * offers.
 */
export const IDENTITY_BODY_SCHEMA = z
  .object({
    firstName: z.string().min(1).max(64).optional(),
    lastName: z.string().min(1).max(64).optional(),
    phone: z.union([z.string().min(1).max(64), z.null()]).optional(),
  })
  .strip();

/** The N9 body (§6.3). */
export const CONSENT_BODY_SCHEMA = z.object({ emailMarketing: z.boolean() }).strip();

/** Options accepted by {@link registerIdentityRoutes}. */
export interface IdentityRouteOptions {
  /** Absent → every route REFUSES with `502`. The routes register regardless. */
  deps?: CustomerIdentityReadDeps & CustomerMutationDeps;
  identityRateLimit?: RedemptionRateLimiterOptions;
  consentRateLimit?: RedemptionRateLimiterOptions;
  identityRateLimiter?: preHandlerAsyncHookHandler;
  consentRateLimiter?: preHandlerAsyncHookHandler;
}

/**
 * Maps a validated body to mutation variables, passing ONLY the keys the customer
 * submitted.
 *
 * This is why the repository's `?? null` cannot clear a field by accident: an
 * absent key never reaches it. Shopify treats an explicit null as "clear", so
 * forwarding `firstName: null` for a body that only changed the phone would erase
 * the customer's name.
 */
function buildIdentityPatch(body: z.infer<typeof IDENTITY_BODY_SCHEMA>): {
  patch: { firstName?: string; lastName?: string; phone?: string | null };
  changed: boolean;
} {
  const patch: { firstName?: string; lastName?: string; phone?: string | null } = {};
  if (body.firstName !== undefined) patch.firstName = body.firstName;
  if (body.lastName !== undefined) patch.lastName = body.lastName;
  if (body.phone !== undefined) patch.phone = body.phone;
  return { patch, changed: Object.keys(patch).length > 0 };
}

/**
 * Registers N6, N7 and N9. MUST be called inside the `/v1` router scope so auth and
 * idempotency have already run.
 */
export function registerIdentityRoutes(
  app: FastifyInstance,
  opts: IdentityRouteOptions = {},
): void {
  // REGISTERED UNCONDITIONALLY, with a refusing dependency when none is wired. A
  // route that vanishes leaves the unauthenticated route census, and answers `404`
  // to a client that would read it as "this account has no identity".
  const deps: ProfileWriteDeps = { source: opts.deps ?? null };

  const identityLimiter =
    opts.identityRateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: IDENTITY_RATE_LIMIT_MAX_REQUESTS,
      windowMs: PROFILE_WRITE_RATE_LIMIT_WINDOW_MS,
      subject: "profile",
      ...(opts.identityRateLimit ?? {}),
    });
  const consentLimiter =
    opts.consentRateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: CONSENT_RATE_LIMIT_MAX_REQUESTS,
      windowMs: PROFILE_WRITE_RATE_LIMIT_WINDOW_MS,
      subject: "consent",
      ...(opts.consentRateLimit ?? {}),
    });

  /* ------------------------------- N6 — read ------------------------------- */
  app.get("/profile/identity", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);
    try {
      // Inside the try, so an UNWIRED source maps to 502 like any other inability
      // to reach Shopify — not to a 500, which would read as a defect in this
      // service rather than a missing credential.
      return await readCustomerIdentity(requireSource(deps), scope);
    } catch (err) {
      return mapPortalWriteFailure(err, reply);
    }
  });

  /* ------------------------------- N7 — write ------------------------------ */
  app.put(
    "/profile/identity",
    { preHandler: [identityLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Identity FIRST, so a stranger learns nothing about which values are valid.
      const scope = requireCustomerScope(req);
      let source: CustomerIdentityReadDeps & CustomerMutationDeps;
      try {
        source = requireSource(deps);
      } catch (err) {
        return mapPortalWriteFailure(err, reply);
      }

      const parsed = IDENTITY_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Invalid profile details.",
          // Field CODES, never zod's sentences (Req 21.7). `too_big`/`too_small`
          // both mean the value is outside the accepted length.
          fields: parsed.error.issues.map((issue) => ({
            field: typeof issue.path[0] === "string" ? issue.path[0] : null,
            code:
              issue.code === "too_big"
                ? "too_long"
                : issue.code === "invalid_type"
                  ? "rejected"
                  : "rejected",
          })),
        });
      }

      const { patch, changed } = buildIdentityPatch(parsed.data);
      if (!changed) {
        // An empty body is a no-op save, not an error. Return the stored state so
        // the client needs no follow-up read.
        try {
          return await readCustomerIdentity(source, scope);
        } catch (err) {
          return mapPortalWriteFailure(err, reply);
        }
      }

      try {
        const stored = await updateCustomerIdentity(source, scope, patch);
        // WHAT SHOPIFY STORED, not what was submitted — Shopify normalises a phone
        // number, so echoing the request would show a value that differs from the
        // account (task 14.5).
        return {
          firstName: stored.firstName,
          lastName: stored.lastName,
          email: stored.email,
          phone: stored.phone,
          emailEditable: false,
        } satisfies PortalIdentityResponse;
      } catch (err) {
        if (err instanceof PortalWriteRejectedError) {
          // Nothing was changed, and the previously stored value is returned
          // alongside the field codes so the client can present both (Req 5.5).
          const previous = await readCustomerIdentity(source, scope).catch(() => null);
          return reply.code(400).send({
            error: "invalid_request",
            message: "Shopify did not accept these details.",
            fields: err.fields,
            ...(previous === null ? {} : { current: previous }),
            retryable: true,
          });
        }
        return mapPortalWriteFailure(err, reply);
      }
    },
  );

  /* ------------------------------ N9 — consent ----------------------------- */
  app.get("/profile/consent", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);
    try {
      const state = await readCustomerConsent(requireSource(deps), scope);
      return projectConsent(state.marketingState, state.consentUpdatedAt);
    } catch (err) {
      return mapPortalWriteFailure(err, reply);
    }
  });

  app.put(
    "/profile/consent",
    { preHandler: [consentLimiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const scope = requireCustomerScope(req);
      let source: CustomerIdentityReadDeps & CustomerMutationDeps;
      try {
        source = requireSource(deps);
      } catch (err) {
        return mapPortalWriteFailure(err, reply);
      }

      const parsed = CONSENT_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Invalid consent value.",
          fields: [{ field: "emailMarketing", code: "rejected" }],
        });
      }

      try {
        const stored = await updateCustomerConsent(source, scope, parsed.data.emailMarketing);
        return projectConsent(stored.marketingState, stored.consentUpdatedAt);
      } catch (err) {
        if (err instanceof PortalWriteRejectedError) {
          return reply.code(400).send({
            error: "invalid_request",
            message: "Shopify did not accept the consent change.",
            fields: err.fields,
            retryable: true,
          });
        }
        return mapPortalWriteFailure(err, reply);
      }
    },
  );
}

/**
 * Projects Shopify's consent state onto the N9 contract.
 *
 * `emailMarketing` is TRUE ONLY for `SUBSCRIBED`. The live enum also has
 * `PENDING`, `NOT_SUBSCRIBED`, `UNSUBSCRIBED`, `REDACTED` and `INVALID`, and
 * treating any of those as consent would be the wrong direction to be wrong in:
 * `PENDING` means a double opt-in was started and never confirmed, which is
 * precisely not consent.
 *
 * `updatedAt` falls back to the empty string only when Shopify reports no
 * timestamp, which it does for a customer whose consent has never been set. The
 * field stays present so the contract does not change shape.
 */
function projectConsent(
  marketingState: string | null,
  consentUpdatedAt: string | null,
): PortalConsentResponse {
  return {
    emailMarketing: marketingState === CONSENT_STATE_SUBSCRIBED,
    updatedAt: consentUpdatedAt ?? "",
  };
}

/** Raised when no Shopify source is wired. Surfaces as `502`, never as empty data. */
export class ProfileWriteSourceUnconfiguredError extends Error {
  readonly code = "profile_write_source_unconfigured" as const;
  constructor() {
    super("No Shopify source is configured for the profile identity routes.");
    this.name = "ProfileWriteSourceUnconfiguredError";
  }
}

/** Returns the wired source, or throws so the caller answers `502`. */
function requireSource(deps: ProfileWriteDeps): CustomerIdentityReadDeps & CustomerMutationDeps {
  if (deps.source === null) throw new ProfileWriteSourceUnconfiguredError();
  return deps.source;
}
