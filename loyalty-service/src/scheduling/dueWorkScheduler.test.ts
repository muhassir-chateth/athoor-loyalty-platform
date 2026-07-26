/**
 * DueWorkScheduler adapter tests (task 24).
 *
 * Covers the wiring contract that makes the cron→due-work migration safe:
 *
 *   - the queue and its consumer exist BEFORE the job is registered as due, so a
 *     job claimed by the very first tick always has something to run it;
 *   - any LEGACY pg-boss cron entry for the job is removed. `pgboss.schedule`
 *     rows persist in the database across deploys, so a job previously registered
 *     with `boss.schedule(name, cron)` would otherwise keep publishing
 *     occurrences alongside due work and double-trigger while the process is
 *     awake. Staging showed exactly these three stale rows after the first
 *     deploy of this change.
 */
import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { DueWorkScheduler } from "./dueWorkScheduler.js";
import { DEFAULT_INTERVAL_SECONDS } from "./dueWork.js";

/** Records the order of pg-boss calls so registration sequencing can be asserted. */
function makeBoss() {
  const calls: string[] = [];
  const boss = {
    calls,
    unschedule: vi.fn(async (name: string) => {
      calls.push(`unschedule:${name}`);
    }),
    createQueue: vi.fn(async (name: string) => {
      calls.push(`createQueue:${name}`);
    }),
    work: vi.fn(async (name: string) => {
      calls.push(`work:${name}`);
      return "worker-1";
    }),
    send: vi.fn(async () => "job-1"),
    schedule: vi.fn(async () => {
      calls.push("schedule:LEGACY-CRON");
    }),
  };
  return boss;
}

class FakeDb implements Queryable {
  readonly registered: Array<{ jobName: string; intervalSeconds: number }> = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (text.includes("INSERT INTO scheduled_runs")) {
      this.registered.push({
        jobName: values[0] as string,
        intervalSeconds: values[1] as number,
      });
      return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

describe("DueWorkScheduler (task 24)", () => {
  it("removes a legacy cron entry, creates the queue, consumes it, then registers due work", async () => {
    const boss = makeBoss();
    const db = new FakeDb();
    const scheduler = new DueWorkScheduler(boss as never, db);

    await scheduler.schedule("runExpiryScan", "0 2 * * *", async () => {});

    // Legacy cron removed first, then consume-side wired before the job can be
    // claimed as due.
    expect(boss.calls).toEqual([
      "unschedule:runExpiryScan",
      "createQueue:runExpiryScan",
      "work:runExpiryScan",
    ]);
    expect(db.registered).toEqual([
      { jobName: "runExpiryScan", intervalSeconds: DEFAULT_INTERVAL_SECONDS },
    ]);
  });

  it("never registers a pg-boss cron schedule", async () => {
    const boss = makeBoss();
    const scheduler = new DueWorkScheduler(boss as never, new FakeDb());

    await scheduler.schedule("reconcileCaches", "0 3 * * *", async () => {});

    // The cron argument is accepted for interface compatibility only: cadence
    // must come from persisted state, which is what makes catch-up possible.
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("applies a per-job cadence override", async () => {
    const db = new FakeDb();
    const scheduler = new DueWorkScheduler(makeBoss() as never, db, {
      intervalsByJob: { reconcileCaches: 3600 },
    });

    await scheduler.schedule("reconcileCaches", "0 3 * * *", async () => {});

    expect(db.registered).toEqual([{ jobName: "reconcileCaches", intervalSeconds: 3600 }]);
  });

  it("runs the registered handler for each delivered job", async () => {
    const boss = makeBoss();
    let runs = 0;
    const scheduler = new DueWorkScheduler(boss as never, new FakeDb());

    await scheduler.schedule("runExpiryScan", "0 2 * * *", async () => {
      runs += 1;
    });

    // Invoke the consumer pg-boss registered, as pg-boss would on delivery.
    const consumer = boss.work.mock.calls[0]![1] as (jobs: unknown[]) => Promise<void>;
    await consumer([{}, {}]);

    expect(runs).toBe(2);
  });
});
