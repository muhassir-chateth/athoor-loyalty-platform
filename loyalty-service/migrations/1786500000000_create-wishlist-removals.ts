/**
 * Migration: the explicit-removal wishlist tombstone (task 9.1) —
 * Requirements 7.1, 7.3, 7.9.
 *
 * ── THE DEFECT THIS CLOSES, STATED EXACTLY ───────────────────────────────────
 * Design §8.4 rule 3 records an accepted cost that this table converts back into a
 * solved problem. `localStorage['shopify-wishlist']` is NEVER cleared — the owner's
 * decision of record, and the safer half of a real trade-off, because clearing it
 * is irreversible on that device and would cost a customer their saved items
 * outright. The consequence was that `POST /v1/profile/wishlist/reconcile`, an
 * add-only UNION, could not tell "never merged" apart from "explicitly removed",
 * so a product removed through the portal was RE-ADDED on the next reconcile.
 * Worse than once per session: `reconcileWishlistOnce()` runs once per PAGE LOAD,
 * so the resurrection recurred for as long as the handle stayed in localStorage.
 *
 * This table is the missing record. A removal through
 * `PUT /v1/profile/wishlist/:productId {on:false}` writes a row here, and the
 * reconcile union excludes every product the customer has explicitly removed. The
 * storage rule is untouched: the device list is still never cleared, and it is
 * still read byte-identically. What changes is that the SERVER now remembers the
 * removal, so rule 5 — "removal is authoritative in one place, on the server" —
 * becomes unconditionally true instead of "conditionally false".
 *
 * ── WHY A TOMBSTONE AND NOT A `removed` FLAG ON `customer_wishlist` ──────────
 * A soft-delete column on the existing table was the obvious alternative and is
 * rejected. `customer_wishlist` is read by the SHIPPED storefront path
 * (`getWishlist`, the drawer, the wishlist page, `dt_wishlist.js`), and every one
 * of those readers would have to learn to filter the new column on the same day
 * the column arrived. A reader that forgot would show removed items as saved.
 * A separate table cannot be forgotten by an existing reader, because no existing
 * reader mentions it — the failure mode of the additive change is "the tombstone
 * is ignored", which is exactly today's behaviour, not a new way to be wrong.
 *
 * ── WHY THE PRIMARY KEY IS THE NATURAL KEY ──────────────────────────────────
 * `(customer_id, shopify_product_id)`, matching `customer_wishlist` exactly. A
 * customer has either removed a product or not; a second removal of the same
 * product is the same fact, not a second event. That makes the write idempotent
 * with `ON CONFLICT DO NOTHING` and makes the reconcile filter a simple
 * anti-join. `removed_at` records WHEN, and is preserved by `DO NOTHING` on a
 * repeat, so the timestamp reflects the first explicit removal rather than the
 * most recent duplicate request.
 *
 * ── HOW A REMOVAL IS UNDONE ─────────────────────────────────────────────────
 * By adding the product again. `PUT … {on:true}` deletes the tombstone, because an
 * explicit add is a NEWER statement of intent than an older removal. Without that,
 * a customer who removed a product could never save it again — the reconcile would
 * keep excluding it and the portal add would be silently reverted on the next page
 * load. The tombstone records "the customer removed this", not "this product is
 * banned".
 *
 * HOLDS NO PII beyond the `customers(id)` it references — a product id and a
 * timestamp. Nothing here needs a name, an email or an address.
 *
 * ADDITIVE AND OFF-LEDGER. One `CREATE TABLE`. It touches no shipped table, adds
 * no column to one, and references `ledger_entries`, `point_lots`, `redemptions`,
 * `discount_codes` and `referrals` not at all, so no path through it can move a
 * balance (Req 23.6, §9.5, §14.1).
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING against any live/production database. Application is a separate,
 * deploy-time action: `npm run migrate:up` against the target Postgres.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // `shopify_product_id` is BIGINT to match `customer_wishlist` exactly. A
  // mismatch there would make the reconcile anti-join compare across types, which
  // Postgres would either coerce silently or refuse — and a silent coercion is how
  // a tombstone stops matching the row it is meant to suppress.
  pgm.sql(`
    CREATE TABLE customer_wishlist_removals (
        customer_id         UUID NOT NULL REFERENCES customers(id),
        shopify_product_id  BIGINT NOT NULL,
        removed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (customer_id, shopify_product_id)
    );
  `);
  // No secondary index. The only query shapes are the anti-join in
  // `reconcileWishlist` and the single-row upsert/delete from N5, and both are
  // served by the primary key's leading `customer_id`. An unused index on a free
  // tier is storage and write cost for nothing.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // ── READ THIS BEFORE ROLLING BACK ───────────────────────────────────────────
  // Dropping this table does not merely remove a feature: it DISCARDS the record
  // of which products each customer explicitly removed. Because the device-local
  // list is never cleared (§8.4 rule 3), the very next reconcile would re-add every
  // one of them, and the customer would watch items they deleted reappear.
  //
  // `migrate-down-guard.mjs` therefore refuses this rollback while any row exists,
  // for the same reason it guards `birthday_grants` in task 6.5. The table is
  // referenced by nothing and its PK is dropped with it, so one statement is the
  // whole teardown once the guard is satisfied.
  pgm.sql("DROP TABLE IF EXISTS customer_wishlist_removals;");
}
