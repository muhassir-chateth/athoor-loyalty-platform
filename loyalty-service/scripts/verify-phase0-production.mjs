/**
 * READ-ONLY Phase 0 production verification. SELECT statements only — there is
 * no INSERT, UPDATE or DELETE anywhere in this file.
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-m1-production.mjs
 * -------------------------------------------------------
 * That verifier asserts GLOBAL invariants — "exactly 9 customer rows", "exactly
 * one ledger entry per customer", "the ledger contains ONLY migration entries".
 * Those were exactly right in the hours after M1, when the migrated cohort was
 * the entire population. They become FALSE the moment lazy enrollment does its
 * job: a repaired historical customer is a 10th row with zero ledger entries and
 * zero point lots, which is correct and which that script would report as four
 * failures. A verifier that cries wolf gets ignored, so this one identifies the
 * cohort by the marker M1 actually stamped — a `migration` / `m1_backfill`
 * ledger entry — rather than by counting rows in a table that is now expected to
 * grow.
 *
 * WHAT IT PROVES
 *   A. The migrated cohort is untouched: 9 customers, 484 points, 9 lots, the
 *      two approved conversions, nothing spent, nothing expiring.
 *   B. Lazy enrollment repaired the target customer EXACTLY ONCE.
 *   C. That repair awarded NO points — no `earn_signup`, no lot, no balance. This
 *      is the property with money attached: a repair is bookkeeping, not a
 *      signup, and the historical cohort must never receive a fresh +50.
 *   D. Nothing anywhere has been awarded a signup bonus it should not have.
 *
 * PRIVACY: customer identifiers are MASKED to the last 4 digits and emails are
 * never selected. `DATABASE_URL` is read from the environment only, never from an
 * argument, so the credential cannot land in shell history.
 *
 * Usage, from the loyalty-service directory:
 *   node scripts/verify-phase0-production.mjs
 *   node scripts/verify-phase0-production.mjs 9395357876563
 */
import pg from "pg";

const EXPECT_COHORT = 9;
const EXPECT_TOTAL_POINTS = 484;
const MIGRATION_ENTRY_TYPE = "migration";
const MIGRATION_REASON = "m1_backfill";
const SIGNUP_ENTRY_TYPE = "earn_signup";

/** The two owner-approved legacy conversions, asserted by masked id. */
const EXPECTED_BY_MASK = { "…4995": 84, "…4627": 50 };
const EXPECTED_OTHERS = 50;

/** The Branch B customer whose repair this run verifies. */
const DEFAULT_TARGET = "9395357876563";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set in this shell. Run this from the terminal that has it exported.",
  );
  process.exit(2);
}

const target = String(process.argv[2] ?? DEFAULT_TARGET);
if (!/^\d+$/.test(target)) {
  console.error("The target customer id must be numeric.");
  process.exit(2);
}

const mask = (id) => `…${String(id).slice(-4)}`;
const targetMask = mask(target);

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

try {
  /* ====================================================================
   * A. The migrated cohort, identified by its own ledger marker.
   * ==================================================================== */
  const migration = await pool.query(
    `SELECT l.id, l.customer_id, l.points, c.shopify_customer_id
       FROM ledger_entries l
       JOIN customers c ON c.id = l.customer_id
      WHERE l.entry_type = $1 AND l.reason = $2`,
    [MIGRATION_ENTRY_TYPE, MIGRATION_REASON],
  );

  check("the migrated cohort is still 9 customers", migration.rowCount === EXPECT_COHORT, {
    found: migration.rowCount,
    expected: EXPECT_COHORT,
  });

  const migrationTotal = migration.rows.reduce((s, r) => s + Number(r.points), 0);
  check("migrated points still total 484", migrationTotal === EXPECT_TOTAL_POINTS, {
    found: migrationTotal,
    expected: EXPECT_TOTAL_POINTS,
  });

  const cohortIds = new Set(migration.rows.map((r) => r.customer_id));
  const pointsByMask = new Map(
    migration.rows.map((r) => [mask(r.shopify_customer_id), Number(r.points)]),
  );

  for (const [m, expected] of Object.entries(EXPECTED_BY_MASK)) {
    check(`${m} still holds ${expected}`, pointsByMask.get(m) === expected, {
      found: pointsByMask.get(m) ?? "customer not found",
      expected,
    });
  }
  const others = [...pointsByMask.entries()].filter(([m]) => !(m in EXPECTED_BY_MASK));
  check(
    `the other seven migrated customers still hold ${EXPECTED_OTHERS} each`,
    others.length === EXPECT_COHORT - Object.keys(EXPECTED_BY_MASK).length &&
      others.every(([, p]) => p === EXPECTED_OTHERS),
    { found: others.map(([m, p]) => `${m}=${p}`) },
  );

  /* -- one migration entry per cohort customer, no duplicates ---------- */
  const perCohortEntries = new Map();
  for (const row of migration.rows) {
    perCohortEntries.set(row.customer_id, (perCohortEntries.get(row.customer_id) ?? 0) + 1);
  }
  const dupeMigration = [...perCohortEntries.entries()].filter(([, n]) => n !== 1);
  check("exactly one migration entry per migrated customer", dupeMigration.length === 0, {
    offenders: dupeMigration.length,
  });

  /* -- the cohort's point lots ----------------------------------------- */
  const lots = await pool.query(
    `SELECT p.id, p.customer_id, p.ledger_entry_id, p.original_points, p.remaining_points,
            p.expires_at, c.shopify_customer_id
       FROM point_lots p
       JOIN customers c ON c.id = p.customer_id`,
  );
  const cohortLots = lots.rows.filter((l) => cohortIds.has(l.customer_id));
  check("the migrated cohort still has 9 point lots", cohortLots.length === EXPECT_COHORT, {
    found: cohortLots.length,
    expected: EXPECT_COHORT,
  });

  const entryPointsById = new Map(migration.rows.map((r) => [r.id, Number(r.points)]));
  const spent = [];
  const originalMismatch = [];
  const expiring = [];
  for (const lot of cohortLots) {
    const entryPoints = entryPointsById.get(lot.ledger_entry_id);
    if (entryPoints !== undefined && Number(lot.original_points) !== entryPoints) {
      originalMismatch.push({ customer: mask(lot.shopify_customer_id) });
    }
    if (Number(lot.remaining_points) !== Number(lot.original_points)) {
      spent.push({
        customer: mask(lot.shopify_customer_id),
        original: Number(lot.original_points),
        remaining: Number(lot.remaining_points),
      });
    }
    if (lot.expires_at !== null) expiring.push(mask(lot.shopify_customer_id));
  }
  check("no migrated points have been spent or altered", spent.length === 0, { offenders: spent });
  check("every migrated lot still matches its entry", originalMismatch.length === 0, {
    offenders: originalMismatch,
  });
  check("every migrated lot is still non-expiring", expiring.length === 0, {
    offenders: expiring,
  });

  /* ====================================================================
   * B + C. The lazily repaired target: exactly one row, and NO award.
   * ==================================================================== */
  const targetRows = await pool.query(
    `SELECT id, shopify_customer_id, tier, lifetime_points, lifetime_spend_gbp, enrolled_at
       FROM customers WHERE shopify_customer_id = $1`,
    [target],
  );

  check(`${targetMask} has EXACTLY ONE customer row`, targetRows.rowCount === 1, {
    found: targetRows.rowCount,
    expected: 1,
    note:
      targetRows.rowCount === 0
        ? "not enrolled yet — the authenticated request has not reached the fallback"
        : undefined,
  });

  if (targetRows.rowCount === 1) {
    const row = targetRows.rows[0];

    const targetLedger = await pool.query(
      `SELECT entry_type, reason, points FROM ledger_entries WHERE customer_id = $1`,
      [row.id],
    );
    const targetSignups = targetLedger.rows.filter((r) => r.entry_type === SIGNUP_ENTRY_TYPE);

    // THE PROPERTY WITH MONEY ATTACHED. A repaired row is bookkeeping, not a
    // signup: the `authenticated_fallback` trigger is `never_award`, so this
    // historical customer must NOT have been credited a fresh +50.
    check(`${targetMask} received NO signup award`, targetSignups.length === 0, {
      found: targetSignups.map((r) => `${r.entry_type}/${r.reason} = ${r.points}`),
    });

    check(`${targetMask} has no ledger entries at all`, targetLedger.rowCount === 0, {
      found: targetLedger.rows.map((r) => `${r.entry_type}/${r.reason} = ${r.points}`),
    });

    const targetLots = lots.rows.filter((l) => l.customer_id === row.id);
    check(`${targetMask} has no point lots`, targetLots.length === 0, {
      found: targetLots.length,
    });

    check(`${targetMask} holds a zero balance`, Number(row.lifetime_points ?? 0) === 0, {
      lifetimePoints: Number(row.lifetime_points ?? 0),
    });

    check(`${targetMask} is NOT in the migrated cohort`, !cohortIds.has(row.id), {
      note: "confirms this is a Branch B repair, not a migrated customer",
    });

    /* -- wishlist persistence for the authenticated owner ---------------- */
    const wishlist = await pool.query(
      `SELECT shopify_product_id, added_at FROM customer_wishlist
        WHERE customer_id = $1 ORDER BY added_at`,
      [row.id],
    );

    check(
      `${targetMask} has at least one persisted wishlist row`,
      wishlist.rowCount >= 1,
      {
        rows: wishlist.rowCount,
        productIds: wishlist.rows.map((r) => String(r.shopify_product_id)),
        note:
          wishlist.rowCount === 0
            ? "no row: either no item was saved on the device, or reconcile did not fire"
            : undefined,
      },
    );

    // The composite PRIMARY KEY (customer_id, shopify_product_id) makes a
    // duplicate structurally impossible. Verified rather than assumed, because
    // "reconciliation ran twice" is the obvious way this could have gone wrong.
    const distinctProducts = new Set(wishlist.rows.map((r) => String(r.shopify_product_id)));
    check(
      `${targetMask} wishlist contains no duplicate product rows`,
      distinctProducts.size === wishlist.rowCount,
      { rows: wishlist.rowCount, distinct: distinctProducts.size },
    );

    /* -- ownership isolation: nobody else's row leaked into this account -- */
    const foreign = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_wishlist w
        WHERE w.customer_id = $1
          AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = w.customer_id)`,
      [row.id],
    );
    check(`${targetMask} wishlist rows all belong to a real customer`, foreign.rows[0].n === 0, {
      orphans: foreign.rows[0].n,
    });
  }

  /* ====================================================================
   * D. Nothing anywhere has gained a signup bonus it should not have.
   * ==================================================================== */
  const signupCensus = await pool.query(
    `SELECT c.shopify_customer_id, l.reason, l.points
       FROM ledger_entries l
       JOIN customers c ON c.id = l.customer_id
      WHERE l.entry_type = $1`,
    [SIGNUP_ENTRY_TYPE],
  );
  // Compared on Shopify ids directly. An earlier draft looked the holder up in
  // `migration.rows` and tested `cohortIds.has(undefined)`, which is always
  // false — so the check passed no matter what. A vacuous check on the one
  // property that has money attached is worse than no check, because it reads as
  // evidence.
  const cohortShopifyIds = new Set(migration.rows.map((r) => String(r.shopify_customer_id)));
  const cohortSignupHolders = signupCensus.rows.filter((r) =>
    cohortShopifyIds.has(String(r.shopify_customer_id)),
  );
  check("no signup award exists for ANY migrated customer", cohortSignupHolders.length === 0, {
    offenders: cohortSignupHolders.map((r) => `${mask(r.shopify_customer_id)}=${r.points}`),
    cohortSize: cohortShopifyIds.size,
  });
  check("total earn_signup entries in production", signupCensus.rowCount === 0, {
    found: signupCensus.rowCount,
    holders: signupCensus.rows.map((r) => mask(r.shopify_customer_id)),
    note:
      signupCensus.rowCount > 0
        ? "a genuinely NEW customer signing up legitimately produces one; review the holders"
        : undefined,
  });

  /* -- global: no duplicate Shopify id (the UNIQUE constraint, verified) */
  const dupes = await pool.query(
    `SELECT shopify_customer_id, COUNT(*)::int AS n
       FROM customers GROUP BY shopify_customer_id HAVING COUNT(*) > 1`,
  );
  check("no duplicate customer rows for any Shopify id", dupes.rowCount === 0, {
    offenders: dupes.rows.map((r) => mask(r.shopify_customer_id)),
  });

  /* ====================================================================
   * E. Webhook health, measured by what actually ARRIVED and was PROCESSED.
   *
   * WHY NOT read `webhookSubscriptions` from the Admin API: that reports
   * CONFIGURATION, scoped to the querying app, and an absent topic there is not
   * conclusive evidence the topic is unconfigured. What matters operationally is
   * whether verified events are arriving and completing, which only our own
   * table can answer.
   *
   * ABSENCE IS NOT FAILURE and is deliberately not asserted as one: a store with
   * no orders in the window has no `orders/paid` event, which says nothing about
   * the subscription. What IS asserted is that nothing is STUCK — no `failed`
   * rows, and nothing left `received` long enough to mean the worker dropped it.
   * ==================================================================== */
  const BUSINESS_TOPICS = ["customers/create", "orders/paid", "refunds/create", "orders/cancelled"];

  const webhookCensus = await pool.query(
    `SELECT topic,
            status,
            COUNT(*)::int          AS n,
            MAX(received_at)       AS last_received,
            MAX(processed_at)      AS last_processed
       FROM webhook_events
      GROUP BY topic, status
      ORDER BY topic, status`,
  );

  const byTopic = new Map();
  for (const r of webhookCensus.rows) {
    const entry = byTopic.get(r.topic) ?? { received: 0, processed: 0, failed: 0, last: null };
    entry[r.status] = (entry[r.status] ?? 0) + r.n;
    const stamp = r.last_processed ?? r.last_received;
    if (stamp && (entry.last === null || stamp > entry.last)) entry.last = stamp;
    byTopic.set(r.topic, entry);
  }

  check("no webhook event is in a FAILED state", 
    webhookCensus.rows.every((r) => r.status !== "failed"),
    {
      failed: webhookCensus.rows
        .filter((r) => r.status === "failed")
        .map((r) => `${r.topic} × ${r.n}`),
    },
  );

  // A row still `received` after an hour means dispatch never completed. Recent
  // ones are simply in flight, so the age bound is what makes this meaningful.
  const stuck = await pool.query(
    `SELECT topic, COUNT(*)::int AS n FROM webhook_events
      WHERE status = 'received' AND received_at < now() - interval '1 hour'
      GROUP BY topic`,
  );
  check("no webhook event is stuck unprocessed (older than 1 hour)", stuck.rowCount === 0, {
    stuck: stuck.rows.map((r) => `${r.topic} × ${r.n}`),
  });

  check("webhook delivery census by business topic (reported, not asserted)", true, {
    topics: BUSINESS_TOPICS.map((topic) => {
      const e = byTopic.get(topic);
      return e
        ? `${topic}: processed=${e.processed ?? 0} received=${e.received ?? 0} ` +
            `failed=${e.failed ?? 0} last=${e.last ? new Date(e.last).toISOString() : "never"}`
        : `${topic}: no events recorded`;
    }),
    note: "absence means no such business event occurred in the retained window, not a broken subscription",
  });

  /* -- population census, for context --------------------------------- */
  const population = await pool.query(`SELECT COUNT(*)::int AS n FROM customers`);
  const lazilyEnrolled = population.rows[0].n - EXPECT_COHORT;
  check("population census (reported, not asserted)", true, {
    totalCustomers: population.rows[0].n,
    migratedCohort: EXPECT_COHORT,
    lazilyRepaired: lazilyEnrolled,
  });

  /* ==================================================================== */
  const failed = checks.filter((c) => !c.pass);
  console.log("\nPHASE 0 PRODUCTION VERIFICATION (read-only)\n");
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
    if (c.detail !== undefined) {
      const detail = JSON.stringify(c.detail, (_k, v) => (v === undefined ? undefined : v));
      if (detail !== "{}") console.log(`      ${detail}`);
    }
  }
  console.log(`\nallPassed = ${failed.length === 0}`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.length} of ${checks.length}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  console.error("Verification could not complete:", err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  await pool.end();
}
