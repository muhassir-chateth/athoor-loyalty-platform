/**
 * M1 RECOVERY — reverses the historical backfill (task 7.2R).
 *
 * This is the missing half of `m1Backfill.ts`. M1 seeds the empty Postgres
 * ledger from the M0 anchor: for each legacy customer it writes ONE `customers`
 * row, ONE `entry_type='migration'` / `reason='m1_backfill'` ledger entry, and
 * ONE matching non-expiring `point_lot`. `rollback.ts` restores Shopify
 * metafields and re-points the theme CTA, but NOTHING has ever been able to undo
 * the ledger side. If M1 landed and had to be undone, an operator had no
 * sanctioned path. This module is that path, and ONLY that path.
 *
 * WHAT MAKES THIS SAFE TO EXIST AT ALL. A tool that deletes ledger rows is the
 * most dangerous thing in this repository, so it is deliberately built as a
 * ONE-MIGRATION REVERSAL rather than as a delete facility:
 *
 *   - The only rows it can ever delete are M1's OWN output, identified by
 *     `entry_type = 'migration'` AND `reason = 'm1_backfill'` — the two
 *     constants {@link MIGRATION_ENTRY_TYPE} / {@link MIGRATION_REASON} imported
 *     from the backfill itself, never re-stated and never parameterised.
 *   - There is NO table name input, NO predicate input, NO id-list input and NO
 *     entry-type input anywhere in this file. The cohort is derived from the M0
 *     anchor file, exactly as M1 derives it. An operator cannot aim this at
 *     anything: they can only confirm what it has already decided.
 *   - Every operator-supplied value is a CONFIRMATION that must equal a value
 *     the module already knows (store, entry type, reason, db fingerprint,
 *     cohort size, total points). A wrong confirmation refuses; it never
 *     redirects the work.
 *   - Every check REFUSES rather than warns. There is no `--force`.
 *   - DRY RUN IS THE DEFAULT ({@link M1RecoveryOptions.mode}); the destructive
 *     path must be opted into AND separately acknowledged.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS NOT A WARNING. Rollback is only
 * provable when the database is still in clean post-M1 state, because M1's write
 * is the ONLY thing that can be reversed without judgement. Production
 * `customers`, `ledger_entries` and `point_lots` were empty (0 rows,
 * owner-verified) before M1, so a clean post-M1 database is exactly 9/9/9 and
 * nothing else — which is what makes "return it to empty" a provable operation
 * rather than a guess. So this module refuses if:
 *
 *   - anything at all exists OUTSIDE the expected cohort (total row counts must
 *     each equal the cohort size — one extra row anywhere and the database is no
 *     longer in clean post-M1 state, so a full reversal to empty is not what the
 *     operator would be doing);
 *   - ANY post-M1 loyalty activity exists for those customers — an order
 *     earning, a referral, a birthday reward, a redemption, an admin adjustment,
 *     a refund clawback, an expiry, or an entry type that does not exist yet.
 *     Enforced as a WHITELIST of exactly one permitted entry type
 *     ({@link PERMITTED_ENTRY_TYPES}) so a future entry type is refused BY
 *     DEFAULT instead of being silently deleted by a tool written before it
 *     existed;
 *   - the migration state is partial or malformed (an entry with no lot, a lot
 *     with no entry, a customer with no entry, two migration entries, an
 *     expiring lot, or a lot whose `remaining < original`, which means points
 *     were already spent);
 *   - the cohort size or the migration point total is not exactly what the
 *     operator stated AND what the anchor implies.
 *
 * When post-M1 activity is found the refusal says explicitly that automatic
 * rollback is NOT possible and manual recovery planning is required, and reports
 * what it found by category with masked ids — because at that point the correct
 * action is a human decision about real customer value, not a delete.
 *
 * ALL-OR-NOTHING. Inspection and deletion run inside ONE
 * {@link Transactor} transaction. Every refusal, and the dry run itself, throws
 * a sentinel INSIDE that transaction, so the transaction rolls back and it is
 * structurally impossible for a refused or dry run to leave anything behind.
 * Deletion order respects the foreign keys: point lots → ledger entries →
 * customers.
 *
 * NEVER TOUCHES SHOPIFY. There is no Admin API import, client or call anywhere
 * in this file. It never reads or writes orders, and it never touches a customer
 * row outside the anchor cohort. It prints no credentials and no emails, and
 * identifies customers by the last 4 digits of their Shopify id only
 * ({@link maskCustomerId}).
 *
 * SAFETY: defining this module touches no live system. It issues SQL only when a
 * caller passes a real transaction client at runtime. Every boundary (the
 * transactor, the anchor, the clock, the database fingerprint) is injected, so
 * the whole decision surface is unit tested against an in-memory fake that the
 * REAL `runM1Backfill` populates first — the round trip is asserted, not
 * assumed. Actual execution is a gated, operator-run step.
 */
import type { Queryable } from "../ledger/repository.js";
import type { M0Backup } from "./m0Export.js";
// The migration identity and the cohort derivation are imported from the
// backfill, never restated. If M1's entry type, reason or conversion ever
// changed, this module must move with it or fail — a second copy here would be
// free to drift and start deleting rows that are not M1's.
import {
  MIGRATION_ENTRY_TYPE,
  MIGRATION_REASON,
  enrolledCustomers,
  requireShopifyCustomerId,
  resolveMigrationBalance,
  type Transactor,
} from "./m1Backfill.js";

/**
 * The ONLY store this recovery may ever run against. Deliberately a hard
 * constant rather than an argument: M1 ran against exactly one production store,
 * so a reversal has exactly one legitimate target. Any other value is refused
 * outright — not warned about — because a ledger delete aimed at the wrong store
 * is unrecoverable.
 */
export const M1_RECOVERY_REQUIRED_STORE = "myathoorlondon.myshopify.com" as const;

/** The only environment a reversal of the production backfill can be aimed at. */
export const M1_RECOVERY_REQUIRED_ENVIRONMENT = "production" as const;

/**
 * THE WHITELIST. The single ledger entry type this recovery tolerates in the
 * database. Anything else — including an entry type that does not exist yet — is
 * post-M1 activity and refuses the run.
 *
 * WHY A WHITELIST AND NOT A BLACKLIST. A blacklist of "activity" entry types
 * would be a list written today against the entry types that exist today. Add
 * `earn_birthday` next quarter and a blacklist silently permits it: the tool
 * would delete a customer who had earned real points. A whitelist fails closed
 * on the unknown, which is the only acceptable default for a delete.
 */
export const PERMITTED_ENTRY_TYPES: ReadonlySet<string> = new Set([MIGRATION_ENTRY_TYPE]);

/** Machine-readable refusal codes. Every one of these REFUSES; none warns. */
export type M1RecoveryRefusalCode =
  /* -- Guards that never need to touch the database ------------------------ */
  | "environment_not_production"
  | "store_not_permitted"
  | "db_fingerprint_unconfirmed"
  | "db_fingerprint_mismatch"
  | "migration_identifier_unconfirmed"
  | "destructive_acknowledgement_missing"
  | "expectations_missing"
  | "anchor_not_m0_export"
  | "anchor_store_mismatch"
  | "anchor_unusable"
  | "anchor_cohort_mismatch"
  | "anchor_total_points_mismatch"
  /* -- Guards that inspect the database ------------------------------------ */
  | "nothing_to_revert"
  | "cohort_count_mismatch"
  | "ledger_total_mismatch"
  | "unrelated_rows_present"
  | "post_migration_activity"
  | "malformed_migration_state";

/** The categories a non-migration ledger row is reported under (masked ids only). */
export type PostMigrationActivityCategory =
  | "purchase_earning"
  | "signup_earning"
  | "first_purchase_earning"
  | "referral_earning"
  | "birthday_reward"
  | "redemption"
  | "admin_adjustment"
  | "refund_clawback"
  | "expiry"
  | "unknown_entry_type";

/** One piece of post-M1 activity, reported with a MASKED customer identifier. */
export interface PostMigrationActivityFinding {
  category: PostMigrationActivityCategory;
  /** Last 4 digits of the Shopify id only — never the full id, never an email. */
  maskedShopifyCustomerId: string;
  entryType: string;
  reason: string;
  points: number;
}

/** A structural problem with the M1 state that makes a clean reversal impossible. */
export interface MalformedStateFinding {
  maskedShopifyCustomerId: string;
  problem:
    | "customer_has_no_migration_entry"
    | "customer_has_multiple_migration_entries"
    | "migration_entry_has_no_matching_lot"
    | "migration_entry_has_multiple_lots"
    | "lot_is_not_matched_to_the_migration_entry"
    | "lot_expires"
    | "lot_points_were_partially_spent"
    | "lot_points_do_not_match_entry"
    | "migration_points_do_not_match_anchor";
  detail: string;
}

/** A refusal. Carries everything an operator needs and nothing sensitive. */
export interface M1RecoveryRefusal {
  code: M1RecoveryRefusalCode;
  /** Operator-facing explanation. Never contains a credential, email or full id. */
  message: string;
  /** Populated for `post_migration_activity`. */
  activity: PostMigrationActivityFinding[];
  /** Populated for `malformed_migration_state`. */
  malformed: MalformedStateFinding[];
  /**
   * True when the situation cannot be resolved by re-running with better
   * arguments and requires a human recovery plan (post-M1 activity, malformed
   * state, unrelated rows). Set so the operator script can print the right
   * next step rather than inviting a retry.
   */
  manualRecoveryRequired: boolean;
}

/** One cohort customer's reversal detail. Masked ids only. */
export interface RevertedCustomer {
  /** Last 4 digits of the Shopify id — the only identifier this module reports. */
  maskedShopifyCustomerId: string;
  /** The local `customers.id` (a UUID; carries no customer information). */
  customerId: string;
  /** The migration points the entry carried (and the lot mirrored). */
  migrationPoints: number;
  /** The `migration` ledger entry that was (or would be) deleted. */
  ledgerEntryId: string;
  /** The matching non-expiring lot that was (or would be) deleted. */
  pointLotId: string;
}

/** What the reversal will affect / did affect. */
export interface M1RecoveryPlan {
  store: string;
  /** Number of cohort customers found, verified equal to the stated expectation. */
  cohortSize: number;
  /** Total migration points found, verified equal to the stated expectation. */
  totalMigrationPoints: number;
  /** Row counts observed in the database before any deletion. */
  observed: { customers: number; ledgerEntries: number; pointLots: number };
  /** Per-customer detail, masked. */
  customers: RevertedCustomer[];
}

/** Rows deleted (or that would be deleted), per table. */
export interface DeletionCounts {
  pointLots: number;
  ledgerEntries: number;
  customers: number;
}

/**
 * The result of a recovery attempt — a discriminated union, never a thrown
 * string. `dry_run` and `reverted` are the only non-failure outcomes, and they
 * are distinct so a dry run can never be mistaken for a completed reversal.
 */
export type M1RecoveryResult =
  | { status: "dry_run"; plan: M1RecoveryPlan; wouldDelete: DeletionCounts }
  | { status: "reverted"; plan: M1RecoveryPlan; deleted: DeletionCounts }
  | { status: "refused"; refusal: M1RecoveryRefusal }
  | { status: "aborted_delete_error"; detail: { reason: string } };

/** Options for {@link runM1Recovery}. Every guard input is required. */
export interface M1RecoveryOptions {
  /** Operator-stated environment. Must be exactly `production`. */
  environment: string | null | undefined;
  /** Operator-stated store. Must equal {@link M1_RECOVERY_REQUIRED_STORE}. */
  store: string | null | undefined;
  /** `--confirm-db-fingerprint`. Must equal {@link actualDbFingerprint}. */
  confirmDbFingerprint: string | null | undefined;
  /** The fingerprint of the database actually configured, computed by the caller. */
  actualDbFingerprint: string | null | undefined;
  /** `--confirm-entry-type`. Must equal {@link MIGRATION_ENTRY_TYPE}. */
  confirmEntryType: string | null | undefined;
  /** `--confirm-reason`. Must equal {@link MIGRATION_REASON}. */
  confirmReason: string | null | undefined;
  /** The M0 anchor file — the ONLY definition of the cohort. Never an id list. */
  backup: M0Backup;
  /** `--expect-cohort`. Required, no default. */
  expectCohort: number | null | undefined;
  /** `--expect-total-points`. Required, no default. */
  expectTotalPoints: number | null | undefined;
  /** Defaults to `dry_run`; `execute` is the only destructive mode. */
  mode?: "dry_run" | "execute";
  /** The destructive acknowledgement. Required in `execute` mode. */
  acknowledgeDeletesMigrationRows?: boolean;
  /** Runs inspection + deletion inside one transaction. */
  transactor: Transactor;
}

/**
 * Masks a Shopify customer id down to its last 4 digits, e.g. `…4995`.
 *
 * Enough for an operator to match a row against the owner-verified cohort list,
 * and useless for identifying a person in a log, a screen share or a ticket. Ids
 * shorter than 4 characters are masked whole rather than partially exposed.
 */
export function maskCustomerId(id: string | number): string {
  const s = String(id);
  return s.length <= 4 ? "…" + "*".repeat(s.length) : `…${s.slice(-4)}`;
}

/**
 * Categorises a non-migration ledger row for the refusal report.
 *
 * Reason is consulted only to separate a birthday reward from a generic
 * adjustment, because that distinction matters to the human who has to plan the
 * manual recovery. Anything unrecognised becomes `unknown_entry_type`, which is
 * reported and refused rather than assumed harmless.
 */
export function categoriseActivity(entryType: string, reason: string): PostMigrationActivityCategory {
  if (/birthday/i.test(reason)) return "birthday_reward";
  switch (entryType) {
    case "earn_order":
      return "purchase_earning";
    case "earn_signup":
      return "signup_earning";
    case "earn_first_purchase":
      return "first_purchase_earning";
    case "earn_referral":
      return "referral_earning";
    case "spend":
      return "redemption";
    case "adjust":
      return "admin_adjustment";
    case "clawback":
      return "refund_clawback";
    case "expire":
      return "expiry";
    default:
      return "unknown_entry_type";
  }
}

/* -------------------------------------------------------------------------- */
/* SQL — narrow by construction                                               */
/* -------------------------------------------------------------------------- */
/*
 * Every statement below is a fixed string. There is no table name, column name,
 * predicate or entry type built from an argument anywhere in this module, so
 * there is nothing an operator (or a future caller) can widen. The deletes are
 * keyed by the exact ids read moments earlier in the SAME transaction, and the
 * ledger delete additionally re-asserts the migration identity in its WHERE
 * clause, so even a mis-plumbed id cannot remove a non-migration row.
 */

const COUNT_CUSTOMERS_SQL = `SELECT COUNT(*)::text AS count FROM customers`;
const COUNT_LEDGER_SQL = `SELECT COUNT(*)::text AS count FROM ledger_entries`;
const COUNT_LOTS_SQL = `SELECT COUNT(*)::text AS count FROM point_lots`;

/**
 * Aggregate-only census of the ledger: counts per (entry_type, reason) with NO
 * ids and NO customer data. Used to report what is present when the row counts
 * disagree, so an operator learns WHAT is in the way instead of just that
 * something is.
 */
const LEDGER_CENSUS_SQL = `
  SELECT entry_type, reason, COUNT(*)::text AS count
  FROM ledger_entries
  GROUP BY entry_type, reason
`;

/**
 * The migration census: how many M1 rows exist ANYWHERE in the ledger and what
 * they total. Deliberately NOT scoped to the cohort, and deliberately run BEFORE
 * any per-customer work, so a stray `migration`/`m1_backfill` row belonging to a
 * customer the anchor has never heard of is caught first — "verify the migration
 * ledger total before doing anything" only means something if the sum covers
 * every migration row in the database, not just the ones expected.
 *
 * The entry type and reason are BOUND PARAMETERS fed from the imported
 * constants, never from an argument.
 */
const MIGRATION_TOTAL_SQL = `
  SELECT COALESCE(SUM(points), 0)::text AS total, COUNT(*)::text AS count
  FROM ledger_entries
  WHERE entry_type = $1 AND reason = $2
`;

/** Resolves one cohort customer, keyed by the Shopify id the anchor supplies. */
const FIND_COHORT_CUSTOMER_SQL = `
  SELECT id, shopify_customer_id
  FROM customers
  WHERE shopify_customer_id = $1
`;

/**
 * ALL ledger rows for one cohort customer — deliberately unfiltered by entry
 * type. Filtering to `migration` here would hide exactly what must refuse the
 * run: an `earn_order` or a `spend` that arrived after M1.
 */
const COHORT_LEDGER_SQL = `
  SELECT id, entry_type, points, reason
  FROM ledger_entries
  WHERE customer_id = $1
  ORDER BY created_at ASC, id ASC
`;

/** ALL point lots for one cohort customer, likewise unfiltered. */
const COHORT_LOTS_SQL = `
  SELECT id, ledger_entry_id, original_points, remaining_points, expires_at
  FROM point_lots
  WHERE customer_id = $1
`;

/** Deletes exactly one lot, keyed by id AND its owning customer AND its entry. */
const DELETE_LOT_SQL = `
  DELETE FROM point_lots
  WHERE id = $1 AND customer_id = $2 AND ledger_entry_id = $3
`;

/**
 * Deletes exactly one ledger entry, keyed by id AND customer AND — crucially —
 * re-asserting `entry_type` / `reason` from the imported constants. This is the
 * last line of defence: the only row this statement can ever remove is an M1
 * migration row.
 */
const DELETE_MIGRATION_ENTRY_SQL = `
  DELETE FROM ledger_entries
  WHERE id = $1 AND customer_id = $2 AND entry_type = $3 AND reason = $4
`;

/** Deletes exactly one cohort customer, keyed by id AND Shopify id. */
const DELETE_COHORT_CUSTOMER_SQL = `
  DELETE FROM customers
  WHERE id = $1 AND shopify_customer_id = $2
`;

/* -------------------------------------------------------------------------- */
/* Internal sentinels — thrown INSIDE the transaction so it always rolls back  */
/* -------------------------------------------------------------------------- */

/**
 * Carries a refusal out of the transaction by throwing, which rolls the
 * transaction back. The inspection phase writes nothing anyway; throwing makes
 * "a refused run cannot have changed anything" structural rather than a property
 * of the code reading correctly.
 */
class RefusalSignal extends Error {
  readonly refusal: M1RecoveryRefusal;
  constructor(refusal: M1RecoveryRefusal) {
    super(refusal.message);
    this.name = "M1RecoveryRefusal";
    this.refusal = refusal;
  }
}

/** Carries a completed dry-run plan out by throwing, so a dry run cannot commit. */
class DryRunSignal extends Error {
  readonly plan: M1RecoveryPlan;
  constructor(plan: M1RecoveryPlan) {
    super("M1 recovery dry run complete; nothing was written.");
    this.name = "M1RecoveryDryRun";
    this.plan = plan;
  }
}

/**
 * A deletion did not affect exactly the one row it was aimed at. Throwing rolls
 * the whole reversal back: a reversal that removed the wrong number of rows is
 * worse than one that did not run.
 */
class DeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "M1RecoveryDeleteError";
  }
}

function refuse(
  code: M1RecoveryRefusalCode,
  message: string,
  extra: Partial<Pick<M1RecoveryRefusal, "activity" | "malformed" | "manualRecoveryRequired">> = {},
): M1RecoveryRefusal {
  return {
    code,
    message,
    activity: extra.activity ?? [],
    malformed: extra.malformed ?? [],
    manualRecoveryRequired: extra.manualRecoveryRequired ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Pre-flight guards (no database access)                                     */
/* -------------------------------------------------------------------------- */

/** One cohort member as the anchor defines it: Shopify id + the points M1 wrote. */
export interface AnchorCohortMember {
  shopifyCustomerId: number;
  expectedMigrationPoints: number;
}

/**
 * Derives the cohort from the M0 anchor using M1's OWN conversion.
 *
 * This is why there is no hardcoded id list and no hardcoded 484: both come from
 * the anchor, through {@link resolveMigrationBalance}, which is the same function
 * that decided what M1 wrote. If the anchor is not the one M1 ran from, the
 * derived cohort and total will not match the operator's stated expectations and
 * the run refuses.
 */
export function deriveAnchorCohort(backup: M0Backup): AnchorCohortMember[] {
  return enrolledCustomers(backup).map((c) => {
    const shopifyCustomerId = requireShopifyCustomerId(c);
    const decision = resolveMigrationBalance(c, shopifyCustomerId);
    return { shopifyCustomerId, expectedMigrationPoints: decision.integerPoints };
  });
}

/**
 * Runs every guard that does not need the database, in cheapest-first order so a
 * misaimed invocation dies before a connection is even used. Returns the derived
 * cohort on success, or the refusal that stopped it.
 */
function preflight(
  options: M1RecoveryOptions,
): { ok: true; cohort: AnchorCohortMember[] } | { ok: false; refusal: M1RecoveryRefusal } {
  const mode = options.mode ?? "dry_run";

  /* -- Environment: stated, exact, no default ------------------------------ */
  if (String(options.environment ?? "") !== M1_RECOVERY_REQUIRED_ENVIRONMENT) {
    return {
      ok: false,
      refusal: refuse(
        "environment_not_production",
        `M1 RECOVERY requires --environment ${M1_RECOVERY_REQUIRED_ENVIRONMENT} (got ` +
          `"${String(options.environment ?? "(unset)")}"). M1 ran against production, so its ` +
          `reversal has exactly one legitimate environment and nothing is inferred.`,
      ),
    };
  }

  /* -- Store: exactly one permitted value, rejected outright otherwise ----- */
  const store = String(options.store ?? "")
    .trim()
    .toLowerCase();
  if (store !== M1_RECOVERY_REQUIRED_STORE) {
    return {
      ok: false,
      refusal: refuse(
        "store_not_permitted",
        `M1 RECOVERY may only run against ${M1_RECOVERY_REQUIRED_STORE} (got "${store || "(unset)"}"). ` +
          `This is a refusal, not a warning: a ledger deletion aimed at the wrong store is ` +
          `unrecoverable.`,
      ),
    };
  }

  /* -- Database fingerprint: same protection M1 demands before writing ----- */
  const confirmedFingerprint = options.confirmDbFingerprint;
  if (!confirmedFingerprint || String(confirmedFingerprint).trim() === "") {
    return {
      ok: false,
      refusal: refuse(
        "db_fingerprint_unconfirmed",
        `--confirm-db-fingerprint is required. A destructive reversal must be aimed at a database ` +
          `the operator has actually looked at; typing the fingerprint is the point, because it ` +
          `cannot be satisfied by a silently inherited .env.`,
      ),
    };
  }
  if (
    !options.actualDbFingerprint ||
    String(confirmedFingerprint).trim() !== String(options.actualDbFingerprint).trim()
  ) {
    return {
      ok: false,
      refusal: refuse(
        "db_fingerprint_mismatch",
        `--confirm-db-fingerprint does not match the configured database ` +
          `(passed "${String(confirmedFingerprint).trim()}", actual ` +
          `"${String(options.actualDbFingerprint ?? "(none)")}"). You are not pointed at the ` +
          `database you think you are.`,
      ),
    };
  }

  /* -- The migration identity must be stated back, exactly ----------------- */
  if (
    String(options.confirmEntryType ?? "") !== MIGRATION_ENTRY_TYPE ||
    String(options.confirmReason ?? "") !== MIGRATION_REASON
  ) {
    return {
      ok: false,
      refusal: refuse(
        "migration_identifier_unconfirmed",
        `--confirm-entry-type and --confirm-reason must be stated and must equal ` +
          `"${MIGRATION_ENTRY_TYPE}" and "${MIGRATION_REASON}" (got ` +
          `"${String(options.confirmEntryType ?? "(unset)")}" / ` +
          `"${String(options.confirmReason ?? "(unset)")}"). These are CONFIRMATIONS, not ` +
          `settings: they cannot change which rows are affected, only prove the operator knows ` +
          `which migration they are reversing.`,
      ),
    };
  }

  /* -- The destructive path must be acknowledged separately ---------------- */
  if (mode === "execute" && options.acknowledgeDeletesMigrationRows !== true) {
    return {
      ok: false,
      refusal: refuse(
        "destructive_acknowledgement_missing",
        `Write mode additionally requires --i-understand-this-deletes-migration-rows. Dry run is ` +
          `the default precisely so the destructive path has to be opted into twice.`,
      ),
    };
  }

  /* -- Expectations: required, no defaults --------------------------------- */
  const expectCohort = Number(options.expectCohort);
  const expectTotalPoints = Number(options.expectTotalPoints);
  if (
    options.expectCohort === null ||
    options.expectCohort === undefined ||
    options.expectTotalPoints === null ||
    options.expectTotalPoints === undefined ||
    !Number.isInteger(expectCohort) ||
    expectCohort <= 0 ||
    !Number.isInteger(expectTotalPoints) ||
    expectTotalPoints <= 0
  ) {
    return {
      ok: false,
      refusal: refuse(
        "expectations_missing",
        `--expect-cohort and --expect-total-points are both REQUIRED positive integers with no ` +
          `defaults (got "${String(options.expectCohort)}" / "${String(options.expectTotalPoints)}"). ` +
          `State the cohort and total you verified immediately before the run; a default would let ` +
          `a stale literal authorise a deletion.`,
      ),
    };
  }

  /* -- The anchor: the only definition of the cohort ----------------------- */
  const backup = options.backup;
  if (!backup || typeof backup !== "object" || backup.kind !== "m0-metafield-export") {
    return {
      ok: false,
      refusal: refuse(
        "anchor_not_m0_export",
        `--backup must be an M0 export (kind "m0-metafield-export"; got ` +
          `"${String((backup as { kind?: unknown } | null)?.kind ?? "(missing)")}"). The cohort is ` +
          `never a hardcoded id list, so without the anchor there is no cohort at all.`,
      ),
    };
  }
  if (String(backup.storeDomain ?? "").trim().toLowerCase() !== store) {
    return {
      ok: false,
      refusal: refuse(
        "anchor_store_mismatch",
        `anchor storeDomain "${String(backup.storeDomain)}" does not match the target store ` +
          `"${store}". Refusing to reverse one store's migration using another store's anchor.`,
      ),
    };
  }

  let cohort: AnchorCohortMember[];
  try {
    cohort = deriveAnchorCohort(backup);
  } catch (err) {
    return {
      ok: false,
      refusal: refuse(
        "anchor_unusable",
        `the anchor cohort could not be derived: ${err instanceof Error ? err.message : String(err)}. ` +
          `If the anchor cannot reproduce what M1 wrote, this tool cannot know what to reverse.`,
      ),
    };
  }

  if (cohort.length !== expectCohort) {
    return {
      ok: false,
      refusal: refuse(
        "anchor_cohort_mismatch",
        `the anchor describes ${cohort.length} legacy customer(s) but --expect-cohort is ` +
          `${expectCohort}. The anchor and the operator must agree before anything is deleted.`,
      ),
    };
  }
  const anchorTotal = cohort.reduce((sum, c) => sum + c.expectedMigrationPoints, 0);
  if (anchorTotal !== expectTotalPoints) {
    return {
      ok: false,
      refusal: refuse(
        "anchor_total_points_mismatch",
        `the anchor implies ${anchorTotal} migration point(s) but --expect-total-points is ` +
          `${expectTotalPoints}. Either the wrong anchor was supplied or the stated total is stale.`,
      ),
    };
  }

  return { ok: true, cohort };
}

/* -------------------------------------------------------------------------- */
/* Database inspection helpers                                                */
/* -------------------------------------------------------------------------- */

/** Parses a COUNT/BIGINT column (`pg` returns these as strings) into a safe integer. */
function parseCount(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DeleteError(`Unreadable ${what} value '${String(value)}' from the database.`);
  }
  return n;
}

async function countRows(tx: Queryable, sql: string, what: string): Promise<number> {
  const res = await tx.query<{ count: string }>(sql);
  return parseCount(res.rows[0]?.count, what);
}

interface CohortLedgerRow {
  id: string;
  entry_type: string;
  points: string | number;
  reason: string;
}

interface CohortLotRow {
  id: string;
  ledger_entry_id: string;
  original_points: string | number;
  remaining_points: string | number;
  expires_at: Date | null;
}

/* -------------------------------------------------------------------------- */
/* The reversal                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Reverses the M1 historical backfill, or refuses.
 *
 * Order of operations — everything after the pre-flight happens inside ONE
 * transaction:
 *
 *   0. Pre-flight ({@link preflight}): environment, store, database fingerprint,
 *      migration-identity confirmation, destructive acknowledgement, mandatory
 *      expectations, and the anchor (kind, store, derived cohort size, derived
 *      point total). No database access; a misaimed run dies here.
 *   1. Census: total `customers`, `ledger_entries` and `point_lots` counts, plus
 *      each anchor member's local `customers` row. All three counts zero AND no
 *      cohort customer present → `nothing_to_revert`, which is the correct,
 *      non-throwing outcome for a SECOND recovery attempt.
 *   2. BEFORE ANY OTHER WORK: the number of `migration`/`m1_backfill` entries in
 *      the ENTIRE ledger, and their point total, must equal the stated cohort
 *      size and the stated total. Not cohort-scoped, so a stray M1 row for a
 *      customer the anchor never listed refuses here.
 *   3. The number of cohort customers actually found must equal the stated
 *      expectation exactly — never a partial cohort.
 *   4. Structural verification per customer: exactly ONE ledger entry, and it is
 *      the `migration`/`m1_backfill` one carrying exactly the points the anchor
 *      implies; exactly ONE matching lot, non-expiring, with
 *      `original == remaining ==` those points. `remaining < original` means
 *      points were spent, which refuses.
 *   5. Whitelist check: any entry type other than `migration`, for any cohort
 *      customer, is post-M1 activity → refuse with the by-category report and
 *      the explicit statement that manual recovery planning is required.
 *   6. The three table counts must EACH equal the cohort size — anything at all
 *      outside the expected M1 output means the database is not in clean post-M1
 *      state, so "return it to the original empty state" is not the operation
 *      that would actually happen.
 *   7. Dry run (the default) → return the plan, having written nothing.
 *   8. Execute → delete lots, then entries, then customers, each keyed by id and
 *      each required to affect exactly one row.
 *
 * A refusal, a dry run, a deletion row-count surprise and any unexpected
 * database error all leave the transaction rolled back, so the database is
 * exactly as it was. Unexpected errors propagate (after rollback) rather than
 * being reported as a tidy status, so they cannot be mistaken for a decision
 * this module made.
 */
export async function runM1Recovery(options: M1RecoveryOptions): Promise<M1RecoveryResult> {
  const mode = options.mode ?? "dry_run";

  const pre = preflight(options);
  if (!pre.ok) {
    return { status: "refused", refusal: pre.refusal };
  }
  const cohort = pre.cohort;
  const store = M1_RECOVERY_REQUIRED_STORE;
  const expectCohort = Number(options.expectCohort);
  const expectTotalPoints = Number(options.expectTotalPoints);

  try {
    const outcome = await options.transactor.transaction<{
      plan: M1RecoveryPlan;
      deleted: DeletionCounts;
    }>(async (tx) => {
      /* -- (1) Census --------------------------------------------------- */
      const observed = {
        customers: await countRows(tx, COUNT_CUSTOMERS_SQL, "customers count"),
        ledgerEntries: await countRows(tx, COUNT_LEDGER_SQL, "ledger_entries count"),
        pointLots: await countRows(tx, COUNT_LOTS_SQL, "point_lots count"),
      };

      // Resolve the cohort's local rows up front: needed both for the
      // nothing-to-revert check and for everything after it.
      const resolved: Array<{ member: AnchorCohortMember; customerId: string }> = [];
      const missing: AnchorCohortMember[] = [];
      for (const member of cohort) {
        const found = await tx.query<{ id: string; shopify_customer_id: string | number }>(
          FIND_COHORT_CUSTOMER_SQL,
          [member.shopifyCustomerId],
        );
        const row = found.rows[0];
        if (!row) {
          missing.push(member);
          continue;
        }
        resolved.push({ member, customerId: row.id });
      }

      /* -- (1b) A SECOND ATTEMPT MUST REFUSE CLEANLY -------------------- */
      // After a successful reversal the loyalty tables are empty again, which is
      // exactly the pre-M1 state. Running recovery again must therefore say
      // "there is nothing here" — not "the cohort count is wrong", and certainly
      // not throw. This check is deliberately BEFORE the cohort-count guard so
      // the empty database gets its own precise, honest refusal.
      if (
        observed.customers === 0 &&
        observed.ledgerEntries === 0 &&
        observed.pointLots === 0 &&
        resolved.length === 0
      ) {
        throw new RefusalSignal(
          refuse(
            "nothing_to_revert",
            `Nothing to revert: customers, ledger_entries and point_lots are all empty and none of ` +
              `the ${cohort.length} anchor cohort customers exist. This is the original pre-M1 ` +
              `state, so either M1 never ran or its reversal has already completed. Nothing was ` +
              `changed.`,
          ),
        );
      }

      /* -- (2) The migration total, BEFORE any other work --------------- */
      // Scoped to the migration identity but NOT to the cohort, so a stray M1
      // row for a customer the anchor never listed is caught here rather than
      // slipping past a cohort-scoped sum.
      const totalRes = await tx.query<{ total: string; count: string }>(MIGRATION_TOTAL_SQL, [
        MIGRATION_ENTRY_TYPE,
        MIGRATION_REASON,
      ]);
      const migrationRowCount = parseCount(totalRes.rows[0]?.count, "migration entry count");
      const migrationTotal = Number(totalRes.rows[0]?.total);
      if (!Number.isSafeInteger(migrationTotal)) {
        throw new DeleteError(
          `Unreadable migration point total '${String(totalRes.rows[0]?.total)}' from the database.`,
        );
      }
      if (migrationTotal !== expectTotalPoints || migrationRowCount !== expectCohort) {
        throw new RefusalSignal(
          refuse(
            "ledger_total_mismatch",
            `The ledger holds ${migrationRowCount} ${MIGRATION_ENTRY_TYPE}/${MIGRATION_REASON} ` +
              `entry(ies) totalling ${migrationTotal} point(s), but --expect-cohort is ` +
              `${expectCohort} and --expect-total-points is ${expectTotalPoints}. Refusing before ` +
              `doing anything: the ledger does not hold the migration you stated you were ` +
              `reversing.`,
            { manualRecoveryRequired: migrationRowCount > expectCohort },
          ),
        );
      }

      /* -- (3) The cohort found must be exactly the cohort expected ------ */
      if (resolved.length !== expectCohort) {
        throw new RefusalSignal(
          refuse(
            "cohort_count_mismatch",
            `Expected ${expectCohort} cohort customer(s) in the database but found ` +
              `${resolved.length}` +
              (missing.length > 0
                ? ` (absent: ${missing.map((m) => maskCustomerId(m.shopifyCustomerId)).join(", ")})`
                : "") +
              `. Refusing to delete a partial cohort.`,
            { manualRecoveryRequired: missing.length > 0 },
          ),
        );
      }

      /* -- (4)+(5) Per-customer structure and the entry-type whitelist --- */
      const malformed: MalformedStateFinding[] = [];
      const activity: PostMigrationActivityFinding[] = [];
      const customers: RevertedCustomer[] = [];
      let cohortLedgerRows = 0;
      let cohortLotRows = 0;
      let totalMigrationPoints = 0;

      for (const { member, customerId } of resolved) {
        const masked = maskCustomerId(member.shopifyCustomerId);

        const ledgerRes = await tx.query<CohortLedgerRow>(COHORT_LEDGER_SQL, [customerId]);
        const lotsRes = await tx.query<CohortLotRow>(COHORT_LOTS_SQL, [customerId]);
        const ledgerRows = ledgerRes.rows;
        const lotRows = lotsRes.rows;
        cohortLedgerRows += ledgerRows.length;
        cohortLotRows += lotRows.length;

        // (5) THE WHITELIST. Every row whose entry type is not the single
        // permitted one is post-M1 activity — including an entry type that does
        // not exist yet, which lands in `unknown_entry_type` and refuses.
        for (const row of ledgerRows) {
          if (!PERMITTED_ENTRY_TYPES.has(row.entry_type)) {
            activity.push({
              category: categoriseActivity(row.entry_type, row.reason),
              maskedShopifyCustomerId: masked,
              entryType: row.entry_type,
              reason: row.reason,
              // Signed, so the report distinguishes an earning from a spend at a
              // glance. Unreadable amounts are reported as-is rather than
              // silently zeroed — this row is already refusing the run.
              points: Number.isSafeInteger(Number(row.points)) ? Number(row.points) : Number.NaN,
            });
          }
        }

        const migrationRows = ledgerRows.filter(
          (r) => r.entry_type === MIGRATION_ENTRY_TYPE && r.reason === MIGRATION_REASON,
        );

        if (migrationRows.length === 0) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "customer_has_no_migration_entry",
            detail:
              `the anchor lists this customer but no ${MIGRATION_ENTRY_TYPE}/${MIGRATION_REASON} ` +
              `entry exists for them, so there is no M1 write here to reverse.`,
          });
          continue;
        }
        if (migrationRows.length > 1) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "customer_has_multiple_migration_entries",
            detail:
              `${migrationRows.length} migration entries exist where M1 writes exactly one; the ` +
              `state is not the one M1 produces.`,
          });
          continue;
        }

        const entry = migrationRows[0]!;
        const entryPoints = Number(entry.points);
        if (!Number.isSafeInteger(entryPoints)) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "lot_points_do_not_match_entry",
            detail: `the migration entry carries an unreadable point amount '${String(entry.points)}'.`,
          });
          continue;
        }

        // Tie the row back to the ANCHOR, not merely to itself: this is what
        // proves the rows present are the rows this anchor's M1 run produced.
        if (entryPoints !== member.expectedMigrationPoints) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "migration_points_do_not_match_anchor",
            detail:
              `the migration entry carries ${entryPoints} point(s) but the anchor implies ` +
              `${member.expectedMigrationPoints}; the rows in the database were not produced by ` +
              `this anchor.`,
          });
          continue;
        }

        const matchingLots = lotRows.filter((l) => l.ledger_entry_id === entry.id);
        if (matchingLots.length === 0) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "migration_entry_has_no_matching_lot",
            detail:
              `the migration entry has no point_lot linked to it; M1 always writes exactly one ` +
              `matching non-expiring lot.`,
          });
          continue;
        }
        if (matchingLots.length > 1) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "migration_entry_has_multiple_lots",
            detail: `${matchingLots.length} lots are linked to a single migration entry; M1 writes one.`,
          });
          continue;
        }
        // A lot that belongs to the customer but is linked to no migration entry
        // is an unmatched lot, and is just as disqualifying as a missing one.
        if (lotRows.length !== matchingLots.length) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "lot_is_not_matched_to_the_migration_entry",
            detail:
              `${lotRows.length - matchingLots.length} point_lot row(s) for this customer are not ` +
              `linked to the migration entry, so they are not M1's output and must not be deleted.`,
          });
          continue;
        }

        const lot = matchingLots[0]!;
        const original = Number(lot.original_points);
        const remaining = Number(lot.remaining_points);

        if (lot.expires_at !== null) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "lot_expires",
            detail: `the lot carries an expires_at; M1's migration lots are always non-expiring.`,
          });
          continue;
        }
        if (remaining < original) {
          // The single most important malformed case: the customer has SPENT
          // migrated points. Deleting the lot would erase evidence of real
          // customer value having moved.
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "lot_points_were_partially_spent",
            detail:
              `remaining_points (${remaining}) is below original_points (${original}), which means ` +
              `migrated points have been spent. Automatic rollback is not possible.`,
          });
          continue;
        }
        if (original !== entryPoints || remaining !== entryPoints) {
          malformed.push({
            maskedShopifyCustomerId: masked,
            problem: "lot_points_do_not_match_entry",
            detail:
              `lot original/remaining (${original}/${remaining}) do not both equal the migration ` +
              `entry's ${entryPoints} point(s).`,
          });
          continue;
        }

        totalMigrationPoints += entryPoints;
        customers.push({
          maskedShopifyCustomerId: masked,
          customerId,
          migrationPoints: entryPoints,
          ledgerEntryId: entry.id,
          pointLotId: lot.id,
        });
      }

      /* -- (5b) Post-M1 activity: refuse, and say why it is terminal ----- */
      if (activity.length > 0) {
        const byCategory = new Map<PostMigrationActivityCategory, number>();
        for (const a of activity) {
          byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1);
        }
        const summary = [...byCategory.entries()].map(([cat, n]) => `${cat} × ${n}`).join(", ");
        throw new RefusalSignal(
          refuse(
            "post_migration_activity",
            `AUTOMATIC ROLLBACK IS NOT POSSIBLE: ${activity.length} post-M1 loyalty movement(s) ` +
              `exist for the cohort (${summary}). MANUAL RECOVERY PLANNING IS REQUIRED — real ` +
              `customer activity has happened since the backfill, so deleting M1's rows would ` +
              `destroy the basis of balances customers have already earned or spent against. ` +
              `Nothing was changed. Findings are reported with masked customer ids.`,
            { activity, manualRecoveryRequired: true },
          ),
        );
      }

      /* -- (4b) Malformed / partial M1 state ---------------------------- */
      if (malformed.length > 0) {
        throw new RefusalSignal(
          refuse(
            "malformed_migration_state",
            `The database is not in clean post-M1 state: ${malformed.length} structural problem(s) ` +
              `found. MANUAL RECOVERY PLANNING IS REQUIRED — this tool only reverses the exact ` +
              `shape M1 produces (one migration entry + one matching non-expiring lot per cohort ` +
              `customer). Nothing was changed.`,
            { malformed, manualRecoveryRequired: true },
          ),
        );
      }

      /* -- (6) NOTHING may exist outside the expected M1 cohort ---------- */
      // The cohort's own migration total was already proved equal to the stated
      // expectation in step (2), and every entry was individually tied back to
      // the anchor above, so the sum is re-asserted here only as a cheap internal
      // invariant rather than as a second operator-facing check.
      if (totalMigrationPoints !== expectTotalPoints) {
        throw new DeleteError(
          `Internal invariant broken: the cohort's verified migration points ` +
            `(${totalMigrationPoints}) do not equal the pre-verified total (${expectTotalPoints}).`,
        );
      }

      if (
        observed.customers !== expectCohort ||
        observed.ledgerEntries !== expectCohort ||
        observed.pointLots !== expectCohort
      ) {
        // Production was empty before M1 (0/0/0, owner-verified), so clean
        // post-M1 state is exactly cohort/cohort/cohort. One extra row anywhere
        // means something else is in this database and "return it to empty" is
        // no longer the operation being authorised.
        const census = await tx.query<{ entry_type: string; reason: string; count: string }>(
          LEDGER_CENSUS_SQL,
        );
        const censusText = census.rows
          .map((r) => `${r.entry_type}/${r.reason} × ${r.count}`)
          .join(", ");
        throw new RefusalSignal(
          refuse(
            "unrelated_rows_present",
            `Rows exist OUTSIDE the expected M1 cohort: observed ${observed.customers} customer(s), ` +
              `${observed.ledgerEntries} ledger entry(ies), ${observed.pointLots} point lot(s), but ` +
              `clean post-M1 state is exactly ${expectCohort} of each (the cohort accounts for ` +
              `${resolved.length} customer(s), ${cohortLedgerRows} ledger entry(ies) and ` +
              `${cohortLotRows} lot(s)). Ledger census: ${censusText || "(empty)"}. MANUAL RECOVERY ` +
              `PLANNING IS REQUIRED — this database is not in clean post-M1 state, so a full ` +
              `reversal to the original empty state is not what would happen. Nothing was changed.`,
            { manualRecoveryRequired: true },
          ),
        );
      }

      const plan: M1RecoveryPlan = {
        store,
        cohortSize: customers.length,
        totalMigrationPoints,
        observed,
        customers,
      };

      /* -- (7) Dry run is the DEFAULT ----------------------------------- */
      if (mode !== "execute") {
        // Thrown, not returned, so the transaction rolls back and a dry run
        // cannot possibly have committed anything.
        throw new DryRunSignal(plan);
      }

      /* -- (8) Delete in foreign-key order: lots → entries → customers -- */
      let deletedLots = 0;
      for (const c of customers) {
        const res = await tx.query(DELETE_LOT_SQL, [c.pointLotId, c.customerId, c.ledgerEntryId]);
        const affected = res.rowCount ?? res.rows.length;
        if (affected !== 1) {
          throw new DeleteError(
            `Deleting the point_lot for ${c.maskedShopifyCustomerId} affected ${affected} row(s), ` +
              `expected exactly 1. The whole reversal was rolled back.`,
          );
        }
        deletedLots += 1;
      }

      let deletedEntries = 0;
      for (const c of customers) {
        const res = await tx.query(DELETE_MIGRATION_ENTRY_SQL, [
          c.ledgerEntryId,
          c.customerId,
          // The identity is re-asserted from the imported constants, so this
          // statement can only ever remove an M1 migration row.
          MIGRATION_ENTRY_TYPE,
          MIGRATION_REASON,
        ]);
        const affected = res.rowCount ?? res.rows.length;
        if (affected !== 1) {
          throw new DeleteError(
            `Deleting the migration ledger entry for ${c.maskedShopifyCustomerId} affected ` +
              `${affected} row(s), expected exactly 1. The whole reversal was rolled back.`,
          );
        }
        deletedEntries += 1;
      }

      let deletedCustomers = 0;
      for (let i = 0; i < customers.length; i += 1) {
        const c = customers[i]!;
        const member = resolved[i]!.member;
        const res = await tx.query(DELETE_COHORT_CUSTOMER_SQL, [c.customerId, member.shopifyCustomerId]);
        const affected = res.rowCount ?? res.rows.length;
        if (affected !== 1) {
          throw new DeleteError(
            `Deleting the customers row for ${c.maskedShopifyCustomerId} affected ${affected} ` +
              `row(s), expected exactly 1. The whole reversal was rolled back.`,
          );
        }
        deletedCustomers += 1;
      }

      return {
        plan,
        deleted: {
          pointLots: deletedLots,
          ledgerEntries: deletedEntries,
          customers: deletedCustomers,
        },
      };
    });

    return { status: "reverted", plan: outcome.plan, deleted: outcome.deleted };
  } catch (err) {
    // Every branch here has already been rolled back by the transactor.
    if (err instanceof RefusalSignal) {
      return { status: "refused", refusal: err.refusal };
    }
    if (err instanceof DryRunSignal) {
      return {
        status: "dry_run",
        plan: err.plan,
        wouldDelete: {
          pointLots: err.plan.customers.length,
          ledgerEntries: err.plan.customers.length,
          customers: err.plan.customers.length,
        },
      };
    }
    if (err instanceof DeleteError) {
      return { status: "aborted_delete_error", detail: { reason: err.message } };
    }
    // A genuinely unexpected failure propagates AFTER rollback, so it can never
    // be mistaken for a decision this module made. The database is unchanged.
    throw err;
  }
}
