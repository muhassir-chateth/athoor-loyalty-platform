import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  APP_PROXY_SIGNATURE_PARAM,
  firstQueryValue,
  verifyAppProxySignature,
  type QueryParams,
} from "../auth/appProxy.js";
import {
  UnconfiguredTokenVerifier,
  type AuthCtx,
  type CustomerAccountTokenVerifier,
  type CustomerResolver,
} from "../auth/identity.js";
import type { VerifiedCustomerEnroller } from "../enrollment/ensureCustomerEnrollment.js";

/**
 * Reusable authentication middleware for consumer `/v1` endpoints (task 6.2,
 * Requirements 9.2, 9.3, 11.3, 11.4).
 *
 * Registered inside the `/v1` router scope as a `preHandler` so it runs BEFORE
 * every current and future customer handler without per-handler wiring, and so
 * a rejected request never reaches business logic and changes no state:
 *
 *   - Web (App Proxy): Shopify's App Proxy `signature` query param is verified
 *     against the app shared secret; ONLY after it verifies is the injected
 *     `logged_in_customer_id` trusted (Req 11.3). A tampered/missing signature
 *     is rejected and `logged_in_customer_id` is ignored (Req 11.4).
 *   - Mobile / portal (Customer Account API): a `Bearer` token is validated via
 *     the injectable {@link CustomerAccountTokenVerifier} (a fake in tests; the
 *     service builds no custom auth, Req 11.5).
 *
 * Both paths resolve the Shopify customer id to a LOCAL `customers.id` via the
 * injectable {@link CustomerResolver} and attach a single {@link AuthCtx} to the
 * request before the handler runs (Req 9.2). If identity cannot be resolved the
 * request is rejected with HTTP 401 and no handler runs (Req 9.3).
 *
 * PUBLIC ROUTES: `/v1/version` and `/v1/rewards` expose non-customer data and
 * are left open (they carry no per-customer information); every other `/v1`
 * route is gated. The allowlist is overridable so a caller can extend it.
 */

/** Shopify injects the logged-in customer id as this query param on App Proxy requests. */
const LOGGED_IN_CUSTOMER_ID_PARAM = "logged_in_customer_id" as const;

/** Shopify sends `logged_in_customer_id=0` for an anonymous (not-logged-in) storefront session. */
const ANONYMOUS_CUSTOMER_ID = "0" as const;

/** The header carrying a Customer Account API bearer token (Fastify lower-cases header names). */
const AUTHORIZATION_HEADER = "authorization";
const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

/**
 * Routes that serve non-customer data and are intentionally public. Both the
 * prefixed and unprefixed forms are listed so the allowlist matches regardless
 * of whether the matched route pattern includes the `/v1` mount prefix.
 */
const DEFAULT_PUBLIC_ROUTES: readonly string[] = [
  "/v1/version",
  "/v1/rewards",
  "/version",
  "/rewards",
  // Membership-card verification (task 19.2, Req 19.5): a scanner/POS presents a
  // signed identifier and receives `{ valid, tier? }` only — no customer data —
  // so it is served without customer auth (a valid response requires a token
  // that only our dedicated signing key could have produced).
  "/v1/membership-card/verify",
  "/membership-card/verify",
];

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved identity for this request; set by the auth preHandler before the handler runs. */
    authCtx?: AuthCtx;
  }
}

export interface AuthPluginOptions {
  /** Maps a Shopify customer id → local `customers.id` (required). */
  resolver: CustomerResolver;
  /** Validates Customer Account API bearer tokens. Defaults to a fail-closed verifier. */
  tokenVerifier?: CustomerAccountTokenVerifier;
  /** App Proxy shared secret. When absent, App Proxy requests cannot be verified and are rejected. */
  appProxySecret?: string;
  /**
   * OPTIONAL lazy-enrollment boundary
   * (`enrollment/ensureCustomerEnrollment.ts` → {@link VerifiedCustomerEnroller}).
   *
   * Consulted ONLY after identity has been fully verified and the read-only
   * {@link CustomerResolver} found no local row — i.e. exactly the production
   * failure where a real, logged-in customer 401s with
   * `identity_resolution_failed` because they never passed through the
   * `customers/create` webhook.
   *
   * Auth deliberately owns NO enrollment logic: no INSERT, no award decision, no
   * knowledge that a ledger exists. It hands the enroller ONE already-verified
   * Shopify customer id and takes back a local id or `null`. The enroller is
   * given no access to this request, so nothing a browser controls — body field,
   * query parameter, header, or email — can influence which customer is enrolled.
   *
   * Omitted by default, and its own config gate defaults to off, so behaviour is
   * unchanged until it is deliberately switched on.
   */
  lazyEnroller?: VerifiedCustomerEnroller;
  /** Overrides the public (unauthenticated) route allowlist. */
  publicRoutes?: readonly string[];
}

/** Why identity resolution failed, mapped to a client-facing error below. */
type AuthFailureReason =
  | "app_proxy_signature_invalid"
  | "app_proxy_verification_unavailable"
  | "identity_resolution_failed";

type AuthResult = { ok: true; ctx: AuthCtx } | { ok: false; reason: AuthFailureReason };

interface ResolveDeps {
  resolver: CustomerResolver;
  tokenVerifier: CustomerAccountTokenVerifier;
  appProxySecret?: string;
  lazyEnroller?: VerifiedCustomerEnroller;
}

/**
 * Resolve a VERIFIED Shopify customer id to a local `customers.id`, falling back
 * to lazy enrollment when — and only when — the read-only resolver finds nothing.
 *
 * PRECONDITION, and the whole reason this is a separate function: `verifiedShopifyCustomerId`
 * has already been authenticated, either by a verified App Proxy signature (so
 * Shopify itself injected the value) or by a verified Customer Account API token
 * (so the token's subject). Both call sites below sit AFTER that verification.
 * Nothing else may call this.
 *
 * The request object is intentionally NOT a parameter. Enrollment therefore
 * cannot see a body field, query parameter, header, or browser-supplied email, so
 * a client cannot nominate which customer gets enrolled — the guarantee is
 * structural, not a rule someone has to remember.
 *
 * A `null` from the enroller (disabled, unusable id, or a failed repair) leaves
 * identity unresolved and the caller rejects with the ordinary 401 — a repair
 * failing must never become a 500, and must never let a request through
 * unidentified.
 */
async function resolveLocalCustomerId(
  verifiedShopifyCustomerId: string,
  deps: ResolveDeps,
): Promise<string | null> {
  const existing = await deps.resolver.resolveByShopifyCustomerId(verifiedShopifyCustomerId);
  if (existing) {
    return existing;
  }
  if (!deps.lazyEnroller) {
    return null;
  }
  return deps.lazyEnroller.enrollVerifiedCustomer(verifiedShopifyCustomerId);
}

/** Read a single-valued header, tolerating the array form Node uses. */
function readHeader(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

/** Extract a bearer token from the Authorization header, or undefined. */
function readBearerToken(req: FastifyRequest): string | undefined {
  const header = readHeader(req, AUTHORIZATION_HEADER);
  if (!header) {
    return undefined;
  }
  const match = BEARER_SCHEME.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

/**
 * Resolve a request to an {@link AuthCtx}. Pure with respect to its injected
 * dependencies (no framework state mutated), so it is exercised directly and
 * through the Fastify hook.
 */
async function resolveAuthContext(req: FastifyRequest, deps: ResolveDeps): Promise<AuthResult> {
  // Customer Account API path takes precedence when a bearer token is present.
  const token = readBearerToken(req);
  if (token) {
    const shopifyCustomerId = await deps.tokenVerifier.verify(token);
    if (!shopifyCustomerId) {
      return { ok: false, reason: "identity_resolution_failed" };
    }
    // The id is the SUBJECT of a token the verifier accepted — verified identity,
    // so lazy enrollment may repair a missing row for it.
    const customerId = await resolveLocalCustomerId(shopifyCustomerId, deps);
    if (!customerId) {
      return { ok: false, reason: "identity_resolution_failed" };
    }
    return { ok: true, ctx: { customerId, source: "customer_account_api", channel: "app" } };
  }

  // App Proxy path: identified by the presence of a `signature` query param.
  const query = (req.query ?? {}) as QueryParams;
  const hasSignature = firstQueryValue(query[APP_PROXY_SIGNATURE_PARAM]) != null;
  if (hasSignature) {
    // Without a configured secret we cannot verify authenticity; never trust
    // logged_in_customer_id on an unverifiable request — fail closed (Req 11.4).
    if (!deps.appProxySecret) {
      return { ok: false, reason: "app_proxy_verification_unavailable" };
    }
    // Verify the signature BEFORE trusting logged_in_customer_id (Req 11.3).
    if (!verifyAppProxySignature(query, deps.appProxySecret)) {
      // Signature invalid → ignore logged_in_customer_id, reject (Req 11.4).
      return { ok: false, reason: "app_proxy_signature_invalid" };
    }
    const shopifyCustomerId = firstQueryValue(query[LOGGED_IN_CUSTOMER_ID_PARAM]);
    if (!shopifyCustomerId || shopifyCustomerId === ANONYMOUS_CUSTOMER_ID) {
      // Verified request but no logged-in customer → cannot resolve identity.
      // Reaching lazy enrollment is impossible from here: an absent or "0"
      // (anonymous) id returns before any enrollment can be considered, so an
      // anonymous storefront session can never create loyalty state.
      return { ok: false, reason: "identity_resolution_failed" };
    }
    // Past this line the signature has verified AND Shopify supplied a non-anonymous
    // logged_in_customer_id, so the id is trusted and a missing local row may be
    // repaired. This is the ONLY value used — the query object is not consulted
    // for identity again, and the request never reaches the enroller.
    const customerId = await resolveLocalCustomerId(shopifyCustomerId, deps);
    if (!customerId) {
      return { ok: false, reason: "identity_resolution_failed" };
    }
    return { ok: true, ctx: { customerId, source: "app_proxy", channel: "web" } };
  }

  // Neither a bearer token nor an App Proxy signature: identity is unresolvable.
  return { ok: false, reason: "identity_resolution_failed" };
}

/** Map a failure reason to its HTTP status + client-facing error body. */
function rejectionFor(reason: AuthFailureReason): { status: number; body: { error: string; message: string } } {
  switch (reason) {
    case "app_proxy_signature_invalid":
      return {
        status: 401,
        body: {
          error: "app_proxy_signature_invalid",
          message: "The App Proxy signature could not be verified; logged_in_customer_id was ignored.",
        },
      };
    case "app_proxy_verification_unavailable":
      return {
        status: 401,
        body: {
          error: "app_proxy_verification_unavailable",
          message: "App Proxy requests cannot be verified because no shared secret is configured.",
        },
      };
    case "identity_resolution_failed":
      return {
        status: 401,
        body: {
          error: "identity_resolution_failed",
          message: "Could not resolve the request to a loyalty customer identity.",
        },
      };
  }
}

/**
 * Register the auth preHandler on `app`. Confine its effect to a route scope by
 * calling this inside an encapsulated plugin (the `/v1` router does exactly
 * this). Public routes are skipped; every other route must resolve to an
 * {@link AuthCtx} or the request is rejected before any handler runs.
 */
export function registerAuth(app: FastifyInstance, opts: AuthPluginOptions): void {
  const resolver = opts.resolver;
  const tokenVerifier = opts.tokenVerifier ?? new UnconfiguredTokenVerifier();
  const appProxySecret = opts.appProxySecret;
  const lazyEnroller = opts.lazyEnroller;
  const publicRoutes = new Set(opts.publicRoutes ?? DEFAULT_PUBLIC_ROUTES);

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const routeUrl = req.routeOptions?.url ?? req.url;
    if (publicRoutes.has(routeUrl)) {
      // Non-customer data (Req 9.1 read endpoints): served without auth.
      return;
    }

    const result = await resolveAuthContext(req, {
      resolver,
      tokenVerifier,
      appProxySecret,
      lazyEnroller,
    });
    if (!result.ok) {
      // Reject before the handler runs → no state change (Req 9.3, 11.4).
      const { status, body } = rejectionFor(result.reason);
      reply.code(status).send(body);
      return reply;
    }

    req.authCtx = result.ctx;
  });
}
