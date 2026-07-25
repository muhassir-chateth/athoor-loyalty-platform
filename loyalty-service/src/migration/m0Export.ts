/**
 * Migration Phase M0 — export & snapshot (task 7.1).
 *
 * This is design.md "Migration Plan → Phase M0 — Export & snapshot (read-only,
 * no changes)" and Requirement 14 criteria 14.1, 14.2, 14.3 and 14.8. It is the
 * FIRST, entirely read-only step of the data-safe migration: it reads ALL 39
 * customers' `loyalty.*` display metafields from Shopify and writes them to a
 * versioned, timestamped JSON backup file that serves as the *rollback anchor*
 * for every later phase (Req 14.1). Nothing here mutates the Shopify store.
 *
 * Guarantees enforced by this module:
 *   - Req 14.1: export every one of the 39 customers' `loyalty.*` metafields to
 *     a versioned backup file, and confirm a COMPLETE record exists for all 39
 *     before proceeding.
 *   - Req 14.2: if the export is NOT complete for all 39, abort BEFORE making
 *     any change, leave the original metafields untouched, and return an error
 *     indication (no backup is claimed as the anchor).
 *   - Req 14.3: validate that each of the 8 Enrolled_Customer balances exactly
 *     equals the integer value of `50 + spend×1`; if any balance does not match,
 *     halt the migration and record the mismatching customer(s) for review.
 *   - Req 14.8: never delete any Shopify metafield. Structurally guaranteed —
 *     the injected {@link MigrationShopifyClient} exposes ONLY a read method;
 *     there is no write or delete path anywhere in this module.
 *
 * SAFETY — this tool is documented and tested but is NOT wired to run against
 * the live store here. The live Shopify Admin API is reached ONLY through the
 * injected {@link MigrationShopifyClient} (read-only) and the filesystem ONLY
 * through the injected {@link BackupWriter}. Tests inject a fake client that
 * returns representative data (the known 8 enrolled + 31 non-enrolled shape) and
 * an in-memory backup writer, so verification calls NO live Admin API and
 * modifies NO live data. Actual execution is a gated, migration-time step.
 */

/** The Shopify metafield namespace all loyalty fields live under. */
export const LOYALTY_METAFIELD_NAMESPACE = "loyalty" as const;

/** Total number of customers expected in the store at migration time (Req 14.1). */
export const TOTAL_CUSTOMER_COUNT = 39 as const;

/** Number of currently-enrolled loyalty customers (Req 14.3). */
export const ENROLLED_CUSTOMER_COUNT = 8 as const;

/** The signup bonus embedded in every enrolled balance: `balance = 50 + spend×1` (Req 14.3). */
export const SIGNUP_BONUS_POINTS = 50 as const;

/** Points earned per GBP of spend for the clean enrolled cohort (£1 = 1pt) (Req 14.3). */
export const EARN_RATE_PER_GBP = 1 as const;

/** Schema version of the backup file format — bumped if the shape ever changes. */
export const BACKUP_SCHEMA_VERSION = "1.0" as const;

/** Discriminator stamped on the backup so a restore tool can recognise it. */
export const BACKUP_KIND = "m0-metafield-export" as const;

/**
 * The `loyalty.*` metafield keys the existing storefront maintains. The export
 * captures ALL metafields in the namespace regardless of this list; the list is
 * used only to parse the well-known fields into {@link ParsedLoyaltyFields} for
 * convenience and validation.
 */
export const LOYALTY_METAFIELD_KEYS = [
  "points_balance",
  "lifetime_points",
  "tier",
  "points_expiry_date",
  "referral_code",
  "referral_count",
  "activity_log",
] as const;

export type LoyaltyMetafieldKey = (typeof LOYALTY_METAFIELD_KEYS)[number];

/** A single raw Shopify metafield, captured verbatim so a restore is faithful. */
export interface RawMetafield {
  namespace: string;
  key: string;
  /** Shopify metafield type, e.g. `number_integer`, `single_line_text_field`, `json`. */
  type: string;
  /** The stored value exactly as Shopify returns it (may be null/empty). */
  value: string | null;
}

/**
 * One customer as returned by the injectable Shopify client. Deliberately
 * read-only data: identity + the customer's `loyalty.*` metafields + the
 * cumulative lifetime GBP spend derived independently from the customer's paid
 * orders. The spend is the INDEPENDENT quantity the enrolled-balance formula is
 * validated against (Req 14.3) — it is not taken from the metafields being
 * checked, so the check is meaningful.
 */
export interface ShopifyCustomerRecord {
  /** Shopify customer id (numeric string, e.g. "1234567890"). */
  id: string;
  /** Shopify customer GID, e.g. `gid://shopify/Customer/1234567890`. */
  gid: string;
  /** Customer email, if present (informational; not required for export). */
  email: string | null;
  /** ALL metafields in the `loyalty` namespace for this customer (possibly empty). */
  metafields: RawMetafield[];
  /** Cumulative lifetime spend in GBP from the customer's paid orders (Req 14.3). */
  lifetimeSpendGBP: number;
}

/**
 * The injectable, READ-ONLY boundary to Shopify for the M0 export. It exposes a
 * single read method and NO write/delete method — so Req 14.8 ("never delete any
 * metafield") holds by construction. Production wires an implementation backed
 * by the GraphQL Admin API (read scopes only); tests inject a fake returning the
 * representative 8-enrolled + 31-non-enrolled dataset.
 */
export interface MigrationShopifyClient {
  /**
   * Returns every customer in the store with their `loyalty.*` metafields and
   * independently-derived lifetime spend. MUST NOT modify anything.
   */
  listCustomersWithLoyaltyMetafields(): Promise<ShopifyCustomerRecord[]>;
}

/** The well-known loyalty fields parsed from a customer's raw metafields. */
export interface ParsedLoyaltyFields {
  pointsBalance: number | null;
  lifetimePoints: number | null;
  tier: string | null;
  pointsExpiryDate: string | null;
  referralCode: string | null;
  referralCount: number | null;
  activityLog: string | null;
}

/** One customer's exported record inside the backup file. */
export interface ExportedCustomer {
  id: string;
  gid: string;
  email: string | null;
  /** True iff the customer is an enrolled loyalty member (has a points balance). */
  enrolled: boolean;
  /** The lifetime spend captured for formula validation (Req 14.3). */
  lifetimeSpendGBP: number;
  /** Every `loyalty.*` metafield, verbatim — this is what a rollback restores. */
  metafields: RawMetafield[];
  /** Convenience parse of the well-known loyalty fields. */
  loyalty: ParsedLoyaltyFields;
}

/** The versioned backup file contents — the rollback anchor for all later phases. */
export interface M0Backup {
  schemaVersion: string;
  kind: typeof BACKUP_KIND;
  /** ISO 8601 instant the export was taken. */
  exportedAt: string;
  /** The Shopify store the export was taken from. */
  storeDomain: string;
  /** Expected total customer count (39) recorded for restore-time sanity checks. */
  totalExpected: number;
  /** Expected enrolled count (8) recorded for restore-time sanity checks. */
  enrolledExpected: number;
  /** Actual number of customers exported. */
  totalExported: number;
  /** Actual number of enrolled customers exported. */
  enrolledExported: number;
  /** Every customer's exported record. */
  customers: ExportedCustomer[];
}

/** A recorded enrolled-balance mismatch for manual review (Req 14.3). */
export interface BalanceMismatch {
  id: string;
  gid: string;
  email: string | null;
  /** The balance actually stored in the `loyalty.points_balance` metafield. */
  actualBalance: number | null;
  /** The balance the `50 + spend×1` formula requires. */
  expectedBalance: number;
  /** The lifetime spend the expectation was computed from. */
  lifetimeSpendGBP: number;
}

/** A description of why an export was judged incomplete (Req 14.2). */
export interface IncompleteExportDetail {
  reason: string;
  found: number;
  expected: number;
  /** Ids (when known) of records missing required identity/metafield data. */
  incompleteRecordIds: string[];
}

/**
 * The injectable filesystem boundary for writing the backup file. Kept as an
 * interface so tests capture the backup in memory and never touch disk. See
 * {@link FileBackupWriter} for the production, disk-backed implementation.
 */
export interface BackupWriter {
  /**
   * Persists `contents` under a name derived from `filename`, returning an
   * identifier for where it was written (a path for the file writer).
   */
  write(filename: string, contents: string): Promise<string>;
}

/** The result of running M0 (a discriminated union — the caller inspects `status`). */
export type M0Result =
  | {
      status: "exported";
      backup: M0Backup;
      backupLocation: string;
      /** All enrolled balances matched the formula. */
      mismatches: [];
    }
  | {
      status: "aborted_incomplete_export";
      detail: IncompleteExportDetail;
    }
  | {
      status: "halted_balance_mismatch";
      /** The backup (rollback anchor) is still written before halting. */
      backup: M0Backup;
      backupLocation: string;
      /** The enrolled customers whose balance did not match, for review. */
      mismatches: BalanceMismatch[];
    };

/** Options for {@link runM0Export}. */
export interface M0ExportOptions {
  /** Read-only Shopify client (injected; fake in tests). */
  client: MigrationShopifyClient;
  /** Where the backup file is written (injected; in-memory in tests). */
  backupWriter: BackupWriter;
  /** The store domain to stamp on the backup. */
  storeDomain: string;
  /** Expected total customers; defaults to {@link TOTAL_CUSTOMER_COUNT} (39). */
  totalExpected?: number;
  /** Expected enrolled customers; defaults to {@link ENROLLED_CUSTOMER_COUNT} (8). */
  enrolledExpected?: number;
  /** Clock for the export timestamp; defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Parses a metafield value expected to hold an integer; null/empty/NaN → null. */
function parseIntField(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** Returns the metafield value for a key within the loyalty namespace, or null. */
function metafieldValue(metafields: RawMetafield[], key: string): string | null {
  const found = metafields.find(
    (m) => m.namespace === LOYALTY_METAFIELD_NAMESPACE && m.key === key,
  );
  return found ? found.value : null;
}

/** Parses the well-known loyalty fields from a customer's raw metafields. */
export function parseLoyaltyFields(metafields: RawMetafield[]): ParsedLoyaltyFields {
  return {
    pointsBalance: parseIntField(metafieldValue(metafields, "points_balance")),
    lifetimePoints: parseIntField(metafieldValue(metafields, "lifetime_points")),
    tier: metafieldValue(metafields, "tier"),
    pointsExpiryDate: metafieldValue(metafields, "points_expiry_date"),
    referralCode: metafieldValue(metafields, "referral_code"),
    referralCount: parseIntField(metafieldValue(metafields, "referral_count")),
    activityLog: metafieldValue(metafields, "activity_log"),
  };
}

/**
 * A customer is an enrolled loyalty member iff they carry a `points_balance`
 * metafield with a parseable value. The 31 non-enrolled customers have no
 * loyalty metafields at all, so this cleanly separates the cohorts.
 */
export function isEnrolled(metafields: RawMetafield[]): boolean {
  return parseIntField(metafieldValue(metafields, "points_balance")) !== null;
}

/**
 * The integer balance the `50 + spend×1` formula requires for an enrolled
 * customer (Req 14.3). `spend` is floored into the integer points space; a
 * negative or non-finite spend is treated as 0 spend.
 */
export function expectedEnrolledBalance(lifetimeSpendGBP: number): number {
  const spend =
    typeof lifetimeSpendGBP === "number" && Number.isFinite(lifetimeSpendGBP) && lifetimeSpendGBP > 0
      ? lifetimeSpendGBP
      : 0;
  return SIGNUP_BONUS_POINTS + Math.floor(spend * EARN_RATE_PER_GBP);
}

/** Builds the timestamped backup filename, filesystem-safe (no colons). */
export function backupFilename(exportedAt: Date): string {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, "-");
  return `${BACKUP_KIND}-${stamp}.json`;
}

/** Maps a raw Shopify record to its exported form. */
function toExportedCustomer(record: ShopifyCustomerRecord): ExportedCustomer {
  return {
    id: record.id,
    gid: record.gid,
    email: record.email,
    enrolled: isEnrolled(record.metafields),
    lifetimeSpendGBP: record.lifetimeSpendGBP,
    // Copy metafields defensively so the backup is immune to later mutation.
    metafields: record.metafields.map((m) => ({ ...m })),
    loyalty: parseLoyaltyFields(record.metafields),
  };
}

/**
 * Judges whether the export is COMPLETE for all expected customers (Req 14.1 /
 * 14.2). Completeness requires: exactly `totalExpected` customers, every record
 * carrying a non-empty id and gid, and every ENROLLED record carrying a
 * parseable `points_balance` (so its balance can be validated). Returns null
 * when complete, or an {@link IncompleteExportDetail} describing the shortfall.
 */
export function assessCompleteness(
  customers: ExportedCustomer[],
  totalExpected: number,
): IncompleteExportDetail | null {
  const incompleteRecordIds: string[] = [];
  for (const c of customers) {
    const missingIdentity = !c.id || c.id.trim() === "" || !c.gid || c.gid.trim() === "";
    const enrolledMissingBalance = c.enrolled && c.loyalty.pointsBalance === null;
    if (missingIdentity || enrolledMissingBalance) {
      // Use gid/id when available, else a positional marker.
      incompleteRecordIds.push(c.id || c.gid || "<unknown>");
    }
  }

  if (customers.length !== totalExpected) {
    return {
      reason: `Expected ${totalExpected} customers but exported ${customers.length}.`,
      found: customers.length,
      expected: totalExpected,
      incompleteRecordIds,
    };
  }

  if (incompleteRecordIds.length > 0) {
    return {
      reason: `${incompleteRecordIds.length} exported record(s) are missing required identity or balance data.`,
      found: customers.length,
      expected: totalExpected,
      incompleteRecordIds,
    };
  }

  return null;
}

/**
 * Validates that every enrolled customer's stored balance equals the integer
 * value of `50 + spend×1` (Req 14.3). Returns the list of mismatches (empty when
 * all enrolled balances match). A customer whose stored `points_balance` differs
 * from the formula — or is absent — is recorded for manual review.
 */
export function validateEnrolledBalances(customers: ExportedCustomer[]): BalanceMismatch[] {
  const mismatches: BalanceMismatch[] = [];
  for (const c of customers) {
    if (!c.enrolled) {
      continue;
    }
    const expected = expectedEnrolledBalance(c.lifetimeSpendGBP);
    if (c.loyalty.pointsBalance !== expected) {
      mismatches.push({
        id: c.id,
        gid: c.gid,
        email: c.email,
        actualBalance: c.loyalty.pointsBalance,
        expectedBalance: expected,
        lifetimeSpendGBP: c.lifetimeSpendGBP,
      });
    }
  }
  return mismatches;
}

/**
 * Runs Migration Phase M0 (Req 14.1, 14.2, 14.3, 14.8). The flow, in order:
 *
 *   1. Read ALL customers' `loyalty.*` metafields via the injected read-only
 *      client (Req 14.1). No store mutation ever occurs (Req 14.8 — the client
 *      has no write/delete method).
 *   2. Confirm a COMPLETE record exists for all `totalExpected` customers. If
 *      not, ABORT before writing any backup or making any change, returning an
 *      error indication (Req 14.2) — the metafields are left untouched.
 *   3. Write the versioned, timestamped JSON backup file — the rollback anchor
 *      (Req 14.1).
 *   4. Validate the enrolled balances against `50 + spend×1`. If any mismatch,
 *      HALT and return the recorded mismatches for review (Req 14.3); the backup
 *      anchor has already been written. Otherwise return success.
 *
 * The backup is written only AFTER completeness is confirmed so a partial,
 * non-authoritative snapshot is never mistaken for the rollback anchor.
 */
export async function runM0Export(options: M0ExportOptions): Promise<M0Result> {
  const totalExpected = options.totalExpected ?? TOTAL_CUSTOMER_COUNT;
  const enrolledExpected = options.enrolledExpected ?? ENROLLED_CUSTOMER_COUNT;
  const now = options.now ?? (() => new Date());

  // 1. Read-only export of all customers' loyalty.* metafields (Req 14.1, 14.8).
  const raw = await options.client.listCustomersWithLoyaltyMetafields();
  const customers = raw.map(toExportedCustomer);

  // 2. Completeness gate — abort BEFORE any change if incomplete (Req 14.2).
  const incomplete = assessCompleteness(customers, totalExpected);
  if (incomplete) {
    return { status: "aborted_incomplete_export", detail: incomplete };
  }

  // 3. Write the versioned backup file — the rollback anchor (Req 14.1).
  const exportedAt = now();
  const enrolledExported = customers.filter((c) => c.enrolled).length;
  const backup: M0Backup = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: BACKUP_KIND,
    exportedAt: exportedAt.toISOString(),
    storeDomain: options.storeDomain,
    totalExpected,
    enrolledExpected,
    totalExported: customers.length,
    enrolledExported,
    customers,
  };
  const backupLocation = await options.backupWriter.write(
    backupFilename(exportedAt),
    JSON.stringify(backup, null, 2),
  );

  // 4. Enrolled-balance validation — halt & record on mismatch (Req 14.3).
  const mismatches = validateEnrolledBalances(customers);
  if (mismatches.length > 0) {
    return { status: "halted_balance_mismatch", backup, backupLocation, mismatches };
  }

  return { status: "exported", backup, backupLocation, mismatches: [] };
}
