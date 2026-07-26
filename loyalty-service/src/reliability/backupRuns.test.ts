/**
 * Tests for the daily-logical-backup bookkeeping + staleness watchdog (task 29).
 *
 * NO live database is contacted: `PgLatestBackupSource` is exercised against a
 * fake `Queryable` that records the SQL it was given, and every freshness case is
 * evaluated with an injected clock so the boundary is deterministic.
 *
 * The last describe block is the important one. It asserts that the platform's
 * real backup posture PASSES the amended standard (`LOGICAL_BACKUP_SPEC`) and
 * FAILS the original one (`REQUIRED_BACKUP_SPEC`), with the specific violation
 * codes named. That keeps the Req 13.6 deviation explicit and machine-checked: if
 * someone later claims the platform has PITR, or quietly weakens the aspirational
 * spec to make a check go green, this test fails.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  evaluateBackupFreshness,
  InMemoryLatestBackupSource,
  LOGICAL_BACKUP_INTERVAL_HOURS,
  LOGICAL_BACKUP_RETENTION_DAYS,
  LOGICAL_BACKUP_SPEC,
  LOGICAL_DUMP_KIND,
  LogicalBackupStatusProvider,
  MAX_BACKUP_AGE_HOURS,
  PgLatestBackupSource,
  type BackupRunRecord,
  type Queryable,
} from "./backupRuns.js";
import {
  evaluateBackupStatus,
  REQUIRED_BACKUP_SPEC,
  verifyBackupConfiguration,
  type BackupViolationCode,
} from "./backupVerification.js";

const NOW = new Date("2025-03-10T12:00:00.000Z");

/** A recorded backup completed `hoursAgo` before {@link NOW}. */
function recordAgedHours(hoursAgo: number): BackupRunRecord {
  const completedAt = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  return {
    kind: LOGICAL_DUMP_KIND,
    destination: "gha-artifact",
    sizeBytes: 4_096,
    sha256: "a".repeat(64),
    encrypted: true,
    startedAt: new Date(completedAt.getTime() - 30_000),
    completedAt,
  };
}

/** Fake `Queryable` recording every call; returns the configured rows. */
function fakeDb(rows: QueryResultRow[]): { db: Queryable; calls: string[] } {
  const calls: string[] = [];
  const db: Queryable = {
    query: <R extends QueryResultRow = QueryResultRow>(queryText: string) => {
      calls.push(queryText);
      return Promise.resolve({ rows: rows as R[], rowCount: rows.length } as QueryResult<R>);
    },
  };
  return { db, calls };
}

function codes(violations: readonly { code: BackupViolationCode }[]): BackupViolationCode[] {
  return violations.map((v) => v.code);
}

describe("LOGICAL_BACKUP_SPEC — the amended Req 13.6 standard", () => {
  it("keeps daily automated backups and 7-day retention, and drops only PITR/WAL", () => {
    expect(LOGICAL_BACKUP_SPEC.requireAutomatedBackups).toBe(true);
    expect(LOGICAL_BACKUP_SPEC.maxBackupIntervalHours).toBe(LOGICAL_BACKUP_INTERVAL_HOURS);
    expect(LOGICAL_BACKUP_SPEC.minBackupRetentionDays).toBe(LOGICAL_BACKUP_RETENTION_DAYS);
    expect(LOGICAL_BACKUP_SPEC.minBackupRetentionDays).toBeGreaterThanOrEqual(7);
    // The deviation, stated in the spec itself rather than in prose only.
    expect(LOGICAL_BACKUP_SPEC.requirePitr).toBe(false);
    expect(LOGICAL_BACKUP_SPEC.minWalRetentionDays).toBe(0);
  });

  it("leaves REQUIRED_BACKUP_SPEC untouched as the aspirational standard", () => {
    // The original standard must NOT be weakened to accommodate the free tier.
    expect(REQUIRED_BACKUP_SPEC.requirePitr).toBe(true);
    expect(REQUIRED_BACKUP_SPEC.minWalRetentionDays).toBeGreaterThanOrEqual(7);
  });

  it("allows a grace period beyond the daily cadence before calling a backup stale", () => {
    expect(MAX_BACKUP_AGE_HOURS).toBeGreaterThan(LOGICAL_BACKUP_INTERVAL_HOURS);
    expect(MAX_BACKUP_AGE_HOURS).toBe(26);
  });
});

describe("evaluateBackupFreshness", () => {
  it("reports a recent backup as fresh", () => {
    const result = evaluateBackupFreshness(recordAgedHours(3), NOW);
    expect(result).toEqual({
      ok: true,
      lastSuccessAt: "2025-03-10T09:00:00.000Z",
      ageHours: 3,
      reason: null,
    });
  });

  it("treats an age of exactly the threshold as fresh (inclusive boundary)", () => {
    const result = evaluateBackupFreshness(recordAgedHours(MAX_BACKUP_AGE_HOURS), NOW);
    expect(result.ageHours).toBe(26);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("reports BACKUP_STALE just past the threshold", () => {
    const result = evaluateBackupFreshness(recordAgedHours(MAX_BACKUP_AGE_HOURS + 0.5), NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("BACKUP_STALE");
    expect(result.ageHours).toBe(26.5);
    // A stale backup still reports WHEN the last recovery point was — that is
    // the number an operator needs during an incident.
    expect(result.lastSuccessAt).toBe("2025-03-09T09:30:00.000Z");
  });

  it("reports a long-dead backup schedule as stale with its true age", () => {
    const result = evaluateBackupFreshness(recordAgedHours(24 * 30), NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("BACKUP_STALE");
    expect(result.ageHours).toBe(720);
  });

  it("distinguishes never-recorded from stale", () => {
    const result = evaluateBackupFreshness(null, NOW);
    expect(result).toEqual({
      ok: false,
      lastSuccessAt: null,
      ageHours: null,
      reason: "NO_BACKUP_RECORDED",
    });
  });

  it("honours a custom threshold", () => {
    const twelveHoursOld = recordAgedHours(12);
    expect(evaluateBackupFreshness(twelveHoursOld, NOW, 6).reason).toBe("BACKUP_STALE");
    expect(evaluateBackupFreshness(twelveHoursOld, NOW, 24).ok).toBe(true);
  });

  it("does not call a future-dated backup stale (CI/database clock skew)", () => {
    const result = evaluateBackupFreshness(recordAgedHours(-0.25), NOW);
    expect(result.ok).toBe(true);
    expect(result.ageHours).toBe(-0.25);
  });

  it("is pure — the same inputs always give the same answer and nothing mutates", () => {
    const record = recordAgedHours(5);
    const frozen = { ...record };
    const first = evaluateBackupFreshness(record, NOW);
    const second = evaluateBackupFreshness(record, NOW);
    expect(first).toEqual(second);
    expect(record).toEqual(frozen);
  });
});

describe("PgLatestBackupSource", () => {
  it("selects the newest row and maps it to a BackupRunRecord", async () => {
    const { db, calls } = fakeDb([
      {
        kind: "logical_dump",
        destination: "r2",
        // `pg` returns BIGINT as a string; the mapping must not leave it one.
        size_bytes: "918273645",
        sha256: "b".repeat(64),
        encrypted: true,
        started_at: new Date("2025-03-10T03:15:00.000Z"),
        completed_at: new Date("2025-03-10T03:16:40.000Z"),
      },
    ]);

    const record = await new PgLatestBackupSource(db).getLatestSuccessful();

    expect(record).toEqual({
      kind: "logical_dump",
      destination: "r2",
      sizeBytes: 918_273_645,
      sha256: "b".repeat(64),
      encrypted: true,
      startedAt: new Date("2025-03-10T03:15:00.000Z"),
      completedAt: new Date("2025-03-10T03:16:40.000Z"),
    });
    expect(typeof record?.sizeBytes).toBe("number");

    // Read-only, newest-first, single row.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/FROM backup_runs/);
    expect(calls[0]).toMatch(/ORDER BY completed_at DESC/);
    expect(calls[0]).toMatch(/LIMIT 1/);
    expect(calls[0]).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it("returns null when no backup has ever been recorded", async () => {
    const { db } = fakeDb([]);
    await expect(new PgLatestBackupSource(db).getLatestSuccessful()).resolves.toBeNull();
  });

  it("propagates a database error to the caller (the caller decides best-effort)", async () => {
    const db: Queryable = {
      query: () => Promise.reject(new Error("relation \"backup_runs\" does not exist")),
    };
    await expect(new PgLatestBackupSource(db).getLatestSuccessful()).rejects.toThrow(
      /backup_runs/,
    );
  });
});

describe("LogicalBackupStatusProvider — the deviation is explicit and machine-checked", () => {
  const provider = (record: BackupRunRecord | null) =>
    new LogicalBackupStatusProvider(new InMemoryLatestBackupSource(record), {
      now: () => NOW,
    });

  it("reports the real posture: daily backups, 7-day retention, no PITR, no WAL", async () => {
    const status = await provider(recordAgedHours(9)).getBackupStatus();
    expect(status).toEqual({
      pitrEnabled: false,
      automatedBackupsEnabled: true,
      backupIntervalHours: 24,
      walRetentionDays: 0,
      backupRetentionDays: 7,
      provider: "github-actions:pg_dump+age:gha-artifact",
    });
  });

  it("PASSES the amended LOGICAL_BACKUP_SPEC when a recent dump exists", async () => {
    const result = await verifyBackupConfiguration(
      provider(recordAgedHours(9)),
      LOGICAL_BACKUP_SPEC,
      () => NOW,
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("FAILS the stricter REQUIRED_BACKUP_SPEC on exactly PITR and WAL retention", async () => {
    const result = await verifyBackupConfiguration(
      provider(recordAgedHours(9)),
      REQUIRED_BACKUP_SPEC,
      () => NOW,
    );
    expect(result.passed).toBe(false);
    // The deviation is these two clauses and nothing else: daily cadence and
    // 7-day backup retention are still met in full.
    expect(codes(result.violations).sort()).toEqual([
      "PITR_DISABLED",
      "WAL_RETENTION_TOO_SHORT",
    ]);
  });

  it("reports automated backups as DISABLED when the newest dump is stale", async () => {
    const status = await provider(recordAgedHours(MAX_BACKUP_AGE_HOURS + 1)).getBackupStatus();
    // Evidence-based: a workflow that no longer runs is not "enabled".
    expect(status.automatedBackupsEnabled).toBe(false);

    const result = evaluateBackupStatus(status, LOGICAL_BACKUP_SPEC, () => NOW);
    expect(result.passed).toBe(false);
    expect(codes(result.violations)).toContain("AUTOMATED_BACKUPS_DISABLED");
  });

  it("fails the amended spec when no backup has ever been recorded", async () => {
    const status = await provider(null).getBackupStatus();
    expect(status.automatedBackupsEnabled).toBe(false);
    expect(status.provider).toBe("github-actions:pg_dump+age:none-recorded");

    const result = evaluateBackupStatus(status, LOGICAL_BACKUP_SPEC, () => NOW);
    expect(result.passed).toBe(false);
    expect(codes(result.violations)).toEqual(["AUTOMATED_BACKUPS_DISABLED"]);
  });

  it("names the off-site destination once R2 is configured", async () => {
    const offsite = { ...recordAgedHours(4), destination: "r2" };
    const status = await provider(offsite).getBackupStatus();
    expect(status.provider).toBe("github-actions:pg_dump+age:r2");
  });
});
