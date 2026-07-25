/**
 * Unit tests for the pre-expiry notification sweep (task 10.2).
 *
 * No live/production database, ESP, or email is touched. The sweep is exercised
 * against a stateful in-memory fake that models the `point_lots` table, the
 * `pre_expiry_notifications` dedupe table, and the SQL the sweep issues — the
 * qualifying-lot `FOR UPDATE` select (with its window + NOT-EXISTS dedupe
 * filter) and the dedupe-row insert — plus a fake Transactor and a recording
 * fake notifier standing in for the pluggable ESP (A5).
 *
 * Covers (Requirements 5.4, 5.5):
 *   - a lot expiring within the window is notified exactly once, with its
 *     expiring amount and expiry date;
 *   - a lot already notified within its window is skipped (Req 5.5);
 *   - lots outside the window (too far out, already mature, never-expiring) are
 *     not notified;
 *   - the window bounds are respected (asOf-exclusive, windowEnd-inclusive) and
 *     honour a configured non-default window;
 *   - re-running the same sweep date is a no-op (dedupe recorded on run 1);
 *   - window validation rejects 0/91/non-integer.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  DEFAULT_PRE_EXPIRY_WINDOW_DAYS,
  RecordingPreExpiryNotifier,
  runPreExpiryNotify,
  validateWindowDays,
  type PreExpiryNotifyDeps,
  type Transactor,
} from "./preExpiryNotify.js";

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
  customer_id: string;
  expires_at: Date;
  points: number;
  window_days: number;
  notified_at: Date;
}

interface FakeDb {
  db: Queryable;
  lots: FakeLot[];
  notifications: FakeNotificationRow[];
  statements: string[];
}

const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const CUSTOMER_B = "33333333-3333-3333-3333-333333333333";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeDb(initialLots: FakeLot[] = [], initialNotifs: FakeNotificationRow[] = []): FakeDb {
  const lots = initialLots.map((l) => ({ ...l }));
  const notifications = initialNotifs.map((n) => ({ ...n }));
  const statements: string[] = [];

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      statements.push(queryText.trim());
      const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
        rows,
        rowCount: rows.length,
        command,
        oid: 0,
        fields: [],
      });

      // Qualifying-lot selection with window + NOT-EXISTS dedupe filter.
      if (/FROM point_lots/i.test(queryText) && /FOR UPDATE/i.test(queryText)) {
        const asOf = values[0] as Date;
        const windowEnd = values[1] as Date;
        const windowDays = values[2] as number;
        const selected = lots
          .filter((l) => {
            if (l.remaining_points <= 0 || l.expires_at === null) {
              return false;
            }
            const exp = l.expires_at.getTime();
            if (!(exp > asOf.getTime() && exp <= windowEnd.getTime())) {
              return false;
            }
            // NOT EXISTS: no tracking row within [expires_at - windowDays, expires_at].
            const windowStart = exp - windowDays * MS_PER_DAY;
            const alreadyNotified = notifications.some(
              (n) => n.point_lot_id === l.id && n.notified_at.getTime() >= windowStart,
            );
            return !alreadyNotified;
          })
          .sort(
            (a, b) =>
              a.customer_id.localeCompare(b.customer_id) ||
              a.earned_at.getTime() - b.earned_at.getTime() ||
              a.seq - b.seq,
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

      if (/INSERT INTO pre_expiry_notifications/i.test(queryText)) {
        const [point_lot_id, customer_id, expires_at, points, window_days, notified_at] =
          values as [string, string, Date, number, number, Date];
        notifications.push({
          point_lot_id,
          customer_id,
          expires_at,
          points,
          window_days,
          notified_at,
        });
        return ok([], "INSERT") as unknown as QueryResult<R>;
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  return { db, lots, notifications, statements };
}

/** A fake Transactor that runs the callback against the fake db (no real BEGIN/COMMIT). */
function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

function makeDeps(
  fake: FakeDb,
  over: Partial<PreExpiryNotifyDeps> = {},
): { deps: PreExpiryNotifyDeps; notifier: RecordingPreExpiryNotifier } {
  const notifier = over.notifier
    ? (over.notifier as RecordingPreExpiryNotifier)
    : new RecordingPreExpiryNotifier();
  const deps: PreExpiryNotifyDeps = {
    transactor: makeTransactor(fake.db),
    notifier,
    now: () => SWEEP_DATE,
    ...over,
  };
  return { deps, notifier };
}

function lot(over: Partial<FakeLot> & Pick<FakeLot, "id" | "remaining_points">): FakeLot {
  return {
    customer_id: CUSTOMER,
    earned_at: new Date("2024-06-01T00:00:00.000Z"),
    expires_at: new Date("2025-06-15T00:00:00.000Z"),
    seq: 0,
    ...over,
  };
}

const SWEEP_DATE = new Date("2025-06-01T00:00:00.000Z");
/** +30 days default window edge. */
const WINDOW_END_30 = new Date(SWEEP_DATE.getTime() + DEFAULT_PRE_EXPIRY_WINDOW_DAYS * MS_PER_DAY);

describe("runPreExpiryNotify: qualifying lots notified once with amount + date (Req 5.4)", () => {
  it("enqueues exactly one notification carrying the expiring amount and expiry date", async () => {
    const expiresAt = new Date("2025-06-20T00:00:00.000Z"); // within 30 days of sweep
    const fake = makeDb([lot({ id: "soon", remaining_points: 80, expires_at: expiresAt })]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]).toEqual({
      customerId: CUSTOMER,
      pointLotId: "soon",
      pointsExpiring: 80,
      expiresAt,
    });
    expect(result.notifiedCount).toBe(1);
    expect(result.windowDays).toBe(DEFAULT_PRE_EXPIRY_WINDOW_DAYS);
    expect(result.windowEnd.getTime()).toBe(WINDOW_END_30.getTime());

    // A dedupe row was recorded for the lot.
    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0]!.point_lot_id).toBe("soon");
    expect(fake.notifications[0]!.points).toBe(80);
    expect(fake.notifications[0]!.window_days).toBe(DEFAULT_PRE_EXPIRY_WINDOW_DAYS);
  });

  it("notifies each qualifying lot across customers exactly once", async () => {
    const fake = makeDb([
      lot({ id: "a", remaining_points: 30, expires_at: new Date("2025-06-10T00:00:00Z") }),
      lot({
        id: "b",
        remaining_points: 70,
        customer_id: CUSTOMER_B,
        expires_at: new Date("2025-06-25T00:00:00Z"),
      }),
    ]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(2);
    expect(notifier.notifications.map((n) => n.pointLotId).sort()).toEqual(["a", "b"]);
    expect(fake.notifications).toHaveLength(2);
  });
});

describe("runPreExpiryNotify: already-notified lots are skipped (Req 5.5)", () => {
  it("does not re-notify a lot with a tracking row inside its window", async () => {
    const expiresAt = new Date("2025-06-20T00:00:00.000Z");
    const fake = makeDb(
      [lot({ id: "soon", remaining_points: 80, expires_at: expiresAt })],
      [
        {
          point_lot_id: "soon",
          customer_id: CUSTOMER,
          expires_at: expiresAt,
          points: 80,
          window_days: DEFAULT_PRE_EXPIRY_WINDOW_DAYS,
          // notified a few days before the sweep — inside the lot's window.
          notified_at: new Date("2025-05-28T00:00:00.000Z"),
        },
      ],
    );
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(0);
    expect(notifier.notifications).toHaveLength(0);
    // No new dedupe row added.
    expect(fake.notifications).toHaveLength(1);
  });

  it("re-running the same sweep date is a no-op (dedupe recorded on first run)", async () => {
    const fake = makeDb([
      lot({ id: "soon", remaining_points: 40, expires_at: new Date("2025-06-15T00:00:00Z") }),
    ]);
    const { deps, notifier } = makeDeps(fake);

    const first = await runPreExpiryNotify(deps);
    expect(first.notifiedCount).toBe(1);
    expect(notifier.notifications).toHaveLength(1);

    const second = await runPreExpiryNotify(deps);
    expect(second.notifiedCount).toBe(0);
    expect(notifier.notifications).toHaveLength(1);
    expect(fake.notifications).toHaveLength(1);
  });
});

describe("runPreExpiryNotify: lots outside the window are not notified (Req 5.4)", () => {
  it("does not notify a lot expiring after the window edge", async () => {
    const fake = makeDb([
      lot({ id: "far", remaining_points: 200, expires_at: new Date("2025-08-01T00:00:00Z") }),
    ]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(0);
    expect(notifier.notifications).toHaveLength(0);
  });

  it("does not notify a lot that has already matured (expires on/before the sweep date)", async () => {
    const fake = makeDb([
      lot({ id: "past", remaining_points: 50, expires_at: new Date("2025-05-15T00:00:00Z") }),
      lot({ id: "today", remaining_points: 50, expires_at: SWEEP_DATE }),
    ]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(0);
    expect(notifier.notifications).toHaveLength(0);
  });

  it("never notifies a NULL-expiry (never-expiring) lot", async () => {
    const fake = makeDb([lot({ id: "migrated", remaining_points: 500, expires_at: null })]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(0);
    expect(notifier.notifications).toHaveLength(0);
  });

  it("does not notify a lot with zero remaining points", async () => {
    const fake = makeDb([
      lot({ id: "empty", remaining_points: 0, expires_at: new Date("2025-06-10T00:00:00Z") }),
    ]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(0);
    expect(notifier.notifications).toHaveLength(0);
  });
});

describe("runPreExpiryNotify: window bounds respected", () => {
  it("includes a lot expiring exactly on the window edge (inclusive) and excludes one just past it", async () => {
    const onEdge = new Date(WINDOW_END_30.getTime());
    const justPast = new Date(WINDOW_END_30.getTime() + MS_PER_DAY);
    const fake = makeDb([
      lot({ id: "edge", remaining_points: 10, expires_at: onEdge }),
      lot({ id: "past-edge", remaining_points: 10, expires_at: justPast }),
    ]);
    const { deps, notifier } = makeDeps(fake);

    const result = await runPreExpiryNotify(deps);

    expect(result.notifiedCount).toBe(1);
    expect(notifier.notifications.map((n) => n.pointLotId)).toEqual(["edge"]);
  });

  it("honours a configured non-default window (60 days) to include lots further out", async () => {
    const fake = makeDb([
      lot({ id: "d45", remaining_points: 25, expires_at: new Date("2025-07-16T00:00:00Z") }), // ~45 days out
    ]);
    const { deps, notifier } = makeDeps(fake, { windowDays: 60 });

    const result = await runPreExpiryNotify(deps);

    expect(result.windowDays).toBe(60);
    expect(result.notifiedCount).toBe(1);
    expect(notifier.notifications[0]!.pointLotId).toBe("d45");
  });
});

describe("validateWindowDays: window is a whole number of days 1..90 (Req 5.4)", () => {
  it("accepts the default and the inclusive bounds", () => {
    expect(validateWindowDays(DEFAULT_PRE_EXPIRY_WINDOW_DAYS)).toBe(30);
    expect(validateWindowDays(1)).toBe(1);
    expect(validateWindowDays(90)).toBe(90);
  });

  it("rejects 0, 91, and non-integer windows", () => {
    expect(() => validateWindowDays(0)).toThrow(RangeError);
    expect(() => validateWindowDays(91)).toThrow(RangeError);
    expect(() => validateWindowDays(30.5)).toThrow(RangeError);
  });

  it("rejects an invalid window before touching the database", async () => {
    const fake = makeDb([]);
    const { deps } = makeDeps(fake, { windowDays: 0 });
    await expect(runPreExpiryNotify(deps)).rejects.toBeInstanceOf(RangeError);
    expect(fake.statements).toHaveLength(0);
  });
});
