/**
 * `/health` backup-staleness reporting (task 29).
 *
 * Supabase Free provides no automated backups and no PITR, so the platform's only
 * protection is a daily encrypted logical dump. The one thing that must never
 * happen is for that mechanism to stop working unnoticed, so `/health` publishes
 * the age of the newest dump. These tests pin the three behaviours that matter:
 *
 *   1. The block appears, with real numbers, when the source is wired.
 *   2. `/health` keeps its previous shape when the dependency is absent, so
 *      tests and local runs are unaffected.
 *   3. A failing lookup NEVER fails the probe — liveness must not depend on the
 *      backup bookkeeping table.
 *
 * No live database is used: the source is an in-memory double.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { API_VERSION } from "../version.js";
import {
  InMemoryLatestBackupSource,
  LOGICAL_DUMP_KIND,
  MAX_BACKUP_AGE_HOURS,
  type BackupRunRecord,
  type LatestBackupSource,
} from "./backupRuns.js";

const config = loadConfig({ NODE_ENV: "test" });

function recordAgedHours(hoursAgo: number): BackupRunRecord {
  const completedAt = new Date(Date.now() - hoursAgo * 3_600_000);
  return {
    kind: LOGICAL_DUMP_KIND,
    destination: "gha-artifact",
    sizeBytes: 2_048,
    sha256: "c".repeat(64),
    encrypted: true,
    startedAt: new Date(completedAt.getTime() - 20_000),
    completedAt,
  };
}

async function health(backupStatus?: LatestBackupSource): Promise<Record<string, unknown>> {
  const app = buildApp(config, backupStatus ? { backupStatus } : {});
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  } finally {
    await app.close();
  }
}

describe("/health backups block (task 29)", () => {
  it("reports a fresh backup as not stale, with its timestamp and age", async () => {
    const record = recordAgedHours(2);
    const body = await health(new InMemoryLatestBackupSource(record));

    expect(body).toMatchObject({ status: "ok", version: API_VERSION });
    expect(body.backups).toMatchObject({
      lastSuccessAt: record.completedAt.toISOString(),
      stale: false,
    });
    expect((body.backups as { ageHours: number }).ageHours).toBeCloseTo(2, 1);
  });

  it("marks a backup older than the staleness threshold as stale", async () => {
    const body = await health(new InMemoryLatestBackupSource(recordAgedHours(MAX_BACKUP_AGE_HOURS + 2)));
    expect(body.backups).toMatchObject({ stale: true });
  });

  it("reports never-backed-up as stale with a null timestamp", async () => {
    const body = await health(new InMemoryLatestBackupSource(null));
    // "No recovery point at all" is at least as urgent as "an ageing one", so it
    // is reported through the same `stale` flag a monitor already watches.
    expect(body.backups).toEqual({ lastSuccessAt: null, ageHours: null, stale: true });
  });

  it("omits the backups block entirely when the dependency is not wired", async () => {
    const body = await health();
    // The shape when NO optional dependency is wired: status, version, the
    // version identifier the versioning plugin adds to every JSON response
    // (Req 9.8), plus the two ALWAYS-PRESENT diagnostic blocks.
    //
    // `build`, `runtime` and `authChain` are unconditional by design. They exist
    // because a production 401 could not be attributed without knowing which
    // commit was running, whether the enrollment fallback was actually live in
    // it, and which step gated requests were stopping at — publishing them only
    // when something else happened to be wired would reintroduce exactly that
    // blind spot. `authChain` in particular must appear on a service with no
    // optional dependency wired at all, because that is the state in which a
    // diagnosis is most needed.
    expect(Object.keys(body).sort()).toEqual([
      "apiVersion",
      "authChain",
      "build",
      "runtime",
      "status",
      "version",
    ]);
    expect(body).toMatchObject({ status: "ok", version: API_VERSION });
    // The actual point of this test, unchanged: an unwired dependency must be
    // ABSENT rather than reported as null/empty, so a monitor cannot mistake
    // "not configured" for "configured and healthy".
    expect(body).not.toHaveProperty("backups");
    expect(body).not.toHaveProperty("scheduling");
  });

  it("still returns ok when the backup lookup throws (best-effort, like scheduling)", async () => {
    const failing: LatestBackupSource = {
      getLatestSuccessful: () => Promise.reject(new Error("connection terminated unexpectedly")),
    };
    const body = await health(failing);

    expect(body).toMatchObject({ status: "ok", version: API_VERSION });
    // Degrades to the base shape rather than failing the probe: a database blip
    // must not make the platform look dead to the keep-alive watchdog.
    expect(body).not.toHaveProperty("backups");
  });
});
