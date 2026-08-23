/**
 * READ-ONLY post-M1 production verification. Runs SELECT statements only — there
 * is no INSERT, UPDATE or DELETE anywhere in this file.
 *
 * Verifies the six post-migration conditions, and separately the authenticated
 * wishlist row, so each is checked by a machine against an explicit expectation
 * rather than read off a screen.
 *
 * Customer identifiers are MASKED to the last 4 digits. Emails are never
 * selected. `DATABASE_URL` is read from the environment only, never an argument.
 *
 * Usage:
 *   node scripts/verify-m1-production.mjs m1
 *   node scripts/verify-m1-production.mjs wishlist <shopifyCustomerId>
 */
import pg from "pg";

const EXPECT_COHORT = 9;
const EXPECT_TOTAL_POINTS = 484;
const MIGRATION_ENTRY_TYPE = "migration";
const MIGRATION_REASON = "m1_backfill";

/** The two owner-approved conversions, asserted by masked id. */
const EXPECTED_BY_MASK = { "…4995": 84, "…4627": 50 };

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set in this shell. Run this from the terminal that has it exported.",
  );
  process.exit(2);
}

const step = process.argv[2] ?? "m1";
const mask = (id) => `…${String(id).slice(-4)}`;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

try {
  if (step === "m1") {
    /* -- 1. exactly 9 customer rows ------------------------------------- */
    const customers = await pool.query(
      `SELECT id, shopify_customer_id, tier, lifetime_points, lifetime_spend_gbp FROM customers`,
    );
    check("exactly 9 customer rows exist", customers.rowCount === EXPECT_COHORT, {
      found: customers.rowCount,
      expected: EXPECT_COHORT,
    });

    /* -- 2. exactly 9 migration/m1_backfill entries --------------------- */
    const migration = await pool.query(
      `SELECT id, customer_id, points, reason FROM ledger_entries
       WHERE entry_type = $1 AND reason = $2`,
      [MIGRATION_ENTRY_TYPE, MIGRATION_REASON],
    );
    check(
      "exactly 9 migration / m1_backfill ledger entries exist",
      migration.rowCount === EXPECT_COHORT,
      { found: migration.rowCount, expected: EXPECT_COHORT },
    );

    /* -- 3. total migration points = 484 -------------------------------- */
    const migrationTotal = migration.rows.reduce((s, r) => s + Number(r.points), 0);
    check("total migration points = 484", migrationTotal === EXPECT_TOTAL_POINTS, {
      found: migrationTotal,
      expected: EXPECT_TOTAL_POINTS,
    });

    /* -- 4. exactly 9 point lots, each matching and non-expiring -------- */
    const lots = await pool.query(
      `SELECT id, customer_id, ledger_entry_id, original_points, remaining_points, expires_at
       FROM point_lots`,
    );
    check("exactly 9 point lots exist", lots.rowCount === EXPECT_COHORT, {
      found: lots.rowCount,
      expected: EXPECT_COHORT,
    });

    const entryById = new Map(migration.rows.map((r) => [r.id, Number(r.points)]));
    const unlinked = [];
    const originalMismatch = [];
    const spent = [];
    const expiring = [];
    for (const lot of lots.rows) {
      const entryPoints = entryById.get(lot.ledger_entry_id);
      if (entryPoints === undefined) {
        unlinked.push(mask(lot.customer_id));
        continue;
      }
      if (Number(lot.original_points) !== entryPoints) {
        originalMismatch.push({ lot: lot.id, original: Number(lot.original_points), entryPoints });
      }
      // Called out as its own check: `remaining < original` would mean migrated
      // points had already moved, which is the single most important thing to
      // know immediately after a migration.
      if (Number(lot.remaining_points) !== Number(lot.original_points)) {
        spent.push({
          original: Number(lot.original_points),
          remaining: Number(lot.remaining_points),
        });
      }
      if (lot.expires_at !== null) expiring.push(lot.id);
    }

    check("every point lot is linked to a migration entry", unlinked.length === 0, { unlinked });
    check("every lot's original_points equals its entry's points", originalMismatch.length === 0, {
      offenders: originalMismatch,
    });
    check("every lot has remaining_points == original_points (nothing spent)", spent.length === 0, {
      offenders: spent,
    });
    check("every migration lot is non-expiring (expires_at IS NULL)", expiring.length === 0, {
      expiringLots: expiring.length,
    });

    /* -- 5. no earn_signup created by M1, and nothing but migration ----- */
    const byType = await pool.query(
      `SELECT entry_type, reason, COUNT(*)::int AS count, SUM(points)::int AS points
       FROM ledger_entries GROUP BY entry_type, reason ORDER BY entry_type`,
    );
    const signup = byType.rows.filter((r) => r.entry_type === "earn_signup");
    check("no earn_signup entries exist", signup.length === 0, {
      found: signup.map((r) => `${r.entry_type}/${r.reason} × ${r.count}`),
    });
    const nonMigration = byType.rows.filter((r) => r.entry_type !== MIGRATION_ENTRY_TYPE);
    check(
      "the ledger contains ONLY migration entries",
      nonMigration.length === 0,
      { census: byType.rows.map((r) => `${r.entry_type}/${r.reason} × ${r.count} (${r.points} pts)`) },
    );

    /* -- 6. no partial or duplicate migration state --------------------- */
    const perCustomer = await pool.query(
      `SELECT c.shopify_customer_id,
              COUNT(l.id)::int AS entries,
              COALESCE(SUM(l.points), 0)::int AS points
       FROM customers c
       LEFT JOIN ledger_entries l ON l.customer_id = c.id
       GROUP BY c.shopify_customer_id
       ORDER BY c.shopify_customer_id`,
    );
    const dupes = perCustomer.rows.filter((r) => r.entries !== 1);
    check("exactly one ledger entry per customer (no partial, no duplicate)", dupes.length === 0, {
      offenders: dupes.map((r) => ({ customer: mask(r.shopify_customer_id), entries: r.entries })),
    });

    const lotsPerCustomer = await pool.query(
      `SELECT c.shopify_customer_id, COUNT(p.id)::int AS lots
       FROM customers c LEFT JOIN point_lots p ON p.customer_id = c.id
       GROUP BY c.shopify_customer_id`,
    );
    const lotDupes = lotsPerCustomer.rows.filter((r) => r.lots !== 1);
    check("exactly one point lot per customer", lotDupes.length === 0, {
      offenders: lotDupes.map((r) => ({ customer: mask(r.shopify_customer_id), lots: r.lots })),
    });

    /* -- The two approved conversions, by masked id --------------------- */
    const byMask = new Map(perCustomer.rows.map((r) => [mask(r.shopify_customer_id), r.points]));
    for (const [m, expected] of Object.entries(EXPECTED_BY_MASK)) {
      check(`${m} balance = ${expected}`, byMask.get(m) === expected, {
        found: byMask.get(m) ?? "customer not found",
        expected,
      });
    }
    const fifties = [...byMask.entries()].filter(([m]) => !(m in EXPECTED_BY_MASK));
    check(
      "the other seven customers hold 50 each",
      fifties.length === 7 && fifties.every(([, p]) => p === 50),
      { count: fifties.length, balances: fifties.map(([m, p]) => `${m}=${p}`) },
    );

    console.log(
      JSON.stringify(
        {
          step: "post-M1 production verification (READ ONLY)",
          allPassed: checks.every((c) => c.pass),
          checks,
          perCustomer: perCustomer.rows.map((r) => ({
            customer: mask(r.shopify_customer_id),
            points: r.points,
          })),
        },
        null,
        2,
      ),
    );
    process.exit(checks.every((c) => c.pass) ? 0 : 1);
  }

  if (step === "wishlist") {
    const shopifyId = process.argv[3];
    if (!shopifyId) {
      console.error("Usage: node scripts/verify-m1-production.mjs wishlist <shopifyCustomerId>");
      process.exit(2);
    }

    const customer = await pool.query(
      `SELECT id, shopify_customer_id FROM customers WHERE shopify_customer_id = $1`,
      [shopifyId],
    );
    check("the authenticated customer has a local row", customer.rowCount === 1, {
      masked: mask(shopifyId),
      found: customer.rowCount,
    });
    const localId = customer.rows[0]?.id ?? null;

    const wishlist = await pool.query(
      `SELECT customer_id, product_id, created_at FROM customer_wishlist ORDER BY created_at`,
    );
    check("at least one wishlist row exists", wishlist.rowCount > 0, { rows: wishlist.rowCount });

    const owned = wishlist.rows.filter((r) => r.customer_id === localId);
    check(
      "every wishlist row is owned by the authenticated customer",
      wishlist.rowCount > 0 && owned.length === wishlist.rowCount,
      { total: wishlist.rowCount, ownedByThisCustomer: owned.length },
    );

    const productIds = owned.map((r) => String(r.product_id));
    check("no duplicate product rows for this customer", new Set(productIds).size === productIds.length, {
      productIds,
    });

    console.log(
      JSON.stringify(
        {
          step: "authenticated wishlist verification (READ ONLY)",
          allPassed: checks.every((c) => c.pass),
          checks,
          customer: mask(shopifyId),
          wishlistProductIds: productIds,
        },
        null,
        2,
      ),
    );
    process.exit(checks.every((c) => c.pass) ? 0 : 1);
  }

  console.error(`Unknown step "${step}". Use "m1" or "wishlist <shopifyCustomerId>".`);
  process.exit(2);
} finally {
  await pool.end();
}
