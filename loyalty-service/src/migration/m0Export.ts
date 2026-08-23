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
  /**
   * How the stored value parsed. `fractional` and `malformed` are ALWAYS recorded
   * for review regardless of arithmetic, because the integer ledger cannot
   * represent them — this is what stops a fractional balance being dropped.
   */
  classification: LegacyBalanceClassification;
  /** The stored value verbatim, so review never depends on a lossy parse. */
  rawBalance: string | null;
  /** Why this record needs a human. */
  reason: string;
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

/**
 * Parses a metafield value expected to hold a NUMBER, integer or fractional.
 *
 * WHY THIS EXISTS (production defect, 2026-08-19): the legacy storefront earned
 * `50 + spend` WITHOUT flooring, so it stored fractional balances such as
 * `"83.75"` and `"55.99"`. `parseIntField` returns null for those, which made
 * {@link isEnrolled} false, which excluded the customer from the cohort AND from
 * balance validation — so M0 exported `SUCCESS` with `mismatches: []` while
 * silently dropping a real paying customer. Parsing must never decide cohort
 * membership; see {@link hasLegacyLoyaltyState}.
 */
function parseNumericField(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * How a legacy `points_balance` value parses. Cohort membership does NOT depend
 * on this — every classification except `absent` (and `absent` too, when other
 * legacy state exists) must reach an operator rather than vanish.
 */
export type LegacyBalanceClassification = "integer" | "fractional" | "malformed" | "absent";

/** The full assessment of a customer's legacy `points_balance` metafield. */
export interface LegacyBalanceAssessment {
  /** The stored value exactly as Shopify returned it; null when the key is absent. */
  raw: string | null;
  /** True when a `points_balance` metafield EXISTS, whatever its value parses to. */
  present: boolean;
  classification: LegacyBalanceClassification;
  /** Numeric value for `integer` and `fractional`; null for `malformed`/`absent`. */
  numeric: number | null;
}

/**
 * Classifies a customer's legacy `points_balance` by PRESENCE first, parseability
 * second.
 *
 *   `"50"`     → integer    (migrates cleanly)
 *   `"50.0"`   → integer    (numerically whole despite the decimal point)
 *   `"83.75"`  → fractional (must reach review — the ledger is integer-only)
 *   `"abc"`    → malformed  (must reach review)
 *   key absent → absent
 */
export function classifyLegacyBalance(metafields: RawMetafield[]): LegacyBalanceAssessment {
  const entry = metafields.find(
    (m) => m.namespace === LOYALTY_METAFIELD_NAMESPACE && m.key === "points_balance",
  );
  if (!entry) {
    return { raw: null, present: false, classification: "absent", numeric: null };
  }

  const raw = entry.value;
  const numeric = parseNumericField(raw);
  if (numeric === null) {
    // The key exists but holds nothing usable — blank or non-numeric. Either way
    // this is an anomaly for an operator, never a reason to drop the customer.
    const blank = raw === null || raw.trim() === "";
    return { raw, present: true, classification: blank ? "absent" : "malformed", numeric: null };
  }

  return {
    raw,
    present: true,
    classification: Number.isInteger(numeric) ? "integer" : "fractional",
    numeric,
  };
}

/**
 * True when the customer carries ANY legacy loyalty state — any `loyalty.*`
 * metafield with a non-blank value.
 *
 * This is the cohort test, and it is deliberately independent of whether any
 * value parses. Presence of legacy state means the customer MUST be examined;
 * parsing only decides whether migration can proceed for them.
 */
export function hasLegacyLoyaltyState(metafields: RawMetafield[]): boolean {
  return metafields.some(
    (m) =>
      m.namespace === LOYALTY_METAFIELD_NAMESPACE &&
      m.value !== null &&
      m.value.trim() !== "",
  );
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
    // NUMERIC, not integer-only: a fractional legacy balance must survive into the
    // parsed record so it can be reviewed. `m1Backfill` independently refuses any
    // non-safe-integer balance, so widening this cannot cause a bad migration —
    // it converts a silent drop into a loud halt.
    pointsBalance: parseNumericField(metafieldValue(metafields, "points_balance")),
    lifetimePoints: parseNumericField(metafieldValue(metafields, "lifetime_points")),
    tier: metafieldValue(metafields, "tier"),
    pointsExpiryDate: metafieldValue(metafields, "points_expiry_date"),
    referralCode: metafieldValue(metafields, "referral_code"),
    referralCount: parseIntField(metafieldValue(metafields, "referral_count")),
    activityLog: metafieldValue(metafields, "activity_log"),
  };
}

/**
 * A customer belongs to the legacy loyalty cohort iff they carry ANY legacy
 * loyalty state. Customers with no `loyalty.*` metafields at all are cleanly
 * separated out and are deferred to lazy enrolment (Req 14.5).
 *
 * PRESENCE-BASED since 2026-08-19. It previously required `points_balance` to
 * parse as an INTEGER, so the real production values `"83.75"` and `"55.99"`
 * made it false: those two customers left the cohort silently, skipped
 * {@link validateEnrolledBalances} entirely, and M0 reported `SUCCESS` with
 * `mismatches: []`. Cohort membership must never depend on parseability —
 * {@link classifyLegacyBalance} reports the parse outcome separately so an
 * anomaly halts the run instead of erasing the customer.
 */
export function isEnrolled(metafields: RawMetafield[]): boolean {
  return hasLegacyLoyaltyState(metafields);
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
 * non-empty id and gid. Returns null when complete, or an
 * {@link IncompleteExportDetail} describing the shortfall.
 *
 * Anomalous BALANCE VALUES are not a completeness concern — see the note in the
 * body and {@link validateEnrolledBalances}.
 */
export function assessCompleteness(
  customers: ExportedCustomer[],
  totalExpected: number,
): IncompleteExportDetail | null {
  const incompleteRecordIds: string[] = [];
  for (const c of customers) {
    const missingIdentity = !c.id || c.id.trim() === "" || !c.gid || c.gid.trim() === "";
    if (missingIdentity) {
      // Use gid/id when available, else a positional marker.
      incompleteRecordIds.push(c.id || c.gid || "<unknown>");
    }
    // NOTE (2026-08-19): a cohort member with an unparseable `points_balance` is
    // deliberately NOT treated as an incomplete EXPORT. The export captured the
    // data faithfully; the value itself is anomalous. Such records are routed to
    // `validateEnrolledBalances`, which halts with the precise reason
    // (`fractional` / `malformed` / `absent`) instead of the misleading
    // "missing required identity or balance data". Both outcomes halt, so no
    // protection is lost — only the diagnosis improves.
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
    // CLASSIFICATION comes from the raw metafield (the faithful capture), but the
    // value COMPARED is the record's own parsed `loyalty.pointsBalance`, because
    // that is the field `m1Backfill` consumes. Validating anything other than the
    // value downstream actually reads would leave a gap between what is checked
    // and what is migrated.
    const assessment = classifyLegacyBalance(c.metafields);
    const recorded = c.loyalty.pointsBalance;
    const base = {
      id: c.id,
      gid: c.gid,
      email: c.email,
      actualBalance: recorded ?? assessment.numeric,
      expectedBalance: expected,
      lifetimeSpendGBP: c.lifetimeSpendGBP,
      classification: assessment.classification,
      rawBalance: assessment.raw,
    };

    switch (assessment.classification) {
      case "fractional":
        // ALWAYS a review item, even when it reconciles perfectly with spend
        // (`50 + 33.75 = 83.75` does). The integer ledger cannot hold it, so a
        // human must choose the conversion — this is the case that used to vanish.
        mismatches.push({
          ...base,
          reason:
            `Legacy balance ${assessment.raw} is fractional; the ledger stores integer points only, ` +
            `so the conversion must be decided explicitly (formula value for this spend: ${expected}).`,
        });
        break;

      case "malformed":
        mismatches.push({
          ...base,
          reason: `Legacy balance ${JSON.stringify(assessment.raw)} is not numeric and cannot be migrated.`,
        });
        break;

      case "absent":
        // The customer carries legacy loyalty state (that is why they are in the
        // cohort) but no usable balance. Surfaced rather than assumed to be zero.
        mismatches.push({
          ...base,
          reason:
            "Customer carries legacy loyalty state but no usable `points_balance`; " +
            "the intended balance must be stated explicitly.",
        });
        break;

      case "integer":
        if (recorded === null) {
          // Raw value parses as an integer but the record carries none — the two
          // disagree, so something rebuilt the record incorrectly. Never assume.
          mismatches.push({
            ...base,
            reason:
              `Raw balance ${JSON.stringify(assessment.raw)} parses as an integer but the exported ` +
              `record carries no balance; the record and the metafield disagree.`,
          });
        } else if (recorded !== assessment.numeric) {
          mismatches.push({
            ...base,
            reason:
              `Exported record balance ${recorded} disagrees with the stored metafield ` +
              `${JSON.stringify(assessment.raw)} (${assessment.numeric}).`,
          });
        } else if (recorded !== expected) {
          mismatches.push({
            ...base,
            reason: `Stored balance ${recorded} does not equal the formula value ${expected}.`,
          });
        }
        break;
    }
  }
  return mismatches;
}

/**
 * Invariant guard (Req 14.2, hardened 2026-08-19): every customer carrying legacy
 * loyalty state must appear in the cohort. Returns the ids of any that do not.
 *
 * This exists so the specific failure that occurred cannot recur in a different
 * disguise: if some future parse or filter change ever drops a legacy customer
 * from the cohort, M0 refuses to report success rather than exporting a quietly
 * short cohort.
 */
export function findUnclassifiedLegacyCustomers(customers: ExportedCustomer[]): string[] {
  return customers
    .filter((c) => hasLegacyLoyaltyState(c.metafields) && !c.enrolled)
    .map((c) => c.id || c.gid || "<unknown>");
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

  // 5. Invariant (2026-08-19): no customer carrying legacy loyalty state may be
  // outside the cohort. Success is only reported when nothing was left
  // unclassified, so a silently short cohort can never look like a clean run.
  const unclassified = findUnclassifiedLegacyCustomers(customers);
  if (unclassified.length > 0) {
    return {
      status: "halted_balance_mismatch",
      backup,
      backupLocation,
      mismatches: unclassified.map((id) => ({
        id,
        gid: "",
        email: null,
        actualBalance: null,
        expectedBalance: 0,
        lifetimeSpendGBP: 0,
        classification: "malformed" as const,
        rawBalance: null,
        reason:
          "Customer carries legacy loyalty state but was excluded from the cohort. " +
          "M0 refuses to report success while any legacy record is unclassified.",
      })),
    };
  }

  return { status: "exported", backup, backupLocation, mismatches: [] };
}
