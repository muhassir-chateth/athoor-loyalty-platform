/**
 * Migration: create the erasure-request audit queue (task 6.4) —
 * Requirements 13.8, 23.5.
 *
 * Creates one table EXACTLY as specified in design.md §14.2 (Table 5):
 *   customer_erasure_requests  — one row per rights request, plus the queue index
 *
 * WHY A TABLE AT ALL. Requirement 13.8 requires a route to REQUEST deletion and
 * Requirement 23.5 requires the deletion to HAPPEN. Erasure spans many tables and
 * must be auditable, so the request is RECORDED here and the execution is an
 * operator-run, logged procedure (§15.5) — not a button that irreversibly deletes
 * on click. The row is the evidence that the request was made and honoured.
 *
 * HOLDS NO PII beyond the `customers(id)` it references. Nothing about the
 * request needs a name, an email or an address: the customer is identified by the
 * verified identity that made the request. This matters because the row is
 * RETAINED through erasure — with `status = 'completed'`, as the audit record
 * (§15.5, §14.5) — so anything personal stored here would survive the very
 * erasure it documents.
 *
 * THE `source` COLUMN is what lets a Shopify redaction request and a portal
 * request enter the SAME queue (§15.6), so there is one procedure to run and one
 * place to look, rather than a second path that quietly does something different.
 *   portal            — the customer asked, through Settings (Req 13.8)
 *   shopify_redaction — Shopify's GDPR redaction webhook propagated in (§15.6)
 *   operator          — raised on the customer's behalf, e.g. by email or phone
 *
 * BOTH CHECK SETS ARE CLOSED, so an unknown status or source is rejected by the
 * database rather than stored and later misread by the operator procedure that
 * reads this queue.
 *
 * THE ONLY NEW TABLE NOT ACCESSED BY CUSTOMER. `idx_erasure_queue (status,
 * requested_at)` serves the operator queue read — open requests, oldest first, so
 * the request waiting longest is the one actioned next. That access pattern is why
 * this is the one new table that needs an index beyond its primary key (§14.4).
 *
 * ERASURE NEVER TOUCHES THE LEDGER (Req 23.6, §15.5). The execution this table
 * records performs no UPDATE and no DELETE against `ledger_entries`; the
 * append-only integrity of the ledger is preserved, and `birthday_grants` is
 * likewise retained because it holds no birthday value.
 *
 * ADDITIVE / OFF-LEDGER: `CREATE TABLE` and `CREATE INDEX` only. No existing
 * table is altered. The only reference to existing schema is the `customers(id)`
 * foreign key. Nothing here touches `ledger_entries`, `point_lots`, `redemptions`,
 * `discount_codes` or `referrals`, so no balance can be affected.
 * `gen_random_uuid()` is already available from the ledger-core migration's
 * `CREATE EXTENSION`; no extension is added.
 *
 * ROLLBACK DESTROYS AUDIT EVIDENCE (§14.6) — the record that a customer exercised
 * a right, which is the one thing here that cannot be reconstructed from anything
 * else. Rolling back the FEATURE is a feature-flag flip, never a migration;
 * `migrate:down` is permitted only once `SELECT count(*)` returns zero (the
 * precondition of task 6.5). Retention is 24 months, then an operator purge
 * (§14.5).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING against any live/production database. Application is a separate,
 * deploy-time action: `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // A surrogate `id` rather than a natural key on `customer_id`: a customer may
  // legitimately make more than one request over time (a second request after a
  // rejection, or a portal request followed by a Shopify redaction), and each is a
  // separate event in the audit record.
  //
  // `completed_at` is NULLABLE and stays NULL until the erasure has actually run —
  // a request that has never been actioned HAS no completion time, and defaulting
  // it would fabricate one.
  pgm.sql(`
    CREATE TABLE customer_erasure_requests (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id     UUID NOT NULL REFERENCES customers(id),
        requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        status          TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'completed', 'rejected')),
        completed_at    TIMESTAMPTZ,                      -- NULL until erasure has run
        source          TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'shopify_redaction', 'operator'))
    );
  `);

  // The operator queue: read by status, oldest first.
  pgm.sql(`
    CREATE INDEX idx_erasure_queue
        ON customer_erasure_requests(status, requested_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // The table is referenced by nothing, and its PK and `idx_erasure_queue` are
  // dropped with it, so one statement is the whole teardown. The shared
  // `customers` table (owned by the ledger-core migration) is left untouched.
  pgm.sql("DROP TABLE IF EXISTS customer_erasure_requests;");
}
