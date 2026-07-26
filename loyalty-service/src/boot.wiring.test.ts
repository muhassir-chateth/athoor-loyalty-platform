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
