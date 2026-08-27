/**
 * Erasure-request repository and the export-only scoped reads — tasks 15.1/15.2,
 * §15.4/§15.5, Req 2.1, 13.8, 23.3, 23.5.
 *
 * SAFETY: no network, no production, no live Postgres.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../../ledger/repository.js";
import type { CustomerScope } from "../../auth/customerScope.js";
import {
  completeErasureRequests,
  ERASURE_SOURCES,
  ERASURE_STATUSES,
  OPEN_ERASURE_STATUSES,
  readErasureRequests,
  readPortalVisits,
  readRecentlyViewedForExport,
  recordErasureRequest,
} from "./erasure.js";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCOPE_A = { customerId: A } as unknown as CustomerScope;
const SCOPE_B = { customerId: B } as unknown as CustomerScope;

interface Row {
  id: string;
  customer_id: string;
  requested_at: string;
  status: string;
  completed_at: string | null;
  source: string;
}

class FakeDb implements Queryable {
  rows: Row[] = [];
  visits = new Map<string, { first_visited_at: string; last_visited_at: string }>();
  viewed = new Map<string, { shopify_product_id: string; viewed_at: string }[]>();
  readonly statements: string[] = [];
  private next = 1;

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    this.statements.push(q);
    const cid = String(values[0] ?? "");
    const ok = (r: QueryResultRow[], n = r.length): QueryResult<R> => ({
      rows: r as R[],
      rowCount: n,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    if (q.startsWith("INSERT INTO customer_erasure_requests")) {
      const row: Row = {
        id: `${String(this.next).padStart(8, "0")}-1111-4111-8111-111111111111`,
        customer_id: cid,
        requested_at: `2026-08-2${this.next}T10:00:00.000Z`,
        status: "received",
        completed_at: null,
        source: String(values[1] ?? "portal"),
      };
      this.next += 1;
      this.rows.push(row);
      return ok([row]);
    }
    if (q.startsWith("UPDATE customer_erasure_requests")) {
      const mine = this.rows.filter((r) => r.customer_id === cid && r.status !== "completed");
      for (const row of mine) {
        row.status = "completed";
        row.completed_at = "2026-08-27T12:00:00.000Z";
      }
      return ok([], mine.length);
    }
    if (q.includes("FROM customer_erasure_requests")) {
      return ok(
        this.rows
          .filter((r) => r.customer_id === cid)
          .slice()
          .sort((x, y) => y.requested_at.localeCompare(x.requested_at)),
      );
    }
    if (q.includes("FROM portal_visits")) {
      const v = this.visits.get(cid);
      return ok(v ? [v] : []);
    }
    if (q.includes("FROM customer_recently_viewed")) {
      return ok(this.viewed.get(cid) ?? []);
    }
    throw new Error(`FakeDb: unknown statement: ${q.slice(0, 60)}`);
  }
}

describe("the vocabularies match the CHECK constraints", () => {
  it("lists exactly the four statuses", () => {
    expect([...ERASURE_STATUSES]).toEqual(["received", "in_progress", "completed", "rejected"]);
  });

  it("lists exactly the three sources, INCLUDING shopify_redaction (§15.6)", () => {
    // The column accepts it so the D4 mechanism has somewhere to land. Accepting
    // such a row is not the same as subscribing to the webhook.
    expect([...ERASURE_SOURCES]).toEqual(["portal", "shopify_redaction", "operator"]);
  });

  it("treats only received and in_progress as OPEN", () => {
    expect([...OPEN_ERASURE_STATUSES]).toEqual(["received", "in_progress"]);
    expect(OPEN_ERASURE_STATUSES).not.toContain("completed");
    expect(OPEN_ERASURE_STATUSES).not.toContain("rejected");
  });
});

describe("recordErasureRequest", () => {
  it("creates a request on the first ask", async () => {
    const db = new FakeDb();
    const { request, created } = await recordErasureRequest(db, SCOPE_A);
    expect(created).toBe(true);
    expect(request).toMatchObject({ status: "received", source: "portal" });
    expect(db.rows).toHaveLength(1);
  });

  it("DELETES NOTHING — only a read and an insert", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_A);
    for (const statement of db.statements) {
      expect(statement).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    }
  });

  it("is idempotent while a request is OPEN", async () => {
    const db = new FakeDb();
    const first = await recordErasureRequest(db, SCOPE_A);
    const second = await recordErasureRequest(db, SCOPE_A);
    expect(second.created).toBe(false);
    expect(second.request).toEqual(first.request);
    expect(db.rows).toHaveLength(1);

    (db.rows[0] as Row).status = "in_progress";
    const third = await recordErasureRequest(db, SCOPE_A);
    expect(third.created).toBe(false);
    expect(third.request.id).toBe(first.request.id);
    expect(db.rows).toHaveLength(1);
  });

  it("permits a NEW request after completion or rejection", async () => {
    for (const finished of ["completed", "rejected"] as const) {
      const db = new FakeDb();
      await recordErasureRequest(db, SCOPE_A);
      (db.rows[0] as Row).status = finished;
      const again = await recordErasureRequest(db, SCOPE_A);
      expect(again.created, finished).toBe(true);
      expect(db.rows, finished).toHaveLength(2);
    }
  });

  it("records the source it is given, including shopify_redaction", async () => {
    const db = new FakeDb();
    const { request } = await recordErasureRequest(db, SCOPE_A, "shopify_redaction");
    expect(request.source).toBe("shopify_redaction");
  });

  it("never sees ANOTHER customer's open request (Req 2.1)", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_B);
    const mine = await recordErasureRequest(db, SCOPE_A);
    // A shared window would let one customer's request suppress another's.
    expect(mine.created).toBe(true);
    expect(db.rows.filter((r) => r.customer_id === A)).toHaveLength(1);
    expect(db.rows.filter((r) => r.customer_id === B)).toHaveLength(1);
  });
});

describe("readErasureRequests", () => {
  it("returns nothing for a customer who has never asked", async () => {
    expect(await readErasureRequests(new FakeDb(), SCOPE_A)).toEqual([]);
  });

  it("returns only the caller's requests", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_B);
    await recordErasureRequest(db, SCOPE_A);
    const mine = await readErasureRequests(db, SCOPE_A);
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain(B);
  });

  it("projects timestamps as ISO strings and narrows the status", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_A);
    const [record] = await readErasureRequests(db, SCOPE_A);
    expect(record?.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record?.completedAt).toBeNull();
    expect(ERASURE_STATUSES).toContain(record?.status);
  });

  it("FAILS CLOSED on an unrecognised status or source", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_A);
    (db.rows[0] as Row).status = "something_new";
    (db.rows[0] as Row).source = "unknown_channel";
    const [record] = await readErasureRequests(db, SCOPE_A);
    // Narrowed to the safe defaults rather than surfaced — a client switching on a
    // status it has never seen would render nothing at all.
    expect(record?.status).toBe("received");
    expect(record?.source).toBe("portal");
  });
});

describe("completeErasureRequests (operator side)", () => {
  it("completes every open request for the caller", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_A);
    (db.rows[0] as Row).status = "completed";
    await recordErasureRequest(db, SCOPE_A);
    const n = await completeErasureRequests(db, SCOPE_A);
    expect(n).toBe(1);
    expect(db.rows.every((r) => r.status === "completed")).toBe(true);
  });

  it("is idempotent — a second run completes nothing", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_A);
    expect(await completeErasureRequests(db, SCOPE_A)).toBe(1);
    expect(await completeErasureRequests(db, SCOPE_A)).toBe(0);
  });

  it("touches no OTHER customer's requests", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_B);
    await recordErasureRequest(db, SCOPE_A);
    await completeErasureRequests(db, SCOPE_A);
    expect(db.rows.find((r) => r.customer_id === B)?.status).toBe("received");
  });

  it("never DELETES the request — it is the audit record (§15.5)", async () => {
    const db = new FakeDb();
    await recordErasureRequest(db, SCOPE_A);
    db.statements.length = 0;
    await completeErasureRequests(db, SCOPE_A);
    for (const statement of db.statements) {
      expect(statement).not.toMatch(/\bDELETE\b/i);
    }
    expect(db.rows).toHaveLength(1);
  });
});

describe("the two export-only reads", () => {
  it("reports NO portal visit as null rather than an empty list", async () => {
    expect(await readPortalVisits(new FakeDb(), SCOPE_A)).toBeNull();
  });

  it("returns the two visit instants the table actually holds", async () => {
    const db = new FakeDb();
    db.visits.set(A, {
      first_visited_at: "2026-01-01T00:00:00.000Z",
      last_visited_at: "2026-08-01T00:00:00.000Z",
    });
    // TWO timestamps, not a visit list: the table is keyed per customer and
    // deliberately does not log every visit (§15.2 minimisation).
    expect(await readPortalVisits(db, SCOPE_A)).toEqual({
      firstVisitedAt: "2026-01-01T00:00:00.000Z",
      lastVisitedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("returns only the caller's visits", async () => {
    const db = new FakeDb();
    db.visits.set(B, {
      first_visited_at: "2020-01-01T00:00:00.000Z",
      last_visited_at: "2020-01-01T00:00:00.000Z",
    });
    expect(await readPortalVisits(db, SCOPE_A)).toBeNull();
  });

  it("returns recently-viewed products with timestamps", async () => {
    const db = new FakeDb();
    db.viewed.set(A, [{ shopify_product_id: "1001", viewed_at: "2026-06-01T00:00:00.000Z" }]);
    expect(await readRecentlyViewedForExport(db, SCOPE_A)).toEqual([
      { productId: "1001", viewedAt: "2026-06-01T00:00:00.000Z" },
    ]);
  });

  it("DROPS a row with an unparseable timestamp rather than emitting a bad value", async () => {
    const db = new FakeDb();
    db.viewed.set(A, [
      { shopify_product_id: "1001", viewed_at: "not-a-date" },
      { shopify_product_id: "1002", viewed_at: "2026-06-01T00:00:00.000Z" },
    ]);
    const rows = await readRecentlyViewedForExport(db, SCOPE_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).toBe("1002");
  });

  it("returns only the caller's recently-viewed rows", async () => {
    const db = new FakeDb();
    db.viewed.set(B, [{ shopify_product_id: "9999", viewed_at: "2026-06-01T00:00:00.000Z" }]);
    expect(await readRecentlyViewedForExport(db, SCOPE_A)).toEqual([]);
  });
});
