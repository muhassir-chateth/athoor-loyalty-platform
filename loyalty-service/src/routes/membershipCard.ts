/**
 * `GET /v1/membership-card` and `GET /v1/membership-card/verify` — issue and
 * verify the Digital Membership Card credential (task 19.2, Req 19.5/19.6).
 *
 * Surfaces the Membership-Credential service (`membership/credential.ts`) over
 * the versioned `/v1` API (design.md `/v1` route table:
 * `GET /v1/membership-card` → signed id + QR + tier; `GET
 * /v1/membership-card/verify` → `{ valid, tier? }`). Both are ADDITIVE `/v1`
 * endpoints introduced without altering any existing web request/response
 * contract (Req 19.7).
 *
 *   - `GET /v1/membership-card` (AUTHENTICATED): issues a {@link
 *     MembershipCredential} for the customer resolved by the `/v1` auth
 *     preHandler (task 6.2, `req.authCtx.customerId`) — an opaque, non-PII
 *     member id + current tier + signature + QR payload, everything a mobile
 *     wallet pass needs (Req 19.6). Identity-source agnostic: reads only
 *     `req.authCtx.customerId`, so App Proxy (web) and Customer Account API
 *     (mobile) yield the same credential (Req 9.2/9.3).
 *
 *   - `GET /v1/membership-card/verify` (PUBLIC): a scanner/POS presents a
 *     previously-issued signed identifier (the QR payload) via the `credential`
 *     query param; the endpoint confirms it was signed by us and returns ONLY
 *     `{ valid, tier? }` (Req 19.5). It is public because it exposes NO customer
 *     data — a validly-signed token can only be produced with our dedicated key,
 *     and a valid response carries membership + tier only, never the member id,
 *     the customer id, or any other customer's data.
 *
 * FAIL CLOSED (Req 19.5): when the dedicated signing key is not configured, the
 * service is unavailable; both endpoints then respond `503` rather than issuing
 * or trusting unsigned credentials.
 *
 * OFF-LEDGER: issuing/verifying a credential never touches the ledger and never
 * affects any customer's Balance (design: "Signing/verification only — no
 * ledger interaction").
 *
 * SAFETY: defining this module touches no live/production system. The default
 * tier source is in-memory and the key is read from config; route logic is
 * unit-tested with an in-memory service, so no live Shopify/Postgres is
 * required during verification.
 */
import { requireCustomerScope } from "../auth/customerScope.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DefaultMembershipCredentialService,
  InMemoryMembershipTierSource,
  MemberNotFoundError,
  MembershipKeyUnavailableError,
  type MembershipCredentialService,
} from "../membership/credential.js";

/** The public path of the verification endpoint (kept in sync with the auth allowlist). */
export const MEMBERSHIP_VERIFY_ROUTE = "/membership-card/verify" as const;

/** Options accepted by {@link registerMembershipCardRoutes}. */
export interface MembershipCardRouteOptions {
  /**
   * The Membership-Credential service. When omitted, a default service is built
   * from {@link membershipSigningKey} + an empty in-memory tier source, so the
   * routes boot without a live Postgres; a Pg-backed tier source is injected at
   * deploy time. Injectable so tests supply a fully in-memory service.
   */
  membershipCredentialService?: MembershipCredentialService;
  /**
   * The dedicated signing key (config `membership.signingKey`, Req 19.5). Used
   * only to build the default service; ignored when a service is injected. When
   * absent the default service is unavailable and both endpoints fail closed.
   */
  membershipSigningKey?: string;
}

/** Query schema for the verification endpoint: the presented signed identifier. */
interface VerifyQuery {
  credential?: string;
}

/**
 * Registers `GET /v1/membership-card` and `GET /v1/membership-card/verify` on
 * `app`. The issue route MUST be called inside the `/v1` router scope so the
 * auth preHandler has already resolved `req.authCtx` (task 6.2); the verify
 * route is registered in the router's public allowlist so a scanner can call it
 * without customer auth.
 *
 * Responses: `200` with the credential / verification body on success; `401` if
 * auth did not attach an identity on the issue route (defensive); `404` when
 * the resolved customer is not a member; `400` when the verify `credential`
 * query param is missing; `503` when the dedicated signing key is unconfigured.
 */
export function registerMembershipCardRoutes(
  app: FastifyInstance,
  opts: MembershipCardRouteOptions = {},
): void {
  const service =
    opts.membershipCredentialService ??
    new DefaultMembershipCredentialService(
      opts.membershipSigningKey,
      new InMemoryMembershipTierSource(),
    );

  // Issue the signed credential for the resolved customer (Req 19.5/19.6).
  app.get("/membership-card", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    try {
      return await service.issueCredential(ctx.customerId);
    } catch (err) {
      if (err instanceof MembershipKeyUnavailableError) {
        return reply.code(503).send({
          error: "membership_service_unavailable",
          message: "The membership-card service is not configured.",
        });
      }
      if (err instanceof MemberNotFoundError) {
        return reply.code(404).send({
          error: "customer_not_found",
          message: "No loyalty member exists for the resolved identity.",
        });
      }
      throw err;
    }
  });

  // Verify a presented signed identifier → { valid, tier? } only (Req 19.5).
  // PUBLIC: exposes no customer data; see the router allowlist.
  app.get("/membership-card/verify", async (req: FastifyRequest, reply: FastifyReply) => {
    const credential = (req.query as VerifyQuery)?.credential;
    if (typeof credential !== "string" || credential.trim() === "") {
      return reply.code(400).send({
        error: "missing_credential",
        message: "A 'credential' query parameter carrying the signed member identifier is required.",
      });
    }

    try {
      // Returns membership + tier ONLY — never any other customer's data.
      return await service.verifyCredential(credential);
    } catch (err) {
      if (err instanceof MembershipKeyUnavailableError) {
        return reply.code(503).send({
          error: "membership_service_unavailable",
          message: "The membership-card service is not configured.",
        });
      }
      throw err;
    }
  });
}
