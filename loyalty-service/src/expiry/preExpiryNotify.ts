/**
 * Pre-expiry notification sweep (task 10.2).
 *
 * Implements the Loyalty Engine's `runPreExpiryNotify(...)` half of the
 * design's "Data Flow: Expiry (scheduled, FIFO)" sequence:
 *
 *     CR->>E: runPreExpiryNotify(today + N days)
 *     E->>DB: SELECT lots expiring within N days
 *     E->>Q: enqueue preExpiryEmail(customer, amount, date)
 *
 * and design.md "Component 5: Scheduler" ("pre-expiry notification sweep") with
 * the ESP treated as a pluggable dependency (assumption A5 — the transactional
 * email/ESP provider is TBC and modelled as an injectable notifier).
 *
 * Contract (Requirements 5.4, 5.5):
 *   - 5.4  For each customer holding one or more Point_Lots whose
 *          `remaining_points > 0` AND whose `expires_at` falls within the
 *          configured pre-expiry window — a whole number of days from 1 to 90
 *          inclusive, default 30 — measured FORWARD from the sweep date, enqueue
 *          EXACTLY ONE notification per qualifying lot that has NOT already been
 *          notified within that lot's pre-expiry window. Each notification
 *          includes the lot's expiring amount and its expiry date.
 *   - 5.5  While a lot has already been notified within its pre-expiry window,
 *          NEVER enqueue a duplicate pre-expiry notification for that lot.
 *
 * ---------------------------------------------------------------------------
 * The window (measured forward from the sweep date)
 * ---------------------------------------------------------------------------
 * A lot qualifies when `sweepDate < expires_at <= sweepDate + windowDays`.
 * Lots that expire strictly after the window are too far out; lots whose
 * `expires_at <= sweepDate` are already mature and are handled by the expiry
 * scan (task 10.1), not by a pre-expiry heads-up. NULL-expiry (never-expiring,
 * e.g. migrated) lots never qualify.
 *
 * ---------------------------------------------------------------------------
 * Notified-tracking mechanism (dedupe store — Req 5.5)
 * ---------------------------------------------------------------------------
 * Deduplication is backed by a dedicated tracking table (documented in
 * {@link PRE_EXPIRY_NOTIFICATIONS_DDL}) that records one row each time a lot is
 * notified in its pre-expiry window:
 *
 *   CREATE TABLE pre_expiry_notifications (
 *       id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *       point_lot_id  UUID NOT NULL REFERENCES point_lots(id),
 *       customer_id   UUID NOT NULL REFERENCES customers(id),
 *       expires_at    TIMESTAMPTZ NOT NULL,  -- the lot expiry the notice was about
 *       points        BIGINT NOT NULL,       -- the expiring amount notified
 *       window_days   INTEGER NOT NULL,      -- the pre-expiry window used
 *       notified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
 *       UNIQUE (point_lot_id)                 -- at most one pre-expiry notice per lot
 *   );
 *
 * A lot is treated as "already notified within its window" when a tracking row
 * exists for it whose `notified_at` falls inside the lot's pre-expiry window
 * `[expires_at - windowDays, expires_at]`. The qualifying SELECT filters those
 * lots out with a `NOT EXISTS` guard (structurally the same idempotency
 * technique the expiry scan uses via `remaining_points > 0`): once a lot has a
 * tracking row inside its window, repeat sweeps on later days within that window
 * are a no-op for it (Req 5.5). Migration of this table is deferred (it is not
 * one of the seven ledger-core tables of task 1.2); the DDL here is the
 * authoritative spec for that follow-up migration.
 *
 * SCOPE (task 10.2): this module does NOT modify the expiry scan (task 10.1),
 * the earning module that sets lot expiry (task 4.2), or reconciliation. It only
 * READS `point_lots`, WRITES the dedupe table, and enqueues via the injected
 * notifier. It writes NOTHING to `ledger_entries` — a pre-expiry heads-up is not
 * a point movement.
 *
 * SAFETY: defining this module touches no live/production system, sends no real
 * email, and calls no Shopify Admin API. The ESP is reached only through the
 * injected {@link PreExpiryNotifier}; all DB access goes through the injected
 * {@link Queryable} / {@link Transactor}. Every path is unit-tested against an
 * in-memory fake DB + fake notifier + fake clock, so live verification is
 * deferred to deploy time.
 */
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

/** Default pre-expiry window in whole days (Req 5.4: default 30). */
export const DEFAULT_PRE_EXPIRY_WINDOW_DAYS = 30 as const;

/** Minimum configurable pre-expiry window in whole days (Req 5.4: 1 inclusive). */
export const MIN_PRE_EXPIRY_WINDOW_DAYS = 1 as const;

/** Maximum configurable pre-expiry window in whole days (Req 5.4: 90 inclusive). */
export const MAX_PRE_EXPIRY_WINDOW_DAYS = 90 as const;

/** Milliseconds in one whole day, used to project the window end forward. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The DDL for the dedupe/tracking table (documented here; migration deferred).
 * A `UNIQUE (point_lot_id)` gives the strongest guard — at most one pre-expiry
 * notification per lot — which, combined with the window-scoped `NOT EXISTS`
 * SELECT filter, satisfies Req 5.5.
 */
export const PRE_EXPIRY_NOTIFICATIONS_DDL = `
  CREATE TABLE pre_expiry_notifications (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      point_lot_id  UUID NOT NULL REFERENCES point_lots(id),
      customer_id   UUID NOT NULL REFERENCES customers(id),
      expires_at    TIMESTAMPTZ NOT NULL,
      points        BIGINT NOT NULL,
      window_days   INTEGER NOT NULL,
      notified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (point_lot_id)
  );
` as const;

/**
 * Validates a pre-expiry window: a whole number of days from
 * {@link MIN_PRE_EXPIRY_WINDOW_DAYS} to {@link MAX_PRE_EXPIRY_WINDOW_DAYS}
 * inclusive (Req 5.4). Throws {@link RangeError} otherwise; returns the window.
 */
export function validateWindowDays(windowDays: number): number {
  if (
    !Number.isInteger(windowDays) ||
    windowDays < MIN_PRE_EXPIRY_WINDOW_DAYS ||
    windowDays > MAX_PRE_EXPIRY_WINDOW_DAYS
  ) {
    throw new RangeError(
      `The pre-expiry window must be a whole number of days from ` +
        `${MIN_PRE_EXPIRY_WINDOW_DAYS} to ${MAX_PRE_EXPIRY_WINDOW_DAYS} inclusive ` +
        `(Requirement 5.4); received ${String(windowDays)}.`,
    );
  }
  return windowDays;
}

/**
 * Runs a unit of work inside a single database transaction. The sweep (select
 * qualifying lots FOR UPDATE → enqueue one notice per lot → record the dedupe
 * row) runs atomically so a lot can never be recorded-as-notified without its
 * notification having been enqueued, and vice versa. Declared locally
 * (structurally identical to the expiry scan's) so this module is independent.
 */
export interface Transactor {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * A single pre-expiry notification, carrying the lot's expiring amount and
 * expiry date (Req 5.4). This is the payload handed to the injected ESP.
 */
export interface PreExpiryNotification {
  /** The owning customer (local `customers.id`). */
  customerId: string;
  /** The `point_lots.id` this heads-up is about. */
  pointLotId: string;
  /** The lot's remaining (expiring) points — the expiring amount (> 0). */
  pointsExpiring: number;
  /** The lot's expiry date included in the notification. */
  expiresAt: Date;
}

/**
 * The injectable boundary to the ESP / notification queue (assumption A5 — the
 * ESP is a pluggable dependency, TBC). Production supplies an implementation
 * that enqueues a transactional email (e.g. via pg-boss → ESP); tests supply a
 * recording fake. Implementations MUST enqueue and return quickly and MUST NOT
 * send mail synchronously here — the sweep runs from the scheduler, off any
 * request path.
 */
export interface PreExpiryNotifier {
  enqueuePreExpiryNotification(notification: PreExpiryNotification): Promise<void>;
}

/**
 * In-memory notifier — the fake used by tests and a safe default. Records the
 * enqueued notifications so callers/tests can assert exactly one per qualifying
 * lot with the correct amount and date.
 */
export class RecordingPreExpiryNotifier implements PreExpiryNotifier {
  readonly notifications: PreExpiryNotification[] = [];
  async enqueuePreExpiryNotification(notification: PreExpiryNotification): Promise<void> {
    this.notifications.push({ ...notification });
  }
}

/**
 * The subset of pg-boss this notifier relies on (declared structurally so the
 * real `PgBoss` satisfies it without a hard type import), mirroring the
 * metafield cache enqueuer.
 */
export interface JobPublisher {
  send(queue: string, data: object, options?: object): Promise<string | null>;
}

/** The queue name pre-expiry notification jobs are published on. */
export const PRE_EXPIRY_NOTIFY_JOB = "preExpiryEmail" as const;

/**
 * pg-boss-backed notifier for production wiring. Publishes one job per
 * qualifying lot, keyed by `pointLotId` via `singletonKey` so an accidental
 * double-publish for the same lot collapses to one pending job (belt-and-braces
 * on top of the DB dedupe guard).
 */
export class PgBossPreExpiryNotifier implements PreExpiryNotifier {
  constructor(private readonly boss: JobPublisher) {}

  async enqueuePreExpiryNotification(notification: PreExpiryNotification): Promise<void> {
    await this.boss.send(
      PRE_EXPIRY_NOTIFY_JOB,
      {
        customerId: notification.customerId,
        pointLotId: notification.pointLotId,
        pointsExpiring: notification.pointsExpiring,
        expiresAt: notification.expiresAt.toISOString(),
      },
      { singletonKey: notification.pointLotId },
    );
  }
}

/** Dependencies for {@link runPreExpiryNotify}. */
export interface PreExpiryNotifyDeps {
  /** Runs the sweep inside one transaction. */
  transactor: Transactor;
  /** The injectable ESP / notification enqueuer (A5). */
  notifier: PreExpiryNotifier;
  /**
   * The pre-expiry window in whole days (Req 5.4). Defaults to
   * {@link DEFAULT_PRE_EXPIRY_WINDOW_DAYS}; validated to 1..90 inclusive.
   */
  windowDays?: number;
  /** Clock injection for the sweep date (defaults to `new Date()`). */
  now?: () => Date;
}

/** The outcome of a pre-expiry sweep for a given sweep date. */
export interface PreExpirySweepResult {
  /** The sweep's reference instant (the "sweep date"). */
  asOf: Date;
  /** The validated pre-expiry window used. */
  windowDays: number;
  /** The forward edge of the window (`asOf + windowDays`). */
  windowEnd: Date;
  /** One record per notification enqueued by THIS run (empty on a full no-op). */
  notified: PreExpiryNotification[];
  /** The number of notifications enqueued by this run. */
  notifiedCount: number;
}

interface QualifyingLotRow extends QueryResultRow {
  id: string;
  customer_id: string;
  remaining_points: string | number;
  earned_at: Date;
  expires_at: Date;
}

/**
 * Selects the qualifying, not-yet-notified lots, locked `FOR UPDATE` so a
 * concurrent redemption/expiry cannot change a lot mid-sweep. A lot matches when
 * it still carries `remaining_points > 0`, has a concrete `expires_at` strictly
 * after the sweep date and on or before the window edge, and has NO tracking row
 * inside its pre-expiry window `[expires_at - windowDays, expires_at]` (Req 5.4,
 * 5.5). Ordered by customer then FIFO for deterministic processing.
 *
 * Parameters: $1 = sweep date (asOf), $2 = window edge (asOf + windowDays),
 * $3 = windowDays (int, for the per-lot window in the NOT EXISTS guard).
 */
const SELECT_QUALIFYING_LOTS_SQL = `
  SELECT pl.id, pl.customer_id, pl.remaining_points, pl.earned_at, pl.expires_at
  FROM point_lots pl
  WHERE pl.remaining_points > 0
    AND pl.expires_at IS NOT NULL
    AND pl.expires_at > $1
    AND pl.expires_at <= $2
    AND NOT EXISTS (
      SELECT 1
      FROM pre_expiry_notifications n
      WHERE n.point_lot_id = pl.id
        AND n.notified_at >= pl.expires_at - make_interval(days => $3::int)
    )
  ORDER BY pl.customer_id ASC, pl.earned_at ASC, pl.ctid ASC
  FOR UPDATE OF pl
`;

/** Records that a lot was notified in its pre-expiry window (the dedupe row). */
const INSERT_NOTIFICATION_SQL = `
  INSERT INTO pre_expiry_notifications
    (point_lot_id, customer_id, expires_at, points, window_days, notified_at)
  VALUES ($1, $2, $3, $4, $5, $6)
`;

/** Parses a BIGINT column (`pg` returns it as a string) into a safe integer. */
function parseRemaining(value: string | number, lotId: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `point_lots.remaining_points value '${value}' for lot ${lotId} is outside the safe integer range.`,
    );
  }
  return n;
}

/**
 * Runs the pre-expiry notification sweep as of the sweep date (Requirements
 * 5.4, 5.5).
 *
 * For every still-funded lot whose `expires_at` falls within the configured
 * window forward of the sweep date AND that has not already been notified within
 * its pre-expiry window, within one transaction it:
 *   1. enqueues EXACTLY ONE notification (customer + expiring amount + expiry
 *      date) via the injected ESP notifier (Req 5.4), and
 *   2. records a dedupe row in `pre_expiry_notifications` so the lot is not
 *      notified again within its window (Req 5.5).
 *
 * Re-running on a later day still inside a lot's window is a no-op for that lot:
 * its tracking row makes the `NOT EXISTS` guard exclude it (Req 5.5). Returns the
 * per-lot notifications enqueued by THIS run plus the count and window used.
 *
 * @param deps transactor, injectable notifier, optional window/clock.
 */
export async function runPreExpiryNotify(deps: PreExpiryNotifyDeps): Promise<PreExpirySweepResult> {
  const windowDays = validateWindowDays(deps.windowDays ?? DEFAULT_PRE_EXPIRY_WINDOW_DAYS);
  const asOf = deps.now ? deps.now() : new Date();
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("runPreExpiryNotify requires a valid sweep date (now()).");
  }
  const windowEnd = new Date(asOf.getTime() + windowDays * MS_PER_DAY);

  const notified = await deps.transactor.transaction<PreExpiryNotification[]>(async (tx) => {
    const selected = await tx.query<QualifyingLotRow>(SELECT_QUALIFYING_LOTS_SQL, [
      asOf,
      windowEnd,
      windowDays,
    ]);

    const results: PreExpiryNotification[] = [];
    for (const row of selected.rows) {
      const pointsExpiring = parseRemaining(row.remaining_points, row.id);
      // The SELECT guarantees remaining > 0; guard defensively so a zero-amount
      // notice is never enqueued.
      if (pointsExpiring <= 0) {
        continue;
      }

      const notification: PreExpiryNotification = {
        customerId: row.customer_id,
        pointLotId: row.id,
        pointsExpiring,
        expiresAt: row.expires_at,
      };

      // (1) Enqueue exactly one notification for this lot (Req 5.4).
      await deps.notifier.enqueuePreExpiryNotification(notification);

      // (2) Record the dedupe row so we never re-notify within the window (Req 5.5).
      await tx.query(INSERT_NOTIFICATION_SQL, [
        row.id,
        row.customer_id,
        row.expires_at,
        pointsExpiring,
        windowDays,
        asOf,
      ]);

      results.push(notification);
    }

    return results;
  });

  return {
    asOf,
    windowDays,
    windowEnd,
    notified,
    notifiedCount: notified.length,
  };
}
