/**
 * Declared-preference repository tests — task 13.1, §12.2/§12.8,
 * Req 2.1, 2.5, 12.1, 12.2, 13.1, 13.2.
 *
 * SAFETY: no network, no production, no live Postgres. The fake enforces the same
 * primary key, the same PARTIAL UNIQUE INDEX on intensity, and the same
 * `value <> ALL($3)` delete semantics the real schema does — so a test that passes
 * here is a statement about the SQL rather than about the fake.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../../ledger/repository.js";
import type { CustomerScope } from "../../auth/customerScope.js";
import {
  ensureCommunicationRow,
  readCommunicationPreferences,
  readDeclaredPreferences,
  replaceDeclaredDimension,
  updateCommunicationPreferences,
} from "./preferences.js";
import { COMMUNICATION_DEFAULTS, projectDeclared } from "../../profile/preferences.js";

const CUSTOMER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCOPE_A = { customerId: CUSTOMER_A } as unknown as CustomerScope;
const SCOPE_B = { customerId: CUSTOMER_B } as unknown as CustomerScope;

/** Raised by the fake when a statement would violate the partial unique index. */
class FakeUniqueViolation extends Error {
  readonly code = "23505";
  constructor(index: string) {
    super(`duplicate key value violates unique constraint "${index}"`);
    this.name = "FakeUniqueViolation";
  }
}

/**
 * Postgres stand-in for the two preference tables.
 *
 * Enforces:
 *   - `customer_fragrance_preferences PRIMARY KEY (customer_id, dimension, value)`
 *   - `UNIQUE INDEX ... ON (customer_id) WHERE dimension = 'intensity'` — checked
 *     PER STATEMENT, which is what makes insert-before-delete fail here exactly as
 *     it would in Postgres
 *   - `customer_communication_preferences PRIMARY KEY (customer_id)` with the
 *     migration's own column DEFAULTs
 */
class FakeDb implements Queryable {
  /** `customerId|dimension|value` → true */
  readonly declared = new Set<string>();
  readonly communication = new Map<
    string,
    {
      product_launches: boolean;
      restock_alerts: boolean;
      birthday_messages: boolean;
      referral_updates: boolean;
    }
  >();
  readonly statements: string[] = [];

  rowsFor(customerId: string): { dimension: string; value: string }[] {
    return [...this.declared]
      .filter((k) => k.startsWith(`${customerId}|`))
      .map((k) => {
        const [, dimension, value] = k.split("|");
        return { dimension: dimension ?? "", value: value ?? "" };
      });
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    const cid = String(values[0] ?? "");
    const ok = (rows: QueryResultRow[], rowCount = rows.length): QueryResult<R> => ({
      rows: rows as R[],
      rowCount,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    // Longest table name first, and THROW on anything unknown rather than
    // defaulting — task 9.1's prefix trap caught three independent doubles that
    // silently matched the wrong table.
    if (q.startsWith("INSERT INTO customer_fragrance_preferences")) {
      this.statements.push("INSERT fragrance");
      const dimension = String(values[1]);
      const value = String(values[2]);
      if (dimension === "intensity") {
        // The partial unique index: at most one intensity row per customer, checked
        // now and not at commit.
        const existing = this.rowsFor(cid).filter((r) => r.dimension === "intensity");
        if (existing.some((r) => r.value !== value)) {
          throw new FakeUniqueViolation("idx_fragrance_pref_single_intensity");
        }
      }
      const key = `${cid}|${dimension}|${value}`;
      if (this.declared.has(key)) return ok([], 0); // ON CONFLICT DO NOTHING
      this.declared.add(key);
      return ok([], 1);
    }
    if (q.startsWith("DELETE FROM customer_fragrance_preferences")) {
      this.statements.push("DELETE fragrance");
      const dimension = String(values[1]);
      const keep = new Set((values[2] as string[]) ?? []);
      let deleted = 0;
      for (const key of [...this.declared]) {
        const [owner, dim, value] = key.split("|");
        if (owner !== cid || dim !== dimension) continue;
        // `value <> ALL($3)`: delete everything NOT in the kept set. An empty kept
        // set therefore clears the dimension — same statement, not a special case.
        if (!keep.has(value ?? "")) {
          this.declared.delete(key);
          deleted += 1;
        }
      }
      return ok([], deleted);
    }
    if (q.includes("FROM customer_fragrance_preferences")) {
      this.statements.push("SELECT fragrance");
      return ok(this.rowsFor(cid).map((r) => ({ dimension: r.dimension, value: r.value })));
    }
    if (q.startsWith("INSERT INTO customer_communication_preferences")) {
      this.statements.push("INSERT communication");
      if (this.communication.has(cid)) return ok([], 0);
      // The TABLE's defaults — the repository never restates them.
      this.communication.set(cid, {
        product_launches: false,
        restock_alerts: false,
        birthday_messages: true,
        referral_updates: true,
      });
      return ok([], 1);
    }
    if (q.startsWith("UPDATE customer_communication_preferences")) {
      this.statements.push("UPDATE communication");
      const row = this.communication.get(cid);
      if (!row) return ok([], 0);
      // `coalesce($n, column)`: null means "not supplied", so the column stands.
      const co = <T>(supplied: unknown, current: T): T => (supplied === null ? current : (supplied as T));
      this.communication.set(cid, {
        product_launches: co(values[1], row.product_launches),
        restock_alerts: co(values[2], row.restock_alerts),
        birthday_messages: co(values[3], row.birthday_messages),
        referral_updates: co(values[4], row.referral_updates),
      });
      return ok([], 1);
    }
    if (q.includes("FROM customer_communication_preferences")) {
      this.statements.push("SELECT communication");
      const row = this.communication.get(cid);
      return ok(row ? [row] : []);
    }
    throw new Error(`FakeDb: unknown statement: ${q}`);
  }
}

describe("readDeclaredPreferences", () => {
  it("returns nothing for a customer who has declared nothing", async () => {
    expect(await readDeclaredPreferences(new FakeDb(), SCOPE_A)).toEqual([]);
  });

  it("returns only the caller's rows", async () => {
    const db = new FakeDb();
    db.declared.add(`${CUSTOMER_A}|scent_family|oud`);
    db.declared.add(`${CUSTOMER_B}|scent_family|floral`);
    const rows = await readDeclaredPreferences(db, SCOPE_A);
    expect(rows).toEqual([{ dimension: "scent_family", value: "oud" }]);
    expect(JSON.stringify(rows)).not.toContain("floral");
  });
});

describe("replaceDeclaredDimension — set semantics (§12.8)", () => {
  it("inserts a first set", async () => {
    const db = new FakeDb();
    const result = await replaceDeclaredDimension(db, SCOPE_A, "scent_family", ["oud", "amber"]);
    expect(result).toEqual({ deleted: 0, inserted: 2 });
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_A)).scent_family).toEqual([
      "oud",
      "amber",
    ]);
  });

  it("SPARES the values that survive, so created_at is preserved for them", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "scent_family", ["oud", "amber"]);
    // `oud` stays, `amber` leaves, `woody` arrives.
    const result = await replaceDeclaredDimension(db, SCOPE_A, "scent_family", ["oud", "woody"]);
    expect(result).toEqual({ deleted: 1, inserted: 1 });
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_A)).scent_family).toEqual([
      "oud",
      "woody",
    ]);
  });

  it("is IDEMPOTENT in the database: an identical save writes nothing at all", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "note", ["rose", "saffron"]);
    const again = await replaceDeclaredDimension(db, SCOPE_A, "note", ["rose", "saffron"]);
    // Not merely an identical RESPONSE — zero rows changed.
    expect(again).toEqual({ deleted: 0, inserted: 0 });
    const third = await replaceDeclaredDimension(db, SCOPE_A, "note", ["rose", "saffron"]);
    expect(third).toEqual({ deleted: 0, inserted: 0 });
  });

  it("CLEARS the dimension when given an empty set", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "season", ["spring", "summer"]);
    const result = await replaceDeclaredDimension(db, SCOPE_A, "season", []);
    expect(result).toEqual({ deleted: 2, inserted: 0 });
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_A)).season).toEqual([]);
  });

  it("touches no OTHER dimension of the same customer", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "scent_family", ["oud"]);
    await replaceDeclaredDimension(db, SCOPE_A, "note", ["rose"]);
    await replaceDeclaredDimension(db, SCOPE_A, "scent_family", []);
    const declared = projectDeclared(await readDeclaredPreferences(db, SCOPE_A));
    expect(declared.scent_family).toEqual([]);
    expect(declared.note).toEqual(["rose"]);
  });

  it("touches no OTHER customer's rows (Req 2.1)", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_B, "scent_family", ["floral", "citrus"]);
    await replaceDeclaredDimension(db, SCOPE_A, "scent_family", ["oud"]);
    // A's clear must not empty B's set.
    await replaceDeclaredDimension(db, SCOPE_A, "scent_family", []);
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_B)).scent_family).toEqual([
      "floral",
      "citrus",
    ]);
  });
});

describe("replaceDeclaredDimension — the intensity partial unique index", () => {
  it("DELETES BEFORE IT INSERTS, which is what lets intensity change at all", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["subtle"]);
    db.statements.length = 0;

    // Changing intensity means two rows are in flight. Postgres checks the partial
    // unique index per statement, so the order is load-bearing rather than tidy.
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["bold"]);

    expect(db.statements).toEqual(["DELETE fragrance", "INSERT fragrance"]);
    expect(db.statements.indexOf("DELETE fragrance")).toBeLessThan(
      db.statements.indexOf("INSERT fragrance"),
    );
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_A)).intensity).toBe("bold");
  });

  it("proves the fake WOULD reject insert-before-delete, so the order test is not vacuous", async () => {
    // The guard only means something if violating it fails. Issuing the two
    // statements in the wrong order by hand must raise the unique violation.
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["subtle"]);
    await expect(
      db.query(
        `INSERT INTO customer_fragrance_preferences (customer_id, dimension, value)
              VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, dimension, value) DO NOTHING`,
        [CUSTOMER_A, "intensity", "bold"],
      ),
    ).rejects.toThrow(/idx_fragrance_pref_single_intensity/);
  });

  it("never holds two intensities at once, across a run of changes", async () => {
    const db = new FakeDb();
    for (const value of ["subtle", "bold", "balanced", "bold", "subtle"]) {
      await replaceDeclaredDimension(db, SCOPE_A, "intensity", [value]);
      const rows = db.rowsFor(CUSTOMER_A).filter((r) => r.dimension === "intensity");
      expect(rows, value).toHaveLength(1);
      expect(rows[0]?.value).toBe(value);
    }
  });

  it("clears intensity with an empty set", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["bold"]);
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", []);
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_A)).intensity).toBeNull();
  });

  it("re-setting the SAME intensity writes nothing and does not trip the index", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["bold"]);
    db.statements.length = 0;
    const again = await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["bold"]);
    expect(again).toEqual({ deleted: 0, inserted: 0 });
    expect(projectDeclared(await readDeclaredPreferences(db, SCOPE_A)).intensity).toBe("bold");
  });
});

describe("communication preferences", () => {
  it("reports NO ROW as null, so the caller can apply defaults rather than 404", async () => {
    expect(await readCommunicationPreferences(new FakeDb(), SCOPE_A)).toBeNull();
  });

  it("creates the row from the TABLE's defaults, never from a restated copy", async () => {
    const db = new FakeDb();
    expect(await ensureCommunicationRow(db, SCOPE_A)).toBe(true);
    const row = await readCommunicationPreferences(db, SCOPE_A);
    expect(row).toEqual({
      product_launches: COMMUNICATION_DEFAULTS.productLaunches,
      restock_alerts: COMMUNICATION_DEFAULTS.restockAlerts,
      birthday_messages: COMMUNICATION_DEFAULTS.birthdayMessages,
      referral_updates: COMMUNICATION_DEFAULTS.referralUpdates,
    });
  });

  it("does NOT reset an existing row back to defaults", async () => {
    const db = new FakeDb();
    await ensureCommunicationRow(db, SCOPE_A);
    await updateCommunicationPreferences(db, SCOPE_A, new Map([["productLaunches", true]]));
    // The second ensure must be a no-op — resetting here would silently undo a
    // customer's opt-in on their next partial save.
    expect(await ensureCommunicationRow(db, SCOPE_A)).toBe(false);
    expect((await readCommunicationPreferences(db, SCOPE_A))?.product_launches).toBe(true);
  });

  it("applies a PARTIAL patch and leaves unsupplied columns exactly as they were", async () => {
    const db = new FakeDb();
    await ensureCommunicationRow(db, SCOPE_A);
    await updateCommunicationPreferences(db, SCOPE_A, new Map([["birthdayMessages", false]]));
    const row = await readCommunicationPreferences(db, SCOPE_A);
    expect(row).toEqual({
      product_launches: false,
      restock_alerts: false,
      birthday_messages: false, // changed
      referral_updates: true, // untouched
    });
  });

  it("lets two DIFFERENT keys be saved without either undoing the other", async () => {
    // The read-modify-write failure this statement shape exists to avoid: two
    // concurrent saves of different keys must both survive.
    const db = new FakeDb();
    await ensureCommunicationRow(db, SCOPE_A);
    await Promise.all([
      updateCommunicationPreferences(db, SCOPE_A, new Map([["productLaunches", true]])),
      updateCommunicationPreferences(db, SCOPE_A, new Map([["restockAlerts", true]])),
    ]);
    const row = await readCommunicationPreferences(db, SCOPE_A);
    expect(row?.product_launches).toBe(true);
    expect(row?.restock_alerts).toBe(true);
  });

  it("is idempotent: the same patch twice leaves the same state", async () => {
    const db = new FakeDb();
    await ensureCommunicationRow(db, SCOPE_A);
    const patch = new Map<"productLaunches", boolean>([["productLaunches", true]]);
    await updateCommunicationPreferences(db, SCOPE_A, patch);
    const first = await readCommunicationPreferences(db, SCOPE_A);
    await updateCommunicationPreferences(db, SCOPE_A, patch);
    expect(await readCommunicationPreferences(db, SCOPE_A)).toEqual(first);
  });

  it("reports false when no row exists, rather than inventing one", async () => {
    const db = new FakeDb();
    expect(
      await updateCommunicationPreferences(db, SCOPE_A, new Map([["productLaunches", true]])),
    ).toBe(false);
    expect(await readCommunicationPreferences(db, SCOPE_A)).toBeNull();
  });

  it("touches no OTHER customer's row (Req 2.1)", async () => {
    const db = new FakeDb();
    await ensureCommunicationRow(db, SCOPE_B);
    await ensureCommunicationRow(db, SCOPE_A);
    await updateCommunicationPreferences(
      db,
      SCOPE_A,
      new Map([
        ["productLaunches", true],
        ["restockAlerts", true],
      ]),
    );
    const b = await readCommunicationPreferences(db, SCOPE_B);
    expect(b?.product_launches).toBe(false);
    expect(b?.restock_alerts).toBe(false);
  });
});

describe("no path through this repository touches the ledger", () => {
  it("issues only preference statements", async () => {
    const db = new FakeDb();
    await replaceDeclaredDimension(db, SCOPE_A, "scent_family", ["oud"]);
    await replaceDeclaredDimension(db, SCOPE_A, "intensity", ["bold"]);
    await ensureCommunicationRow(db, SCOPE_A);
    await updateCommunicationPreferences(db, SCOPE_A, new Map([["restockAlerts", true]]));
    await readDeclaredPreferences(db, SCOPE_A);
    await readCommunicationPreferences(db, SCOPE_A);
    // Every statement the fake saw was one of the two preference tables; the fake
    // throws on anything it does not recognise, so reaching here is the proof.
    for (const statement of db.statements) {
      expect(statement).toMatch(/fragrance|communication/);
    }
  });
});
