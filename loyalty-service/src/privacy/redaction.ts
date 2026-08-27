/**
 * The operator-run redaction procedure (spec task 15.3, design §15.5/§15.6,
 * Req 23.5, 23.6, 23.7, 23.9, 22.11).
 *
 * ── THE D4 BOUNDARY, RESTATED AS A PROPERTY OF THIS FILE ────────────────────
 * D4 — registering Shopify's `customers/redact` compliance webhook — is NOT
 * AUTHORISED (Requirement 22.11 forbids webhook subscription changes during the
 * rollout). So this module:
 *
 *   • registers NO webhook subscription and contains no webhook topic, no
 *     subscription call and no HMAC path. `redaction.test.ts` asserts that by
 *     scanning this source, so an edit that quietly added one would fail;
 *   • is invoked by an OPERATOR, explicitly, against a named customer;
 *   • ACCEPTS a queue row whose `source` is `shopify_redaction`, because §15.6's
 *     mechanism is designed and the column exists to receive it. Accepting such a
 *     row is not the same as subscribing to the webhook, and the distinction is
 *     the whole D4 boundary: the data model is ready, the subscription is not made.
 *
 * ── FAIL CLOSED, EVERYWHERE ─────────────────────────────────────────────────
 * Four refusals, all before anything is written:
 *   1. no target → refuse. There is no "redact everyone" mode and no default.
 *   2. a target that is not a well-formed UUID → refuse without querying.
 *   3. a target with no `customers` row → refuse. Redacting a customer that does
 *      not exist would be a no-op that reported success.
 *   4. no explicit confirmation on a live run → refuse. `dryRun` is the DEFAULT,
 *      so the destructive path cannot be reached by forgetting an argument.
 *
 * ── THE LEDGER IS NEVER TOUCHED (Req 23.6) ──────────────────────────────────
 * §15.5's design point: `ledger_entries` holds no personal data — a row is an
 * opaque `customer_id`, an entry type, a reason, points and timestamps. Once the
 * identifying values elsewhere are gone, the ledger is a set of numbers attached to
 * an identifier that no longer resolves to a person. So it needs no redaction, and
 * this procedure issues NO statement against it, nor against `point_lots`,
 * `redemptions`, `discount_codes` or `referrals`. The executor wrapper below
 * REFUSES such a statement at runtime rather than trusting the statement list, and
 * a test asserts the refusal fires.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────
 * Every action is a `DELETE ... WHERE customer_id = $1` or an `UPDATE ... SET
 * email = NULL`. Re-running affects zero rows and changes nothing. There is no
 * "already redacted?" check to get wrong, because the operations are naturally
 * idempotent — which is a stronger guarantee than a guard.
 *
 * SAFETY: destructive by design, and therefore gated as above. Defining this module
 * executes nothing; a caller must pass a real executor AND pass `dryRun: false`.
 */
import { AUDIT_OPERATION_TYPES, SYSTEM_ACTOR_ID } from "../admin/auditTrail.js";

/** The `pg` surface this procedure needs. A Pool or a PoolClient satisfies it. */
export interface RedactionExecutor {
  query<R = unknown>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Runs work inside a transaction, so a partial redaction cannot commit. */
export interface RedactionTransactor {
  transaction<T>(fn: (tx: RedactionExecutor) => Promise<T>): Promise<T>;
}

/**
 * Tables emptied of the customer's rows, in execution order (§15.5).
 *
 * ORDER IS DELIBERATE: the two tombstone-bearing tables (`customer_wishlist` and
 * its removals) go together, and `customer_erasure_requests` is NOT in this list
 * because §15.5 retains it as the audit record of the request.
 */
export const REDACTION_DELETE_TABLES = [
  "customer_birthdays",
  "customer_fragrance_preferences",
  "customer_communication_preferences",
  "customer_favourites",
  "customer_wishlist",
  "customer_wishlist_removals",
  "customer_recently_viewed",
  "device_tokens",
  "portal_visits",
] as const;

/**
 * Tables RETAINED, with the reason, so the omission is legible (§15.5).
 *
 * Not used by the procedure — it is documentation the test asserts against, so a
 * table moved between the two lists is a visible change rather than a silent one.
 */
export const REDACTION_RETAINED_TABLES: Readonly<Record<string, string>> = Object.freeze({
  ledger_entries: "append-only, holds no personal data (Req 23.6)",
  point_lots: "no personal content",
  redemptions: "no personal content; unredeemed codes voided in Shopify by the operator",
  discount_codes: "no personal content",
  referrals: "no personal content",
  birthday_grants: "holds no birthday value; needed to keep the once-per-year guard honest",
  customer_erasure_requests: "the audit record of the request itself",
});

/**
 * Tables no redaction statement may ever name (Req 23.6).
 *
 * Enforced at RUNTIME by {@link guardLedgerSafety}, not merely by the statement
 * list above, because the list is what a future edit changes and the guard is what
 * catches that edit.
 */
export const LEDGER_PROTECTED_TABLES = [
  "ledger_entries",
  "point_lots",
  "redemptions",
  "discount_codes",
  "referrals",
] as const;

/** Matches a canonical UUID. Anything else is refused before a query is issued. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Why a redaction refused. Identifiers, so a caller can branch on the cause. */
export const REDACTION_REFUSAL_REASONS = [
  "no_target",
  "malformed_target",
  "unknown_customer",
  "not_confirmed",
  "ledger_statement_refused",
] as const;
export type RedactionRefusalReason = (typeof REDACTION_REFUSAL_REASONS)[number];

/** Raised when the procedure refuses. Carries the reason, never any PII. */
export class RedactionRefusedError extends Error {
  readonly code = "redaction_refused" as const;
  readonly reason: RedactionRefusalReason;
  constructor(reason: RedactionRefusalReason) {
    // The message is a constant plus an identifier. No email, no name, no id —
    // this can reach a console and §15.7 forbids PII in output.
    super(`Redaction refused: ${reason}.`);
    this.name = "RedactionRefusedError";
    this.reason = reason;
  }
}

/**
 * Wraps an executor so any statement naming a ledger-protected table is refused.
 *
 * THE POINT OF DOING THIS AT RUNTIME rather than by review: the statement list is
 * exactly what a future edit changes, and a reviewer reading a diff that adds
 * `DELETE FROM redemptions` to a redaction procedure could plausibly think it
 * reasonable. This makes it impossible instead of ill-advised.
 */
export function guardLedgerSafety(executor: RedactionExecutor): RedactionExecutor {
  return {
    async query<R = unknown>(sql: string, values?: unknown[]) {
      const lowered = sql.toLowerCase();
      for (const table of LEDGER_PROTECTED_TABLES) {
        // Word-boundary matched, so `redemptions` does not trip on a comment and
        // `point_lots` does not match `point_lots_archive` by prefix.
        if (new RegExp(`\\b${table}\\b`).test(lowered)) {
          throw new RedactionRefusedError("ledger_statement_refused");
        }
      }
      return executor.query<R>(sql, values);
    },
  };
}

/** What a run did, or would do. */
export interface RedactionOutcome {
  readonly customerId: string;
  readonly dryRun: boolean;
  /** Rows affected per table, in {@link REDACTION_DELETE_TABLES} order. */
  readonly deleted: Readonly<Record<string, number>>;
  /** True iff `customers.email` was cleared (or would be). */
  readonly emailRedacted: boolean;
  /** How many erasure requests were marked completed. */
  readonly requestsCompleted: number;
  /** Retained tables and why, echoed so the operator sees what was NOT touched. */
  readonly retained: Readonly<Record<string, string>>;
}

/** Options for {@link runCustomerRedaction}. */
export interface RedactionOptions {
  /** The local `customers.id` to redact. REQUIRED — there is no default. */
  readonly customerId?: string | null;
  /**
   * `true` (the DEFAULT) previews without writing.
   *
   * The default is the safe value on purpose: a caller who forgets this argument
   * gets a preview, not a deletion. Reversing it would make the destructive path
   * the one you reach by omission.
   */
  readonly dryRun?: boolean;
  /**
   * Must be `true` for a live run. Belt to `dryRun`'s braces.
   *
   * Two independent affirmations are required to delete, because `dryRun: false`
   * alone is one keystroke away from `dryRun: true` and this operation is
   * irreversible across nine tables.
   */
  readonly confirm?: boolean;
  /** The operator's id for the audit record. Defaults to the system actor. */
  readonly actorId?: string;
}

/** The audit operation type this procedure writes. */
export const REDACTION_AUDIT_OPERATION = "customer_redaction" as const;

/**
 * `customers.email` is NULLABLE — confirmed from
 * `1784817408986_create-ledger-core` (`email CITEXT`, no `NOT NULL`, and no
 * `UNIQUE` on it; only `shopify_customer_id` and `referral_code` are unique).
 *
 * That resolves OQ-9, so §15.5's first branch applies and erasure sets the column
 * to `NULL`. The deterministic `redacted-<id>@invalid` tombstone was the fallback
 * for a NOT NULL column and is deliberately NOT used: a tombstone still stores a
 * value derived from the customer's id, and `NULL` stores nothing at all. Where
 * both satisfy the constraint, storing nothing is the better privacy outcome.
 */
export const EMAIL_IS_NULLABLE = true as const;

/**
 * Redacts one customer, or previews the redaction.
 *
 * @throws {RedactionRefusedError} any of the four fail-closed conditions
 */
export async function runCustomerRedaction(
  transactor: RedactionTransactor,
  options: RedactionOptions,
): Promise<RedactionOutcome> {
  const customerId = options.customerId ?? null;
  const dryRun = options.dryRun ?? true;

  // ── Fail closed, before anything is read or written ──────────────────────
  if (customerId === null || customerId.trim() === "") {
    throw new RedactionRefusedError("no_target");
  }
  if (!UUID_PATTERN.test(customerId)) {
    // Refused WITHOUT a query. A malformed target reaching the database is how a
    // typo becomes a wildcard.
    throw new RedactionRefusedError("malformed_target");
  }
  if (!dryRun && options.confirm !== true) {
    throw new RedactionRefusedError("not_confirmed");
  }

  return transactor.transaction(async (raw) => {
    // Every statement below goes through the guard, so the ledger cannot be
    // reached even by a future edit to this function.
    const db = guardLedgerSafety(raw);

    // The customer must exist. A redaction of nobody that reported success would
    // let an operator believe a request had been actioned.
    const found = await db.query<{ id: string }>(
      "SELECT id FROM customers WHERE id = $1 LIMIT 1",
      [customerId],
    );
    if (found.rows.length === 0) {
      throw new RedactionRefusedError("unknown_customer");
    }

    const deleted: Record<string, number> = {};

    for (const table of REDACTION_DELETE_TABLES) {
      if (dryRun) {
        // COUNT, do not delete. The preview reports exactly what the live run
        // would remove, from the same predicate, so the two cannot disagree.
        const counted = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE customer_id = $1`,
          [customerId],
        );
        deleted[table] = Number(counted.rows[0]?.n ?? 0);
      } else {
        const result = await db.query(`DELETE FROM ${table} WHERE customer_id = $1`, [customerId]);
        deleted[table] = result.rowCount ?? 0;
      }
    }

    // The email. NULL rather than a tombstone — see EMAIL_IS_NULLABLE.
    let emailRedacted = false;
    if (dryRun) {
      const held = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM customers WHERE id = $1 AND email IS NOT NULL",
        [customerId],
      );
      emailRedacted = Number(held.rows[0]?.n ?? 0) > 0;
    } else {
      const cleared = await db.query(
        "UPDATE customers SET email = NULL, updated_at = now() WHERE id = $1 AND email IS NOT NULL",
        [customerId],
      );
      emailRedacted = (cleared.rowCount ?? 0) > 0;
    }

    // The request record is RETAINED and marked completed (§15.5).
    let requestsCompleted = 0;
    if (dryRun) {
      const open = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM customer_erasure_requests WHERE customer_id = $1 AND status <> 'completed'",
        [customerId],
      );
      requestsCompleted = Number(open.rows[0]?.n ?? 0);
    } else {
      const completed = await db.query(
        `UPDATE customer_erasure_requests
            SET status = 'completed', completed_at = now()
          WHERE customer_id = $1 AND status <> 'completed'`,
        [customerId],
      );
      requestsCompleted = completed.rowCount ?? 0;
    }

    // The audit record. Written INSIDE the transaction, so a redaction cannot
    // commit without its record and the record cannot survive a rollback.
    if (!dryRun) {
      await db.query(
        `INSERT INTO admin_audit_log
                 (admin_user_id, operation_type, affected_customer_id, detail)
          VALUES ($1, $2, $3, $4)`,
        [
          options.actorId ?? SYSTEM_ACTOR_ID,
          REDACTION_AUDIT_OPERATION,
          customerId,
          // COUNTS AND TABLE NAMES ONLY. No email, no birthday, no product ids —
          // an audit record of a privacy erasure must not itself become a store of
          // the data that was erased (§15.7).
          JSON.stringify({
            action: "customer_redaction",
            deleted,
            emailRedacted,
            requestsCompleted,
            ledgerTouched: false,
          }),
        ],
      );
    }

    return {
      customerId,
      dryRun,
      deleted,
      emailRedacted,
      requestsCompleted,
      retained: REDACTION_RETAINED_TABLES,
    };
  });
}

/**
 * The audit type this procedure uses is one the shared vocabulary knows about.
 *
 * A compile-time check, so adding the operation here without adding it to
 * `AUDIT_OPERATION_TYPES` (and therefore without the migration that widens the
 * CHECK) fails the build rather than failing at 2am against production.
 */
export type RedactionAuditTypeIsRegistered =
  typeof REDACTION_AUDIT_OPERATION extends (typeof AUDIT_OPERATION_TYPES)[number] ? true : never;
