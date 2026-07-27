/**
 * Boot-wiring regression test (task 14).
 *
 * PROBLEM THIS TEST SOLVES
 * ------------------------
 * Unit tests inject their own fakes, so they pass identically whether or not
 * `index.ts` wires the real Pg-backed implementations. This is exactly how four
 * rounds of "implemented but never reachable" gaps survived a 1 000+ test suite:
 *
 *   - PgIdempotencyStore  (this task)
 *   - PgFraudReviewSource / PgAdminCustomerLedgerSource / CallbackAdminOperations (task 7)
 *   - Referral engine (task 25)
 *   - Analytics, reconciliation, metafield cache (various tasks)
 *
 * This test guards against future regressions of the same kind: it reads the
 * *source text* of `index.ts` and asserts that each critical Pg-backed class is
 * both imported and actually passed into `buildApp`. If someone removes a wiring
 * line, this test fails — which is exactly the signal we want.
 *
 * APPROACH
 * --------
 * We do NOT spin up Postgres or pg-boss. We simply read the source file and look
 * for the patterns that production wiring must contain. This keeps the test fast,
 * infrastructure-free, and portable across CI environments.
 *
 * If `index.ts` is split into multiple files in future, update the patterns below
 * to match the new structure.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(__dirname, "index.ts"), "utf8");

describe("boot wiring regression — index.ts must wire Pg-backed implementations", () => {
  // -------------------------------------------------------------------------
  // 1. Idempotency store (Req 9.6/9.7, task 14)
  //    The in-memory fallback is process-local and lost on spin-down; the Pg
  //    store survives restarts and delivers the promised 24-hour window.
  // -------------------------------------------------------------------------
  it("imports PgIdempotencyStore", () => {
    expect(indexSource).toMatch(/import\s.*PgIdempotencyStore.*from/);
  });

  it("passes PgIdempotencyStore to buildApp as idempotencyStore", () => {
    expect(indexSource).toMatch(/idempotencyStore\s*:\s*new\s+PgIdempotencyStore\s*\(/);
  });

  // -------------------------------------------------------------------------
  // 2. Admin read surfaces (task 7, Req 10.5/10.6/10.7)
  // -------------------------------------------------------------------------
  it("imports PgAdminCustomerLedgerSource", () => {
    expect(indexSource).toMatch(/import\s.*PgAdminCustomerLedgerSource.*from/);
  });

  it("passes PgAdminCustomerLedgerSource to buildApp as adminCustomerLedgerSource", () => {
    expect(indexSource).toMatch(/adminCustomerLedgerSource\s*:\s*new\s+PgAdminCustomerLedgerSource\s*\(/);
  });

  it("imports PgFraudReviewSource", () => {
    expect(indexSource).toMatch(/import\s.*PgFraudReviewSource.*from/);
  });

  it("passes PgFraudReviewSource to buildApp as fraudReviewSource", () => {
    expect(indexSource).toMatch(/fraudReviewSource\s*:\s*new\s+PgFraudReviewSource\s*\(/);
  });

  it("imports CallbackAdminOperationsService", () => {
    // Multi-line import: the symbol name appears somewhere in the import block.
    expect(indexSource).toMatch(/CallbackAdminOperationsService/);
    expect(indexSource).toMatch(/from\s+["']\.\/admin\/operations/);
  });

  it("passes CallbackAdminOperationsService to buildApp as adminOperationsService", () => {
    expect(indexSource).toMatch(/adminOperationsService\s*:\s*new\s+CallbackAdminOperationsService\s*\(/);
  });

  // -------------------------------------------------------------------------
  // 3. Customer sources for /v1 (Req 9.2, 6.x, task 7)
  // -------------------------------------------------------------------------
  it("imports PgCustomerResolver", () => {
    expect(indexSource).toMatch(/import\s.*PgCustomerResolver.*from/);
  });

  it("passes PgCustomerResolver to buildApp as customerResolver", () => {
    expect(indexSource).toMatch(/customerResolver\s*:\s*new\s+PgCustomerResolver\s*\(/);
  });

  it("imports PgCustomerBalanceSource", () => {
    expect(indexSource).toMatch(/import\s.*PgCustomerBalanceSource.*from/);
  });

  it("passes PgCustomerBalanceSource to buildApp as balanceSource", () => {
    expect(indexSource).toMatch(/balanceSource\s*:\s*new\s+PgCustomerBalanceSource\s*\(/);
  });

  // -------------------------------------------------------------------------
  // 4. Webhook event store (task 23, Req 12.x)
  // -------------------------------------------------------------------------
  it("imports PgWebhookEventStore", () => {
    expect(indexSource).toMatch(/import\s.*PgWebhookEventStore.*from/);
  });

  it("passes PgWebhookEventStore to buildApp as webhookEventStore", () => {
    // Stored in a variable first; check the variable is created from the Pg class
    expect(indexSource).toMatch(/new\s+PgWebhookEventStore\s*\(/);
    expect(indexSource).toMatch(/webhookEventStore/);
  });

  // -------------------------------------------------------------------------
  // 5. Referral deps (task 25, Req 2.9/11.8)
  // -------------------------------------------------------------------------
  it("passes referralDeps to buildApp", () => {
    expect(indexSource).toMatch(/referralDeps\s*:/);
  });

  // The referral claim credits the REFERRER, so the referral routes need the same
  // Admin-gated lazy metafield enqueuer as the other balance-changing consumers
  // (task 35, Req 13.5a). Without it the referrer's display cache stays stale.
  it("threads the lazy metafieldEnqueuer getter into referralDeps", () => {
    const referralDepsBlock = /referralDeps\s*:\s*\{[\s\S]*?get\s+metafieldEnqueuer\s*\(\s*\)/;
    expect(indexSource).toMatch(referralDepsBlock);
  });

  // The `orders/paid` referral advance must REPORT the credited referrer so the
  // worker can refresh that customer's cache after the transaction commits.
  it("returns the credited referrerId from advanceReferralStage", () => {
    expect(indexSource).toMatch(/advanceReferralStage[\s\S]*?referrerId\s*:\s*outcome\.referrerId/);
  });

  // -------------------------------------------------------------------------
  // 6. Due-work status source (task 24, Req 20.6a)
  // -------------------------------------------------------------------------
  it("imports PgDueWorkStatusSource", () => {
    expect(indexSource).toMatch(/import\s.*PgDueWorkStatusSource.*from/);
  });

  it("passes PgDueWorkStatusSource to buildApp as dueWorkStatus", () => {
    expect(indexSource).toMatch(/dueWorkStatus\s*:\s*new\s+PgDueWorkStatusSource\s*\(/);
  });

  // -------------------------------------------------------------------------
  // 6b. Latest-backup status source (task 29, Req 13.6 as amended)
  //     Supabase Free has no automated backups and no PITR; protection is a
  //     daily encrypted logical dump recorded in `backup_runs`. Without this
  //     wiring `/health` omits the `backups` block and a backup mechanism that
  //     stopped running would again be invisible.
  // -------------------------------------------------------------------------
  it("imports PgLatestBackupSource", () => {
    expect(indexSource).toMatch(/import\s.*PgLatestBackupSource.*from/);
  });

  it("passes PgLatestBackupSource to buildApp as backupStatus", () => {
    expect(indexSource).toMatch(/backupStatus\s*:\s*new\s+PgLatestBackupSource\s*\(/);
  });

  // -------------------------------------------------------------------------
  // 7. Analytics service (task 24 / 17.3, Req 20)
  // -------------------------------------------------------------------------
  it("imports CachedAggregateAnalyticsService", () => {
    expect(indexSource).toMatch(/import\s.*CachedAggregateAnalyticsService.*from/);
  });

  it("passes CachedAggregateAnalyticsService to buildApp as analyticsService", () => {
    expect(indexSource).toMatch(/analyticsService\s*:\s*new\s+CachedAggregateAnalyticsService\s*\(/);
  });
});

/**
 * VIP benefits / entitlements (task 30, Req 18.2/18.3/18.5/18.6).
 *
 * This is the exact gap this file exists to catch. `DbEntitlementResolver` was
 * complete and unit-tested from task 15.2 and **never constructed**, so no test
 * in a 1 200-test suite noticed that Requirement 18 could not fire in the running
 * service. These assertions read the source of `index.ts`, `app.ts` and `v1.ts`
 * and fail if any link in the chain is removed — construction, forwarding, or
 * route registration.
 */
const appSource = readFileSync(join(__dirname, "app.ts"), "utf8");
const v1Source = readFileSync(join(__dirname, "routes", "v1.ts"), "utf8");
const balanceSource = readFileSync(join(__dirname, "routes", "balance.ts"), "utf8");

describe("boot wiring regression — the entitlement resolver reaches the running service (task 30)", () => {
  it("index.ts imports DbEntitlementResolver", () => {
    expect(indexSource).toMatch(/import\s.*DbEntitlementResolver.*from/);
  });

  it("index.ts constructs DbEntitlementResolver and passes it to buildApp", () => {
    expect(indexSource).toMatch(/entitlementResolver\s*:\s*new\s+DbEntitlementResolver\s*\(/);
  });

  it("index.ts builds the resolver over the real pool, not a fake", () => {
    expect(indexSource).toMatch(/new\s+DbEntitlementResolver\s*\(\s*pool\s*\)/);
  });

  it("app.ts forwards entitlementResolver into the /v1 router", () => {
    expect(appSource).toMatch(/entitlementResolver\s*:\s*deps\.entitlementResolver/);
  });

  it("v1.ts registers the benefit routes when the resolver is wired", () => {
    expect(v1Source).toMatch(/if\s*\(\s*opts\.entitlementResolver\s*\)/);
    expect(v1Source).toMatch(/registerBenefitRoutes\s*\(\s*app\s*,/);
  });

  it("v1.ts threads the resolver into the balance route so account data carries benefits (Req 18.2)", () => {
    expect(v1Source).toMatch(
      /registerBalanceRoute\s*\(\s*app\s*,\s*\{[\s\S]*?entitlementResolver\s*:\s*opts\.entitlementResolver/,
    );
  });

  it("the benefit surface computes no tier of its own — it delegates to the resolver", () => {
    const benefitRouteSource = readFileSync(join(__dirname, "routes", "benefits.ts"), "utf8");
    // No tier ranking, threshold or multiplier logic may live in the route layer:
    // duplicating it is how the resolver and the balance summary would drift.
    expect(benefitRouteSource).not.toMatch(/tierRank|advanceTier|deriveTier|lifetime_spend/);
    expect(benefitRouteSource).not.toMatch(/FROM\s+benefits|SELECT\s/i);
    // And the balance route resolves benefits rather than deriving them.
    expect(balanceSource).toMatch(/entitlementResolver\.resolveBenefits\s*\(/);
  });
});

/**
 * Profile preference writes + the suggestion engine (task 31, Req 17.2/17.4/
 * 17.5/17.6). Reachability-audit finding 3: `setFavourite`, `reconcileWishlist`,
 * `RecentlyViewedStore` and `RulesBasedSuggestionEngine` were all complete and
 * referenced by nothing outside their own files. These assertions fail if the
 * construction or the forwarding is removed again.
 */
describe("boot wiring regression — profile preference writes reach the service (task 31)", () => {
  const profileRouteSource = readFileSync(join(__dirname, "routes", "profile.ts"), "utf8");

  it("index.ts constructs the Pg preference store and the recently-viewed store", () => {
    expect(indexSource).toMatch(/preferenceStore\s*:\s*new\s+PgProfilePreferenceStore\s*\(\s*pool\s*\)/);
    expect(indexSource).toMatch(/recentlyViewedRecorder\s*:\s*new\s+RecentlyViewedStore\s*\(\s*pool\s*\)/);
  });

  it("index.ts wires the suggestion engine into the profile data source (Req 17.6)", () => {
    expect(indexSource).toMatch(/suggestionEngine\s*:\s*new\s+RulesBasedSuggestionEngine\s*\(/);
  });

  it("app.ts forwards both preference dependencies into the /v1 router", () => {
    expect(appSource).toMatch(/preferenceStore\s*:\s*deps\.preferenceStore/);
    expect(appSource).toMatch(/recentlyViewedRecorder\s*:\s*deps\.recentlyViewedRecorder/);
  });

  it("v1.ts passes them to the profile routes", () => {
    expect(v1Source).toMatch(
      /registerProfileRoutes\s*\(\s*app\s*,\s*\{[\s\S]*?preferenceStore\s*:\s*opts\.preferenceStore/,
    );
    expect(v1Source).toMatch(/recentlyViewedRecorder\s*:\s*opts\.recentlyViewedRecorder/);
  });

  it("the route layer delegates to the existing preference module rather than reimplementing it", () => {
    // The production store is pure delegation: no product-id validation, no
    // union, no ON CONFLICT of its own may live in the route module.
    expect(profileRouteSource).toMatch(/await setFavourite\(this\.db/);
    expect(profileRouteSource).toMatch(/return reconcileWishlist\(this\.db/);
    // No SQL literal and no product-id normaliser of its own. (Prose mentioning
    // the table names is fine; a query string is not.)
    expect(profileRouteSource).not.toMatch(/`\s*(INSERT|DELETE|UPDATE)\s/i);
    expect(profileRouteSource).not.toMatch(/normaliseProductId/);
  });
});

/**
 * Market-config drift check (task 32, Req 21.6a, A18).
 *
 * The decision is that the engine keeps reading the hardcoded constants, so the
 * only thing that must stay wired is the READ-ONLY drift check. If it is removed,
 * the deviation silently stops being machine-checked and a hand-edited rule-set
 * row becomes invisible again — which is the whole hazard the decision accepted.
 */
describe("boot wiring regression — the market-config deviation stays machine-checked (task 32)", () => {
  it("index.ts wires the drift source over the real provider and pool", () => {
    expect(indexSource).toMatch(
      /marketConfigDrift\s*:\s*new\s+ProviderMarketConfigDriftSource\s*\(\s*new\s+DbMarketConfigProvider\s*\(\s*pool\s*\)\s*\)/,
    );
  });

  it("the engine still reads the CONSTANTS, not the provider (the decision itself)", () => {
    // A18: wiring the provider into the money paths was declined. If someone
    // later injects it into the earning or redemption engine, that is a
    // behaviour change that must be a deliberate task, not a quiet edit.
    const orderSource = readFileSync(join(__dirname, "earning", "order.ts"), "utf8");
    const redeemSource = readFileSync(join(__dirname, "redemption", "redeem.ts"), "utf8");
    expect(orderSource).not.toMatch(/MarketConfigProvider|loadActiveMarketConfig/);
    expect(redeemSource).not.toMatch(/MarketConfigProvider|loadActiveMarketConfig/);
  });

  it("the drift check is read-only: it writes nothing", () => {
    const driftSource = readFileSync(join(__dirname, "markets", "configDrift.ts"), "utf8");
    // Statement keywords only — prose mentioning "the seed inserts with…" is fine.
    expect(driftSource).not.toMatch(/(INSERT INTO|UPDATE \w+ SET|DELETE FROM)/i);
    expect(driftSource).not.toMatch(/\.query\s*\(/);
  });
});

/**
 * Purchased fragrances from Shopify (task 44, Req 17.1/17.6). Before this, the
 * profile data source was constructed with the default empty Shopify source, so
 * purchases were always empty and the suggestion engine's exclude-already-purchased
 * rule excluded nothing. These assertions fail if the source stops being wired, or
 * if the fail-safe wrapper is removed and a Shopify outage starts failing profiles.
 */
describe("boot wiring regression — Shopify purchase history reaches the profile (task 44)", () => {
  it("index.ts constructs the purchase-history source over the real transport and pool lookup", () => {
    expect(indexSource).toMatch(/new\s+ShopifyGraphqlPurchaseHistorySource\s*\(/);
    expect(indexSource).toMatch(/new\s+PgShopifyCustomerIdLookup\s*\(\s*pool\s*\)/);
  });

  it("it is wrapped in the caching/fail-safe source, not passed raw", () => {
    expect(indexSource).toMatch(
      /new\s+CachingPurchaseHistorySource\s*\(\s*[\s\S]{0,400}?new\s+ShopifyGraphqlPurchaseHistorySource/,
    );
  });

  it("it is passed to the profile data source as its Shopify source", () => {
    expect(indexSource).toMatch(/shopify\s*:\s*shopifyPurchaseHistory/);
  });

  it("it is Admin-token gated, so a non-Shopify boot keeps the empty-source fallback", () => {
    expect(indexSource).toMatch(/config\.shopify\.adminApiToken\s*\n?\s*\?\s*new\s+CachingPurchaseHistorySource/);
  });

  it("a degraded read is reported rather than swallowed", () => {
    expect(indexSource).toMatch(/purchased-fragrance read from Shopify degraded to empty/);
  });

  it("ranking and exclusion stay in the suggestion engine — the client does neither", () => {
    const raw = readFileSync(join(__dirname, "shopify", "purchaseHistory.ts"), "utf8");
    // Strip comments: prose explaining the division of responsibility is fine and
    // useful; an import or a call into the suggestion engine is not.
    const clientCode = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(clientCode).not.toMatch(/from\s+"\.\.\/profile\/suggestions/);
    expect(clientCode).not.toMatch(/SuggestionEngine|SuggestionDataSource|getSuggestions/);
    // Read-only: no mutation, and no money fields requested.
    expect(clientCode).not.toMatch(/mutation/);
    expect(clientCode).not.toMatch(/PriceSet/);
  });
});
