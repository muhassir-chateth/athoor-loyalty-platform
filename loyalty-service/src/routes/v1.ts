import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_VERSION } from "../version.js";
import { REWARD_CATALOG, UnknownRewardError } from "../rewards/catalog.js";
import {
  redeem,
  CustomerNotFoundError,
  InvalidIdempotencyKeyError,
  LockTimeoutError,
  RedemptionInsufficientPointsError,
  RewardChannelNotAllowedError,
  type RedeemDeps,
} from "../redemption/redeem.js";
import { registerIdempotency } from "../plugins/idempotency.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import { registerAuth } from "../plugins/auth.js";
import { registerBalanceRoute, type CustomerBalanceSource } from "./balance.js";
import { registerHistoryRoute, type LedgerHistorySource } from "./history.js";
import { registerProfileRoutes, type ProfileRouteOptions } from "./profile.js";
import { registerDeviceRoutes, type DeviceRouteOptions } from "./devices.js";
import { registerReferralRoutes, type ReferralRoutesOptions } from "./referral.js";
import { registerBenefitRoutes } from "./benefits.js";
import type { EntitlementResolver } from "../benefits/entitlementResolver.js";
import {
  registerMembershipCardRoutes,
  type MembershipCardRouteOptions,
} from "./membershipCard.js";
import {
  createRedemptionRateLimiter,
  type RedemptionRateLimiterOptions,
} from "../plugins/rateLimit.js";
import {
  InMemoryCustomerResolver,
  type CustomerAccountTokenVerifier,
  type CustomerResolver,
} from "../auth/identity.js";
import type { VerifiedCustomerEnroller } from "../enrollment/ensureCustomerEnrollment.js";

/**
 * Options accepted by the `/v1` router.
 */
export interface V1RouterOptions {
  /**
   * Store backing idempotent replay of state-changing requests (Req 9.6/9.7).
   * Defaults to an in-memory store inside {@link registerIdempotency} so the
   * router runs with no live Postgres.
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * Resolves a Shopify customer id → local `customers.id` for auth (Req 9.2).
   * Defaults to an empty in-memory resolver so the gateway boots without a live
   * Postgres; customer endpoints then fail closed with an identity-resolution
   * error until a real resolver is wired.
   */
  customerResolver?: CustomerResolver;
  /**
   * Validates Customer Account API bearer tokens (Req 9.2, 11.5). Defaults to a
   * fail-closed verifier inside {@link registerAuth}; do NOT call live Shopify.
   */
  tokenVerifier?: CustomerAccountTokenVerifier;
  /**
   * App Proxy shared secret used to verify Shopify's signature (Req 11.3). When
   * absent, App Proxy requests to customer endpoints are rejected (fail closed).
   */
  appProxySecret?: string;
  /**
   * OPTIONAL lazy-enrollment boundary for a VERIFIED customer with no local row
   * (`enrollment/ensureCustomerEnrollment.ts`). Forwarded to the auth middleware,
   * which consults it only AFTER identity has been verified and the read-only
   * resolver returned nothing. Omitted by default — and gated by
   * `ENROLLMENT_LAZY_FALLBACK_ENABLED`, which defaults to false — so the auth
   * surface is unchanged until it is deliberately enabled.
   */
  lazyEnroller?: VerifiedCustomerEnroller;
  /**
   * Loads a customer's tier row + derived spendable balance for `GET /v1/balance`
   * (task 6.3). Defaults inside the balance route to an empty in-memory source
   * so the gateway boots without a live Postgres; the balance endpoint then
   * returns a not-found response until a real source is wired.
   */
  balanceSource?: CustomerBalanceSource;
  /**
   * Loads a page of a customer's ledger history + total count for
   * `GET /v1/history` (task 6.4). Defaults inside the history route to an empty
   * in-memory source so the gateway boots without a live Postgres; the history
   * endpoint then returns an empty page until a real source is wired.
   */
  historySource?: LedgerHistorySource;
  /**
   * Per-customer redemption rate-limit configuration for `POST /v1/redeem`
   * (task 6.5, Req 11.12). Defaults to 10 requests / 60s keyed on
   * `req.authCtx.customerId`. Injectable so tests can supply a fake clock/store.
   */
  redeemRateLimit?: RedemptionRateLimiterOptions;
  /**
   * Dependencies for the spec-defined `POST /v1/redeem` handler (design.md route
   * table + Data Flow: Redemption; Req 3.2–3.11): the append-only ledger
   * repository, the atomic transactor, and the discount-code job enqueuer. When
   * present the route serves the real handler over the EXISTING {@link redeem}
   * engine; when ABSENT (tests/local) the route retains its 501 fallback so
   * existing behaviour/tests are unchanged.
   */
  redeemDeps?: RedeemDeps;
  /**
   * Dependencies for the referral attribution endpoints (task 25, Req 2.9).
   * Production wires the ledger repo, transactor and pool; when ABSENT the
   * referral routes are not registered at all, so tests and local runs keep
   * their existing route surface.
   */
  referralDeps?: ReferralRoutesOptions;
  /**
   * Supplies the Fragrance_Profile data for `GET /v1/profile` and
   * `GET /v1/profile/journey` (task 14.5): purchased fragrances from paid
   * Shopify orders + Loyalty_Service preference data. Defaults inside the
   * profile routes to an empty in-memory source so the gateway boots without a
   * live Shopify/Postgres; the profile endpoints then return empty profiles
   * (Req 17.9) until a real source is wired.
   */
  fragranceProfileDataSource?: ProfileRouteOptions["fragranceProfileDataSource"];
  /**
   * Records portal visits for `POST /v1/profile/visit` (task 14.6), driving the
   * private-client first-visit vs returning-member experience (task 16.1,
   * Req 16.1/16.2). Defaults inside the profile routes to an in-memory recorder
   * so the gateway boots without a live Postgres; a Pg-backed recorder is
   * injected at deploy time.
   */
  portalVisitRecorder?: ProfileRouteOptions["portalVisitRecorder"];
  /**
   * Backs the profile preference WRITES — `PUT /v1/profile/favourites/:id`,
   * `POST /v1/profile/wishlist/reconcile` and their paired reads (task 31,
   * Req 17.2/17.4). Production wires `PgProfilePreferenceStore`; absent, those
   * routes are not registered so the existing surface is unchanged.
   */
  preferenceStore?: ProfileRouteOptions["preferenceStore"];
  /**
   * Backs `POST /v1/profile/recently-viewed` (task 31, Req 17.5). Production
   * wires the existing `RecentlyViewedStore`, which owns sampling and retention.
   */
  recentlyViewedRecorder?: ProfileRouteOptions["recentlyViewedRecorder"];
  /**
   * Registers/de-registers a customer's push Device_Tokens for
   * `POST /v1/devices` and `DELETE /v1/devices/:token` (task 19.1, Req 19.1).
   * Additive `/v1` mobile-readiness surface. Defaults inside the device routes
   * to an in-memory store so the gateway boots without a live Postgres; a
   * Pg-backed store is injected at deploy time.
   */
  deviceTokenStore?: DeviceRouteOptions["deviceTokenStore"];
  /**
   * The Membership-Credential service backing `GET /v1/membership-card` and
   * `GET /v1/membership-card/verify` (task 19.2, Req 19.5/19.6). Additive `/v1`
   * mobile-readiness surface. When omitted a default service is built from
   * {@link membershipSigningKey} + an empty in-memory tier source, so the
   * gateway boots without a live Postgres; a Pg-backed tier source is injected
   * at deploy time.
   */
  membershipCredentialService?: MembershipCardRouteOptions["membershipCredentialService"];
  /**
   * The DEDICATED membership signing key from config (`membership.signingKey`,
   * Req 19.5) used to build the default Membership-Credential service. Never
   * reuses another secret. When absent the membership-card surface fails closed.
   */
  membershipSigningKey?: string;
  /**
   * The Entitlement Resolver backing `GET /v1/benefits`,
   * `POST /v1/benefits/:key/request` and the `benefits` field of
   * `GET /v1/balance` (task 30, Req 18.2/18.3/18.5/18.6). Production wires
   * `DbEntitlementResolver` over the pool. When ABSENT the benefit routes are
   * not registered and the balance body omits `benefits`, so tests and local
   * runs keep their existing route surface and response shape.
   */
  entitlementResolver?: EntitlementResolver;
}

/**
 * The versioned `/v1` router. Every loyalty operation is mounted under this
 * prefix (Requirement 9.1) — nothing loyalty-related is exposed outside `/v1`,
 * because this encapsulated plugin is registered with the `/v1` prefix and no
 * loyalty handler is registered anywhere else. Request handling is stateless
 * (Requirement 9.8): no session state is kept and no session cookie is set.
 *
 * VERSIONING POLICY (Requirements 9.4, 9.5): changes to `/v1` are **additive
 * only** — new endpoints and new optional fields may be added, but no existing
 * `/v1` endpoint or field is removed or renamed. Any breaking change ships
 * under a new version path (`/v2`), leaving `/v1` unchanged so a released
 * client (web or a future mobile app) never breaks.
 *
 * IDEMPOTENCY (Requirements 9.6, 9.7): the idempotency middleware is registered
 * at the top of this scope, so every state-changing `/v1` operation — current
 * and future — requires a 1–128 char `Idempotency-Key`, rejects a missing or
 * invalid key, and returns the stored result for a repeated key within a 24h
 * window without re-running the handler.
 */
export async function v1Routes(app: FastifyInstance, opts: V1RouterOptions = {}): Promise<void> {
  // Identity resolution for consumer endpoints, scoped to /v1 (task 6.2,
  // Req 9.2/9.3, 11.3/11.4). Registered first so identity is resolved before
  // any other preHandler (including idempotency) runs on a customer endpoint.
  // `/v1/version` and `/v1/rewards` are left public (non-customer data). The
  // default resolver is empty, so customer endpoints fail closed until a real
  // resolver/verifier is wired via app dependencies.
  registerAuth(app, {
    resolver: opts.customerResolver ?? new InMemoryCustomerResolver(),
    tokenVerifier: opts.tokenVerifier,
    appProxySecret: opts.appProxySecret,
    lazyEnroller: opts.lazyEnroller,
  });

  // Idempotency + validation for state-changing requests, scoped to /v1.
  // Its preHandler gate runs after auth so identity is known first.
  registerIdempotency(app, opts.idempotencyStore);

  // Version discovery endpoint. Proves the /v1 mount is live and surfaces the
  // version identifier (also injected into every JSON payload by the plugin).
  app.get("/version", async () => {
    return { version: API_VERSION };
  });

  // Reward catalog (task 5.1, Req 3.1). Read-only: returns exactly the four
  // redeemable rewards (100→£5, 250→£15, 500→£35, 1000→£75). Wrapped in an
  // object (not a bare array) so the versioning plugin can inject the version
  // field into the JSON payload.
  app.get("/rewards", async () => {
    return { rewards: REWARD_CATALOG };
  });

  // Authenticated balance summary (task 6.3, Req 7.5/7.6/8.5): spendable
  // balance, tier + progress, and available rewards for the resolved customer.
  // The entitlement resolver is threaded into the balance summary so a
  // customer's qualifying Benefits travel with the account data the dashboard
  // already reads (Req 18.2), not only on the dedicated endpoint below.
  registerBalanceRoute(app, {
    balanceSource: opts.balanceSource,
    entitlementResolver: opts.entitlementResolver,
  });

  // Authenticated, paginated transaction history (task 6.4, Req 6.1–6.7):
  // entries typed earned/spent/expired with reason, ISO date, and order
  // reference, most-recent-first, with total count and a next-page indicator.
  registerHistoryRoute(app, { historySource: opts.historySource });

  // Authenticated Fragrance_Profile + journey timeline (task 14.5, Req 17.1,
  // 17.8, 17.9, 17.10): purchased fragrances (paid Shopify orders) plus
  // favourites/wishlist/recently-viewed/suggestions on GET /v1/profile, and the
  // chronological journey milestones on GET /v1/profile/journey. Empty
  // categories return empty (never an error); only the resolved customer's data
  // is returned.
  // Preference WRITES (task 31, Req 17.2/17.4/17.5; reachability finding 3): the
  // profile could be read and never written, so `setFavourite`,
  // `reconcileWishlist` and `RecentlyViewedStore` had no production call site.
  registerProfileRoutes(app, {
    fragranceProfileDataSource: opts.fragranceProfileDataSource,
    portalVisitRecorder: opts.portalVisitRecorder,
    preferenceStore: opts.preferenceStore,
    recentlyViewedRecorder: opts.recentlyViewedRecorder,
  });

  // Mobile readiness (task 19.1, Req 19.1/19.7): additive device-token
  // registration/de-registration under /v1 (POST /v1/devices,
  // DELETE /v1/devices/:token). Introduced WITHOUT changing any existing web
  // endpoint or field. Both are state-changing, so the scope-level idempotency
  // plugin requires an Idempotency-Key; both run after the auth preHandler so
  // the token is bound to the resolved customer. Off-ledger — never touches a
  // customer's Balance. Notification events targeting these tokens (Req 19.2)
  // are modelled in devices/deviceTokens.ts and the task 19.1 migration.
  registerDeviceRoutes(app, { deviceTokenStore: opts.deviceTokenStore });

  // Referral attribution (task 25, Req 2.9/11.8): `GET /v1/referral` returns the
  // member's own code, `POST /v1/referral` applies a code they were given and
  // credits the referrer +150 through the existing engine. Registered only when
  // the Pg-backed dependencies are wired, so tests and local runs are unchanged.
  // Both inherit this scope's App Proxy auth and, for the POST, the idempotency
  // contract — no new security surface.
  if (opts.referralDeps) {
    registerReferralRoutes(app, opts.referralDeps);
  }

  // VIP benefits (task 30, Req 18.2/18.3/18.5/18.6; reachability finding 2).
  // `GET /v1/benefits` returns the Benefits the customer's derived tier
  // qualifies for; `POST /v1/benefits/:key/request` records an invocation of an
  // enabled Benefit and denies an unqualified one with the required tier and no
  // state change. Every decision belongs to the existing Entitlement Resolver;
  // the routes only map its typed outcomes to HTTP. Registered only when the
  // resolver is wired, so tests and local runs are unchanged.
  if (opts.entitlementResolver) {
    registerBenefitRoutes(app, { entitlementResolver: opts.entitlementResolver });
  }

  // Mobile readiness (task 19.2, Req 19.5/19.6): additive Digital Membership
  // Card credential surface under /v1. `GET /v1/membership-card` (authenticated)
  // issues an opaque, non-PII member id + tier + signature + QR payload for
  // wallet-pass readiness; `GET /v1/membership-card/verify` (public — no
  // customer data) confirms a presented signed identifier as `{ valid, tier? }`
  // only. Signed/verified with a DEDICATED key (never another secret); fails
  // closed (503) when the key is unconfigured. Off-ledger — never touches a
  // customer's Balance. Introduced WITHOUT changing any existing endpoint/field.
  registerMembershipCardRoutes(app, {
    membershipCredentialService: opts.membershipCredentialService,
    membershipSigningKey: opts.membershipSigningKey,
  });

  // Redemption (design.md route table `POST /v1/redeem` → RedemptionResult; Data
  // Flow: Redemption; Req 3.2/3.3/3.7/3.9/3.10/3.11, 19.4). The limiter is
  // attached as a route-level preHandler so it runs AFTER the scope-level auth
  // preHandler has resolved `req.authCtx` and rejects the 11th+ request within
  // any 60s window per customer with HTTP 429 (Req 11.12). The scope-level
  // idempotency plugin (registered above) already requires an `Idempotency-Key`
  // for this state-changing POST and replays a repeated key within the 24h
  // window (Req 9.6/9.7).
  //
  // The handler drives the EXISTING {@link redeem} engine — it invents no new
  // behaviour — and maps its typed outcomes/errors to HTTP. When `redeemDeps` is
  // not injected (tests/local) the route retains the original 501 fallback so
  // existing behaviour/tests are unchanged; the real handler serves only once
  // deps are wired in index.ts.
  const redeemDeps = opts.redeemDeps;
  app.post(
    "/redeem",
    { preHandler: [createRedemptionRateLimiter(opts.redeemRateLimit)] },
    async (req, reply) => {
      // Not wired (tests/local): keep the pre-existing 501 contract verbatim.
      if (!redeemDeps) {
        return reply.code(501).send({
          error: "not_implemented",
          message: "The redemption endpoint is not yet available on this build.",
        });
      }

      // Identity is normally resolved by the scope auth preHandler; reject
      // defensively if absent so no redemption runs without an identity (Req 9.3).
      const ctx = req.authCtx;
      if (!ctx) {
        return reply.code(401).send({
          error: "identity_resolution_failed",
          message: "Could not resolve the request to a loyalty customer identity.",
        });
      }

      // Validate the body: `{ rewardId, idempotencyKey }` (design.md RedeemBody).
      // An unknown reward id itself is rejected by the engine (Req 3.10); here we
      // only enforce the shape.
      const parsed = REDEEM_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "A redemption requires a body of { rewardId, idempotencyKey }.",
        });
      }
      const { rewardId, idempotencyKey } = parsed.data;

      try {
        // Attribute the redemption to the resolved channel (web via App Proxy,
        // app via a Customer Account API bearer token) (Req 19.3/19.4).
        const outcome = await redeem(
          ctx.customerId,
          rewardId,
          idempotencyKey,
          redeemDeps,
          ctx.channel,
        );
        // `redeemed` (new spend) and `replayed` (existing redemption, Req 3.7)
        // both return 200 with the redemption (RedemptionResult).
        return reply.code(200).send(outcome.redemption);
      } catch (err) {
        // Map the engine's EXISTING typed errors to HTTP (no new behaviour).
        if (err instanceof UnknownRewardError) {
          return reply.code(400).send({ error: "invalid_reward", message: err.message }); // Req 3.10
        }
        if (err instanceof RedemptionInsufficientPointsError) {
          return reply.code(409).send({ error: err.code, message: err.message }); // Req 3.3/5.7
        }
        if (err instanceof RewardChannelNotAllowedError) {
          return reply.code(403).send({ error: err.code, message: err.message }); // Req 19.4
        }
        if (err instanceof LockTimeoutError) {
          return reply.code(503).send({ error: err.code, message: err.message }); // Req 3.11
        }
        if (err instanceof CustomerNotFoundError) {
          return reply.code(404).send({ error: err.code, message: err.message });
        }
        if (err instanceof InvalidIdempotencyKeyError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}

/**
 * Zod schema for the `POST /v1/redeem` body (design.md → `RedeemBody`):
 * `{ rewardId: RewardId; idempotencyKey: string }`. Enforces only the shape —
 * an unknown reward id is rejected by the redemption engine (Req 3.10) and an
 * oversized/blank idempotency key by the engine's own validation. Unknown keys
 * are stripped so the contract stays additive-friendly.
 */
const REDEEM_BODY_SCHEMA = z
  .object({
    rewardId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strip();
