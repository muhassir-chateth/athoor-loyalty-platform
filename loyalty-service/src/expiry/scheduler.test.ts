/**
 * Unit tests for the expiry scheduler (task 10.2).
 *
 * No live/production database, scheduler, ESP, or email is touched. The daily
 * run is exercised against a stateful in-memory fake modelling `point_lots`,
 * `ledger_entries`, and `pre_expiry_notifications`, plus a fake Transactor, the
 * real {@link LedgerRepository}, a recording fake notifier (the pluggable ESP),
 * and a fake {@link RecurringScheduler} that captures the registered handler.
 *
 * Covers:
 *   - {@link EXPIRY_WINDOW_MONTHS} is the shared 12-month constant (Req 5.1);
 *   - {@link runDailyExpiry} runs BOTH the FIFO expiry scan (matured lots) and
 *     the pre-expiry sweep (upcoming lots) at the same instant;
 *   - {@link registerExpiryScan} registers the daily job on the scheduler and,
 *     when the captured handler is invoked, the scan runs (a matured lot expires)
 *     and the sweep enqueues a notification.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import type { ExpiryScanDeps, Transactor } from "./expiryScan.js";
import { RecordingPreExpiryNotifier, type PreExpiryNotifyDeps } from "./preExpiryNotify.js";
import {
  EXPIRY_SCAN_CRON,
  EXPIRY_SCAN_JOB,
  EXPIRY_WINDOW_MONTHS,
  registerExpiryScan,
  runDailyExpiry,
  type ExpirySchedulerDeps,
  type RecurringScheduler,
} from "./scheduler.js";

interface FakeLot {
  id: string;
  customer_id: string;
  remaining_points: number;
  earned_at: Date;
  expires_at: Date | null;
  seq: number;
}

interface FakeNotificationRow {
  point_lot_id: string;
  notified_at: Date;
}

interface FakeLedgerEntry {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  order_reference: number | null;
  point_lot_id: string | null;
  redemption_id: string | null;
  source_event_id: string | null;
  created_at: Date;
}

interface FakeDb {
  db: Queryable;
  lots: FakeLot[];
  ledger: FakeLedgerEntry[];
  notifications: FakeNotificationRow[];
}

const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RUN_DATE = new Date("2025-06-01T00:00:00.000Z");

function makeDb(initialLots: FakeLot[]): FakeDb {
  const lots = initialLots.map((l) => ({ ...l }));
  const ledger: FakeLedgerEntry[] = [];
  const notifications: FakeNotificationRow[] = [];
  let idCounter = 0;

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
        rows,
        rowCount: rows.length,
        command,
        oid: 0,
        fields: [],
      });

      // Pre-expiry qualifying-lot select (references pre_expiry_notifications).
      if (/FROM point_lots/i.test(queryText) && /pre_expiry_notifications/i.test(queryText)) {
        const asOf = values[0] as Date;
        const windowEnd = values[1] as Date;
        const windowDays = values[2] as number;
        const selected = lots
          .filter((l) => {
            if (l.remaining_points <= 0 || l.expires_at === null) return false;
            const exp = l.expires_at.getTime();
            if (!(exp > asOf.getTime() && exp <= windowEnd.getTime())) return false;
            const windowStart = exp - windowDays * MS_PER_DAY;
            return !notifications.some(
              (n) => n.point_lot_id === l.id && n.notified_at.getTime() >= windowStart,
            );
          })
          .map((l) => ({
            id: l.id,
            customer_id: l.customer_id,
            remaining_points: String(l.remaining_points),
            earned_at: l.earned_at,
            expires_at: l.expires_at,
          }));
        return ok(selected as unknown as R[], "SELECT");
      }

      // Expiry-scan matured-lot select (FOR UPDATE, no dedupe table).
      if (/FROM point_lots/i.test(queryText) && /FOR UPDATE/i.test(queryText)) {
        const asOf = values[0] as Date;
        const selected = lots
          .filter(
            (l) =>
              l.expires_at !== null &&
              l.expires_at.getTime() <= asOf.getTime() &&
              l.remaining_points > 0,
          )
          .map((l) => ({
            id: l.id,
            customer_id: l.customer_id,
            remaining_points: String(l.remaining_points),
            earned_at: l.earned_at,
            expires_at: l.expires_at,
          }));
        return ok(selected as unknown as R[], "SELECT");
      }

      if (/UPDATE point_lots/i.test(queryText)) {
        const target = lots.find((l) => l.id === (values[0] as string));
        if (target) target.remaining_points = 0;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        const [customer_id, entry_type, points, reason, order_reference, point_lot_id] =
          values as [string, string, number, string, number | null, string | null];
        const row: FakeLedgerEntry = {
          id: `ledger-${++idCounter}`,
          customer_id,
          entry_type,
          points,
          reason,
          order_reference: order_reference ?? null,
          point_lot_id: point_lot_id ?? null,
          redemption_id: null,
          source_event_id: null,
          created_at: new Date("2025-06-01T00:00:00.000Z"),
        };
        ledger.push(row);
        return ok([{ ...row, points: String(points) }] as unknown as R[], "INSERT");
      }

      if (/INSERT INTO pre_expiry_notifications/i.test(queryText)) {
        notifications.push({
          point_lot_id: values[0] as string,
          notified_at: values[5] as Date,
        });
        return ok([], "INSERT") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  return { db, lots, ledger, notifications };
}

function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

function makeSchedulerDeps(fake: FakeDb): {
  deps: ExpirySchedulerDeps;
  notifier: RecordingPreExpiryNotifier;
} {
  const transactor = makeTransactor(fake.db);
  const expiry: ExpiryScanDeps = { repo: new LedgerRepository(fake.db), transactor };
  const notifier = new RecordingPreExpiryNotifier();
  const preExpiry: PreExpiryNotifyDeps = { transactor, notifier };
  return { deps: { expiry, preExpiry, now: () => RUN_DATE }, notifier };
}

/** A fake RecurringScheduler that captures the registered cron handler. */
class FakeScheduler implements RecurringScheduler {
  registrations: Array<{ jobName: string; cron: string; handler: () => Promise<void> }> = [];
  async schedule(jobName: string, cron: string, handler: () => Promise<void>): Promise<void> {
    this.registrations.push({ jobName, cron, handler });
  }
}

function lot(over: Partial<FakeLot> & Pick<FakeLot, "id" | "remaining_points" | "expires_at">): FakeLot {
  return {
    customer_id: CUSTOMER,
    earned_at: new Date("2024-06-01T00:00:00.000Z"),
    seq: 0,
    ...over,
  };
}

describe("EXPIRY_WINDOW_MONTHS: the shared 12-month lot expiry constant (Req 5.1)", () => {
  it("is exactly 12 months", () => {
    expect(EXPIRY_WINDOW_MONTHS).toBe(12);
  });
});

describe("runDailyExpiry: runs the scan and the pre-expiry sweep at one instant", () => {
  it("expires matured lots and notifies upcoming lots in the same run", async () => {
    const fake = makeDb([
      // Matured: expires before the run date → expired by the scan.
      lot({ id: "matured", remaining_points: 120, expires_at: new Date("2025-05-01T00:00:00Z") }),
      // Upcoming: expires within 30 days after the run date → notified by the sweep.
      lot({ id: "soon", remaining_points: 80, expires_at: new Date("2025-06-20T00:00:00Z") }),
      // Far out: neither expired nor notified.
      lot({ id: "far", remaining_points: 50, expires_at: new Date("2025-12-01T00:00:00Z") }),
    ]);
    const { deps, notifier } = makeSchedulerDeps(fake);

    const result = await runDailyExpiry(deps);

    // Same instant drove both halves.
    expect(result.asOf.getTime()).toBe(RUN_DATE.getTime());

    // Scan expired the matured lot exactly once.
    expect(result.expiry.expiredLotCount).toBe(1);
    expect(result.expiry.expiredLots[0]!.lotId).toBe("matured");
    expect(fake.ledger.filter((e) => e.entry_type === "expire")).toHaveLength(1);
    expect(fake.lots.find((l) => l.id === "matured")!.remaining_points).toBe(0);

    // Sweep notified the upcoming lot exactly once, with amount + date.
    expect(result.preExpiry.notifiedCount).toBe(1);
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]).toEqual({
      customerId: CUSTOMER,
      pointLotId: "soon",
      pointsExpiring: 80,
      expiresAt: new Date("2025-06-20T00:00:00Z"),
    });

    // Far-out lot untouched by both.
    expect(fake.lots.find((l) => l.id === "far")!.remaining_points).toBe(50);
  });
});

describe("registerExpiryScan: registration wires the daily run to the scheduler", () => {
  it("registers the job under the default schedule and invoking the handler runs scan + sweep", async () => {
    const fake = makeDb([
      lot({ id: "matured", remaining_points: 60, expires_at: new Date("2025-05-15T00:00:00Z") }),
      lot({ id: "soon", remaining_points: 40, expires_at: new Date("2025-06-10T00:00:00Z") }),
    ]);
    const { deps, notifier } = makeSchedulerDeps(fake);
    const scheduler = new FakeScheduler();

    const schedule = await registerExpiryScan(scheduler, deps);

    // Registered exactly once under the documented job name + cadence.
    expect(schedule.jobName).toBe(EXPIRY_SCAN_JOB);
    expect(schedule.cron).toBe(EXPIRY_SCAN_CRON);
    expect(scheduler.registrations).toHaveLength(1);
    expect(scheduler.registrations[0]!.jobName).toBe(EXPIRY_SCAN_JOB);

    // Nothing has run yet — registration does not invoke the scan.
    expect(fake.ledger).toHaveLength(0);
    expect(notifier.notifications).toHaveLength(0);

    // Invoking the captured handler runs the daily cycle.
    await scheduler.registrations[0]!.handler();

    expect(fake.ledger.filter((e) => e.entry_type === "expire")).toHaveLength(1);
    expect(fake.lots.find((l) => l.id === "matured")!.remaining_points).toBe(0);
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.pointLotId).toBe("soon");
  });
});
