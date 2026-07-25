import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  PgWebhookEventStore,
  WEBHOOK_EVENT_RETENTION_DAYS,
  retentionCutoff,
  type Queryable,
} from "./eventStore.js";

/**
 * Unit tests for the Pg-backed dedupe store using a fake Queryable, so the
 * ON CONFLICT semantics are verified without a live Postgres (Req 12.2, 12.4).
 */

interface Call {
  text: string;
  values?: unknown[];
}

/**
 * A fake Postgres that simulates `INSERT ... ON CONFLICT (shopify_webhook_id)
 * DO NOTHING RETURNING id`: the first insert of an id returns a row
 * (rowCount 1); a repeat returns none (rowCount 0). DELETE returns a count.
 */
class FakeQueryable implements Queryable {
  readonly calls: Call[] = [];
  private readonly ids = new Set<string>();
  deletedCount = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });

    if (/INSERT INTO webhook_events/.test(text)) {
      const id = String(values?.[0]);
      const isNew = !this.ids.has(id);
      if (isNew) this.ids.add(id);
      return {
        command: "INSERT",
        rowCount: isNew ? 1 : 0,
        oid: 0,
        fields: [],
        rows: isNew ? ([{ id: "row-uuid" }] as unknown as R[]) : [],
      };
    }

    if (/DELETE FROM webhook_events/.test(text)) {
      const removed = this.deletedCount;
      return { command: "DELETE", rowCount: removed, oid: 0, fields: [], rows: [] };
    }

    return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
  }
}

describe("PgWebhookEventStore.recordIfNew (Req 12.2, 12.4)", () => {
  it("returns true for a first-seen id and false for a duplicate", async () => {
    const db = new FakeQueryable();
    const store = new PgWebhookEventStore(db);

    const rec = { shopifyWebhookId: "evt-1", topic: "orders/paid", payloadHash: "abc" };
    expect(await store.recordIfNew(rec)).toBe(true);
    expect(await store.recordIfNew(rec)).toBe(false);
  });

  it("uses ON CONFLICT DO NOTHING so the UNIQUE constraint arbitrates atomically", async () => {
    const db = new FakeQueryable();
    const store = new PgWebhookEventStore(db);
    await store.recordIfNew({ shopifyWebhookId: "evt-2", topic: "orders/paid", payloadHash: "h" });

    const insert = db.calls.find((c) => /INSERT INTO webhook_events/.test(c.text));
    expect(insert?.text).toMatch(/ON CONFLICT \(shopify_webhook_id\) DO NOTHING/);
    expect(insert?.values).toEqual(["evt-2", "orders/paid", "h"]);
  });
});

describe("retention policy (Req 12.1)", () => {
  it("retains at least 30 days", () => {
    expect(WEBHOOK_EVENT_RETENTION_DAYS).toBeGreaterThanOrEqual(30);
  });

  it("computes a cutoff exactly 30 days before the reference time", () => {
    const asOf = new Date("2025-06-30T00:00:00.000Z");
    const cutoff = retentionCutoff(asOf);
    const expected = new Date("2025-05-31T00:00:00.000Z");
    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });

  it("prunes only rows before the cutoff", async () => {
    const db = new FakeQueryable();
    db.deletedCount = 3;
    const store = new PgWebhookEventStore(db);
    const removed = await store.deleteReceivedBefore(retentionCutoff(new Date("2025-06-30T00:00:00Z")));
    expect(removed).toBe(3);
    const del = db.calls.find((c) => /DELETE FROM webhook_events/.test(c.text));
    expect(del?.text).toMatch(/received_at < \$1/);
  });
});
