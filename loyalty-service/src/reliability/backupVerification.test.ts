import { describe, expect, it } from "vitest";
import {
  assertBackupConfiguration,
  BackupStatusSchema,
  evaluateBackupStatus,
  MAX_DAILY_BACKUP_INTERVAL_HOURS,
  MIN_BACKUP_RETENTION_DAYS,
  MIN_WAL_RETENTION_DAYS,
  REQUIRED_BACKUP_SPEC,
  verifyBackupConfiguration,
  type BackupStatus,
  type BackupStatusProvider,
  type BackupViolationCode,
} from "./backupVerification.js";

/** A fully-compliant baseline deployment status (PITR on, daily, retention ≥7d). */
const COMPLIANT: BackupStatus = {
  pitrEnabled: true,
  automatedBackupsEnabled: true,
  backupIntervalHours: 24,
  walRetentionDays: 7,
  backupRetentionDays: 7,
  provider: "railway:postgres-prod",
};

/** In-memory fake provider — no live database is ever contacted. */
function fakeProvider(status: BackupStatus): BackupStatusProvider {
  return { getBackupStatus: () => Promise.resolve(status) };
}

/** Fixed clock so `checkedAt` is deterministic in assertions. */
const fixedNow = () => new Date("2025-01-01T00:00:00.000Z");

function codes(result: { violations: readonly { code: BackupViolationCode }[] }): BackupViolationCode[] {
  return result.violations.map((v) => v.code);
}

describe("REQUIRED_BACKUP_SPEC (Req 13.6)", () => {
  it("requires PITR, automated daily backups, and ≥7-day retention", () => {
    expect(REQUIRED_BACKUP_SPEC.requirePitr).toBe(true);
    expect(REQUIRED_BACKUP_SPEC.requireAutomatedBackups).toBe(true);
    expect(REQUIRED_BACKUP_SPEC.maxBackupIntervalHours).toBe(MAX_DAILY_BACKUP_INTERVAL_HOURS);
    expect(REQUIRED_BACKUP_SPEC.minWalRetentionDays).toBe(MIN_WAL_RETENTION_DAYS);
    expect(REQUIRED_BACKUP_SPEC.minBackupRetentionDays).toBe(MIN_BACKUP_RETENTION_DAYS);
    expect(MIN_WAL_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
  });
});

describe("verifyBackupConfiguration — passing cases", () => {
  it("passes when PITR is on and retention is exactly the 7-day minimum", async () => {
    const result = await verifyBackupConfiguration(fakeProvider(COMPLIANT), REQUIRED_BACKUP_SPEC, fixedNow);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.status.provider).toBe("railway:postgres-prod");
    expect(result.checkedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("passes when retention exceeds the minimum and backups are more frequent than daily", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({
        ...COMPLIANT,
        backupIntervalHours: 6,
        walRetentionDays: 30,
        backupRetentionDays: 14,
      }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("verifyBackupConfiguration — failing cases", () => {
  it("fails and reports PITR_DISABLED when PITR is off", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({ ...COMPLIANT, pitrEnabled: false }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(false);
    expect(codes(result)).toContain("PITR_DISABLED");
    const violation = result.violations.find((v) => v.code === "PITR_DISABLED");
    expect(violation?.actual).toBe(false);
    expect(violation?.required).toBe(true);
    expect(violation?.message).toMatch(/point-in-time recovery/i);
  });

  it("fails and reports WAL_RETENTION_TOO_SHORT when WAL retention < 7 days", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({ ...COMPLIANT, walRetentionDays: 6 }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(false);
    expect(codes(result)).toContain("WAL_RETENTION_TOO_SHORT");
    const violation = result.violations.find((v) => v.code === "WAL_RETENTION_TOO_SHORT");
    expect(violation?.actual).toBe(6);
    expect(violation?.required).toBe(7);
  });

  it("fails and reports BACKUP_RETENTION_TOO_SHORT when backup retention < 7 days", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({ ...COMPLIANT, backupRetentionDays: 3 }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(false);
    expect(codes(result)).toContain("BACKUP_RETENTION_TOO_SHORT");
  });

  it("fails and reports AUTOMATED_BACKUPS_DISABLED when automated backups are off", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({ ...COMPLIANT, automatedBackupsEnabled: false }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(false);
    expect(codes(result)).toContain("AUTOMATED_BACKUPS_DISABLED");
    // Cadence is not additionally flagged when backups are disabled entirely.
    expect(codes(result)).not.toContain("BACKUPS_NOT_DAILY");
  });

  it("fails and reports BACKUPS_NOT_DAILY when the backup interval exceeds 24h", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({ ...COMPLIANT, backupIntervalHours: 48 }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(false);
    expect(codes(result)).toContain("BACKUPS_NOT_DAILY");
  });

  it("reports every unmet requirement at once for a fully non-compliant deployment", async () => {
    const result = await verifyBackupConfiguration(
      fakeProvider({
        pitrEnabled: false,
        automatedBackupsEnabled: false,
        backupIntervalHours: 72,
        walRetentionDays: 1,
        backupRetentionDays: 0,
      }),
      REQUIRED_BACKUP_SPEC,
      fixedNow,
    );
    expect(result.passed).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "PITR_DISABLED",
        "AUTOMATED_BACKUPS_DISABLED",
        "WAL_RETENTION_TOO_SHORT",
        "BACKUP_RETENTION_TOO_SHORT",
      ]),
    );
  });
});

describe("evaluateBackupStatus — input validation", () => {
  it("rejects a status with a negative retention value", () => {
    expect(() =>
      evaluateBackupStatus({ ...COMPLIANT, walRetentionDays: -1 }),
    ).toThrow();
  });

  it("rejects a status with a non-finite interval", () => {
    expect(() =>
      evaluateBackupStatus({ ...COMPLIANT, backupIntervalHours: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it("BackupStatusSchema accepts a well-formed status", () => {
    expect(() => BackupStatusSchema.parse(COMPLIANT)).not.toThrow();
  });
});

describe("assertBackupConfiguration", () => {
  it("resolves with the result when the deployment is compliant", async () => {
    const result = await assertBackupConfiguration(fakeProvider(COMPLIANT), REQUIRED_BACKUP_SPEC, fixedNow);
    expect(result.passed).toBe(true);
  });

  it("throws a descriptive Req 13.6 error listing violations when non-compliant", async () => {
    await expect(
      assertBackupConfiguration(
        fakeProvider({ ...COMPLIANT, pitrEnabled: false, walRetentionDays: 2 }),
        REQUIRED_BACKUP_SPEC,
        fixedNow,
      ),
    ).rejects.toThrow(/Requirement 13\.6/);
  });
});
