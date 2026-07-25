import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createQueue } from "./queue.js";
import { PgWebhookEventStore } from "./webhooks/eventStore.js";
import { PgBossWebhookEnqueuer, WEBHOOK_PROCESS_QUEUE } from "./webhooks/enqueue.js";
import { LedgerRepository } from "./ledger/repository.js";
import { PgAuditTrailRecorder } from "./admin/auditTrail.js";
import { SharedSecretAdminAuthenticator } from "./admin/adminAuth.js";
import { createLedgerAdminAdjustmentService } from "./admin/adjustmentService.js";
import {
  DefaultMembershipCredentialService,
  PgMembershipTierSource,
} from "./membership/credential.js";
import type { Queryable } from "./ledger/repository.js";
import { registerWebhookProcessingWorker, type Transactor } from "./worker.js";
import { PgBossRecurringScheduler } from "./scheduler.js";
import { registerExpiryScan } from "./expiry/scheduler.js";
import {
  PgBossPreExpiryNotifier,
  PRE_EXPIRY_NOTIFY_JOB,
} from "./expiry/preExpiryNotify.js";
import { registerPreExpiryEmailWorker, LoggingEmailProvider } from "./expiry/emailProvider.js";
import { ShopifyGraphqlAdminClient, ShopifyGraphqlMetafieldClient } from "./shopify/adminClient.js";
import { ShopifyAdminGateway } from "./shopify/adminGateway.js";
import {
  MetafieldCacheWriter,
  PgBossMetafieldCacheEnqueuer,
  registerMetafieldCacheWorker,
  METAFIELD_CACHE_JOB,
} from "./shopify/metafieldCache.js";
import {
  registerDiscountCodeWorker,
  PgBossDiscountCodeEnqueuer,
  DISCOUNT_CODE_JOB,
} from "./redemption/generateDiscountCode.js";
import { PgCustomerResolver } from "./auth/identity.js";
import { PgCustomerBalanceSource } from "./routes/balance.js";
import { PgLedgerHistorySource } from "./routes/history.js";
import { PgFragranceProfileDataSource } from "./profile/fragranceProfile.js";
import { PgPortalVisitRecorder } from "./routes/profile.js";
import { PgDeviceTokenStore } from "./devices/deviceTokens.js";
import { registerReconciliationJob } from "./reconciliation/reconcile.js";
import { registerAnalyticsRefresh } from "./admin/analyticsRefresh.js";
import { PgAnalyticsDataSource } from "./admin/pgAnalyticsDataSource.js";
import { CachedAggregateAnalyticsService } from "./admin/analyticsService.js";

/**
 * Service entrypoint. Loads validated config, wires the durable webhook dedupe
 * store (Postgres) and hand-off queue (pg-boss), registers the background
 * workers + recurring schedulers (this is the final wiring wave), builds the
 * app, and listens. Wires graceful shutdown so in-flight requests can drain.
 *
 * This file is BOOT GLUE. It constructs the already-implemented production
 * components (Shopify Admin clients/gateway, metafield cache writer, workers,
 * schedulers, analytics reader) and connects them to pg-boss/Postgres; it
 * introduces no domain logic. Because it needs a live Postgres/pg-boss/Shopify
 * to run, this wiring is NOT exercised by the unit-test suite — its correctness
 * is a type-level + static-review concern (the individual components it wires
 * are each unit-tested in isolation with fakes).
 *
 * FAIL-SAFE BOOT: the Admin-dependent workers (discount-code, metafield-cache)
 * and the reconciliation scheduler require a real Shopify Admin API token
 * (the transport is constructed with it). When the token is ABSENT — local /
 * non-Shopify runs — they are SKIPPED with a clear warning rather than stubbed
 * with a fake client, so the service still boots and serves the ledger.
 *
 * SAFETY: connecting to Postgres/pg-boss touches only OUR datastore. No Shopify
 * Admin API call is made at startup — the Admin clients only issue requests when
 * a queued job runs. Webhook topic registration is a separate deploy step (see
 * src/webhooks/registration.ts) and is never run here.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config);
  const boss = createQueue(config);
  await boss.start();
  // Ensure the hand-off queue exists before the receiver enqueues to it.
  await boss.createQueue(WEBHOOK_PROCESS_QUEUE);
  // The discount-code queue must exist before `POST /v1/redeem` enqueues a job
  // for a committed redemption (Req 3.5), independent of whether the Admin-gated
  // discount-code worker below is registered. Creating it here (idempotent) lets
  // the redeem route hand off even on a non-Shopify/local boot; the worker that
  // consumes it starts only when an Admin token is configured.
  await boss.createQueue(DISCOUNT_CODE_JOB);

  // Admin management surface (task 17.1). A pool-backed transactor runs the
  // adjustment/credit ledger append + audit append atomically (Req 10.9); the
  // shared-secret authenticator denies access without the configured admin
  // credential (Req 10.1), failing closed when no secret is configured.
  const ledgerRepo = new LedgerRepository(pool);
  const auditRecorder = new PgAuditTrailRecorder(pool);
  const adminTransactor = async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  // Background processing wiring (boot glue only — see src/worker.ts,
  // src/scheduler.ts). A single pool-backed transactor object satisfies the
  // structurally-identical `Transactor` each earning/clawback/expiry/redemption
  // unit declares, reusing the same atomic BEGIN/COMMIT/ROLLBACK helper as the
  // admin surface. No new domain logic is introduced here.
  const transactor: Transactor = { transaction: adminTransactor };

  // Build the app up-front so its logger is available for boot-time wiring
  // warnings. Analytics is served from the hourly-refreshed materialized views
  // via the Pg-backed data source (Req 20; the refresh job is registered below).
  const app = buildApp(config, {
    webhookEventStore: new PgWebhookEventStore(pool),
    webhookEnqueuer: new PgBossWebhookEnqueuer(boss),
    // Pg-backed customer sources for the authenticated `/v1` consumer surface
    // (Req 9.2, 6.x, 17.x, 19.x). Without these the endpoints fail closed
    // (empty/not-found). `tokenVerifier` is intentionally left unwired — no Pg
    // implementation exists and the App Proxy dashboard path does not need it,
    // so Customer Account bearer tokens keep the fail-closed default.
    customerResolver: new PgCustomerResolver(pool),
    balanceSource: new PgCustomerBalanceSource(pool),
    historySource: new PgLedgerHistorySource(pool),
    // DEFAULT options: the existing empty Shopify purchase source stands in
    // until a real Shopify order source is wired; preference data is read from
    // Postgres (Req 17.x).
    fragranceProfileDataSource: new PgFragranceProfileDataSource(pool),
    portalVisitRecorder: new PgPortalVisitRecorder(pool),
    deviceTokenStore: new PgDeviceTokenStore(pool),
    // Real `POST /v1/redeem` handler (design.md route table; Req 3.2–3.11): the
    // append-only ledger repo, the atomic transactor, and the pg-boss discount-
    // code enqueuer (the queue was created above).
    redeemDeps: {
      repo: ledgerRepo,
      transactor,
      enqueuer: new PgBossDiscountCodeEnqueuer(boss),
    },
    adminAuthenticator: new SharedSecretAdminAuthenticator(config.admin.authSecret),
    adminAdjustmentService: createLedgerAdminAdjustmentService(
      ledgerRepo,
      auditRecorder,
      adminTransactor,
    ),
    // Digital Membership Card (task 19.2, Req 19.5/19.6). Signs/verifies with
    // the DEDICATED membership signing key from secrets/env (never another
    // secret); reads the customer's tier read-only from the `customers` row.
    // When the key is unset the service is unavailable and the surface fails
    // closed.
    membershipCredentialService: new DefaultMembershipCredentialService(
      config.membership.signingKey,
      new PgMembershipTierSource(pool),
    ),
    // Admin analytics (task 17.3, Req 20) reads the materialized views through
    // the Pg data source; the pure metric core is unchanged.
    analyticsService: new CachedAggregateAnalyticsService(new PgAnalyticsDataSource(pool)),
  });

  const scheduler = new PgBossRecurringScheduler(boss);

  // ------------------------------------------------------------------------
  // Admin-dependent wiring (gated on the Shopify Admin API token).
  //
  // The discount-code + metafield-cache workers and the reconciliation
  // scheduler all need to reach the Shopify Admin API, whose transport is
  // constructed from `shopDomain` + `adminApiToken`. We construct them ONLY when
  // the token is present; otherwise we skip and warn (fail-safe boot). We do NOT
  // stub a fake Admin client.
  // ------------------------------------------------------------------------
  const shopDomain = config.shopify.shopDomain;
  const adminApiToken = config.shopify.adminApiToken;

  // The metafield-cache enqueuer is threaded into the webhook worker so that a
  // balance-affecting webhook refreshes the customer's cache in near real time
  // (Req 13.1). It is left undefined when the Admin token is absent (no worker
  // exists to consume the job); the reconciliation job is then the safety net.
  let metafieldEnqueuer: PgBossMetafieldCacheEnqueuer | undefined;

  if (adminApiToken) {
    // (C) Discount-code generation worker (Req 3.5/3.6, Property 10). Mints the
    // single-use, customer-bound code via the Admin GraphQL API through the
    // rate-limit-aware gateway. Runs off the request path (Req 13.2). The queue
    // itself was created unconditionally above so the redeem route can enqueue.
    const discountGateway = new ShopifyAdminGateway(
      new ShopifyGraphqlAdminClient(shopDomain, adminApiToken),
    );
    await registerDiscountCodeWorker(
      boss,
      { gateway: discountGateway, repo: ledgerRepo, transactor, db: pool },
      DISCOUNT_CODE_JOB,
    );

    // (D) Metafield-cache worker (Req 13.1/15.5). Writes the `loyalty.*` display
    // metafields via the Admin GraphQL API; the writer is non-fatal (the ledger
    // stays authoritative) and preserves last-known-good on failure (Req 15.6).
    await boss.createQueue(METAFIELD_CACHE_JOB);
    const metafieldWriter = new MetafieldCacheWriter(
      new ShopifyGraphqlMetafieldClient(shopDomain, adminApiToken),
    );
    await registerMetafieldCacheWorker(boss, { writer: metafieldWriter, db: pool });

    // Real-time cache refresh after any balance-affecting webhook (Req 13.1):
    // only meaningful now that the worker above exists to consume the jobs.
    metafieldEnqueuer = new PgBossMetafieldCacheEnqueuer(boss);

    // (E) Reconciliation scheduler (Req 1.7/13.7). Recomputes cached
    // balances/tiers from the ledger and repairs metafield-cache drift — so it
    // needs the metafield writer and is therefore Admin-gated too.
    await registerReconciliationJob(scheduler, {
      db: pool,
      transactor,
      metafieldWriter,
    });
  } else {
    app.log.warn(
      "SHOPIFY_ADMIN_API_TOKEN is not configured: skipping the discount-code worker, " +
        "the metafield-cache worker, real-time metafield refresh, and the reconciliation " +
        "scheduler (fail-safe boot for non-Shopify/local runs). No fake Admin client is " +
        "stubbed; once a token is configured the reconciliation job is the periodic cache " +
        "safety net.",
    );
  }

  // (A) Webhook processing: consume the `webhook.process` hand-off queue and
  // dispatch each verified/deduped event to its existing earning/clawback
  // handler (customers/create, orders/paid, refunds/create, orders/cancelled).
  // The handlers only append to the immutable ledger; when the metafield
  // enqueuer is wired (Admin token present), a balance-affecting outcome also
  // enqueues a cache refresh for the affected customer (Req 13.1). The queue was
  // created above.
  await registerWebhookProcessingWorker(boss, {
    repo: ledgerRepo,
    transactor,
    metafieldEnqueuer,
  });

  // (B) Daily expiry: FULL scan + pre-expiry notification sweep (Req 5.2–5.5).
  // Now that the `pre_expiry_notifications` migration exists, we wire the FULL
  // `registerExpiryScan` (scan + sweep), replacing the previous scan-only
  // wiring. The sweep enqueues `preExpiryEmail` jobs via the pg-boss notifier;
  // the ESP worker below consumes them (defaulting to the safe logging provider
  // when no real ESP is configured). Create the notification queue before
  // publishing to or consuming from it.
  await boss.createQueue(PRE_EXPIRY_NOTIFY_JOB);
  await registerPreExpiryEmailWorker(boss, { provider: new LoggingEmailProvider() });
  await registerExpiryScan(scheduler, {
    expiry: { repo: ledgerRepo, transactor },
    preExpiry: { transactor, notifier: new PgBossPreExpiryNotifier(boss) },
  });

  // (F) Analytics-aggregate refresh (Req 20.3, A12). Pure DB — no Admin token
  // needed — so it is always registered. Refreshes the materialized views the
  // Pg analytics data source reads, at least hourly.
  await registerAnalyticsRefresh(scheduler, { db: pool });

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
