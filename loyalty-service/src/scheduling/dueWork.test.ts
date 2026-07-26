/**
 * Due-work scheduling tests (task 24).
 *
 * THE REGRESSION THESE EXIST FOR: pg-boss cron fires a schedule only when its
 * previous occurrence is under 60 seconds old and the process is alive, so a
 * window that elapses while the host sleeps is skipped silently and never
 * replayed. On a free host that spins down when idle, the daily expiry scan
 * therefore effectively never ran — the exact failure staging exhibited.
 *
 * These tests prove the replacement behaviour: work whose due time passed while
 * the service was asleep is claimed and enqueued on the NEXT WAKE rather than
 * lost, exactly once per due window, safely under concurrency, and without ever
 * touching the ledger.
 *
 * The fake models `scheduled_runs` and the SQL the module issues, including the
 * atomicity of the claiming UPDATE, so no live Postgres is required.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  DEFAULT_INTERVAL_SECONDS,
  claimDueJobs,
  listOverdueJobs,
  registerDueWorkJob,
  runDueWork,
  type DueWorkPublisher,
} from "./dueWork.js";

const DAY_SECONDS = 86_400;

interface Row {
  job_name: string;
  interval_seconds: number;
  last_run_at: Date | null;
}

/**
 * In-memory `scheduled_runs`. `now` is injectable so a test can advance time to
 * model the host having been asleep across a due window.
 */
class FakeDb implements Queryable {
  readonly rows = new Map<string, Row>();
  now: Date;
  /** Every statement issued, so a test can assert nothing else was touched. */
  readonly statements: string[] = [];

  constructor(now: Date = new Date("2026-05-01T00:00:00.000Z")) {
    this.now = now;
  }

  advance(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000);
  }

  private result<R extends QueryResultRow>(rows: R[], command: string): QueryResult<R> {
    return { rows, rowCount: rows.length, command, oid: 0, fields: [] };
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push(text.trim());

    if (text.includes("INSERT INTO scheduled_runs")) {
      const [jobName, intervalSeconds] = values as [string, number];
      const existing = this.rows.get(jobName);
      // ON CONFLICT DO UPDATE SET interval_seconds — last_run_at preserved.
      this.rows.set(jobName, {
        job_name: jobName,
        interval_seconds: intervalSeconds,
        last_run_at: existing?.last_run_at ?? null,
      });
      return this.result([{ job_name: jobName } as unknown as R], "INSERT");
    }

    if (text.includes("UPDATE scheduled_runs") && text.includes("SET last_run_at = now()")) {
      // The claiming UPDATE: select due rows and stamp them in one step, which
      // is what makes concurrent evaluators safe.
      const claimed: Row[] = [];
      for (const row of this.rows.values()) {
        const due =
          row.last_run_at === null ||
          row.last_run_at.getTime() + row.interval_seconds * 1000 <= this.now.getTime();
        if (due) {
          row.last_run_at = this.now;
          claimed.push({ ...row });
        }
      }
      return this.result(
        claimed.map((r) => ({
          job_name: r.job_name,
          interval_seconds: r.interval_seconds,
        })) as unknown as R[],
        "UPDATE",
      );
    }

    if (text.includes("FROM scheduled_runs")) {
      const grace = values[0] as number;
      const overdue = [...this.rows.values()]
        .filter(
          (row) =>
            row.last_run_at === null ||
            row.last_run_at.getTime() + (row.interval_seconds + grace) * 1000 <= this.now.getTime(),
        )
        .sort((a, b) => a.job_name.localeCompare(b.job_name))
        .map((row) => ({
          job_name: row.job_name,
          interval_seconds: row.interval_seconds,
          last_run_at: row.last_run_at,
          overdue_by_seconds:
            row.last_run_at === null
              ? null
              : (this.now.getTime() -
                  (row.last_run_at.getTime() + row.interval_seconds * 1000)) /
                1000,
        }));
      return this.result(overdue as unknown as R[], "SELECT");
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

class RecordingPublisher implements DueWorkPublisher {
  readonly sent: string[] = [];
  async send(queue: string): Promise<string | null> {
    this.sent.push(queue);
    return `job-${this.sent.length}`;
  }
}

describe("due work: missed windows are recovered on the next wake (task 24, Req 5.2/5.3, 13.7)", () => {
  it("enqueues a job whose due time passed while the service was asleep", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);

    // First pass establishes the baseline (a new job is due immediately).
    expect((await runDueWork({ db, publisher })).enqueued).toEqual(["runExpiryScan"]);

    // The host sleeps for three days — under pg-boss cron all three 02:00
    // windows would have been skipped silently and never replayed.
    db.advance(3 * DAY_SECONDS);

    // On wake the overdue work is claimed and enqueued.
    expect((await runDueWork({ db, publisher })).enqueued).toEqual(["runExpiryScan"]);
    expect(publisher.sent).toEqual(["runExpiryScan", "runExpiryScan"]);
  });

  it("enqueues an overdue job ONCE, not once per missed window", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);
    await runDueWork({ db, publisher });

    // Asleep for ten days.
    db.advance(10 * DAY_SECONDS);
    await runDueWork({ db, publisher });

    // One catch-up run brings the system up to date; the handlers are idempotent
    // (expiry is idempotent per lot, Property 9), so replaying ten times would
    // add nothing but load.
    expect(publisher.sent).toEqual(["runExpiryScan", "runExpiryScan"]);
  });

  it("does not enqueue a job that is not yet due", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "reconcileCaches", DAY_SECONDS);
    await runDueWork({ db, publisher });

    db.advance(DAY_SECONDS - 60); // one minute short of due
    expect((await runDueWork({ db, publisher })).enqueued).toEqual([]);

    db.advance(60); // now due
    expect((await runDueWork({ db, publisher })).enqueued).toEqual(["reconcileCaches"]);
  });

  it("claims each due window exactly once across concurrent evaluators", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);

    // A boot pass racing the interval tick: the claim stamps `last_run_at` in the
    // same statement that selects due rows, so only one can win.
    const [a, b] = await Promise.all([
      runDueWork({ db, publisher }),
      runDueWork({ db, publisher }),
    ]);

    expect([...a.enqueued, ...b.enqueued]).toEqual(["runExpiryScan"]);
    expect(publisher.sent).toEqual(["runExpiryScan"]);
  });

  it("recovers every registered job after a shared outage", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);
    await registerDueWorkJob(db, "reconcileCaches", DAY_SECONDS);
    await runDueWork({ db, publisher });
    publisher.sent.length = 0;

    db.advance(2 * DAY_SECONDS);
    const { enqueued } = await runDueWork({ db, publisher });

    expect(enqueued.sort()).toEqual(["reconcileCaches", "runExpiryScan"]);
  });
});

describe("due work: registration (task 24)", () => {
  it("defaults to a daily cadence", async () => {
    const db = new FakeDb();
    await registerDueWorkJob(db, "runExpiryScan");
    expect(db.rows.get("runExpiryScan")!.interval_seconds).toBe(DEFAULT_INTERVAL_SECONDS);
  });

  it("preserves last_run_at across re-registration, so a redeploy does not reset the clock", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);
    await runDueWork({ db, publisher });
    const stamped = db.rows.get("runExpiryScan")!.last_run_at;

    // Redeploy: the job is registered again moments later.
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);

    expect(db.rows.get("runExpiryScan")!.last_run_at).toEqual(stamped);
    // And it must NOT run again immediately.
    expect((await runDueWork({ db, publisher })).enqueued).toEqual([]);
  });

  it("applies a changed cadence on re-registration", async () => {
    const db = new FakeDb();
    await registerDueWorkJob(db, "refreshAnalyticsAggregates", 3600);
    await registerDueWorkJob(db, "refreshAnalyticsAggregates", DAY_SECONDS);
    expect(db.rows.get("refreshAnalyticsAggregates")!.interval_seconds).toBe(DAY_SECONDS);
  });

  it("rejects a non-positive interval", async () => {
    const db = new FakeDb();
    await expect(registerDueWorkJob(db, "bad", 0)).rejects.toThrow(/positive whole number/);
    await expect(registerDueWorkJob(db, "bad", -1)).rejects.toThrow(/positive whole number/);
  });

  it("touches only scheduled_runs — never the ledger or lots", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);
    db.advance(2 * DAY_SECONDS);
    await runDueWork({ db, publisher });

    const touched = db.statements.join("\n");
    expect(touched).not.toMatch(/ledger_entries/i);
    expect(touched).not.toMatch(/point_lots/i);
    expect(touched).not.toMatch(/customers/i);
  });
});

describe("due work: overdue reporting for monitoring (task 24)", () => {
  it("reports a never-run job as overdue with a null age", async () => {
    const db = new FakeDb();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);

    const overdue = await listOverdueJobs(db, DAY_SECONDS);
    expect(overdue).toEqual([
      {
        jobName: "runExpiryScan",
        intervalSeconds: DAY_SECONDS,
        lastRunAt: null,
        overdueBySeconds: null,
      },
    ]);
  });

  it("stays quiet while a job is merely waiting for the next wake", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);
    await runDueWork({ db, publisher });

    // Due, but inside the grace period: a free host legitimately waits for its
    // next wake, so this must not be reported as a failure.
    db.advance(DAY_SECONDS + 60);
    expect(await listOverdueJobs(db, DAY_SECONDS)).toEqual([]);
  });

  it("reports a job that has stopped running beyond the grace period", async () => {
    const db = new FakeDb();
    const publisher = new RecordingPublisher();
    await registerDueWorkJob(db, "runExpiryScan", DAY_SECONDS);
    await runDueWork({ db, publisher });

    db.advance(5 * DAY_SECONDS);
    const overdue = await listOverdueJobs(db, DAY_SECONDS);

    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.jobName).toBe("runExpiryScan");
    expect(overdue[0]!.overdueBySeconds).toBe(4 * DAY_SECONDS);
  });
});
