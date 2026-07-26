#!/usr/bin/env node
/**
 * ONE-OFF OPERATOR SCRIPT — NOT production code, NOT part of the service build.
 *
 * Backfills the Point_Lots missing behind historical positive ledger entries
 * that were credited BEFORE Property 17 landed (signup bonuses, referral
 * rewards and admin adjustments/credits used to append a ledger entry without a
 * matching lot). Because Spendable_Balance derives solely from non-expired lot
 * remainders (Req 1.3), those credits appear in a customer's history yet can
 * never be redeemed. New credits are backed automatically; this script repairs
 * only the pre-existing rows.
 *
 * GUARANTEES
 *   - IDEMPOTENT: selects only positive entries that have NO lot referencing
 *     them (`point_lots.ledger_entry_id`). Re-running after a successful run
 *     finds nothing to do.
 *   - NON-DESTRUCTIVE: never updates or deletes an existing lot or ledger row;
 *     it only INSERTs the missing lots. The ledger itself is never touched.
 *   - DRY RUN BY DEFAULT: prints the plan and exits. Pass `--apply` to write.
 *   - ATOMIC: all inserts run in a single transaction, so a failure leaves the
 *     database exactly as it was.
 *
 * EXPIRY RULE (mirrors the spec)
 *   - `migration` entries          → non-expiring (`expires_at = NULL`, Req 14.4)
 *   - every other positive entry   → 12 months after the entry timestamp (A1)
 *
 * `remaining_points` is set to the full entry amount: past debits (spend,
 * clawback, expiry) already consumed remainders from the lots that existed at
 * the time, so the un-backed credits were never drawn down.
 *
 * USAGE
 *   DATABASE_URL=postgres://... node scripts/backfill-missing-point-lots.mjs
 *   DATABASE_URL=postgres://... node scripts/backfill-missing-point-lots.mjs --apply
 *
 * Set PGSSL_NO_VERIFY=1 when connecting to a managed pooler whose certificate
 * chain is not locally verifiable (e.g. Supabase in staging).
 */
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const LOT_EXPIRY_MONTHS = 12;

/** Adds whole calendar months in UTC, clamping to the target month's last day. */
function addMonths(date, months) {
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

/** Positive ledger entries with no lot pointing at them. */
const FIND_UNBACKED_SQL = `
  SELECT l.id, l.customer_id, l.entry_type, l.points, l.reason, l.created_at
  FROM ledger_entries l
  LEFT JOIN point_lots p ON p.ledger_entry_id = l.id
  WHERE l.points > 0 AND p.id IS NULL
  ORDER BY l.created_at
`;

const INSERT_LOT_SQL = `
  INSERT INTO point_lots
    (customer_id, ledger_entry_id, original_points, remaining_points, earned_at, expires_at)
  VALUES ($1, $2, $3, $3, $4, $5)
  RETURNING id
`;

const CONSISTENCY_SQL = `
  SELECT c.shopify_customer_id,
         (SELECT COALESCE(SUM(points), 0) FROM ledger_entries l WHERE l.customer_id = c.id) AS balance,
         (SELECT COALESCE(SUM(remaining_points), 0) FROM point_lots p
           WHERE p.customer_id = c.id AND (p.expires_at IS NULL OR p.expires_at > now())) AS spendable
  FROM customers c
  ORDER BY c.created_at
`;

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ...(process.env.PGSSL_NO_VERIFY === "1" ? { ssl: { rejectUnauthorized: false } } : {}),
});

try {
  const { rows: unbacked } = await pool.query(FIND_UNBACKED_SQL);

  console.log(`Mode            : ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log(`Unbacked credits: ${unbacked.length}\n`);

  if (unbacked.length === 0) {
    console.log("Nothing to backfill — every positive ledger entry already has a lot.");
  } else {
    for (const e of unbacked) {
      const expires = e.entry_type === "migration" ? null : addMonths(e.created_at, LOT_EXPIRY_MONTHS);
      console.log(
        `  ${e.entry_type.padEnd(22)} +${String(e.points).padStart(5)}  ${e.reason}\n` +
          `    entry ${e.id}  customer ${e.customer_id}\n` +
          `    earned_at ${e.created_at.toISOString()}  expires_at ${expires ? expires.toISOString() : "NULL (non-expiring)"}`,
      );
    }

    if (APPLY) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let created = 0;
        for (const e of unbacked) {
          const expires =
            e.entry_type === "migration" ? null : addMonths(e.created_at, LOT_EXPIRY_MONTHS);
          await client.query(INSERT_LOT_SQL, [
            e.customer_id,
            e.id,
            e.points,
            e.created_at,
            expires,
          ]);
          created += 1;
        }
        await client.query("COMMIT");
        console.log(`\nCreated ${created} lot(s).`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } else {
      console.log("\nDry run only. Re-run with --apply to create these lots.");
    }
  }

  // Post-state: balance vs spendable per customer. After a successful apply the
  // two should agree for every customer whose credits are all still unspent.
  const { rows: state } = await pool.query(CONSISTENCY_SQL);
  console.log("\nBalance vs spendable per customer:");
  for (const r of state) {
    const gap = Number(r.balance) - Number(r.spendable);
    console.log(
      `  customer ${String(r.shopify_customer_id).padEnd(16)} balance ${String(r.balance).padStart(6)}  spendable ${String(r.spendable).padStart(6)}  gap ${gap}`,
    );
  }

  const { rows: remaining } = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_entries l
     LEFT JOIN point_lots p ON p.ledger_entry_id = l.id
     WHERE l.points > 0 AND p.id IS NULL`,
  );
  console.log(`\nRemaining unbacked credits: ${remaining[0].n}`);
} finally {
  await pool.end();
}
