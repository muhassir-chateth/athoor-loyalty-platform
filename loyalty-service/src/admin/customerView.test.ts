/**
 * Unit tests for the admin customer ledger/history view (task 17.2, Req 10.5).
 */
import { describe, expect, it } from "vitest";
import {
  buildAdminCustomerLedgerView,
  deriveActingParty,
  mapAdminLedgerEntry,
  InMemoryAdminCustomerLedgerSource,
  type AdminRawLedgerEntry,
} from "./customerView.js";

function entry(overrides: Partial<AdminRawLedgerEntry> & Pick<AdminRawLedgerEntry, "id" | "createdAt">): AdminRawLedgerEntry {
  return {
    entryType: "earn_order",
    points: 10,
    reason: "order",
    orderReference: null,
    sourceEventId: null,
    ...overrides,
  };
}

describe("deriveActingParty (Req 10.5)", () => {
  it("maps an admin: tag to that admin user", () => {
    expect(deriveActingParty("admin:ops-alice")).toEqual({ kind: "admin", id: "ops-alice" });
  });

  it("maps a webhook id to the system", () => {
    expect(deriveActingParty("whid-123")).toEqual({ kind: "system", id: "system" });
  });

  it("maps null to the system", () => {
    expect(deriveActingParty(null)).toEqual({ kind: "system", id: "system" });
  });

  it("treats an empty admin id as the system (defensive)", () => {
    expect(deriveActingParty("admin:")).toEqual({ kind: "system", id: "system" });
  });
});

describe("mapAdminLedgerEntry (Req 10.5)", () => {
  it("surfaces the raw entry type, amount, reason, acting party, and ISO timestamp", () => {
    const created = new Date("2024-01-02T03:04:05.000Z");
    const view = mapAdminLedgerEntry(
      entry({
        id: "e1",
        entryType: "adjust",
        points: -20,
        reason: "goodwill reversal",
        sourceEventId: "admin:ops-bob",
        createdAt: created,
      }),
    );
    expect(view).toEqual({
      id: "e1",
      type: "adjust",
      points: -20,
      reason: "goodwill reversal",
      actingParty: { kind: "admin", id: "ops-bob" },
      timestamp: "2024-01-02T03:04:05.000Z",
      orderReference: null,
    });
  });
});

describe("buildAdminCustomerLedgerView (Req 10.5)", () => {
  it("orders entries most-recent-first and reports the complete count", () => {
    const raw = [
      entry({ id: "a", createdAt: new Date("2024-01-01T00:00:00.000Z") }),
      entry({ id: "c", createdAt: new Date("2024-03-01T00:00:00.000Z") }),
      entry({ id: "b", createdAt: new Date("2024-02-01T00:00:00.000Z") }),
    ];
    const view = buildAdminCustomerLedgerView("cust-1", raw);
    expect(view.customerId).toBe("cust-1");
    expect(view.totalCount).toBe(3);
    expect(view.entries.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("tie-breaks entries sharing a timestamp by descending id", () => {
    const when = new Date("2024-01-01T00:00:00.000Z");
    const view = buildAdminCustomerLedgerView("cust-1", [
      entry({ id: "id-1", createdAt: when }),
      entry({ id: "id-2", createdAt: when }),
    ]);
    expect(view.entries.map((e) => e.id)).toEqual(["id-2", "id-1"]);
  });

  it("returns an empty ledger for a customer with no entries", () => {
    const view = buildAdminCustomerLedgerView("cust-x", []);
    expect(view).toEqual({ customerId: "cust-x", entries: [], totalCount: 0 });
  });
});

describe("InMemoryAdminCustomerLedgerSource", () => {
  it("returns the seeded entries and an empty list for an unknown customer", async () => {
    const source = new InMemoryAdminCustomerLedgerSource();
    source.set("cust-1", [entry({ id: "e1", createdAt: new Date() })]);
    expect(await source.loadLedger("cust-1")).toHaveLength(1);
    expect(await source.loadLedger("nope")).toEqual([]);
  });
});
