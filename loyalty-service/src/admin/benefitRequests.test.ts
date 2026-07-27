/**
 * Benefit-request fulfilment workflow (task 41) — Req 18.5, 10.5, 10.9.
 *
 * Covers the lifecycle rules, idempotence, the atomicity of the audit record,
 * and the concurrency loser's behaviour. The transition rules are asserted
 * exhaustively over every (from, to) pair rather than by example, so a future
 * edit to `ALLOWED_FROM` cannot quietly widen what a terminal request permits.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_FROM,
  BENEFIT_REQUEST_STATUSES,
  BENEFIT_REQUEST_TRANSITIONS,
  BenefitRequestInvalidTransitionError,
  BenefitRequestNotFoundError,
  BenefitRequestService,
  buildBenefitRequestView,
  canTransition,
  InMemoryBenefitRequestStore,
  isTerminal,
  PgBenefitRequestStore,
  TERMINAL_STATUSES,
  type AdminBenefitRequest,
  type BenefitRequestStatus,
  type BenefitRequestStore,
  type BenefitRequestTransition,
} from "./benefitRequests.js";
import { InMemoryAuditTrailRecorder } from "./auditTrail.js";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

const REQUEST_ID = "req-1";
const CUSTOMER_ID = "cust-1";

function request(over: Partial<AdminBenefitRequest> = {}): AdminBenefitRequest {
  return {
    id: REQUEST_ID,
    status: "requested",
    customerId: CUSTOMER_ID,
    benefitKey: "private_consultation",
    benefitName: "Private Consultation Booking",
    requestedAt: "2026-07-01T00:00:00.000Z",
    statusChangedAt: null,
    ...over,
  };
}

function service(
  seed: AdminBenefitRequest[] = [request()],
  overrides: { store?: BenefitRequestStore } = {},
) {
  const store = overrides.store ?? new InMemoryBenefitRequestStore(seed);
  const audit = new InMemoryAuditTrailRecorder();
  const calls: string[] = [];
  const svc = new BenefitRequestService({
    store,
    audit,
    transactor: async (work) => {
      calls.push("begin");
      const result = await work({} as Queryable);
      calls.push("commit");
      return result;
    },
  });
  return { svc, store, audit, calls };
}

describe("the lifecycle rules (pure)", () => {
  it("treats fulfilled, declined and cancelled as terminal and nothing else", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["cancelled", "declined", "fulfilled"]);
    for (const status of BENEFIT_REQUEST_STATUSES) {
      expect(isTerminal(status)).toBe(TERMINAL_STATUSES.includes(status));
    }
  });

  it("permits no transition OUT of a terminal status, for every pair", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of BENEFIT_REQUEST_TRANSITIONS) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("permits exactly the documented moves from requested and confirmed", () => {
    const table: Record<string, BenefitRequestTransition[]> = {
      requested: ["confirmed", "fulfilled", "declined", "cancelled"],
      confirmed: ["fulfilled", "declined", "cancelled"],
    };
    for (const [from, allowed] of Object.entries(table)) {
      for (const to of BENEFIT_REQUEST_TRANSITIONS) {
        expect(canTransition(from as BenefitRequestStatus, to)).toBe(allowed.includes(to));
      }
    }
    // `confirmed` cannot be re-entered from itself; that is the no-op path.
    expect(canTransition("confirmed", "confirmed")).toBe(false);
  });

  it("keeps ALLOWED_FROM free of terminal statuses (the invariant behind the above)", () => {
    for (const to of BENEFIT_REQUEST_TRANSITIONS) {
      for (const from of ALLOWED_FROM[to]) {
        expect(isTerminal(from)).toBe(false);
      }
    }
  });
});

describe("buildBenefitRequestView (Req 10.5)", () => {
  it("puts open requests oldest-first and closed ones most-recent-first", () => {
    const view = buildBenefitRequestView([
      request({ id: "b", status: "requested", requestedAt: "2026-07-02T00:00:00.000Z" }),
      request({ id: "a", status: "confirmed", requestedAt: "2026-07-01T00:00:00.000Z" }),
      request({ id: "c", status: "fulfilled", requestedAt: "2026-06-01T00:00:00.000Z" }),
      request({ id: "d", status: "declined", requestedAt: "2026-06-02T00:00:00.000Z" }),
    ]);

    // The thing waiting longest is the thing to action next.
    expect(view.open.map((r) => r.id)).toEqual(["a", "b"]);
    expect(view.closed.map((r) => r.id)).toEqual(["d", "c"]);
  });

  it("returns empty lists for no requests, not an error", () => {
    expect(buildBenefitRequestView([])).toEqual({ open: [], closed: [] });
  });
});

describe("BenefitRequestService.transition", () => {
  it("advances requested → fulfilled and records exactly one audit record", async () => {
    const { svc, audit } = service();

    const result = await svc.transition(REQUEST_ID, "fulfilled", "admin-1", "delivered in store");

    expect(result.changed).toBe(true);
    expect(result.request.status).toBe("fulfilled");
    expect(result.request.statusChangedAt).not.toBeNull();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      adminUserId: "admin-1",
      operationType: "benefit_request",
      affectedCustomerId: CUSTOMER_ID,
    });
    expect(audit.records[0]!.detail).toMatchObject({
      benefitRequestId: REQUEST_ID,
      benefitKey: "private_consultation",
      fromStatus: "requested",
      toStatus: "fulfilled",
      reason: "delivered in store",
    });
  });

  it("writes the audit record INSIDE the same transaction as the status change", async () => {
    const { svc, calls } = service();
    await svc.transition(REQUEST_ID, "confirmed", "admin-1");
    // One begin/commit pair wrapping the whole thing: a transition cannot be
    // recorded without its audit row, or vice versa.
    expect(calls).toEqual(["begin", "commit"]);
  });

  it("supports the two-step path requested → confirmed → fulfilled", async () => {
    const { svc, audit } = service();

    await svc.transition(REQUEST_ID, "confirmed", "admin-1");
    const final = await svc.transition(REQUEST_ID, "fulfilled", "admin-2");

    expect(final.request.status).toBe("fulfilled");
    expect(audit.records.map((r) => r.detail.toStatus)).toEqual(["confirmed", "fulfilled"]);
  });

  it.each(BENEFIT_REQUEST_TRANSITIONS)("is IDEMPOTENT when already %s", async (status) => {
    const { svc, audit } = service([request({ status })]);

    const result = await svc.transition(REQUEST_ID, status, "admin-1");

    // Success, nothing changed, and NO audit record — because nothing happened.
    expect(result.changed).toBe(false);
    expect(result.request.status).toBe(status);
    expect(audit.records).toEqual([]);
  });

  it.each([
    ["fulfilled", "declined"],
    ["fulfilled", "cancelled"],
    ["declined", "fulfilled"],
    ["cancelled", "fulfilled"],
    ["cancelled", "confirmed"],
  ] as const)("refuses %s → %s and writes nothing", async (from, to) => {
    const { svc, audit, store } = service([request({ status: from })]);

    await expect(svc.transition(REQUEST_ID, to, "admin-1")).rejects.toBeInstanceOf(
      BenefitRequestInvalidTransitionError,
    );
    expect(audit.records).toEqual([]);
    expect((await store.find(REQUEST_ID))!.status).toBe(from);
  });

  it("carries from/to on the refusal so the operator sees why", async () => {
    const { svc } = service([request({ status: "fulfilled" })]);

    await expect(svc.transition(REQUEST_ID, "declined", "admin-1")).rejects.toMatchObject({
      code: "benefit_request_invalid_transition",
      from: "fulfilled",
      to: "declined",
    });
  });

  it("404s an unknown request id without writing anything", async () => {
    const { svc, audit } = service();

    await expect(svc.transition("no-such-request", "fulfilled", "admin-1")).rejects.toBeInstanceOf(
      BenefitRequestNotFoundError,
    );
    expect(audit.records).toEqual([]);
  });

  it("omits `reason` from the audit detail when none is supplied", async () => {
    const { svc, audit } = service();
    await svc.transition(REQUEST_ID, "declined", "admin-1");
    expect("reason" in audit.records[0]!.detail).toBe(false);
  });

  it("attributes to the SYSTEM actor when no admin id is present", async () => {
    const { svc, audit } = service();
    await svc.transition(REQUEST_ID, "cancelled", "");
    expect(audit.records[0]!.adminUserId).toBe("system");
  });
});

describe("concurrency: the guarded write is the gate, not the pre-read", () => {
  it("reports idempotent success when a concurrent operator applied the SAME transition", async () => {
    const inner = new InMemoryBenefitRequestStore([request()]);
    let firstWrite = true;
    const racing: BenefitRequestStore = {
      list: () => inner.list(),
      find: (id) => inner.find(id),
      applyTransition: async (id, to, allowed, tx) => {
        if (firstWrite) {
          firstWrite = false;
          // Someone else got there first with the same target status.
          await inner.applyTransition(id, to, allowed, tx);
          return false;
        }
        return inner.applyTransition(id, to, allowed, tx);
      },
    };
    const { svc, audit } = service([], { store: racing });

    const result = await svc.transition(REQUEST_ID, "fulfilled", "admin-1");

    expect(result.changed).toBe(false);
    expect(result.request.status).toBe("fulfilled");
    // The loser writes no audit record: it changed nothing.
    expect(audit.records).toEqual([]);
  });

  it("refuses when a concurrent operator moved the request somewhere ELSE", async () => {
    const inner = new InMemoryBenefitRequestStore([request()]);
    const racing: BenefitRequestStore = {
      list: () => inner.list(),
      find: (id) => inner.find(id),
      applyTransition: async (id, _to, _allowed, tx) => {
        // A different operator declined it while we were trying to fulfil it.
        await inner.applyTransition(id, "declined", ["requested"], tx);
        return false;
      },
    };
    const { svc, audit } = service([], { store: racing });

    await expect(svc.transition(REQUEST_ID, "fulfilled", "admin-1")).rejects.toMatchObject({
      code: "benefit_request_invalid_transition",
      from: "declined",
    });
    expect(audit.records).toEqual([]);
  });
});

describe("PgBenefitRequestStore", () => {
  it("guards the UPDATE on the allowed source statuses", async () => {
    const captured: Array<{ text: string; values: unknown[] }> = [];
    const db: Queryable = {
      query: async <R extends QueryResultRow>(text: string, values: unknown[] = []) => {
        captured.push({ text, values });
        const rows = text.includes("UPDATE") ? [{ id: REQUEST_ID }] : [];
        return { rows: rows as R[], rowCount: rows.length, command: "UPDATE", oid: 0, fields: [] } as QueryResult<R>;
      },
    };

    const changed = await new PgBenefitRequestStore(db).applyTransition(
      REQUEST_ID,
      "fulfilled",
      ["requested", "confirmed"],
      db,
    );

    expect(changed).toBe(true);
    const update = captured.find((c) => c.text.includes("UPDATE"))!;
    expect(update.text).toMatch(/status = ANY\(\$3\)/);
    expect(update.values).toEqual([REQUEST_ID, "fulfilled", ["requested", "confirmed"]]);
    // It stamps the change time and touches nothing else.
    expect(update.text).toMatch(/status_changed_at = now\(\)/);
    expect(update.text).not.toMatch(/ledger_entries|point_lots/);
  });

  it("reports no change when the guard matches nothing", async () => {
    const db: Queryable = {
      query: async <R extends QueryResultRow>() =>
        ({ rows: [] as R[], rowCount: 0, command: "UPDATE", oid: 0, fields: [] }) as QueryResult<R>,
    };
    await expect(
      new PgBenefitRequestStore(db).applyTransition(REQUEST_ID, "fulfilled", ["requested"], db),
    ).resolves.toBe(false);
  });

  it("joins the benefit so the queue is readable without a second lookup", async () => {
    const db: Queryable = {
      query: async <R extends QueryResultRow>(text: string) => {
        expect(text).toMatch(/JOIN benefits/);
        const rows = [
          {
            id: REQUEST_ID,
            status: "requested",
            customer_id: CUSTOMER_ID,
            requested_at: new Date("2026-07-01T00:00:00Z"),
            status_changed_at: null,
            benefit_key: "private_consultation",
            benefit_name: "Private Consultation Booking",
          },
        ];
        return { rows: rows as R[], rowCount: 1, command: "SELECT", oid: 0, fields: [] } as QueryResult<R>;
      },
    };

    const [row] = await new PgBenefitRequestStore(db).list();

    expect(row).toEqual({
      id: REQUEST_ID,
      status: "requested",
      customerId: CUSTOMER_ID,
      benefitKey: "private_consultation",
      benefitName: "Private Consultation Booking",
      requestedAt: "2026-07-01T00:00:00.000Z",
      statusChangedAt: null,
    });
  });
});

describe("the audit trail accepts the new operation type", () => {
  it("records a benefit_request operation without rejecting it", async () => {
    const audit = new InMemoryAuditTrailRecorder();
    const record = await audit.record({
      adminUserId: "admin-1",
      operationType: "benefit_request",
      affectedCustomerId: CUSTOMER_ID,
      detail: { toStatus: "fulfilled" },
    });
    expect(record.operationType).toBe("benefit_request");
  });

  it("still rejects an unknown operation type", async () => {
    const audit = new InMemoryAuditTrailRecorder();
    await expect(
      audit.record({
        adminUserId: "admin-1",
        // deliberately invalid
        operationType: "not_a_type" as never,
      }),
    ).rejects.toThrow(/Unknown audit operation type/);
  });
});

describe("no-op transitions never reach the database", () => {
  it("does not open a transaction when the status already matches", async () => {
    const transactor = vi.fn();
    const svc = new BenefitRequestService({
      store: new InMemoryBenefitRequestStore([request({ status: "fulfilled" })]),
      audit: new InMemoryAuditTrailRecorder(),
      transactor: transactor as never,
    });

    const result = await svc.transition(REQUEST_ID, "fulfilled", "admin-1");

    expect(result.changed).toBe(false);
    expect(transactor).not.toHaveBeenCalled();
  });
});

/**
 * REGRESSION (found on staging, not by these unit tests): the post-transition
 * read must go through the TRANSACTION, not the pool. On the pool it takes a
 * different connection, cannot see the uncommitted UPDATE, and returns the
 * PRE-change row — so the operator is shown the status they just moved away from.
 * The in-memory store has no isolation, which is precisely why no unit test could
 * have caught it; these tests assert the executor is threaded so it cannot regress.
 */
describe("the response reflects the POST-transition state (staging regression)", () => {
  it("reads the updated row through the transaction executor", async () => {
    const seenExecutors: Array<Queryable | undefined> = [];
    const inner = new InMemoryBenefitRequestStore([request()]);
    const store: BenefitRequestStore = {
      list: () => inner.list(),
      find: (id, executor) => {
        seenExecutors.push(executor);
        return inner.find(id);
      },
      applyTransition: (id, to, allowed, tx) => inner.applyTransition(id, to, allowed, tx),
    };
    const tx = { query: async () => ({}) } as unknown as Queryable;
    const svc = new BenefitRequestService({
      store,
      audit: new InMemoryAuditTrailRecorder(),
      transactor: async (work) => work(tx),
    });

    const result = await svc.transition(REQUEST_ID, "fulfilled", "admin-1");

    expect(result.request.status).toBe("fulfilled");
    // The pre-read is outside the transaction (no executor); the post-read is
    // inside it and MUST carry the transaction.
    expect(seenExecutors[0]).toBeUndefined();
    expect(seenExecutors[seenExecutors.length - 1]).toBe(tx);
  });

  it("re-reads a lost race through the transaction too", async () => {
    const seenExecutors: Array<Queryable | undefined> = [];
    const inner = new InMemoryBenefitRequestStore([request()]);
    const store: BenefitRequestStore = {
      list: () => inner.list(),
      find: (id, executor) => {
        seenExecutors.push(executor);
        return inner.find(id);
      },
      applyTransition: async () => false, // always lose
    };
    const tx = { query: async () => ({}) } as unknown as Queryable;
    const svc = new BenefitRequestService({
      store,
      audit: new InMemoryAuditTrailRecorder(),
      transactor: async (work) => work(tx),
    });

    await expect(svc.transition(REQUEST_ID, "fulfilled", "admin-1")).rejects.toBeInstanceOf(
      BenefitRequestInvalidTransitionError,
    );
    expect(seenExecutors[seenExecutors.length - 1]).toBe(tx);
  });

  it("PgBenefitRequestStore.find uses the executor it is given", async () => {
    const calls: string[] = [];
    const makeDb = (label: string): Queryable => ({
      query: async <R extends QueryResultRow>() => {
        calls.push(label);
        return { rows: [] as R[], rowCount: 0, command: "SELECT", oid: 0, fields: [] } as QueryResult<R>;
      },
    });
    const pool = makeDb("pool");
    const tx = makeDb("tx");
    const store = new PgBenefitRequestStore(pool);

    await store.find(REQUEST_ID);
    await store.find(REQUEST_ID, tx);

    expect(calls).toEqual(["pool", "tx"]);
  });
});
