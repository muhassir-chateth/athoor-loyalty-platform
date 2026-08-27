/**
 * The declared inventory of every relation this service creates in `public`.
 *
 * WHY A FROZEN LIST, WHEN THE DATABASE ALREADY KNOWS
 * ==================================================
 * Because CI has no Postgres, and the failure this guards against happens at
 * authoring time, not at runtime. Supabase exposes the whole `public` schema
 * through PostgREST, so every table added here becomes an HTTP endpoint the
 * moment a privilege is granted on it. Migration `1785950000000` revokes those
 * privileges and turns the default off, but a default is only a default — it
 * protects the table nobody thought about, not the table someone deliberately
 * grants access to later.
 *
 * So the inventory exists to make adding a table a DECISION rather than a side
 * effect. `security.publicSchemaPosture.test.ts` cross-checks this list against
 * the migrations actually on disk, in both directions:
 *
 *   - a table created by a migration but missing here fails CI, with the message
 *     telling the author to classify it;
 *   - an entry here with no migration creating it also fails, so the list cannot
 *     rot into a description of a schema that no longer exists.
 *
 * This is the same shape as `PORTAL_MIGRATIONS` in the migrate:down guard: a
 * frozen literal whose agreement with reality is itself tested, because a guard
 * whose scope silently narrows is worse than no guard.
 *
 * WHY `apiAccess` IS A LITERAL TYPE
 * =================================
 * `apiAccess: "none"` is the ONLY permitted value, expressed as a literal rather
 * than a union. Adding a relation that claims any other posture is a TYPE error
 * caught by `npm run typecheck`, before any test runs. There is deliberately no
 * `"read"` or `"public"` variant to reach for: no client of this system uses the
 * Supabase Data API at all — the storefront goes through the Shopify App Proxy to
 * the Render backend, which connects to Postgres directly as `postgres`. If that
 * ever changes, adding a variant here should be an argued change to this file,
 * visible in review, not a quiet flag flip in a migration.
 */

/**
 * What kind of data the relation holds. This does not change the required
 * posture — everything is `apiAccess: "none"` — it records WHAT WOULD BE LOST if
 * the posture ever regressed, so an incident can be triaged by reading one file
 * instead of thirty migrations.
 */
export type DataClass =
  /** Directly identifies a person: email, date of birth, name. */
  | "pii"
  /** Bearer material. Possession is use: push tokens, redeemable codes. */
  | "secret"
  /** Keyed to a customer, no direct identifier, but still their data. */
  | "customer_scoped"
  /** Configuration, infrastructure and bookkeeping. No customer data. */
  | "operational";

export interface PublicRelation {
  readonly name: string;
  readonly kind: "table" | "materialized_view";
  /** Migration filename that creates it. Cross-checked against disk. */
  readonly createdBy: string;
  readonly data: DataClass;
  /**
   * Required Data API posture. Literal on purpose — see the file header. No
   * relation in `public` may be reachable by `anon` or `authenticated`.
   */
  readonly apiAccess: "none";
  /** Why it is classified as it is, where that is not self-evident. */
  readonly note?: string;
}

export const PUBLIC_SCHEMA_INVENTORY: readonly PublicRelation[] = [
  // -- ledger core -----------------------------------------------------------
  {
    name: "customers",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "pii",
    apiAccess: "none",
    note: "email (CITEXT, nullable), shopify_customer_id and referral_code. The single highest-value relation here.",
  },
  {
    name: "ledger_entries",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Append-only source of truth for balances. Exposure would leak every customer's earning and spending history.",
  },
  {
    name: "point_lots",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "redemptions",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "discount_codes",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "secret",
    apiAccess: "none",
    note: "A discount code is bearer material: reading one is enough to spend it. Read exposure is a financial loss, not just a privacy one.",
  },
  {
    name: "webhook_events",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Holds Shopify webhook payloads, which carry customer identity and order detail.",
  },
  {
    name: "referrals",
    kind: "table",
    createdBy: "1784817408986_create-ledger-core.ts",
    data: "pii",
    apiAccess: "none",
    note: "referred_email is the email of a person who may not be a customer at all.",
  },

  // -- benefits --------------------------------------------------------------
  {
    name: "benefits",
    kind: "table",
    createdBy: "1784818000000_create-benefits-schema.ts",
    data: "operational",
    apiAccess: "none",
  },
  {
    name: "benefit_requests",
    kind: "table",
    createdBy: "1784818000000_create-benefits-schema.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },

  // -- profile / preferences -------------------------------------------------
  {
    name: "customer_favourites",
    kind: "table",
    createdBy: "1784904000000_create-profile-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "customer_wishlist",
    kind: "table",
    createdBy: "1784904000000_create-profile-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "customer_wishlist_removals",
    kind: "table",
    createdBy: "1786500000000_create-wishlist-removals.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note:
      "Task 9.1 explicit-removal tombstone (design §8.4 rule 3). One row per product " +
      "the customer deleted from their wishlist; it is what stops an uncleared " +
      "device-local list resurrecting the removal on the next reconcile. Product ids " +
      "and a timestamp only — no PII beyond the referenced customer.",
  },
  {
    name: "customer_recently_viewed",
    kind: "table",
    createdBy: "1784904000000_create-profile-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Browsing history. Low value individually, high value in aggregate.",
  },
  {
    name: "tier_change_history",
    kind: "table",
    createdBy: "1784904000000_create-profile-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "portal_visits",
    kind: "table",
    createdBy: "1784904000000_create-profile-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },

  // -- admin / audit ---------------------------------------------------------
  {
    name: "admin_audit_log",
    kind: "table",
    createdBy: "1784990000000_create-admin-audit-log.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Records which operator did what to whom. Exposure leaks both customer data and internal process.",
  },

  // -- notifications ---------------------------------------------------------
  {
    name: "device_tokens",
    kind: "table",
    createdBy: "1785000000000_create-device-tokens.ts",
    data: "secret",
    apiAccess: "none",
    note: "A push token is bearer material: holding one lets you send notifications to that device.",
  },
  {
    name: "notification_events",
    kind: "table",
    createdBy: "1785000000000_create-device-tokens.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },

  // -- market configuration --------------------------------------------------
  {
    name: "markets",
    kind: "table",
    createdBy: "1785000000000_create-market-config.ts",
    data: "operational",
    apiAccess: "none",
  },
  {
    name: "earning_rule_sets",
    kind: "table",
    createdBy: "1785000000000_create-market-config.ts",
    data: "operational",
    apiAccess: "none",
    note: "Not customer data, but write access would let an attacker mint points by changing the rules.",
  },
  {
    name: "reward_rule_sets",
    kind: "table",
    createdBy: "1785000000000_create-market-config.ts",
    data: "operational",
    apiAccess: "none",
    note: "As earning_rule_sets: write access is a points-minting primitive.",
  },

  // -- scheduled work --------------------------------------------------------
  {
    name: "pre_expiry_notifications",
    kind: "table",
    createdBy: "1785200000000_create-pre-expiry-notifications.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "analytics_aggregate_refresh",
    kind: "table",
    createdBy: "1785300000000_create-analytics-aggregates.ts",
    data: "operational",
    apiAccess: "none",
  },
  {
    name: "scheduled_runs",
    kind: "table",
    createdBy: "1785400000000_create-scheduled-runs.ts",
    data: "operational",
    apiAccess: "none",
  },
  {
    name: "idempotency_keys",
    kind: "table",
    createdBy: "1785500000000_create-idempotency-keys.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Keyed on request identity and may retain response material, so treated as customer data rather than infrastructure.",
  },
  {
    name: "backup_runs",
    kind: "table",
    createdBy: "1785600000000_create-backup-runs.ts",
    data: "operational",
    apiAccess: "none",
    note: "Exposure would tell an attacker when backups run and whether they are encrypted.",
  },

  // -- analytics materialised views -----------------------------------------
  //
  // These are the three most dangerous relations in the schema, for a reason
  // that is easy to miss: RLS DOES NOT APPLY TO A MATERIALISED VIEW. A matview
  // is a physical copy refreshed by its owner, so enabling RLS on `customers`
  // and `ledger_entries` does nothing for these. Revoked grants are the ONLY
  // control, which is why the hardening migration enumerates relkind 'm'
  // explicitly instead of relying on `ON ALL TABLES IN SCHEMA`.
  {
    name: "analytics_customers",
    kind: "materialized_view",
    createdBy: "1785300000000_create-analytics-aggregates.ts",
    data: "pii",
    apiAccess: "none",
    note: "Physical copy derived from customers. RLS cannot protect it; only revocation can.",
  },
  {
    name: "analytics_ledger",
    kind: "materialized_view",
    createdBy: "1785300000000_create-analytics-aggregates.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Physical copy derived from ledger_entries. RLS cannot protect it; only revocation can.",
  },
  {
    name: "analytics_redemptions",
    kind: "materialized_view",
    createdBy: "1785300000000_create-analytics-aggregates.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Physical copy derived from redemptions. RLS cannot protect it; only revocation can.",
  },

  // -- rollback snapshot for the hardening migration -------------------------
  {
    name: "security_baseline_grants",
    kind: "table",
    createdBy: "1785950000000_harden-data-api-exposure.ts",
    data: "operational",
    apiAccess: "none",
    note: "Catalogue metadata only, recorded so the hardening can be reversed exactly. Dropped by that migration's down().",
  },
  {
    name: "security_baseline_rls",
    kind: "table",
    createdBy: "1785950000000_harden-data-api-exposure.ts",
    data: "operational",
    apiAccess: "none",
  },
  {
    name: "security_baseline_default_acl",
    kind: "table",
    createdBy: "1785950000000_harden-data-api-exposure.ts",
    data: "operational",
    apiAccess: "none",
  },

  // -- portal additive series (task 6) --------------------------------------
  {
    name: "customer_birthdays",
    kind: "table",
    createdBy: "1786000000000_create-customer-birthdays.ts",
    data: "pii",
    apiAccess: "none",
    note: "birth_month and birth_day. A date of birth is among the most sensitive fields in the schema, and this table does not exist in production yet — it must be born hardened.",
  },
  {
    name: "birthday_grants",
    kind: "table",
    createdBy: "1786000000000_create-customer-birthdays.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "customer_fragrance_preferences",
    kind: "table",
    createdBy: "1786100000000_create-fragrance-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
  },
  {
    name: "customer_communication_preferences",
    kind: "table",
    createdBy: "1786200000000_create-communication-preferences.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "Marketing consent. Write exposure would let an attacker opt a customer back in, which is a regulatory problem as well as a privacy one.",
  },
  {
    name: "customer_erasure_requests",
    kind: "table",
    createdBy: "1786300000000_create-erasure-requests.ts",
    data: "customer_scoped",
    apiAccess: "none",
    note: "The audit record that a customer exercised a right. Delete exposure would destroy evidence of compliance.",
  },
];

/**
 * `pgmigrations` is created by node-pg-migrate itself, not by any migration in
 * this repository, so it can never appear in the disk scan and is excluded from
 * the parity check. It is still covered by the hardening migration, which
 * enumerates the live catalogue rather than this list.
 */
export const RELATIONS_NOT_CREATED_BY_MIGRATIONS: readonly string[] = ["pgmigrations"];

export const INVENTORY_BY_NAME: ReadonlyMap<string, PublicRelation> = new Map(
  PUBLIC_SCHEMA_INVENTORY.map((r) => [r.name, r]),
);
