/**
 * The operator-run redaction procedure — task 15.3, §15.5/§15.6,
 * Req 23.5, 23.6, 23.7, 23.9, 22.11.
 *
 * SAFETY: no network, no production, no live Postgres. The fake records every
 * statement so the tests can assert what WOULD have been issued — which is how the
 * "never touches the ledger" property is proven rather than asserted.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMAIL_IS_NULLABLE,
  guardLedgerSafety,
  LEDGER_PROTECTED_TABLES,
  REDACTION_AUDIT_OPERATION,
  REDACTION_DELETE_TABLES,
  REDACTION_REFUSAL_REASONS,
  REDACTION_RETAINED_TABLES,
  RedactionRefusedError,
  runCustomerRedaction,
  type RedactionExecutor,
  type RedactionTransactor,
} from "./redaction.js";
import { AUDIT_OPERATION_TYPES } from "../admin/auditTrail.js";

const TARGET = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** Records every statement and models rows for two customers. */
class FakeDb implements RedactionExecutor {
  readonly statements: { sql: string; values: unknown[] }[] = [];
  /** `table` → customerId → row count. */
  rows = new Map<string, Map<string, number>>();
  emails = new Map<string, string | null>([
    [TARGET, "target@example.com"],
    [OTHER, "other@example.com"],
  ]);
  openRequests = new Map<string, number>([
    [TARGET, 1],
    [OTHER, 1],
  ]);
  customers = new Set<string>([TARGET, OTHER]);
  auditRecords: { operationType: string; customerId: string; detail: string }[] = [];

  constructor() {
    for (const table of REDACTION_DELETE_TABLES) {
      this.rows.set(
        table,
        new Map([
          [TARGET, 3],
          [OTHER, 5],
        ]),
      );
    }
  }

  count(table: string, customerId: string): number {
    return this.rows.get(table)?.get(customerId) ?? 0;
  }

  async query<R = unknown>(sql: string, values: unknown[] = []) {
    this.statements.push({ sql, values });
    const q = sql.trim();
    const cid = String(values[0] ?? "");
    const rows = (r: unknown[], n = r.length) => ({ rows: r as R[], rowCount: n });

    if (q.startsWith("SELECT id FROM customers")) {
      return rows(this.customers.has(cid) ? [{ id: cid }] : []);
    }
    if (q.startsWith("SELECT count(*)::text AS n FROM customers")) {
      const held = this.emails.get(cid);
      return rows([{ n: held === null || held === undefined ? "0" : "1" }]);
    }
    if (q.startsWith("UPDATE customers SET email = NULL")) {
      const had = this.emails.get(cid);
      const changed = had !== null && had !== undefined;
      if (changed) this.emails.set(cid, null);
      return rows([], changed ? 1 : 0);
    }
    if (q.includes("FROM customer_erasure_requests")) {
      return rows([{ n: String(this.openRequests.get(cid) ?? 0) }]);
    }
    if (q.startsWith("UPDATE customer_erasure_requests")) {
      const n = this.openRequests.get(cid) ?? 0;
      this.openRequests.set(cid, 0);
      return rows([], n);
    }
    if (q.startsWith("INSERT INTO admin_audit_log")) {
      this.auditRecords.push({
        operationType: String(values[1]),
        customerId: String(values[2]),
        detail: String(values[3]),
      });
      return rows([], 1);
    }
    const counted = /^SELECT count\(\*\)::text AS n FROM ([a-z_]+) WHERE customer_id/.exec(q);
    if (counted !== null) return rows([{ n: String(this.count(counted[1] as string, cid)) }]);
    const deleted = /^DELETE FROM ([a-z_]+) WHERE customer_id/.exec(q);
    if (deleted !== null) {
      const table = deleted[1] as string;
      const n = this.count(table, cid);
      this.rows.get(table)?.set(cid, 0);
      return rows([], n);
    }
    throw new Error(`FakeDb: unknown statement: ${q.slice(0, 70)}`);
  }
}

/** A real all-or-nothing transactor over the fake. */
function transactorFor(db: FakeDb): RedactionTransactor {
  return {
    async transaction<T>(fn: (tx: RedactionExecutor) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

describe("the D4 boundary — no unauthorised webhook, anywhere", () => {
  const source = readFileSync(fileURLToPath(new URL("./redaction.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("registers no webhook subscription and names no compliance topic", () => {
    // D4 is NOT AUTHORISED: Req 22.11 forbids webhook subscription changes during
    // the rollout. Asserted against the SOURCE, because the point is that there is
    // nowhere in this module such a call could live.
    for (const banned of [
      "customers/redact",
      "CUSTOMERS_REDACT",
      "webhookSubscriptionCreate",
      "WEBHOOK_TOPICS",
      "shop/redact",
      "customers/data_request",
      "registerWebhook",
    ]) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it("issues no HTTP request and imports no Shopify transport", () => {
    for (const banned of ["fetch(", "http://", "https://", "ShopifyGraphqlTransport", "adminClient"]) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it("is not reachable from any route", () => {
    // The customer-facing erasure route records intent and stops. If a route ever
    // imported this module, a customer request could trigger a nine-table deletion.
    const routes = readFileSync(
      fileURLToPath(new URL("../routes/privacy.ts", import.meta.url)),
      "utf8",
    );
    // COMMENTS STRIPPED FIRST. The route's own header explains that the
    // destructive half lives in `privacy/redaction.ts`, which is exactly the
    // documentation a reader needs — so the check has to be about CODE, not prose.
    const routeCode = routes.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(routeCode).not.toContain("privacy/redaction");
    expect(routeCode).not.toContain("runCustomerRedaction");
    // And no route file anywhere imports it.
    const routesDir = fileURLToPath(new URL("../routes/", import.meta.url));
    for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
      const code = readFileSync(join(routesDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} imports the redaction procedure`).not.toMatch(
        /from\s+"[^"]*privacy\/redaction/,
      );
    }
  });
});

describe("fail closed", () => {
  it("refuses with NO target", async () => {
    const db = new FakeDb();
    for (const customerId of [undefined, null, "", "   "]) {
      await expect(
        runCustomerRedaction(transactorFor(db), { customerId, dryRun: false, confirm: true }),
      ).rejects.toThrow(RedactionRefusedError);
    }
    // Not one statement was issued — the refusal precedes any query.
    expect(db.statements).toHaveLength(0);
  });

  it("refuses a MALFORMED target without querying", async () => {
    const db = new FakeDb();
    for (const bad of [
      "not-a-uuid",
      "1",
      "'; DROP TABLE customers; --",
      "11111111-1111-4111-8111",
      "%",
      "*",
      TARGET.replace("-", ""),
    ]) {
      let reason: string | null = null;
      try {
        await runCustomerRedaction(transactorFor(db), {
          customerId: bad,
          dryRun: false,
          confirm: true,
        });
      } catch (err) {
        reason = (err as RedactionRefusedError).reason;
      }
      expect(reason, bad).toBe("malformed_target");
    }
    // A malformed target reaching the database is how a typo becomes a wildcard.
    expect(db.statements).toHaveLength(0);
  });

  it("refuses an UNKNOWN customer rather than reporting a successful no-op", async () => {
    const db = new FakeDb();
    db.customers.delete(TARGET);
    let reason: string | null = null;
    try {
      await runCustomerRedaction(transactorFor(db), {
        customerId: TARGET,
        dryRun: false,
        confirm: true,
      });
    } catch (err) {
      reason = (err as RedactionRefusedError).reason;
    }
    expect(reason).toBe("unknown_customer");
    // It looked the customer up and then stopped: no DELETE was issued.
    expect(db.statements.filter((s) => s.sql.includes("DELETE"))).toHaveLength(0);
  });

  it("refuses a live run WITHOUT explicit confirmation", async () => {
    const db = new FakeDb();
    let reason: string | null = null;
    try {
      await runCustomerRedaction(transactorFor(db), { customerId: TARGET, dryRun: false });
    } catch (err) {
      reason = (err as RedactionRefusedError).reason;
    }
    expect(reason).toBe("not_confirmed");
    expect(db.statements).toHaveLength(0);
  });

  it("DEFAULTS to a dry run, so the destructive path cannot be reached by omission", async () => {
    const db = new FakeDb();
    // No `dryRun` at all, no `confirm`.
    const outcome = await runCustomerRedaction(transactorFor(db), { customerId: TARGET });
    expect(outcome.dryRun).toBe(true);
    expect(db.statements.filter((s) => /^DELETE|^UPDATE/.test(s.sql.trim()))).toHaveLength(0);
    // And everything is still there.
    for (const table of REDACTION_DELETE_TABLES) {
      expect(db.count(table, TARGET), table).toBe(3);
    }
  });

  it("carries no PII in a refusal message", () => {
    for (const reason of REDACTION_REFUSAL_REASONS) {
      const err = new RedactionRefusedError(reason);
      expect(err.message).toBe(`Redaction refused: ${reason}.`);
      expect(err.message).not.toContain("@");
    }
  });
});

describe("the ledger is never touched (Req 23.6)", () => {
  it("issues NO statement naming a ledger-protected table", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    const all = db.statements.map((s) => s.sql.toLowerCase()).join(" ");
    for (const table of LEDGER_PROTECTED_TABLES) {
      expect(all, table).not.toMatch(new RegExp(`\\b${table}\\b`));
    }
  });

  it("REFUSES a ledger statement at runtime, not merely by convention", async () => {
    // The guard is what catches a future edit; the statement list is what a future
    // edit changes.
    const db = new FakeDb();
    const guarded = guardLedgerSafety(db);
    for (const table of LEDGER_PROTECTED_TABLES) {
      await expect(
        guarded.query(`DELETE FROM ${table} WHERE customer_id = $1`, [TARGET]),
      ).rejects.toThrow(RedactionRefusedError);
    }
    // Nothing reached the executor.
    expect(db.statements).toHaveLength(0);
  });

  it("lets a permitted statement through the guard", async () => {
    const db = new FakeDb();
    const guarded = guardLedgerSafety(db);
    await guarded.query("DELETE FROM customer_birthdays WHERE customer_id = $1", [TARGET]);
    expect(db.statements).toHaveLength(1);
  });

  it("does not trip on a prefix or a longer table name", async () => {
    const db = new FakeDb();
    const guarded = guardLedgerSafety(db);
    // `point_lots_archive` is not `point_lots`, and word boundaries make that true.
    // The property is that the GUARD let it through — asserted by the statement
    // reaching the executor, not by what the executor then did with it.
    await guarded.query("DELETE FROM point_lots_archive WHERE customer_id = $1", [TARGET]);
    expect(db.statements).toHaveLength(1);
    // The reverse direction: the bare name IS still caught, so the word-boundary
    // relaxation did not open a hole.
    await expect(
      guarded.query("DELETE FROM point_lots WHERE customer_id = $1", [TARGET]),
    ).rejects.toThrow(RedactionRefusedError);
    expect(db.statements).toHaveLength(1);
  });

  it("declares every protected table as retained, with a reason", () => {
    for (const table of LEDGER_PROTECTED_TABLES) {
      expect(REDACTION_RETAINED_TABLES, table).toHaveProperty(table);
      expect(String(REDACTION_RETAINED_TABLES[table]).length).toBeGreaterThan(5);
    }
  });

  it("keeps the delete and retain lists DISJOINT", () => {
    for (const table of REDACTION_DELETE_TABLES) {
      expect(
        Object.keys(REDACTION_RETAINED_TABLES),
        `${table} is both deleted and retained`,
      ).not.toContain(table);
    }
  });
});

describe("retained versus redacted (§15.5)", () => {
  it("deletes exactly the nine §15.5 tables and no other", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    const deletedTables = db.statements
      .map((s) => /^DELETE FROM ([a-z_]+)/.exec(s.sql.trim())?.[1])
      .filter((t): t is string => t !== undefined);
    expect([...deletedTables].sort()).toEqual([...REDACTION_DELETE_TABLES].sort());
  });

  it("RETAINS the erasure request and marks it completed", async () => {
    const db = new FakeDb();
    const outcome = await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    // Updated, never deleted — it is the audit record of the request.
    expect(db.statements.some((s) => s.sql.includes("DELETE FROM customer_erasure_requests"))).toBe(
      false,
    );
    expect(outcome.requestsCompleted).toBe(1);
    expect(db.openRequests.get(TARGET)).toBe(0);
  });

  it("RETAINS birthday_grants, so the once-per-year guard stays honest", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    expect(db.statements.some((s) => s.sql.includes("birthday_grants"))).toBe(false);
    expect(REDACTION_RETAINED_TABLES).toHaveProperty("birthday_grants");
  });

  it("clears customers.email to NULL rather than to a tombstone (OQ-9)", async () => {
    const db = new FakeDb();
    const outcome = await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    expect(EMAIL_IS_NULLABLE).toBe(true);
    expect(outcome.emailRedacted).toBe(true);
    expect(db.emails.get(TARGET)).toBeNull();
    // A tombstone would still store a value derived from the customer's id.
    const emailStatements = db.statements.filter((s) => s.sql.includes("email"));
    expect(emailStatements.some((s) => s.sql.includes("email = NULL"))).toBe(true);
    expect(JSON.stringify(db.statements)).not.toContain("@invalid");
  });
});

describe("cross-customer isolation — it cannot redact the wrong customer", () => {
  it("leaves EVERY other customer's rows, email and requests untouched", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    for (const table of REDACTION_DELETE_TABLES) {
      expect(db.count(table, TARGET), `${table} target`).toBe(0);
      expect(db.count(table, OTHER), `${table} other`).toBe(5);
    }
    expect(db.emails.get(OTHER)).toBe("other@example.com");
    expect(db.openRequests.get(OTHER)).toBe(1);
  });

  it("binds the target as a PARAMETER on every statement, never interpolated", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    for (const statement of db.statements) {
      // The customer id never appears in SQL text — only in values. An interpolated
      // id is how a redaction becomes a wildcard.
      expect(statement.sql, statement.sql.slice(0, 50)).not.toContain(TARGET);
    }
    // And every customer-scoped statement carried the target as its first value.
    const scoped = db.statements.filter((s) => s.sql.includes("customer_id = $1") || s.sql.includes("id = $1"));
    expect(scoped.length).toBeGreaterThan(0);
    for (const statement of scoped) {
      expect(statement.values[0]).toBe(TARGET);
    }
  });

  it("never issues an unscoped DELETE", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    for (const statement of db.statements) {
      if (!/^DELETE|^UPDATE/i.test(statement.sql.trim())) continue;
      // A destructive statement without a WHERE on the target would empty a table.
      expect(statement.sql, statement.sql.slice(0, 60)).toMatch(/WHERE\s+(?:customer_)?id\s*=\s*\$1/);
    }
  });
});

describe("the dry run previews exactly what the live run would do", () => {
  it("reports the same per-table counts the live run then deletes", async () => {
    const preview = new FakeDb();
    const previewed = await runCustomerRedaction(transactorFor(preview), { customerId: TARGET });

    const live = new FakeDb();
    const executed = await runCustomerRedaction(transactorFor(live), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });

    expect(previewed.deleted).toEqual(executed.deleted);
    expect(previewed.emailRedacted).toBe(executed.emailRedacted);
    expect(previewed.requestsCompleted).toBe(executed.requestsCompleted);
  });

  it("writes NOTHING, including no audit record", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), { customerId: TARGET });
    for (const statement of db.statements) {
      expect(statement.sql.trim()).toMatch(/^SELECT\b/i);
    }
    expect(db.auditRecords).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("re-running changes nothing and reports zeroes", async () => {
    const db = new FakeDb();
    const first = await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    const second = await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    for (const table of REDACTION_DELETE_TABLES) {
      expect(first.deleted[table], table).toBe(3);
      expect(second.deleted[table], table).toBe(0);
    }
    expect(second.emailRedacted).toBe(false);
    expect(second.requestsCompleted).toBe(0);
  });

  it("stays idempotent over many runs", async () => {
    const db = new FakeDb();
    for (let i = 0; i < 4; i += 1) {
      await runCustomerRedaction(transactorFor(db), {
        customerId: TARGET,
        dryRun: false,
        confirm: true,
      });
    }
    for (const table of REDACTION_DELETE_TABLES) {
      expect(db.count(table, TARGET), table).toBe(0);
    }
    expect(db.emails.get(TARGET)).toBeNull();
    // The other customer is still whole after four runs.
    expect(db.count("customer_wishlist", OTHER)).toBe(5);
  });
});

describe("auditability", () => {
  it("writes ONE audit record with the redaction operation type", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
      actorId: "operator-7",
    });
    expect(db.auditRecords).toHaveLength(1);
    expect(db.auditRecords[0]).toMatchObject({
      operationType: REDACTION_AUDIT_OPERATION,
      customerId: TARGET,
    });
  });

  it("uses an operation type the shared vocabulary knows", () => {
    // If this drifts, the CHECK rejects the INSERT at 2am against production.
    expect(AUDIT_OPERATION_TYPES).toContain(REDACTION_AUDIT_OPERATION);
  });

  it("records COUNTS and table names, never the data that was erased", async () => {
    const db = new FakeDb();
    await runCustomerRedaction(transactorFor(db), {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    const detail = db.auditRecords[0]?.detail ?? "";
    // An audit record of a privacy erasure must not itself become a store of the
    // erased data (§15.7).
    expect(detail).not.toContain("@example.com");
    expect(detail).not.toContain("target@");
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    expect(parsed).toMatchObject({ action: "customer_redaction", ledgerTouched: false });
    expect(parsed.deleted).toBeTypeOf("object");
  });

  it("writes the audit record INSIDE the transaction", async () => {
    // A redaction must not be able to commit without its record.
    const db = new FakeDb();
    let insideTransaction = false;
    const transactor: RedactionTransactor = {
      async transaction<T>(fn: (tx: RedactionExecutor) => Promise<T>): Promise<T> {
        insideTransaction = true;
        const result = await fn(db);
        // The audit record must already exist when the transaction body returns.
        expect(db.auditRecords).toHaveLength(1);
        insideTransaction = false;
        return result;
      },
    };
    await runCustomerRedaction(transactor, {
      customerId: TARGET,
      dryRun: false,
      confirm: true,
    });
    expect(insideTransaction).toBe(false);
  });
});
