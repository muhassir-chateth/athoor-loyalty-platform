import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import {
  buildRedactingLoggerOptions,
  maskRequestPath,
  REQUEST_ID_LOG_LABEL,
  type LogDestination,
} from "./observability/logRedaction.js";
import { registerVersioning } from "./plugins/versioning.js";
import { webhookRoutes } from "./plugins/webhooks.js";
import type { WebhookEventStore } from "./webhooks/eventStore.js";
import type { WebhookEnqueuer } from "./webhooks/enqueue.js";
import type { DueWorkStatusSource } from "./scheduling/dueWork.js";
import type { ReferralRoutesOptions } from "./routes/referral.js";
import { v1Routes } from "./routes/v1.js";
import { adminRoutes } from "./admin/routes.js";
import type { AdminAuthenticator } from "./admin/adminAuth.js";
import type { AdminAdjustmentService } from "./admin/adjustmentService.js";
import type { AdminCustomerLedgerSource } from "./admin/customerView.js";
import type { FraudReviewSource } from "./admin/fraudReview.js";
import type { AdminOperationsService } from "./admin/operations.js";
import type { AnalyticsService } from "./admin/analyticsService.js";
import type { BenefitRequestService } from "./admin/benefitRequests.js";
import type { FragranceProfileDataSource } from "./profile/fragranceProfile.js";
import type {
  PortalVisitRecorder,
  ProfilePreferenceStore,
  RecentlyViewedRecorder,
} from "./routes/profile.js";
import type { CustomerBalanceSource } from "./routes/balance.js";
import type { EntitlementResolver } from "./benefits/entitlementResolver.js";
import type { LedgerHistorySource } from "./routes/history.js";
import type { PortalOrderSource } from "./routes/orders.js";
import type { PortalCatalogSource } from "./routes/catalog.js";
import type { WishlistWriteStore } from "./routes/wishlist.js";
import type { PortalRedemptionSource } from "./routes/redemptions.js";
import type { BirthdayRouteOptions } from "./routes/birthday.js";
import type { PreferencesRouteOptions } from "./routes/preferences.js";
import type { ProductTaxonomy } from "./profile/inferred.js";
import type { DeviceTokenStore } from "./devices/deviceTokens.js";
import type { MembershipCredentialService } from "./membership/credential.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotency/store.js";
import type { OverdueJob } from "./scheduling/dueWork.js";
import { evaluateBackupFreshness, type LatestBackupSource } from "./reliability/backupRuns.js";
import type {
  MarketConfigDriftReport,
  MarketConfigDriftSource,
} from "./markets/configDrift.js";
import type {
  ChannelReachabilityReport,
  ChannelReachabilitySource,
} from "./channel/reachability.js";
import type { CustomerAccountTokenVerifier, CustomerResolver } from "./auth/identity.js";
import type { VerifiedCustomerEnroller } from "./enrollment/ensureCustomerEnrollment.js";
import {
  AuthChainCounters,
  type AuthChainCountersSnapshot,
} from "./plugins/authChainCounters.js";
import type { RedeemDeps } from "./redemption/redeem.js";
import { API_VERSION } from "./version.js";

/**
 * Optional runtime dependencies injected into the app. In production these are
 * backed by Postgres / pg-boss (wired in index.ts); tests and local runs omit
 * them and the webhook plugin falls back to in-memory implementations so no
 * live infrastructure is required.
 */
export interface AppDependencies {
  webhookEventStore?: WebhookEventStore;
  webhookEnqueuer?: WebhookEnqueuer;
  /**
   * OPTIONAL read-only view of due-work scheduling state, surfaced on `/health`
   * (task 24). Lets an external monitor detect a schedule that has stopped
   * firing — previously a silent failure, because pg-boss skips a missed cron
   * window without error. Omitted in tests and local runs, where `/health`
   * keeps its original shape.
   */
  dueWorkStatus?: DueWorkStatusSource;
  /**
   * OPTIONAL read-only view of the most recent successful database backup,
   * surfaced on `/health` (task 29). Supabase Free provides no automated backups
   * and no PITR, so protection comes from a daily encrypted logical dump taken
   * by `.github/workflows/backup.yml`, which records each success in
   * `backup_runs`.
   *
   * WHY IT IS REPORTED HERE: a backup that quietly stops running is the classic
   * backup failure mode — you discover it at the exact moment you need the
   * backup. This codebase has a documented history of precisely this class of
   * bug (pg-boss skipping cron windows without error; four rounds of
   * implemented-but-unreachable wiring), so the freshness of the last dump is
   * made observable rather than assumed, letting the keep-alive watchdog fail
   * loudly on it. Omitted in tests and local runs, where `/health` keeps its
   * original shape.
   */
  backupStatus?: LatestBackupSource;
  /**
   * OPTIONAL read-only market-config drift check, surfaced on `/health`
   * (task 32, Req 21.1–21.4/21.6). The engine reads the hardcoded constants;
   * this reports whether the retained rule-set rows still agree with them, so a
   * table that has quietly diverged is visible instead of misleading. Omitted in
   * tests and local runs, where `/health` keeps its previous payload exactly.
   */
  marketConfigDrift?: MarketConfigDriftSource;
  /**
   * OPTIONAL read-only channel-reachability check, surfaced on `/health`
   * (task 42, Req 19.3/19.4, A19). Reports which channels a request can be
   * attributed to and, crucially, any app-exclusive benefit or reward that is
   * therefore grantable to nobody. Omitted in tests and local runs, where
   * `/health` keeps its previous payload exactly.
   */
  channelReachability?: ChannelReachabilitySource;
  /**
   * Pg-backed dependencies for the referral attribution endpoints (task 25,
   * Req 2.9/11.8). When omitted the routes are not registered at all, so tests
   * and local runs keep the previous `/v1` surface. Production wires the ledger
   * repository, a transactor and the pool, which is what makes referral rewards
   * reachable — the engine previously had no production call site.
   */
  referralDeps?: ReferralRoutesOptions;
  /**
   * Backs idempotent replay for state-changing `/v1` requests (Req 9.6/9.7).
   * Production wires a Pg-backed store; tests and local runs omit it and an
   * in-memory store is used so no live Postgres is required.
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * Resolves a Shopify customer id → local `customers.id` for `/v1` auth
   * (Req 9.2). Production wires a Pg-backed resolver; tests and local runs omit
   * it and an empty in-memory resolver is used, so customer endpoints fail
   * closed until wired.
   */
  customerResolver?: CustomerResolver;
  /**
   * OPTIONAL lazy-enrollment boundary (`enrollment/ensureCustomerEnrollment.ts`
   * → {@link LazyEnrollmentGate}) used when a VERIFIED customer has no local
   * `customers` row yet. Production wires it only when
   * `ENROLLMENT_LAZY_FALLBACK_ENABLED` is true, which it is not by default; tests
   * and local runs omit it, so `/v1` auth behaves exactly as before. It NEVER
   * awards a signup bonus — a repaired row is not a signup.
   */
  lazyEnroller?: VerifiedCustomerEnroller;
  /**
   * OPTIONAL injected auth-chain tally. Production leaves this unset and gets a
   * fresh per-process instance; tests inject one so they can assert on the
   * counts `/health` publishes without reaching into module state.
   */
  authChainCounters?: AuthChainCounters;
  /**
   * Validates Customer Account API bearer tokens (Req 9.2, 11.5). Kept behind
   * this interface so tests inject a fake and the service never calls live
   * Shopify from a test or local run.
   */
  tokenVerifier?: CustomerAccountTokenVerifier;
  /**
   * Loads a customer's tier row + derived spendable balance for `GET /v1/balance`
   * (task 6.3). Production wires a {@link PgCustomerBalanceSource}; tests and
   * local runs omit it and an empty in-memory source is used, so the balance
   * endpoint returns a not-found response until wired. Forwarded into the `/v1`
   * router (which already accepts `balanceSource`).
   */
  balanceSource?: CustomerBalanceSource;
  /**
   * The Entitlement Resolver backing the VIP benefit surface (task 30,
   * Req 18.2/18.3/18.5/18.6). Production wires a {@link DbEntitlementResolver}
   * over the pool (index.ts); tests and local runs omit it, and then the benefit
   * routes are not registered and `GET /v1/balance` omits its `benefits` field,
   * so the existing route surface and response shape are unchanged. Forwarded
   * into the `/v1` router.
   */
  entitlementResolver?: EntitlementResolver;
  /**
   * Loads a page of a customer's ledger history + total count for
   * `GET /v1/history` (task 6.4). Production wires a {@link PgLedgerHistorySource};
   * tests and local runs omit it and an empty in-memory source is used, so the
   * history endpoint returns an empty page until wired. Forwarded into the `/v1`
   * router (which already accepts `historySource`).
   */
  historySource?: LedgerHistorySource;
  /**
   * Loads the customer's orders for `GET /v1/orders` and
   * `GET /v1/orders/:orderId` (task 8.1/8.2, design §6.3 N1/N2). Production wires
   * a caching, Shopify-backed source (index.ts). When omitted the routes answer
   * `502 upstream_unavailable` rather than an empty page, because an empty orders
   * list is a false statement about a customer's own purchases rather than a
   * fail-closed one. READ-ONLY, and nothing is persisted — Shopify is
   * authoritative for orders and no copy exists in Postgres (Req 3.3, §7.1).
   * Forwarded into the `/v1` router.
   */
  portalOrderSource?: PortalOrderSource;
  /**
   * Backs `GET /v1/catalog/products` (task 8.4, §6.3 N4). Global catalogue data, so
   * it takes NO customer scope and is validated by `assertGlobalCatalogueQuery`
   * rather than the customer-scoped guard. Omitted → the route answers
   * `502 upstream_unavailable` rather than reporting every product deleted.
   *
   * DECLARED HERE FOR A REASON. Task 8.4 built this source and index.ts constructed
   * it, but it was passed through a SPREAD — `...(x ? { x } : {})` — and TypeScript
   * applies excess-property checking only to object LITERALS. So an undeclared
   * dependency travelled silently, was never forwarded below, and the endpoint ran
   * on its refusing default in production. Declared and forwarded now, and
   * `boot.wiring.test.ts` asserts the forwarding rather than trusting it.
   */
  portalCatalogSource?: PortalCatalogSource;
  /**
   * Backs `PUT /v1/profile/wishlist/:productId` (N5, task 9.1) — the wishlist’s only
   * removal authority and the only writer of the explicit-removal tombstone.
   * Omitted → the route still registers but refuses loudly, because an absent route
   * would answer `404`, which a client reads as "not on your wishlist".
   */
  wishlistStore?: WishlistWriteStore;
  /**
   * Backs `GET /v1/redemptions` (N16, task 10.2) — issued codes with value and
   * status, which `/v1/history` alone cannot state (§9.2). Omitted → an empty
   * in-memory source.
   *
   * DECLARED AND FORWARDED TOGETHER, deliberately. Task 8.4 constructed
   * `portalCatalogSource` in index.ts and passed it through a SPREAD, which
   * bypasses excess-property checking — so an undeclared dependency travelled
   * silently and was never forwarded, and the endpoint answered 502 in production
   * until task 9.1 found it. `app.test.ts` asserts this forwarding by observing the
   * route rather than trusting the wiring.
   */
  redemptionSource?: PortalRedemptionSource;
  /**
   * Backs `GET`/`PUT /v1/profile/birthday` (N10/N11, task 12.2). DECLARED AND
   * FORWARDED together — the shape that caught `portalCatalogSource` travelling
   * through a spread, undeclared, and never reaching its route.
   */
  birthdayDeps?: BirthdayRouteOptions;
  /**
   * Backs `GET`/`PUT /v1/profile/preferences` (N12/N13, task 13.2). DECLARED AND
   * FORWARDED together, for the same reason `birthdayDeps` is.
   */
  preferencesDeps?: PreferencesRouteOptions;
  /**
   * The server-owned product→family/note mapping behind the additive `inferred`
   * block on `GET /v1/profile` (task 13.3). Absent → an empty mapping.
   */
  productTaxonomy?: ProductTaxonomy;
  /**
   * Dependencies for the spec-defined `POST /v1/redeem` handler (Req 3.2–3.11):
   * the append-only ledger repository, the atomic transactor, and the
   * discount-code job enqueuer. Production wires `{ repo, transactor,
   * enqueuer: PgBossDiscountCodeEnqueuer }` (index.ts); tests and local runs omit
   * it and the `/v1/redeem` route retains its 501 fallback so existing behaviour
   * is unchanged. Forwarded into the `/v1` router.
   */
  redeemDeps?: RedeemDeps;
  /**
   * Supplies the Fragrance_Profile data for `GET /v1/profile` and
   * `GET /v1/profile/journey` (task 14.5): purchased fragrances from paid
   * Shopify orders + Loyalty_Service preference data. Production wires a
   * Pg/Shopify-backed source; tests and local runs omit it and an empty
   * in-memory source is used, so profile endpoints return empty profiles
   * (Req 17.9) until wired.
   */
  fragranceProfileDataSource?: FragranceProfileDataSource;
  /**
   * Records portal visits for `POST /v1/profile/visit` (task 14.6), driving the
   * private-client first-visit vs returning-member experience (task 16.1,
   * Req 16.1/16.2). Production wires a Pg-backed recorder
   * ({@link PortalVisitRecorder}); tests and local runs omit it and an in-memory
   * recorder is used, so no live Postgres is required.
   */
  portalVisitRecorder?: PortalVisitRecorder;
  /**
   * Backs the profile preference writes (task 31, Req 17.2/17.4). Production
   * wires a {@link PgProfilePreferenceStore}; omitted, the favourite/wishlist
   * routes are not registered. Forwarded into the `/v1` router.
   */
  preferenceStore?: ProfilePreferenceStore;
  /**
   * Backs off-ledger recently-viewed ingestion (task 31, Req 17.5). Production
   * wires the existing `RecentlyViewedStore`. Forwarded into the `/v1` router.
   */
  recentlyViewedRecorder?: RecentlyViewedRecorder;
  /**
   * Registers/de-registers a customer's push Device_Tokens for the additive
   * `POST /v1/devices` and `DELETE /v1/devices/:token` mobile-readiness surface
   * (task 19.1, Req 19.1/19.7). Production wires a {@link PgDeviceTokenStore};
   * tests and local runs omit it and an in-memory store is used, so no live
   * Postgres is required.
   */
  deviceTokenStore?: DeviceTokenStore;
  /**
   * Backs the additive Digital Membership Card surface `GET /v1/membership-card`
   * and `GET /v1/membership-card/verify` (task 19.2, Req 19.5/19.6). Production
   * wires a {@link DefaultMembershipCredentialService} over a Pg-backed tier
   * source (built in index.ts from the dedicated signing key); tests and local
   * runs omit it and the router builds a default service from the configured
   * signing key + an empty in-memory tier source. When the dedicated key is
   * absent the surface fails closed.
   */
  membershipCredentialService?: MembershipCredentialService;
  /**
   * Verifies admin bearer tokens for the `/v1/admin/*` management surface
   * (task 17.1, Req 10.1). Production wires an SSO/JWT- or shared-secret-backed
   * {@link AdminAuthenticator}; tests and local runs omit it and a fail-closed
   * verifier is used, so the admin surface denies all access until wired.
   */
  adminAuthenticator?: AdminAuthenticator;
  /**
   * Performs admin manual adjustments / manual credits (task 17.1,
   * Req 10.2–10.4). Production wires a ledger + audit backed service; tests and
   * local runs omit it and a functional in-memory service is used so the admin
   * endpoints work without live Postgres.
   */
  adminAdjustmentService?: AdminAdjustmentService;
  /**
   * Loads a selected customer's complete ledger for the admin customer view
   * (task 17.2, Req 10.5). Production wires a Pg-backed source; tests and local
   * runs omit it and an empty in-memory source is used.
   */
  adminCustomerLedgerSource?: AdminCustomerLedgerSource;
  /**
   * Loads referrals + redemptions for the admin fraud-review view (task 17.2,
   * Req 10.6). Production wires a Pg-backed source; tests and local runs omit
   * it and an empty in-memory source is used.
   */
  fraudReviewSource?: FraudReviewSource;
  /**
   * Runs admin-initiated migration/reconciliation operations and records the
   * audit trail (task 17.2, Req 10.7/10.9). Production wires a service around
   * the real jobs; tests and local runs omit it and a functional in-memory
   * service returning zero counts is used.
   */
  adminOperationsService?: AdminOperationsService;
  /**
   * Computes Admin_Analytics from the hourly-refreshed cached aggregates
   * (task 17.3, Req 20). Production wires a materialized-view-backed data
   * source; tests and local runs omit it and a functional in-memory service is
   * used, returning empty-safe metrics until the data source is wired.
   */
  analyticsService?: AnalyticsService;
  /**
   * The benefit-request fulfilment workflow (task 41, Req 18.5/10.5/10.9).
   * Production wires a service over `benefit_requests` + the audit trail; omitted,
   * the benefit-request admin endpoints are not registered. Forwarded into the
   * `/v1/admin` router.
   */
  adminBenefitRequestService?: BenefitRequestService;
  /**
   * OPTIONAL sink for log lines (task 5.7). Production omits it and pino writes
   * to stdout, which is what the hosting platform collects.
   *
   * It exists because logging is DISABLED under `NODE_ENV=test` (see below), and
   * a privacy gate whose output nothing can read is a gate nobody can verify.
   * Supplying a destination turns logging on for that one app instance, through
   * the same redacting options production uses — so a test asserts against the
   * real serialiser rather than a reimplementation of it. The default is
   * unchanged, so the existing suite is unaffected.
   */
  logDestination?: LogDestination;
}

/**
 * Builds the Fastify application: stateless request handling, a versioned
 * `/v1` router, a version identifier on every JSON response (Req 9.8), and a
 * health endpoint. The app is created without binding a port so it can be
 * exercised directly by tests via `app.inject(...)`.
 */
export function buildApp(config: AppConfig, deps: AppDependencies = {}): FastifyInstance {
  // THE LOG-FIELD ALLOWLIST (task 5.7, Req 2.8/23.7, design §24.3) is installed
  // here, on the app's own logger, rather than offered as a helper — so it
  // governs every `app.log.*` and `req.log.*` call including ones written later,
  // and there is no unfiltered logger to reach for by mistake.
  //
  // It is not only hardening. Fastify's default request log emits `req.url`, and
  // on this service that URL carries the App Proxy `signature` and
  // `logged_in_customer_id` on every proxied storefront request — two of the
  // values §24.3 names as never-loggable. The serialiser projects `req`/`res`
  // onto `method`/`route`/`statusCode`/`durationMs` and drops the originals.
  const loggerOptions = buildRedactingLoggerOptions({
    level: config.logLevel,
    ...(deps.logDestination ? { destination: deps.logDestination } : {}),
  });

  const app = Fastify({
    // Quiet logs during tests unless a test explicitly supplies a destination to
    // assert on; the configured level otherwise. Either way the options are the
    // redacting ones, so a test can never observe an unfiltered logger.
    logger: config.env === "test" && !deps.logDestination ? false : loggerOptions,
    // §24.3 names the per-request correlation field `requestId`; pino's default
    // binding is `reqId`. Bindings do not pass through the payload serialiser, so
    // the name is set here instead. `LogController` is the supported route —
    // the top-level `requestIdLogLabel` option is deprecated in Fastify 5.
    logController: new LogController({ requestIdLogLabel: REQUEST_ID_LOG_LABEL }),
    // Trust the HTTPS-terminating proxy/edge in front of the service so
    // request protocol/ip are read from forwarded headers (Requirement 11.11).
    trustProxy: true,
  });

  // Version identifier on every response + statelessness guarantees.
  registerVersioning(app);

  // NOT-FOUND HANDLER, replacing Fastify's own for a PRIVACY reason (task 5.8,
  // Req 2.8, design §24.3).
  //
  // Fastify's `basic404` does two things this service cannot do. It logs
  //
  //     Route GET:/v1/orders/6012345678901/lines?…&logged_in_customer_id=…&signature=… not found
  //
  // and it echoes that same target back in the response body. The log line
  // carries four of §24.3's never-log rows at once — the full query string, the
  // App Proxy signature, `logged_in_customer_id`, and an order number in the
  // path — and it is emitted for EVERY unmatched request, which on a proxied
  // storefront is every mistyped or stale portal URL.
  //
  // The allowlist serialiser could not catch it: the call is
  // `log.info("<string>")`, so there was no payload to filter and no error whose
  // text the message could be compared against. Found by the log-capture gate,
  // which is what that gate is for.
  //
  // Both halves are fixed here. The log line carries `method`, the masked
  // `route` and `statusCode` — enough to see that a 404 happened and roughly
  // where — and the body names the status without repeating what was asked for.
  // `maskRequestPath` is the same reduction the serialiser applies to `route`,
  // shared rather than duplicated so the two cannot drift.
  app.setNotFoundHandler(async (req, reply) => {
    req.log.info(
      { method: req.method, route: maskRequestPath(req.url), statusCode: 404 },
      "route not found",
    );
    return reply.code(404).send({
      error: "not_found",
      message: "The requested resource does not exist on this service.",
      statusCode: 404,
    });
  });

  // Aggregate auth-chain stop points, shared between the auth middleware that
  // records them and the `/health` route that publishes them. Created here
  // because that shared ownership is the only reason it is not a local of
  // either one. Counts and a closed set of labels only — never an identifier;
  // see `plugins/authChainCounters.ts`.
  const authChainCounters = deps.authChainCounters ?? new AuthChainCounters();

  // Liveness/readiness probe (not under /v1 — infra concern, not a loyalty op).
  //
  // This is also the endpoint an external free scheduler pings to WAKE a host
  // that sleeps when idle (task 24). It is deliberately side-effect-free: the
  // ping only causes the process to start, and the due-work ticker inside the
  // service then decides what is actually due from its own persisted timestamps.
  // No scheduling authority is delegated to the caller, so no credential is
  // shared and no mutating endpoint is exposed.
  //
  // When a due-work status source is wired it also reports schedules overdue
  // beyond their grace period, so a monitor can detect a schedule that has
  // stopped firing — the failure mode that was previously silent. Reporting is
  // best-effort: if the lookup fails the probe still answers `ok`, because
  // liveness must not depend on the scheduling table.
  //
  // The `backups` block (task 29) follows the IDENTICAL pattern for the same
  // reason: Supabase Free has no automated backups and no PITR, so protection is
  // a daily encrypted logical dump whose only durable evidence is a `backup_runs`
  // row. A backup mechanism that silently stops is worthless — you learn about it
  // when you need the backup — so its freshness is published here where the
  // existing keep-alive watchdog can fail loudly on it. Also best-effort: a
  // failed lookup omits the block rather than failing the probe.
  app.get("/health", async () => {
    const payload: {
      status: string;
      version: string;
      build?: { commit: string | null; deployedAt: string | null };
      runtime?: { lazyEnrollmentFallbackEnabled: boolean; lazyEnrollerWired: boolean };
      authChain?: AuthChainCountersSnapshot;
      scheduling?: { overdue: OverdueJob[] };
      backups?: { lastSuccessAt: string | null; ageHours: number | null; stale: boolean };
      marketConfig?: MarketConfigDriftReport;
      channels?: ChannelReachabilityReport;
    } = { status: "ok", version: API_VERSION };

    // WHICH BUILD IS ACTUALLY RUNNING, and WHETHER the enrollment fallback is
    // actually live in it.
    //
    // WHY THIS EXISTS. After deploying the lazy-enrollment fallback and setting
    // ENROLLMENT_LAZY_FALLBACK_ENABLED=true, the authenticated /v1 surface still
    // returned 401. Two very different causes produce that identical response —
    // the flag not being parsed by the running process, or Shopify not supplying
    // `logged_in_customer_id` — and the service published NOTHING that could tell
    // them apart: no build identifier, no config echo. Diagnosis stalled on an
    // observability gap rather than on a hard problem.
    //
    // `commit` is read from the platform's own build variable, so it cannot drift
    // from what is deployed the way a hand-maintained version string does.
    //
    // PRIVACY: a commit SHA, a timestamp and two booleans. No secret, no
    // customer data, nothing that reveals a credential. `lazyEnrollerWired`
    // reports whether the collaborator was actually constructed and injected,
    // which is a stricter statement than the flag alone — the flag could be true
    // while the wiring was missed.
    payload.build = {
      commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
      deployedAt: process.env.RENDER_SERVICE_STARTED_AT ?? null,
    };
    payload.runtime = {
      lazyEnrollmentFallbackEnabled: config.enrollment.lazyFallbackEnabled,
      // Read at request time through the SAME deferred property the auth plugin
      // resolves, so this cannot claim the fallback is live while auth holds
      // `undefined` — the disagreement that concealed the wiring defect.
      lazyEnrollerWired: deps.lazyEnroller !== undefined,
    };

    // WHERE gated requests are actually stopping, in aggregate.
    //
    // `runtime` above says whether the fallback is live; this says whether it is
    // ever REACHED, which is the other half of the same question. A verified
    // request that carries no `logged_in_customer_id` and a wired-but-unreached
    // fallback are different defects with the same 401, and the difference shows
    // up here as `verified_but_no_customer_id` versus
    // `no_local_row_fallback_not_wired`.
    //
    // PRIVACY: counts against a closed set of ten labels. No id — not even a
    // masked suffix — no route, no timestamp per request, no IP.
    payload.authChain = authChainCounters.snapshot();

    if (deps.dueWorkStatus) {
      try {
        payload.scheduling = { overdue: await deps.dueWorkStatus.listOverdue() };
      } catch {
        // Best-effort: liveness must not depend on the scheduling table.
      }
    }

    if (deps.backupStatus) {
      try {
        const latest = await deps.backupStatus.getLatestSuccessful();
        const freshness = evaluateBackupFreshness(latest, new Date());
        payload.backups = {
          lastSuccessAt: freshness.lastSuccessAt,
          ageHours: freshness.ageHours,
          // `stale` is true both when the newest dump is too old AND when none
          // has ever been recorded — from a monitor's point of view "no recovery
          // point" is at least as urgent as "an ageing one".
          stale: !freshness.ok,
        };
      } catch {
        // Best-effort: liveness must not depend on the backup bookkeeping table.
      }
    }

    // Market-config drift (task 32). The engine reads the hardcoded constants;
    // `markets` / `earning_rule_sets` / `reward_rule_sets` are retained as the
    // forward path for a second market. Two representations of the same rules
    // therefore exist and only one is obeyed, so this block states which
    // (`source: "constants"`) and whether the configured rows still agree.
    // Publishing it is what stops an operator reading a rule-set row and drawing
    // a false conclusion about live behaviour. Informational — drift never fails
    // the probe, because no engine decision depends on those rows.
    if (deps.marketConfigDrift) {
      try {
        payload.marketConfig = await deps.marketConfigDrift.report();
      } catch {
        // Best-effort: liveness must not depend on the rule-set tables either.
      }
    }

    // Channel reachability (task 42). No Customer Account API token verifier is
    // wired, so `channel: "app"` cannot be reached and every request is `web`
    // (A19). That is deliberate, but it makes one configuration edit dangerous:
    // flipping a benefit to `appExclusive` — a data change, no deploy — would
    // make it grantable to NOBODY, silently, because the gate is working exactly
    // as specified. `ungrantable` names any such item so the mistake is visible
    // instead of an entitlement quietly vanishing for every member.
    if (deps.channelReachability) {
      try {
        payload.channels = await deps.channelReachability.report();
      } catch {
        // Best-effort: liveness must not depend on the benefit configuration.
      }
    }

    return payload;
  });

  // Mount all loyalty operations under /v1 (Requirement 9.1). The router also
  // enforces the idempotency contract for state-changing requests (Req 9.6/9.7)
  // using the injected store, defaulting to in-memory when absent.
  // Every request is resolved to a local customer identity before any handler
  // runs (Req 9.2/9.3); web via App Proxy signature (Req 11.3/11.4) and mobile
  // via a Customer Account API bearer token converge on one AuthCtx. The App
  // Proxy shared secret comes from config; the resolver/verifier are injected
  // (defaulting to fail-closed in-memory implementations).
  const idempotencyStore = deps.idempotencyStore ?? new InMemoryIdempotencyStore();
  app.register(v1Routes, {
    prefix: "/v1",
    idempotencyStore,
    customerResolver: deps.customerResolver,
    // A FUNCTION, not a plain read. `deps.lazyEnroller` may be a getter backed by
    // a variable `index.ts` assigns only after buildApp returns; reading it here
    // would capture `undefined` forever and auth would never see the enroller.
    // That was a live production defect — see LazyEnrollerSource in plugins/auth.ts.
    lazyEnroller: () => deps.lazyEnroller,
    // Same instance the /health route reads, so what is published is what the
    // auth middleware actually recorded.
    authChainCounters,
    tokenVerifier: deps.tokenVerifier,
    appProxySecret: config.shopify.appProxySecret,
    balanceSource: deps.balanceSource,
    entitlementResolver: deps.entitlementResolver,
    historySource: deps.historySource,
    portalOrderSource: deps.portalOrderSource,
    portalCatalogSource: deps.portalCatalogSource,
    wishlistStore: deps.wishlistStore,
    redemptionSource: deps.redemptionSource,
    birthdayDeps: deps.birthdayDeps,
    preferencesDeps: deps.preferencesDeps,
    productTaxonomy: deps.productTaxonomy,
    redeemDeps: deps.redeemDeps,
    fragranceProfileDataSource: deps.fragranceProfileDataSource,
    portalVisitRecorder: deps.portalVisitRecorder,
    preferenceStore: deps.preferenceStore,
    recentlyViewedRecorder: deps.recentlyViewedRecorder,
    deviceTokenStore: deps.deviceTokenStore,
    membershipCredentialService: deps.membershipCredentialService,
    // Dedicated membership signing key (Req 19.5). When no explicit service is
    // injected, the router builds the default service from this key; when the
    // key is absent the membership-card surface fails closed.
    membershipSigningKey: config.membership.signingKey,
    // Referral attribution endpoints (task 25). Registered only when wired.
    referralDeps: deps.referralDeps,
  });

  // Inbound Shopify webhooks. Registered as an encapsulated plugin so its
  // raw-body content-type parser and HMAC gate (Requirements 11.1, 11.2) apply
  // only under /webhooks and never alter JSON parsing for /v1 or /health.
  // Dedupe/persist/enqueue (Req 12.1–12.5, 13.8) use the injected store and
  // enqueuer, defaulting to in-memory implementations when absent.
  app.register(webhookRoutes, {
    config,
    eventStore: deps.webhookEventStore,
    enqueuer: deps.webhookEnqueuer,
    prefix: "/webhooks",
  });

  // Admin management surface (task 17.1, Requirement 10). Registered as its OWN
  // encapsulated plugin under /v1/admin so the consumer-identity preHandler in
  // v1Routes does not apply; instead an ADMIN-auth preHandler gates every admin
  // route, denying access without an authenticated admin role and performing no
  // data change (Req 10.1). Manual adjustments/credits create one `adjust`
  // ledger entry plus one immutable audit record (Req 10.2–10.4, 10.9). The
  // authenticator defaults to fail-closed and the adjustment service to a
  // functional in-memory implementation, so the surface boots without live infra.
  // The customer-view (Req 10.5), fraud-review (Req 10.6), and
  // migration/reconciliation operation (Req 10.7) surfaces are added by
  // task 17.2, all behind injectable sources/services defaulting to in-memory.
  app.register(adminRoutes, {
    prefix: "/v1/admin",
    adminAuthenticator: deps.adminAuthenticator,
    adjustmentService: deps.adminAdjustmentService,
    customerLedgerSource: deps.adminCustomerLedgerSource,
    fraudReviewSource: deps.fraudReviewSource,
    operationsService: deps.adminOperationsService,
    analyticsService: deps.analyticsService,
    benefitRequestService: deps.adminBenefitRequestService,
  });

  return app;
}
