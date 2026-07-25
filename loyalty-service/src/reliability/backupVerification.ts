import { z } from "zod";

/**
 * Backup / point-in-time-recovery (PITR) verification (task 12.2).
 *
 * Requirement 13.6: the PostgreSQL deployment MUST have point-in-time recovery
 * and automated backups enabled with WAL (write-ahead-log) retention of at
 * least 7 days. The design (Reliability → "Backup & recovery") states:
 *
 *   > Point-in-time recovery (PITR) enabled on Postgres (managed provider);
 *   > daily automated backups + WAL retention (≥7 days).
 *
 * Because backups/PITR are a property of the *deployment configuration* (a
 * managed Postgres provider such as Railway/Render — see the design's hosting
 * table, Option A) rather than of application data, this module does NOT connect
 * to, mutate, or query any live database. It provides two things:
 *
 *   1. {@link REQUIRED_BACKUP_SPEC} — the required-settings spec (PITR on,
 *      automated daily backups, WAL/backup retention ≥ 7 days) that a compliant
 *      deployment must satisfy.
 *   2. {@link verifyBackupConfiguration} — a verifier that reads the current
 *      settings from an injectable {@link BackupStatusProvider} and returns a
 *      pass/fail result listing every unmet requirement.
 *
 * The provider is an interface so the source of truth for "current settings"
 * stays pluggable: in production it can be backed by the managed provider's API
 * or an operator-maintained config file; in tests it is a simple fake. Nothing
 * here performs a live backup, restore, or database call.
 *
 * See the loyalty-service README ("Backup & point-in-time recovery") for how to
 * enable PITR on the recommended managed Postgres (Railway / Render) at deploy
 * time.
 */

/** Minimum WAL retention required by Requirement 13.6, in whole days. */
export const MIN_WAL_RETENTION_DAYS = 7;

/** Minimum automated-backup retention required alongside WAL, in whole days. */
export const MIN_BACKUP_RETENTION_DAYS = 7;

/**
 * The maximum interval between automated backups for them to count as (at least)
 * "daily". A daily cadence is exactly 24h; more frequent (e.g. continuous PITR
 * base backups) is also acceptable.
 */
export const MAX_DAILY_BACKUP_INTERVAL_HOURS = 24;

/**
 * The current backup/recovery settings of a Postgres deployment, as reported by
 * a {@link BackupStatusProvider}. These mirror the knobs a managed provider
 * exposes; the module treats them as untrusted input and validates them with
 * {@link BackupStatusSchema} before evaluating.
 */
export interface BackupStatus {
  /** Whether point-in-time recovery is enabled on the deployment. */
  readonly pitrEnabled: boolean;
  /** Whether scheduled automated backups are enabled. */
  readonly automatedBackupsEnabled: boolean;
  /**
   * How often automated backups run, in hours (daily = 24). Values ≤
   * {@link MAX_DAILY_BACKUP_INTERVAL_HOURS} satisfy the "daily automated
   * backups" requirement.
   */
  readonly backupIntervalHours: number;
  /** How many days of write-ahead logs are retained (drives PITR window). */
  readonly walRetentionDays: number;
  /** How many days of automated base backups are retained. */
  readonly backupRetentionDays: number;
  /**
   * Optional free-text identifier of the deployment/provider the status came
   * from (e.g. "railway:postgres-prod"). Recorded in the result for auditing.
   */
  readonly provider?: string;
}

/**
 * Zod schema validating a {@link BackupStatus}. Retention and interval values
 * must be finite, non-negative numbers; the booleans are required. This guards
 * against a misconfigured provider silently passing verification.
 */
export const BackupStatusSchema = z.object({
  pitrEnabled: z.boolean(),
  automatedBackupsEnabled: z.boolean(),
  backupIntervalHours: z.number().finite().nonnegative(),
  walRetentionDays: z.number().finite().nonnegative(),
  backupRetentionDays: z.number().finite().nonnegative(),
  provider: z.string().min(1).optional(),
});

/**
 * Source of the deployment's current backup/recovery settings. Injected into
 * {@link verifyBackupConfiguration} so the settings can come from a managed
 * provider's API, an operator config file, or a test fake — the verifier itself
 * never connects to any live system.
 */
export interface BackupStatusProvider {
  /** Returns the deployment's current backup/recovery settings. */
  getBackupStatus(): Promise<BackupStatus>;
}

/** The required-settings spec a compliant deployment must satisfy (Req 13.6). */
export interface BackupRequirementSpec {
  /** PITR must be enabled. */
  readonly requirePitr: boolean;
  /** Automated backups must be enabled. */
  readonly requireAutomatedBackups: boolean;
  /** Maximum allowed interval between automated backups, in hours (daily = 24). */
  readonly maxBackupIntervalHours: number;
  /** Minimum required WAL retention, in whole days. */
  readonly minWalRetentionDays: number;
  /** Minimum required automated-backup retention, in whole days. */
  readonly minBackupRetentionDays: number;
}

/**
 * The required backup/recovery configuration for the loyalty-service Postgres
 * deployment (Requirement 13.6 / design "Backup & recovery"): PITR enabled,
 * daily automated backups, and WAL + backup retention of at least 7 days.
 */
export const REQUIRED_BACKUP_SPEC: BackupRequirementSpec = {
  requirePitr: true,
  requireAutomatedBackups: true,
  maxBackupIntervalHours: MAX_DAILY_BACKUP_INTERVAL_HOURS,
  minWalRetentionDays: MIN_WAL_RETENTION_DAYS,
  minBackupRetentionDays: MIN_BACKUP_RETENTION_DAYS,
} as const;

/** Machine-readable code for each way a deployment can fail verification. */
export type BackupViolationCode =
  | "PITR_DISABLED"
  | "AUTOMATED_BACKUPS_DISABLED"
  | "BACKUPS_NOT_DAILY"
  | "WAL_RETENTION_TOO_SHORT"
  | "BACKUP_RETENTION_TOO_SHORT";

/** A single unmet requirement, with the offending and required values. */
export interface BackupViolation {
  /** Machine-readable violation code. */
  readonly code: BackupViolationCode;
  /** Human-readable explanation, including the observed and required values. */
  readonly message: string;
  /** The setting's observed value (boolean or number). */
  readonly actual: boolean | number;
  /** The setting's required value/threshold (boolean or number). */
  readonly required: boolean | number;
}

/** The outcome of verifying a deployment against a {@link BackupRequirementSpec}. */
export interface BackupVerificationResult {
  /** True iff every requirement in the spec is met (no violations). */
  readonly passed: boolean;
  /** Every unmet requirement; empty when {@link passed} is true. */
  readonly violations: readonly BackupViolation[];
  /** The (validated) settings that were evaluated. */
  readonly status: BackupStatus;
  /** The spec the settings were evaluated against. */
  readonly spec: BackupRequirementSpec;
  /** ISO 8601 timestamp of when the check ran. */
  readonly checkedAt: string;
}

/**
 * Evaluates already-known backup settings against a spec. Pure and synchronous:
 * it performs no I/O and touches no live system — it only compares numbers and
 * booleans. Use {@link verifyBackupConfiguration} to fetch settings from a
 * provider first.
 *
 * @param status the deployment's current settings (validated before comparison).
 * @param spec   the required-settings spec (defaults to {@link REQUIRED_BACKUP_SPEC}).
 * @param now    clock injection for a deterministic `checkedAt` (defaults to now).
 * @throws if `status` fails {@link BackupStatusSchema} validation.
 */
export function evaluateBackupStatus(
  status: BackupStatus,
  spec: BackupRequirementSpec = REQUIRED_BACKUP_SPEC,
  now: () => Date = () => new Date(),
): BackupVerificationResult {
  const parsed = BackupStatusSchema.parse(status);
  const violations: BackupViolation[] = [];

  if (spec.requirePitr && !parsed.pitrEnabled) {
    violations.push({
      code: "PITR_DISABLED",
      message:
        "Point-in-time recovery (PITR) is disabled; it must be enabled (Req 13.6).",
      actual: parsed.pitrEnabled,
      required: true,
    });
  }

  if (spec.requireAutomatedBackups && !parsed.automatedBackupsEnabled) {
    violations.push({
      code: "AUTOMATED_BACKUPS_DISABLED",
      message:
        "Automated backups are disabled; scheduled automated backups must be enabled (Req 13.6).",
      actual: parsed.automatedBackupsEnabled,
      required: true,
    });
  }

  // Only meaningful to check cadence when automated backups are on.
  if (
    spec.requireAutomatedBackups &&
    parsed.automatedBackupsEnabled &&
    parsed.backupIntervalHours > spec.maxBackupIntervalHours
  ) {
    violations.push({
      code: "BACKUPS_NOT_DAILY",
      message: `Automated backups run every ${parsed.backupIntervalHours}h; they must run at least every ${spec.maxBackupIntervalHours}h (daily) (Req 13.6).`,
      actual: parsed.backupIntervalHours,
      required: spec.maxBackupIntervalHours,
    });
  }

  if (parsed.walRetentionDays < spec.minWalRetentionDays) {
    violations.push({
      code: "WAL_RETENTION_TOO_SHORT",
      message: `WAL retention is ${parsed.walRetentionDays} day(s); it must be at least ${spec.minWalRetentionDays} days (Req 13.6).`,
      actual: parsed.walRetentionDays,
      required: spec.minWalRetentionDays,
    });
  }

  if (parsed.backupRetentionDays < spec.minBackupRetentionDays) {
    violations.push({
      code: "BACKUP_RETENTION_TOO_SHORT",
      message: `Backup retention is ${parsed.backupRetentionDays} day(s); it must be at least ${spec.minBackupRetentionDays} days (Req 13.6).`,
      actual: parsed.backupRetentionDays,
      required: spec.minBackupRetentionDays,
    });
  }

  return {
    passed: violations.length === 0,
    violations,
    status: parsed,
    spec,
    checkedAt: now().toISOString(),
  };
}

/**
 * Verifies the deployment's backup/recovery configuration (Req 13.6) by reading
 * the current settings from an injected {@link BackupStatusProvider} and
 * evaluating them against a spec. The verifier itself performs no database or
 * backup operations — it only inspects the settings the provider reports.
 *
 * @param provider source of the deployment's current settings.
 * @param spec     the required-settings spec (defaults to {@link REQUIRED_BACKUP_SPEC}).
 * @param now      clock injection for a deterministic `checkedAt` (defaults to now).
 */
export async function verifyBackupConfiguration(
  provider: BackupStatusProvider,
  spec: BackupRequirementSpec = REQUIRED_BACKUP_SPEC,
  now: () => Date = () => new Date(),
): Promise<BackupVerificationResult> {
  const status = await provider.getBackupStatus();
  return evaluateBackupStatus(status, spec, now);
}

/**
 * Convenience assertion for boot-time/CI gating: verifies the configuration and
 * throws a descriptive error if any requirement is unmet, so a non-compliant
 * deployment fails fast rather than running without adequate recovery coverage.
 *
 * @throws if the configuration does not satisfy the spec.
 */
export async function assertBackupConfiguration(
  provider: BackupStatusProvider,
  spec: BackupRequirementSpec = REQUIRED_BACKUP_SPEC,
  now: () => Date = () => new Date(),
): Promise<BackupVerificationResult> {
  const result = await verifyBackupConfiguration(provider, spec, now);
  if (!result.passed) {
    const detail = result.violations.map((v) => `  - ${v.message}`).join("\n");
    throw new Error(
      `PostgreSQL backup/PITR configuration does not meet Requirement 13.6:\n${detail}`,
    );
  }
  return result;
}
