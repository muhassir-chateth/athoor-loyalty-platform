/**
 * Tests for the portal's data-access choke point (spec task 5.4).
 *
 * The scopes here are built through `requireCustomerScope`, exactly as a request
 * would build them, rather than cast into existence. A test that cast its way to
 * a `CustomerScope` would be proving the primitive works for a value production
 * cannot produce, which is the wrong reassurance.
 *
 * The two-customer statements are asserted against a fake executor that RECORDS
 * text and values, so the assertions are about the SQL actually issued and the
 * parameters actually bound — not about a return value that a correct-looking but
 * unscoped statement would produce identically.
 *
 * SAFETY: no Postgres, no Shopify, no network. The executor is in-memory.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.6
 */
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { requireCustomerScope, type CustomerScope } from "../../auth/customerScope.js";
import { ScopeUnavailableError } from "../../auth/customerScope.js";
import type { Queryable } from "../../ledger/repository.js";
import { redactLogPayload } from "../../observability/logRedaction.js";
import {
  PORTAL_NOT_FOUND_CODES,
  PortalRepositoryError,
  PortalRepositoryFaultError,
  PortalResourceNotFoundError,
  UnscopedStatementError,
  scopedMutate,
  scopedMutateExpectingRow,
  scopedSelect,
  scopedSelectOne,
  validateScopedStatement,
} from "./scopedQuery.js";

const CUSTOMER_A = "1f0c7c4e-0000-4000-8000-00000000000a";
const CUSTOMER_B = "1f0c7c4e-0000-4000-8000-00000000000b";

/** A scope obtained the only way production can obtain one. */
function scopeFor(customerId: string, channel: "web" | "app" = "web"): CustomerScope {
  return requireCustomerScope({
    authCtx: { customerId, channel, source: channel === "web" ? "app_proxy" : "customer_account_api" },
  } as unknown as FastifyRequest);
}

const SCOPE_A = scopeFor(CUSTOMER_A);
const SCOPE_B = scopeFor(CUSTOMER_B);

/** Records every statement it is asked to run and replies with a canned result. */
class RecordingExecutor implements Queryable {
  readonly calls: { sql: string; values: unknown[] }[] = [];

  constructor(
    private readonly reply: (sql: string, values: unknown[]) => { rows: QueryResultRow[]; rowCount?: number },
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    const bound = values ?? [];
    this.calls.push({ sql: queryText, values: bound });
    const { rows, rowCount } = this.reply(queryText, bound);
    return {
      rows: rows as R[],
      rowCount: rowCount ?? rows.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    };
  }
}

/** An executor that fails the way a database fails. */
class FailingExecutor implements Queryable {
  calls = 0;
  constructor(private readonly failure: unknown) {}
  async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
    this.calls += 1;
    throw this.failure;
  }
}

const rows = (values: QueryResultRow[]) => () => ({ rows: values });
const noRows = () => ({ rows: [] as QueryResultRow[], rowCount: 0 });

/* ========================================================================== *
 * The statement contract
 * ========================================================================== */

describe("validateScopedStatement accepts ownership expressed in the statement", () => {
  it.each([
    ["a select filtered by customer", "SELECT a FROM t WHERE customer_id = $1"],
    ["a qualified predicate", "SELECT a FROM t AS x WHERE x.customer_id = $1"],
    ["extra whitespace around the predicate", "SELECT a FROM t WHERE  customer_id   =   $1"],
    ["mixed case", "select a from t where CUSTOMER_ID = $1"],
    ["an insert whose leading column is the owner", "INSERT INTO t (customer_id, p) VALUES ($1, $2)"],
    [
      "an insert with ON CONFLICT DO NOTHING",
      "INSERT INTO t (customer_id, p) VALUES ($1, $2) ON CONFLICT (customer_id, p) DO NOTHING",
    ],
    ["an update scoped in its WHERE", "UPDATE t SET p = $2 WHERE customer_id = $1"],
    ["a targeted delete", "DELETE FROM t WHERE customer_id = $1 AND p = $2"],
  ])("accepts %s", (_label, sql) => {
    expect(() => validateScopedStatement(sql)).not.toThrow();
  });

  it("accepts a join whose joined table has no customer_id of its own", () => {
    // The real N16 shape: `discount_codes` is keyed by `redemption_id` and holds
    // no customer column, so ownership can only live on the redemptions side.
    // Proving the validator accepts this NOW matters, because task 10.2 depends
    // on it and would otherwise discover the primitive cannot express its query.
    expect(() =>
      validateScopedStatement(`SELECT r.id, r.status, dc.code
                                 FROM redemptions r
                            LEFT JOIN discount_codes dc ON dc.redemption_id = r.id
                                WHERE r.customer_id = $1
                             ORDER BY r.created_at DESC
                                LIMIT $2`),
    ).not.toThrow();
  });
});

describe("validateScopedStatement refuses a statement that does not scope itself", () => {
  it.each([
    ["no predicate at all", "SELECT a FROM t", "missing_ownership_placeholder"],
    ["the resource but not the owner", "SELECT a FROM t WHERE id = $1", "ownership_placeholder_misused"],
    [
      "ownership on the wrong placeholder",
      "SELECT a FROM t WHERE id = $1 AND customer_id = $2",
      "ownership_placeholder_misused",
    ],
    ["a projected owner rather than a filtered one", "SELECT $1 FROM t WHERE id = $2", "ownership_placeholder_misused"],
    ["an insert that does not lead with the owner", "INSERT INTO t (p, customer_id) VALUES ($1, $2)", "insert_customer_id_not_leading_column"],
    ["a select with no WHERE clause", "SELECT customer_id = $1 FROM t", "missing_where_clause"],
    ["stacked statements", "SELECT a FROM t WHERE customer_id = $1; DROP TABLE t", "statement_stacking"],
    ["interpolated SQL", "SELECT a FROM t WHERE customer_id = ${cid}", "interpolated_sql"],
    ["an unsupported statement kind", "TRUNCATE customer_wishlist", "unsupported_statement_kind"],
    ["a CTE, which these rules cannot prove", "WITH x AS (SELECT 1) SELECT a FROM x WHERE customer_id = $1", "unsupported_statement_kind"],
    ["an empty statement", "   ", "empty_sql"],
  ])("refuses %s", (_label, sql, reason) => {
    let thrown: unknown;
    try {
      validateScopedStatement(sql);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnscopedStatementError);
    expect((thrown as UnscopedStatementError).reason).toBe(reason);
  });

  it("refuses an ownership predicate that sits outside the WHERE clause", () => {
    // `ON x.customer_id = $1` in a join condition looks like ownership and does
    // not filter the outer result, which is the subtle version of this mistake.
    let thrown: unknown;
    try {
      validateScopedStatement(
        "SELECT a FROM t LEFT JOIN u ON u.customer_id = $1 WHERE t.id = $2",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnscopedStatementError);
    expect((thrown as UnscopedStatementError).reason).toBe("ownership_predicate_outside_where");
  });

  it("refuses a disjunction that would make the ownership predicate optional", () => {
    // The subtlest breach available, and the reason the `AND` in task 5.4's
    // `customer_id = $1 AND <resource> = $2` is load-bearing. Every other rule
    // passes: `$1` is compared to `customer_id`, inside the WHERE, bound by the
    // primitive. And the statement matches every customer's row whose product id
    // matches — on a DELETE, it empties other people's wishlists.
    let thrown: unknown;
    try {
      validateScopedStatement(
        "DELETE FROM customer_wishlist WHERE customer_id = $1 OR shopify_product_id = $2",
        1,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnscopedStatementError);
    expect((thrown as UnscopedStatementError).reason).toBe("disjunction_in_where");
  });

  it("refuses a disjunction on a read as well as a write", () => {
    expect(() =>
      validateScopedStatement("SELECT a FROM t WHERE customer_id = $1 OR id = $2", 1),
    ).toThrow(UnscopedStatementError);
  });

  it("does not mistake ORDER BY, FOR UPDATE or a column named color for a disjunction", () => {
    // A rule that produced false rejections would get loosened, and a loosened
    // rule is how a real check dies. These are the three shapes containing the
    // letters `or` that a scoped statement legitimately uses.
    for (const sql of [
      "SELECT a FROM t WHERE customer_id = $1 ORDER BY a",
      "SELECT a FROM t WHERE customer_id = $1 FOR UPDATE",
      "SELECT color FROM t WHERE customer_id = $1 AND color = $2",
    ]) {
      expect(() => validateScopedStatement(sql), sql).not.toThrow();
    }
  });

  it("catches a bound parameter the statement never uses", () => {
    // The caller passed a resource id but the SQL filters on the customer alone,
    // so the delete would remove the customer's whole set instead of one row.
    let thrown: unknown;
    try {
      validateScopedStatement("DELETE FROM t WHERE customer_id = $1", 1);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as UnscopedStatementError).reason).toBe("placeholder_numbering_mismatch");
  });

  it("catches the off-by-one where the caller numbered its own first parameter $1", () => {
    let thrown: unknown;
    try {
      validateScopedStatement("SELECT a FROM t WHERE customer_id = $1 AND p = $2", 2);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as UnscopedStatementError).reason).toBe("placeholder_numbering_mismatch");
  });

  it("reads $10 as ten rather than as one, so it is not mistaken for the owner", () => {
    // A validator that matched `$1` inside `$10` would accept a statement whose
    // ownership placeholder does not exist.
    expect(() => validateScopedStatement("SELECT a FROM t WHERE id = $10")).toThrow(
      UnscopedStatementError,
    );
  });
});

/* ========================================================================== *
 * $1 belongs to the scope
 * ========================================================================== */

describe("the primitive owns $1 (Requirement 2.1)", () => {
  it("binds the scope's customer id first, ahead of every caller parameter", async () => {
    const executor = new RecordingExecutor(rows([{ a: 1 }]));
    await scopedSelect(executor, SCOPE_A, {
      sql: "SELECT a FROM t WHERE customer_id = $1 AND p = $2",
      params: ["44556677"],
    });
    expect(executor.calls[0]?.values).toEqual([CUSTOMER_A, "44556677"]);
  });

  it("binds a different customer's id for a different scope, with identical SQL", async () => {
    const executor = new RecordingExecutor(rows([]));
    const statement = { sql: "SELECT a FROM t WHERE customer_id = $1" };
    await scopedSelect(executor, SCOPE_A, statement);
    await scopedSelect(executor, SCOPE_B, statement);
    expect(executor.calls[0]?.values).toEqual([CUSTOMER_A]);
    expect(executor.calls[1]?.values).toEqual([CUSTOMER_B]);
    expect(executor.calls[0]?.sql).toBe(executor.calls[1]?.sql);
  });

  it("issues no query at all when the statement is unscoped", async () => {
    // Fail-closed: the rejection happens BEFORE execution, so an unscoped
    // statement never runs even once.
    const executor = new RecordingExecutor(rows([{ a: 1 }]));
    await expect(
      scopedSelect(executor, SCOPE_A, { sql: "SELECT a FROM t WHERE id = $1", params: ["x"] }),
    ).rejects.toBeInstanceOf(UnscopedStatementError);
    expect(executor.calls).toEqual([]);
  });

  it("cannot be steered by a caller parameter that looks like a customer id", async () => {
    // The attack shape: pass the victim's id as a parameter and hope it lands on
    // `$1`. It lands on `$2`, where the SQL compares it to the resource column.
    const executor = new RecordingExecutor(rows([]));
    await scopedSelect(executor, SCOPE_A, {
      sql: "SELECT a FROM t WHERE customer_id = $1 AND p = $2",
      params: [CUSTOMER_B],
    });
    expect(executor.calls[0]?.values[0]).toBe(CUSTOMER_A);
    expect(executor.calls[0]?.values[1]).toBe(CUSTOMER_B);
  });
});

/* ========================================================================== *
 * Zero rows means 404, and says nothing else
 * ========================================================================== */

describe("a foreign identifier yields 404 with nothing that distinguishes it (Requirements 2.2, 2.3)", () => {
  it("maps zero selected rows to a not-found error", async () => {
    const executor = new RecordingExecutor(noRows);
    await expect(
      scopedSelectOne(executor, SCOPE_A, {
        sql: "SELECT a FROM t WHERE customer_id = $1 AND id = $2",
        params: ["someone-elses-id"],
      }),
    ).rejects.toBeInstanceOf(PortalResourceNotFoundError);
  });

  it("maps zero affected rows on a write to a not-found error", async () => {
    const executor = new RecordingExecutor(noRows);
    await expect(
      scopedMutateExpectingRow(executor, SCOPE_A, {
        sql: "DELETE FROM t WHERE customer_id = $1 AND id = $2",
        params: ["someone-elses-id"],
      }),
    ).rejects.toBeInstanceOf(PortalResourceNotFoundError);
  });

  it("produces a byte-identical error for a real-but-foreign id and a random one", async () => {
    // §4.5 row 14 — no existence oracle. The two cases are indistinguishable
    // because the statement cannot tell them apart either: both match zero rows.
    const executor = new RecordingExecutor(noRows);
    const attempt = async (resourceId: string) => {
      try {
        await scopedSelectOne(
          executor,
          SCOPE_A,
          { sql: "SELECT a FROM t WHERE customer_id = $1 AND id = $2", params: [resourceId] },
          "order_not_found",
        );
        return null;
      } catch (error) {
        const notFound = error as PortalResourceNotFoundError;
        return { code: notFound.code, message: notFound.message, name: notFound.name };
      }
    };

    const foreignButReal = await attempt("6543210987");
    const pureFiction = await attempt("99999999999999999999");
    expect(foreignButReal).toEqual(pureFiction);
  });

  it("carries no resource attribute anywhere on the error", () => {
    const error = new PortalResourceNotFoundError("order_not_found");
    const serialised = JSON.stringify({
      code: error.code,
      message: error.message,
      ...Object.fromEntries(Object.entries(error)),
    });
    // No id, no table name, no column name, no count — nothing a handler could
    // interpolate into a body that would confirm the resource exists.
    expect(serialised).not.toMatch(/\d{4,}/);
    expect(serialised.toLowerCase()).not.toContain("customer_id");
    expect(serialised.toLowerCase()).not.toContain("select");
  });

  it("never lets a not-found code carry a digit", () => {
    // A code like `order_6543210987_not_found` would be the oracle re-opened.
    for (const code of PORTAL_NOT_FOUND_CODES) {
      expect(code).not.toMatch(/\d/);
    }
  });

  it("falls back to the generic code rather than propagating an unknown one", () => {
    const smuggled = "order_6543210987_not_found" as unknown as (typeof PORTAL_NOT_FOUND_CODES)[number];
    expect(new PortalResourceNotFoundError(smuggled).code).toBe("not_found");
  });

  it("treats an empty result set as a legitimate empty answer, not a 404", async () => {
    // A customer with no saved products has an empty wishlist; that is data, not
    // a missing resource. Conflating the two would show an error state to every
    // new member.
    const executor = new RecordingExecutor(noRows);
    await expect(
      scopedSelect(executor, SCOPE_A, { sql: "SELECT a FROM t WHERE customer_id = $1" }),
    ).resolves.toEqual([]);
  });

  it("reports an idempotent no-op write as zero affected rows rather than 404", async () => {
    const executor = new RecordingExecutor(noRows);
    await expect(
      scopedMutate(executor, SCOPE_A, {
        sql: "INSERT INTO t (customer_id, p) VALUES ($1, $2) ON CONFLICT (customer_id, p) DO NOTHING",
        params: ["1"],
      }),
    ).resolves.toBe(0);
  });
});

/* ========================================================================== *
 * A fault is a fault
 * ========================================================================== */

describe("a database fault stays distinguishable from an authorisation failure (5.2/5.5 property)", () => {
  it.each([
    ["a connection refusal", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["a statement timeout", Object.assign(new Error("canceling statement"), { code: "57014" })],
    ["a unique violation quoting the offending value", Object.assign(new Error("duplicate key"), { code: "23505", detail: "Key (email)=(someone@example.com) already exists.", table: "customers" })],
    ["a non-Error rejection", "the pool exploded"],
  ])("reports %s as a fault", async (_label, failure) => {
    const executor = new FailingExecutor(failure);
    let thrown: unknown;
    try {
      await scopedSelect(executor, SCOPE_A, { sql: "SELECT a FROM t WHERE customer_id = $1" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortalRepositoryFaultError);
    // The three outcomes must never collapse into one another.
    expect(thrown).not.toBeInstanceOf(PortalResourceNotFoundError);
    expect(thrown).not.toBeInstanceOf(ScopeUnavailableError);
    expect(thrown).not.toBeInstanceOf(UnscopedStatementError);
    expect((thrown as PortalRepositoryFaultError).code).toBe("repository_fault");
  });

  it("does not turn a fault into an empty result", async () => {
    // The tempting degradation. It would read to the customer as "you have no
    // orders" during an outage, and to us as a quiet success.
    const executor = new FailingExecutor(new Error("down"));
    await expect(
      scopedSelect(executor, SCOPE_A, { sql: "SELECT a FROM t WHERE customer_id = $1" }),
    ).rejects.toBeInstanceOf(PortalRepositoryFaultError);
  });

  it("does not turn a fault into a 404 on the write path either", async () => {
    const executor = new FailingExecutor(new Error("down"));
    let thrown: unknown;
    try {
      await scopedMutateExpectingRow(executor, SCOPE_A, {
        sql: "DELETE FROM t WHERE customer_id = $1 AND id = $2",
        params: ["1"],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortalRepositoryFaultError);
    expect(thrown).not.toBeInstanceOf(PortalResourceNotFoundError);
  });

  it("keeps the driver error reachable for classification but out of the message", () => {
    const driverError = Object.assign(new Error("duplicate key value violates…"), {
      code: "23505",
      detail: "Key (email)=(someone@example.com) already exists.",
    });
    const fault = new PortalRepositoryFaultError(driverError);
    expect(fault.cause).toBe(driverError);
    expect(fault.message).not.toContain("someone@example.com");
    expect(fault.message).not.toContain("duplicate");
  });

  it("shares one catchable base class across all three outcomes", () => {
    for (const error of [
      new PortalResourceNotFoundError(),
      new PortalRepositoryFaultError(new Error("x")),
      new UnscopedStatementError("empty_sql"),
    ]) {
      expect(error).toBeInstanceOf(PortalRepositoryError);
    }
  });
});

/* ========================================================================== *
 * The fault's cause cannot ride into a log line
 * ========================================================================== */

describe("the 5.7 allowlist serialiser strips what the fault carries (design §24.3)", () => {
  it("drops the driver error attached as `cause`, including its detail and table", () => {
    // Attaching a `pg` error as `cause` is only safe if redaction does not
    // follow it. Asserted rather than assumed: a `pg` unique-violation `detail`
    // quotes the offending value, so a duplicate signup would otherwise log a
    // customer's email verbatim.
    const fault = new PortalRepositoryFaultError(
      Object.assign(new Error("duplicate key value"), {
        code: "23505",
        detail: "Key (email)=(someone@example.com) already exists.",
        table: "customers",
        constraint: "customers_email_key",
      }),
    );

    const redacted = JSON.stringify(redactLogPayload({ err: fault, errorCode: fault.code }));

    expect(redacted).not.toContain("someone@example.com");
    expect(redacted).not.toContain("customers_email_key");
    expect(redacted).not.toContain("cause");
    expect(redacted).not.toContain("duplicate key value");
    // What survives is what a log reader needs: the class and the code.
    expect(redacted).toContain("PortalRepositoryFaultError");
    expect(redacted).toContain("repository_fault");
  });

  it("keeps a not-found distinguishable from a fault in the log stream", () => {
    const notFound = JSON.stringify(
      redactLogPayload({ err: new PortalResourceNotFoundError("order_not_found") }),
    );
    expect(notFound).toContain("PortalResourceNotFoundError");
    expect(notFound).toContain("order_not_found");
  });
});
