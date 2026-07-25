/**
 * Admin customer ledger/history view (task 17.2, Requirement 10.5).
 *
 * Requirement 10.5: WHEN an Admin_User selects a customer, THE Loyalty_Service
 * SHALL display that customer's COMPLETE Ledger and transaction history ordered
 * from MOST RECENT to OLDEST, where EACH entry shows its:
 *   - type          (the ledger `entry_type`);
 *   - point amount  (the signed movement);
 *   - reason        (the human-readable reason);
 *   - acting party  (who caused the movement — an Admin_User or the system);
 *   - timestamp     (when it was recorded).
 *
 * This is a READ surface for the admin console. Unlike the customer-facing
 * `GET /v1/history` (task 6.4), which collapses the nine ledger types into the
 * three customer-visible buckets `earned | spent | expired` (Req 6.1), the
 * admin view exposes the RAW `entry_type` so staff see full fidelity (e.g. it
 * distinguishes an `adjust` from an `earn_order` from a `clawback`) and returns
 * the customer's COMPLETE ledger, not a paginated slice (Req 10.5).
 *
 * ACTING PARTY (Req 10.5). Every ledger append records who caused it in
 * `source_event_id`:
 *   - a manual adjustment / manual credit stamps `admin:<adminUserId>`
 *     (see `adminActorTag` in adjustments.ts), so the acting party is that
 *     Admin_User;
 *   - an automated movement (signup/order/referral earn, redemption spend,
 *     clawback, expiry, migration, reconciliation) carries either a Shopify
 *     webhook id or null, i.e. the SYSTEM acted, not a person.
 * {@link deriveActingParty} maps `source_event_id` to a structured
 * {@link ActingParty} so the UI can render "who" uniformly.
 *
 * Data access is behind an injectable {@link AdminCustomerLedgerSource} with an
 * in-memory default, mirroring the balance/history/profile source pattern, so
 * the admin surface boots and is unit-testable WITHOUT live Postgres; the
 * Pg-backed source issues read-only SQL only when a real Pool/PoolClient is
 * wired at runtime.
 *
 * SAFETY: defining this module touches no live/production system. It performs
 * only read-only SELECTs when a real database is wired.
 */
import type { QueryResultRow } from "pg";
import type { LedgerEntryType, Queryable } from "../ledger/repository.js";

/** Prefix a ledger `source_event_id` carries when an Admin_User caused the entry. */
export const ADMIN_ACTOR_PREFIX = "admin:";

/**
 * Who caused a ledger movement (Req 10.5). `kind` is `admin` when a named
 * Admin_User acted (with `id` = their admin user id), otherwise `system` for an
 * automated movement (with `id` = `"system"`).
 */
export interface ActingParty {
  kind: "admin" | "system";
  /** The Admin_User id for an admin action, or `"system"` for an automated one. */
  id: string;
}

/** The reserved acting-party id used for automated/system-originated movements. */
export const SYSTEM_ACTING_PARTY: ActingParty = { kind: "system", id: "system" };

/**
 * Derives the {@link ActingParty} for a ledger entry from its `source_event_id`
 * (Req 10.5). An `admin:<id>` tag → that Admin_User; anything else (a Shopify
 * webhook id or null) → the system. Pure.
 */
export function deriveActingParty(sourceEventId: string | null | undefined): ActingParty {
  if (typeof sourceEventId === "string" && sourceEventId.startsWith(ADMIN_ACTOR_PREFIX)) {
    const id = sourceEventId.slice(ADMIN_ACTOR_PREFIX.length).trim();
    if (id.length > 0) {
      return { kind: "admin", id };
    }
  }
  return SYSTEM_ACTING_PARTY;
}

/**
 * A raw ledger entry as loaded from the store for the admin view. The pure
 * {@link mapAdminLedgerEntry} projects it into the admin-facing
 * {@link AdminLedgerEntryView}.
 */
export interface AdminRawLedgerEntry {
  id: string;
  entryType: LedgerEntryType;
  points: number;
  reason: string;
  orderReference: number | null;
  /** Records who caused the entry: `admin:<id>` for an admin action, else a webhook id/null. */
  sourceEventId: string | null;
  createdAt: Date;
}

/** A single admin-facing ledger entry (Req 10.5): type, amount, reason, acting party, timestamp. */
export interface AdminLedgerEntryView {
  /** The ledger row id (stable, opaque). */
  id: string;
  /** The RAW ledger entry type (full fidelity, not the customer-facing bucket). */
  type: LedgerEntryType;
  /** The signed point movement (positive = credit, negative = debit). */
  points: number;
  /** Human-readable reason for the movement (Req 10.5). */
  reason: string;
  /** Who caused the movement — an Admin_User or the system (Req 10.5). */
  actingParty: ActingParty;
  /** The movement timestamp as an ISO 8601 string (Req 10.5). */
  timestamp: string;
  /** The associated Shopify order id, or null when not order-associated. */
  orderReference: number | null;
}

/** The complete admin ledger view for a customer (Req 10.5). */
export interface AdminCustomerLedgerView {
  /** The customer whose ledger this is. */
  customerId: string;
  /** Every ledger entry for the customer, most-recent-first (Req 10.5). */
  entries: AdminLedgerEntryView[];
  /** The total number of entries returned (the customer's complete ledger size). */
  totalCount: number;
}

/** Projects a raw ledger entry into the admin-facing view (pure, Req 10.5). */
export function mapAdminLedgerEntry(entry: AdminRawLedgerEntry): AdminLedgerEntryView {
  return {
    id: entry.id,
    type: entry.entryType,
    points: entry.points,
    reason: entry.reason,
    actingParty: deriveActingParty(entry.sourceEventId),
    timestamp: entry.createdAt.toISOString(),
    orderReference: entry.orderReference,
  };
}

/**
 * Sorts raw entries most-recent-first and projects them, then wraps them in an
 * {@link AdminCustomerLedgerView} (pure). Ordering is by `createdAt` descending,
 * tie-broken by descending id, matching the customer history ordering (Req 6.2)
 * so the two surfaces agree on order for entries sharing a timestamp.
 */
export function buildAdminCustomerLedgerView(
  customerId: string,
  rawEntries: readonly AdminRawLedgerEntry[],
): AdminCustomerLedgerView {
  const sorted = [...rawEntries].sort((a, b) => {
    const byDate = b.createdAt.getTime() - a.createdAt.getTime();
    if (byDate !== 0) {
      return byDate;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const entries = sorted.map(mapAdminLedgerEntry);
  return { customerId, entries, totalCount: entries.length };
}

/**
 * Loads a customer's COMPLETE ledger (Req 10.5). Expressed as an injectable
 * interface so the route is unit-testable with an in-memory fake and never
 * requires a live Postgres (mirrors the history source pattern).
 */
export interface AdminCustomerLedgerSource {
  loadLedger(customerId: string): Promise<AdminRawLedgerEntry[]>;
}

const SELECT_CUSTOMER_LEDGER_SQL = `
  SELECT id, entry_type, points, reason, order_reference, source_event_id, created_at
  FROM ledger_entries
  WHERE customer_id = $1
  ORDER BY created_at DESC, id DESC
`;

interface LedgerDbRow extends QueryResultRow {
  id: string;
  entry_type: string;
  points: string | number;
  reason: string;
  order_reference: string | number | null;
  source_event_id: string | null;
  created_at: Date;
}

function parseIntegerColumn(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres-backed {@link AdminCustomerLedgerSource}: reads the customer's
 * complete ledger from `ledger_entries`, most-recent-first. Read-only.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing.
 */
export class PgAdminCustomerLedgerSource implements AdminCustomerLedgerSource {
  constructor(private readonly db: Queryable) {}

  async loadLedger(customerId: string): Promise<AdminRawLedgerEntry[]> {
    const result = await this.db.query<LedgerDbRow>(SELECT_CUSTOMER_LEDGER_SQL, [customerId]);
    return result.rows.map((row) => ({
      id: row.id,
      entryType: row.entry_type as LedgerEntryType,
      points: parseIntegerColumn(row.points),
      reason: row.reason,
      orderReference: row.order_reference === null ? null : parseIntegerColumn(row.order_reference),
      sourceEventId: row.source_event_id,
      createdAt: row.created_at,
    }));
  }
}

/**
 * In-memory {@link AdminCustomerLedgerSource} backed by a `customerId → entries`
 * map. The default source for local runs and the vehicle for tests, so the
 * admin customer view runs with no live Postgres. An unknown customer yields an
 * empty ledger.
 */
export class InMemoryAdminCustomerLedgerSource implements AdminCustomerLedgerSource {
  private readonly byCustomerId: Map<string, AdminRawLedgerEntry[]>;

  constructor(
    entries: Record<string, AdminRawLedgerEntry[]> | Map<string, AdminRawLedgerEntry[]> = {},
  ) {
    this.byCustomerId =
      entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async loadLedger(customerId: string): Promise<AdminRawLedgerEntry[]> {
    return [...(this.byCustomerId.get(customerId) ?? [])];
  }

  /** Test/setup helper: register a customer's raw ledger entries. */
  set(customerId: string, entries: AdminRawLedgerEntry[]): void {
    this.byCustomerId.set(customerId, entries);
  }
}
