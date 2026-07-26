import type { QueryResult, QueryResultRow } from "pg";
import type {
  BackupRequirementSpec,
  BackupStatus,
  BackupStatusProvider,
} from "./backupVerification.js";

/**
 * Daily encrypted logical backups + staleness watchdog (task 29, Option B).
 *
 * WHY THIS EXISTS
 * ---------------
 * Requirement 13.6 asks for point-in-time recovery, automated backups, and WAL
 * retention of at least 7 days. The zero-cost hosting decision (Render Free +
 * Supabase Free) delivers NONE of the three: Supabase's free tier provides no
 * automated backups, no PITR and no WAL retention. So the requirement was unmet
 * on every clause, silently, while `backupVerification.ts` — which can detect
 * exactly that — sat unreachable with no production call site (reachability
 * audit finding 6).
 *
 * Option B closes the gap without leaving the zero-cost envelope:
 *
 *   1. A daily GitHub Actions workflow (`.github/workflows/backup.yml`) takes a
 *      `pg_dump` logical dump, encrypts it to an `age` PUBLIC key (the private
 *      key never leaves the operator), retains it as a workflow artifact for at
 *      least 7 days, optionally copies it off-site to Cloudflare R2, and only
 *      THEN records one row in `backup_runs`.
 *   2. This module reads that row and reports freshness on `/health`, so a
 *      backup mechanism that stops running is VISIBLE rather than silent — the
 *      classic backup failure mode, and one this codebase has shipped before in
 *      other guises (pg-boss skipping cron windows; wired-but-unreachable code).
 *
 * WHAT THIS COSTS US, STATED PLAINLY: a logical dump gives a ~24-hour RPO and a
 * manual RTO. It cannot recover to an arbitrary second, so a mistake made at
 * 14:00 cannot be undone as of 13:59 — it can only be undone as of last night's
 * dump. That is a real reduction against the original 13.6 and is why
 * {@link LOGICAL_BACKUP_SPEC} exists ALONGSIDE (not instead of)
 * `REQUIRED_BACKUP_SPEC`: the deviation stays explicit and machine-checked.
 *
 * LEDGER SAFETY: everything here is read-only bookkeeping. This module never
 * touches `ledger_entries`, `point_lots` or any balance; it reads at most one
 * row from `backup_runs`.
 */

/**
 * The interval between scheduled logical backups, in hours. The workflow runs
 * once a day, so this is 24 by construction — if the schedule changes, change it
 * here too, because {@link LogicalBackupStatusProvider} reports it as the
 * deployment's backup cadence.
 */
export const LOGICAL_BACKUP_INTERVAL_HOURS = 24 as const;

/**
 * How many days of backups are retained. This must match the workflow's
 * artifact `retention-days` (and the R2 lifecycle rule, once configured), since
 * it is the number the verifier checks against the retention standard.
 */
export const LOGICAL_BACKUP_RETENTION_DAYS = 7 as const;

/**
 * Days of write-ahead logs retained. ZERO, and deliberately so: a logical dump
 * captures a single consistent snapshot and carries no WAL, so there is no
 * continuous-recovery window at all. Reported honestly rather than omitted, so
 * that evaluating against `REQUIRED_BACKUP_SPEC` FAILS — which is the point.
 */
export const LOGICAL_WAL_RETENTION_DAYS = 0 as const;

/**
 * The AMENDED Requirement 13.6 standard for the MVP: automated daily backups
 * with at least 7 days of retention, and NO point-in-time recovery.
 *
 * This is not a relaxation for convenience — it is what the zero-cost hosting
 * tier can actually provide, written down so it can be checked. `REQUIRED_BACKUP_SPEC`
 * in `backupVerification.ts` remains the ASPIRATIONAL full-PITR standard and is
 * deliberately left unchanged: the day the platform moves to a paid Postgres
 * tier with PITR, the deployment should be verified against that spec instead,
 * and this one deleted. See `docs/ops/backup-and-recovery.md` for the documented
 * deviation and the condition that should trigger the upgrade.
 */
export const LOGICAL_BACKUP_SPEC: BackupRequirementSpec = {
  // No PITR on the free tier, and no PITR from a logical dump either.
  requirePitr: false,
  // A daily backup must genuinely be happening — this clause is NOT relaxed.
  requireAutomatedBackups: true,
  maxBackupIntervalHours: LOGICAL_BACKUP_INTERVAL_HOURS,
  // No WAL is retained, so requiring any would be requiring the impossible.
  minWalRetentionDays: 0,
  // Retention is the one clause the free tier CAN meet in full, so it is kept
  // at the original 7 days.
  minBackupRetentionDays: LOGICAL_BACKUP_RETENTION_DAYS,
} as const;

/**
 * How old the most recent successful backup may be before it counts as stale:
 * the 24-hour cadence plus a 2-hour grace.
 *
 * The grace exists because GitHub's scheduled workflows are explicitly
 * best-effort and are frequently delayed under load (the same caveat documented
 * in `keepalive.yml`). Without it the watchdog would cry wolf on ordinary queue
 * delay, and an alarm that fires routinely is an alarm that gets ignored — which
 * would hand us back the silent failure we are trying to eliminate.
 */
export const MAX_BACKUP_AGE_HOURS = 26 as const;

/** The `kind` recorded by the daily logical-dump workflow. */
export const LOGICAL_DUMP_KIND = "logical_dump" as const;

/** One successfully completed backup, as recorded in `backup_runs`. */
export interface BackupRunRecord {
  /** Mechanism that produced the artifact, e.g. `logical_dump`. */
  kind: string;
  /** Where the artifact was stored, e.g. `gha-artifact` or `r2`. */
  destination: string;
  /** Size of the ENCRYPTED artifact in bytes; always > 0 (enforced by CHECK). */
  sizeBytes: number;
  /** SHA-256 of the ENCRYPTED artifact, so a download can be verified. */
  sha256: string;
  /** Whether the artifact is encrypted. Always true in practice; recorded, not assumed. */
  encrypted: boolean;
  startedAt: Date;
  completedAt: Date;
}

/**
 * Read-only view of the most recent successful backup, surfaced on `/health`.
 * Declared here (next to the state it reports) and satisfied in production by
 * {@link PgLatestBackupSource} — mirroring `DueWorkStatusSource` /
 * `PgDueWorkStatusSource`, the existing precedent for a best-effort read-only
 * health watchdog.
 */
export interface LatestBackupSource {
  /** The newest successful backup, or null when none has ever been recorded. */
  getLatestSuccessful(): Promise<BackupRunRecord | null>;
}

/**
 * The minimal database surface this module needs. A `pg` Pool and PoolClient
 * both satisfy this (the same structural interface used across the codebase).
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Only ever one row: the newest completion. Served by the
 * `backup_runs_completed_at_desc_idx` index created with the table.
 */
const LATEST_BACKUP_SQL = `
  SELECT kind,
         destination,
         size_bytes,
         sha256,
         encrypted,
         started_at,
         completed_at
    FROM backup_runs
   ORDER BY completed_at DESC
   LIMIT 1
`;

interface BackupRunRow {
  kind: string;
  destination: string;
  /** BIGINT arrives from `pg` as a string to avoid precision loss. */
  size_bytes: number | string;
  sha256: string;
  encrypted: boolean;
  started_at: Date;
  completed_at: Date;
}

/** Postgres-backed {@link LatestBackupSource}. Changes no state. */
export class PgLatestBackupSource implements LatestBackupSource {
  constructor(private readonly db: Queryable) {}

  async getLatestSuccessful(): Promise<BackupRunRecord | null> {
    const { rows } = await this.db.query<BackupRunRow>(LATEST_BACKUP_SQL);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      kind: row.kind,
      destination: row.destination,
      // `pg` returns BIGINT as a string; Number is exact well past any dump size.
      sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : Number(row.size_bytes),
      sha256: row.sha256,
      encrypted: row.encrypted,
      startedAt: new Date(row.started_at),
      completedAt: new Date(row.completed_at),
    };
  }
}

/** Test double: returns whatever record it was constructed with. */
export class InMemoryLatestBackupSource implements LatestBackupSource {
  constructor(private latest: BackupRunRecord | null = null) {}

  /** Replaces the record returned by subsequent lookups. */
  set(latest: BackupRunRecord | null): void {
    this.latest = latest;
  }

  getLatestSuccessful(): Promise<BackupRunRecord | null> {
    return Promise.resolve(this.latest);
  }
}

/** Why a backup is not considered fresh. Null when it is. */
export type BackupFreshnessReason = "NO_BACKUP_RECORDED" | "BACKUP_STALE";

/** The outcome of a freshness evaluation — exactly what `/health` reports. */
export interface BackupFreshness {
  /** True iff a backup exists and is within the maximum age. */
  ok: boolean;
  /** ISO 8601 completion time of the newest backup; null when there is none. */
  lastSuccessAt: string | null;
  /** Age of the newest backup in hours (2 dp); null when there is none. */
  ageHours: number | null;
  /** Machine-readable failure reason; null when {@link ok} is true. */
  reason: BackupFreshnessReason | null;
}

/**
 * Decides whether the most recent backup is fresh enough. PURE: no I/O, no
 * clock read, no database — the caller supplies both the record and `now`, so
 * every case (including the boundary) is deterministically testable.
 *
 * The two failure modes are kept DISTINCT because they demand different
 * responses:
 *   - `NO_BACKUP_RECORDED` — nothing has ever succeeded. Either the workflow has
 *     never run (secrets not yet configured) or it has never got as far as
 *     recording a row. There is NO recovery point at all.
 *   - `BACKUP_STALE` — backups worked and then stopped. A recovery point exists
 *     but is ageing, and something is broken now.
 *
 * The boundary is INCLUSIVE: an age of exactly `maxAgeHours` is still ok. The
 * threshold already contains a deliberate grace period, so treating the exact
 * boundary as a failure would only add clock-rounding flakiness.
 *
 * A backup dated in the FUTURE (clock skew between CI and the database) yields a
 * negative age, which is ≤ the threshold and therefore ok — skew is not
 * evidence that backups stopped.
 */
export function evaluateBackupFreshness(
  latest: BackupRunRecord | null,
  now: Date,
  maxAgeHours: number = MAX_BACKUP_AGE_HOURS,
): BackupFreshness {
  if (!latest) {
    return { ok: false, lastSuccessAt: null, ageHours: null, reason: "NO_BACKUP_RECORDED" };
  }

  const ageMs = now.getTime() - latest.completedAt.getTime();
  const ageHours = Math.round((ageMs / 3_600_000) * 100) / 100;
  const ok = ageHours <= maxAgeHours;

  return {
    ok,
    lastSuccessAt: latest.completedAt.toISOString(),
    ageHours,
    reason: ok ? null : "BACKUP_STALE",
  };
}

/** Options for {@link LogicalBackupStatusProvider}. */
export interface LogicalBackupStatusProviderOptions {
  /** Clock injection for deterministic tests. Defaults to the system clock. */
  now?: () => Date;
  /** Staleness threshold; defaults to {@link MAX_BACKUP_AGE_HOURS}. */
  maxAgeHours?: number;
}

/**
 * Reports the deployment's ACTUAL backup posture as a {@link BackupStatus},
 * derived from the newest `backup_runs` row.
 *
 * This is the production {@link BackupStatusProvider} the reliability module
 * always needed and never had: `verifyBackupConfiguration` /
 * `assertBackupConfiguration` could only ever be exercised by test fakes, so the
 * requirement they encode was never actually checked against anything real.
 * Evaluating this provider against {@link LOGICAL_BACKUP_SPEC} asserts the
 * amended standard; evaluating it against `REQUIRED_BACKUP_SPEC` documents the
 * deviation, and is expected to FAIL on `PITR_DISABLED` and
 * `WAL_RETENTION_TOO_SHORT` for as long as the platform stays on the free tier.
 *
 * `automatedBackupsEnabled` is derived from EVIDENCE, not configuration: it is
 * true only when a backup has actually completed within the staleness window. A
 * workflow file that exists but no longer runs therefore reads as disabled,
 * which is the honest answer.
 */
export class LogicalBackupStatusProvider implements BackupStatusProvider {
  private readonly now: () => Date;
  private readonly maxAgeHours: number;

  constructor(
    private readonly source: LatestBackupSource,
    options: LogicalBackupStatusProviderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxAgeHours = options.maxAgeHours ?? MAX_BACKUP_AGE_HOURS;
  }

  async getBackupStatus(): Promise<BackupStatus> {
    const latest = await this.source.getLatestSuccessful();
    const freshness = evaluateBackupFreshness(latest, this.now(), this.maxAgeHours);

    return {
      // Free tier: no PITR, and a logical dump cannot provide one.
      pitrEnabled: false,
      // Evidence-based: a recent successful run, not the mere existence of a
      // workflow file.
      automatedBackupsEnabled: freshness.ok,
      backupIntervalHours: LOGICAL_BACKUP_INTERVAL_HOURS,
      walRetentionDays: LOGICAL_WAL_RETENTION_DAYS,
      backupRetentionDays: LOGICAL_BACKUP_RETENTION_DAYS,
      // Names the MECHANISM (and, when known, where the artifact went) so an
      // audit record says how the deployment is protected, not just that it is.
      provider: latest
        ? `github-actions:pg_dump+age:${latest.destination}`
        : "github-actions:pg_dump+age:none-recorded",
    };
  }
}
