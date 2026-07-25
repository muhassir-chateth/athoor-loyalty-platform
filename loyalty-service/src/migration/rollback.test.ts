/**
 * Unit + property tests for Migration rollback (task 7.3, Req 14.9).
 *
 * NO live/production Shopify Admin API or live theme is touched and NO live data
 * is modified: the metafield restore runs against a FAKE
 * {@link MetafieldRestoreClient} backed by an IN-MEMORY metafield store, the
 * service stop runs against a FAKE {@link ServiceController}, and the M3 theme
 * artifact is captured by an IN-MEMORY {@link BackupWriter}. The restore client
 * exposes only set/read methods (no delete), so there is no code path that could
 * delete a metafield (Req 14.8).
 *
 * Covers:
 *   - restore writes each customer's EXACT exported metafield values and reaches
 *     the observable post-restore condition metafields == exported (Req 14.9);
 *   - the rollback stops the service first and aborts if it cannot (Req 14.9);
 *   - no metafield is ever deleted during rollback (Req 14.8);
 *   - the rollback is idempotent / safe to re-run;
 *   - verification flags a metafield that was not restored to its exported value;
 *   - the M3 theme CTA revert generates the documented mailto artifact without a
 *     live theme push (Req 14.9);
 *   - property: for ANY backup, after restore every customer's metafields equal
 *     their exported values and nothing was deleted.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { M0Backup, RawMetafield, ExportedCustomer } from "./m0Export.js";
import {
  REDEMPTION_MODE_CONFIG_KEY,
  RETAINED_MAILTO_SNIPPET_FILE,
  THEME_CTA_ROLLBACK_KIND,
  buildThemeCtaRollbackArtifact,
  runMetafieldRollback,
  verifyRestored,
  writeThemeCtaRollbackArtifact,
  type MetafieldRestoreClient,
  type MetafieldRestoreInput,
  type ServiceController,
} from "./rollback.js";
import type { BackupWriter } from "./m0Export.js";

const STORE = "myathoorlondon.myshopify.com";
const FIXED_NOW = () => new Date("2025-02-01T09:30:00.000Z");

/** Builds a full set of loyalty.* metafields for an enrolled customer. */
function enrolledMetafields(balance: number): RawMetafield[] {
  const ns = "loyalty";
  return [
    { namespace: ns, key: "points_balance", type: "number_integer", value: String(balance) },
    { namespace: ns, key: "lifetime_points", type: "number_integer", value: String(balance) },
    { namespace: ns, key: "tier", type: "single_line_text_field", value: "bronze" },
    { namespace: ns, key: "referral_code", type: "single_line_text_field", value: "ATH-REF-01" },
    { namespace: ns, key: "activity_log", type: "json", value: "[]" },
  ];
}

/** One exported customer record. */
function exportedCustomer(index: number, metafields: RawMetafield[]): ExportedCustomer {
  const id = String(1000 + index);
  return {
    id,
    gid: `gid://shopify/Customer/${id}`,
    email: `member${index}@example.com`,
    enrolled: metafields.length > 0,
    lifetimeSpendGBP: index * 10,
    metafields,
    loyalty: {
      pointsBalance: null,
      lifetimePoints: null,
      tier: null,
      pointsExpiryDate: null,
      referralCode: null,
      referralCount: null,
      activityLog: null,
    },
  };
}

/** A small representative backup: 3 enrolled (with metafields) + 2 non-enrolled. */
function sampleBackup(): M0Backup {
  const enrolled = [
    exportedCustomer(1, enrolledMetafields(50)),
    exportedCustomer(2, enrolledMetafields(150)),
    exportedCustomer(3, enrolledMetafields(1050)),
  ];
  const nonEnrolled = [exportedCustomer(4, []), exportedCustomer(5, [])];
  const customers = [...enrolled, ...nonEnrolled];
  return {
    schemaVersion: "1.0",
    kind: "m0-metafield-export",
    exportedAt: "2025-01-15T12:00:00.000Z",
    storeDomain: STORE,
    totalExpected: customers.length,
    enrolledExpected: enrolled.length,
    totalExported: customers.length,
    enrolledExported: enrolled.length,
    customers,
  };
}

/**
 * A fake restore client backed by an in-memory metafield store keyed by
 * customer GID. `restore` upserts by namespace+key (never deletes); `read`
 * returns the current metafields. Optionally seeds a DRIFTED starting state so
 * we can prove the restore overwrites drift back to the exported values.
 */
function fakeRestoreClient(seed: Record<string, RawMetafield[]> = {}): {
  client: MetafieldRestoreClient;
  store: Map<string, RawMetafield[]>;
  restoreCalls: () => number;
  deleteCalls: () => number;
} {
  const store = new Map<string, RawMetafield[]>();
  for (const [gid, mfs] of Object.entries(seed)) {
    store.set(gid, mfs.map((m) => ({ ...m })));
  }
  let restoreCalls = 0;
  const deleteCalls = 0; // there is deliberately no delete path (Req 14.8)

  const client: MetafieldRestoreClient = {
    async restoreCustomerMetafields(input: MetafieldRestoreInput): Promise<void> {
      restoreCalls += 1;
      const current = store.get(input.customerGid) ?? [];
      const byKey = new Map<string, RawMetafield>();
      for (const m of current) byKey.set(`${m.namespace}\u0000${m.key}`, m);
      // Upsert each restored metafield; never delete existing keys (Req 14.8).
      for (const m of input.metafields) {
        byKey.set(`${m.namespace}\u0000${m.key}`, { ...m });
      }
      store.set(input.customerGid, [...byKey.values()]);
    },
    async readCustomerMetafields(customerGid: string): Promise<RawMetafield[]> {
      return (store.get(customerGid) ?? []).map((m) => ({ ...m }));
    },
  };

  return { client, store, restoreCalls: () => restoreCalls, deleteCalls: () => deleteCalls };
}

/** A fake service controller that records stop() and reports stopped afterwards. */
function fakeService(canStop = true): ServiceController & { stopped: () => boolean } {
  let running = true;
  return {
    async isRunning() {
      return running;
    },
    async stop() {
      if (canStop) running = false;
    },
    stopped: () => !running,
  };
}

/** An in-memory backup writer capturing generated artifacts. */
function memoryWriter(): {
  writer: BackupWriter;
  writes: Array<{ filename: string; contents: string }>;
} {
  const writes: Array<{ filename: string; contents: string }> = [];
  return {
    writer: {
      async write(filename: string, contents: string): Promise<string> {
        writes.push({ filename, contents });
        return `memory://${filename}`;
      },
    },
    writes,
  };
}

/** Sorts metafields deterministically for equality comparison regardless of order. */
function sortMf(mfs: RawMetafield[]): RawMetafield[] {
  return [...mfs].sort((a, b) => `${a.namespace}.${a.key}`.localeCompare(`${b.namespace}.${b.key}`));
}

describe("runMetafieldRollback — restores exported values (Req 14.9)", () => {
  it("restores each customer's exact exported metafields onto an empty store", async () => {
    const backup = sampleBackup();
    const { client, store } = fakeRestoreClient();
    const service = fakeService();

    const result = await runMetafieldRollback({ backup, client, service });

    expect(result.status).toBe("rolled_back");
    if (result.status !== "rolled_back") return;
    expect(result.serviceStopped).toBe(true);
    expect(result.customersRestored).toBe(backup.customers.length);
    expect(result.mismatches).toEqual([]);
    expect(result.details.every((d) => d.verified)).toBe(true);

    // The store now equals the exported values for every customer.
    for (const c of backup.customers) {
      expect(sortMf(store.get(c.gid) ?? [])).toEqual(sortMf(c.metafields));
    }
  });

  it("overwrites drifted metafield values back to their exported values", async () => {
    const backup = sampleBackup();
    // Seed a drifted state: the first enrolled customer's balance was changed
    // by the migration to 999; rollback must restore it to the exported 50.
    const drifted = backup.customers[0]!;
    const driftedMfs = drifted.metafields.map((m) =>
      m.key === "points_balance" ? { ...m, value: "999" } : { ...m },
    );
    const { client, store } = fakeRestoreClient({ [drifted.gid]: driftedMfs });
    const service = fakeService();

    const result = await runMetafieldRollback({ backup, client, service });

    expect(result.status).toBe("rolled_back");
    const restored = store.get(drifted.gid)!;
    const balance = restored.find((m) => m.key === "points_balance")!;
    expect(balance.value).toBe("50"); // exported value, not the drifted 999
  });

  it("reaches the observable post-restore condition metafields == exported", async () => {
    const backup = sampleBackup();
    const { client } = fakeRestoreClient();

    await runMetafieldRollback({ backup, client, service: fakeService() });

    // Read back through the same boundary the storefront would observe.
    for (const c of backup.customers) {
      const observed = await client.readCustomerMetafields(c.gid);
      expect(sortMf(observed)).toEqual(sortMf(c.metafields));
    }
  });
});

describe("runMetafieldRollback — service stop guard (Req 14.9)", () => {
  it("stops the service before restoring", async () => {
    const backup = sampleBackup();
    const { client } = fakeRestoreClient();
    const service = fakeService(true);

    const result = await runMetafieldRollback({ backup, client, service });

    expect(service.stopped()).toBe(true);
    expect(result.status).toBe("rolled_back");
  });

  it("aborts without touching any metafield when the service will not stop", async () => {
    const backup = sampleBackup();
    const { client, store } = fakeRestoreClient();
    const service = fakeService(false); // stop() is a no-op; still running

    const result = await runMetafieldRollback({ backup, client, service });

    expect(result.status).toBe("aborted_service_running");
    // Nothing was restored.
    expect(store.size).toBe(0);
  });

  it("still restores when no controller is injected (caller asserts stopped)", async () => {
    const backup = sampleBackup();
    const { client } = fakeRestoreClient();

    const result = await runMetafieldRollback({ backup, client });

    expect(result.status).toBe("rolled_back");
    if (result.status !== "rolled_back") return;
    expect(result.serviceStopped).toBe(false);
  });
});

describe("runMetafieldRollback — never deletes, idempotent (Req 14.8 / 14.9)", () => {
  it("never deletes a metafield during rollback", async () => {
    const backup = sampleBackup();
    const { client, deleteCalls } = fakeRestoreClient();

    await runMetafieldRollback({ backup, client, service: fakeService() });

    // The client has no delete surface, and none was invoked.
    expect(deleteCalls()).toBe(0);
    expect(Object.keys(client).sort()).toEqual(
      ["readCustomerMetafields", "restoreCustomerMetafields"].sort(),
    );
  });

  it("preserves extra (non-exported) metafields rather than deleting them", async () => {
    const backup = sampleBackup();
    const target = backup.customers[0]!;
    const extra: RawMetafield = {
      namespace: "loyalty",
      key: "legacy_note",
      type: "single_line_text_field",
      value: "keep me",
    };
    const { client, store } = fakeRestoreClient({ [target.gid]: [extra] });

    await runMetafieldRollback({ backup, client, service: fakeService() });

    // The extra key survives (not deleted) and the exported keys are restored.
    const restored = store.get(target.gid)!;
    expect(restored.find((m) => m.key === "legacy_note")).toEqual(extra);
    for (const want of target.metafields) {
      expect(restored.find((m) => m.key === want.key)?.value).toBe(want.value);
    }
  });

  it("is idempotent — re-running reaches the same verified end state", async () => {
    const backup = sampleBackup();
    const { client, store } = fakeRestoreClient();
    const service = fakeService();

    const first = await runMetafieldRollback({ backup, client, service });
    const snapshotAfterFirst = new Map([...store.entries()].map(([k, v]) => [k, sortMf(v)]));

    const second = await runMetafieldRollback({ backup, client, service });

    expect(first.status).toBe("rolled_back");
    expect(second.status).toBe("rolled_back");
    // End state is identical after the second run.
    for (const c of backup.customers) {
      expect(sortMf(store.get(c.gid) ?? [])).toEqual(snapshotAfterFirst.get(c.gid));
    }
  });

  it("does not mutate the authoritative backup while restoring", async () => {
    const backup = sampleBackup();
    const snapshot = JSON.stringify(backup);
    const { client } = fakeRestoreClient();

    await runMetafieldRollback({ backup, client, service: fakeService() });

    expect(JSON.stringify(backup)).toBe(snapshot);
  });
});

describe("verifyRestored — flags values not restored to export", () => {
  it("reports a mismatch when a metafield value differs from the exported value", () => {
    const exported = enrolledMetafields(50);
    const actual = exported.map((m) =>
      m.key === "tier" ? { ...m, value: "gold" } : { ...m },
    );
    const mismatches = verifyRestored(exported, actual);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ key: "tier", expected: "bronze", actual: "gold" });
  });

  it("reports a mismatch when an exported metafield is missing from the store", () => {
    const exported = enrolledMetafields(50);
    const actual = exported.filter((m) => m.key !== "referral_code");
    const mismatches = verifyRestored(exported, actual);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ key: "referral_code", actual: null });
  });

  it("surfaces verification_failed when the client fails to persist a value", async () => {
    const backup = sampleBackup();
    // A faulty client that silently drops the 'tier' metafield on restore.
    const store = new Map<string, RawMetafield[]>();
    const client: MetafieldRestoreClient = {
      async restoreCustomerMetafields(input) {
        store.set(
          input.customerGid,
          input.metafields.filter((m) => m.key !== "tier").map((m) => ({ ...m })),
        );
      },
      async readCustomerMetafields(gid) {
        return (store.get(gid) ?? []).map((m) => ({ ...m }));
      },
    };

    const result = await runMetafieldRollback({ backup, client, service: fakeService() });

    expect(result.status).toBe("verification_failed");
    if (result.status !== "verification_failed") return;
    // Every enrolled customer (which has a 'tier') reports the dropped key.
    expect(result.mismatches.every((m) => m.key === "tier")).toBe(true);
    expect(result.mismatches.length).toBe(backup.customers.filter((c) => c.enrolled).length);
  });
});

describe("M3 theme CTA revert artifact (Req 14.9)", () => {
  it("builds a documented mailto revert artifact (no live theme push)", () => {
    const artifact = buildThemeCtaRollbackArtifact(FIXED_NOW);
    expect(artifact.kind).toBe(THEME_CTA_ROLLBACK_KIND);
    expect(artifact.redemptionMode).toBe("mailto");
    expect(artifact.configFlag.key).toBe(REDEMPTION_MODE_CONFIG_KEY);
    expect(artifact.configFlag.value).toBe("mailto");
    expect(artifact.retainedSnippet.file).toBe(RETAINED_MAILTO_SNIPPET_FILE);
    expect(artifact.steps.length).toBeGreaterThan(0);
    // Points at the retained snippet file kept in version control (task 6.7).
    expect(artifact.retainedSnippet.file).toContain("loyalty-dashboard.liquid");
  });

  it("persists the artifact via the injected writer without touching the theme", async () => {
    const { writer, writes } = memoryWriter();

    const { artifact, location } = await writeThemeCtaRollbackArtifact(writer, FIXED_NOW);

    expect(writes).toHaveLength(1);
    expect(location).toContain(THEME_CTA_ROLLBACK_KIND);
    expect(writes[0]!.filename).toBe("m3-theme-cta-rollback-2025-02-01T09-30-00-000Z.json");
    // The written file is valid JSON equal to the returned artifact.
    expect(JSON.parse(writes[0]!.contents)).toEqual(artifact);
  });
});

describe("runMetafieldRollback — property: restore equals export (Req 14.9)", () => {
  it("for ANY backup, after restore every customer's metafields equal their exported values", async () => {
    const rawMetafieldArb: fc.Arbitrary<RawMetafield> = fc.record({
      namespace: fc.constant("loyalty"),
      key: fc.constantFrom(
        "points_balance",
        "lifetime_points",
        "tier",
        "referral_code",
        "referral_count",
        "activity_log",
      ),
      type: fc.constantFrom("number_integer", "single_line_text_field", "json"),
      value: fc.option(fc.string(), { nil: null }),
    });

    const customerArb = (index: number): fc.Arbitrary<ExportedCustomer> =>
      fc
        // Dedupe metafields by key so each (namespace,key) is unique per customer.
        .uniqueArray(rawMetafieldArb, { maxLength: 6, selector: (m) => m.key })
        .map((metafields) => exportedCustomer(index, metafields));

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }).chain((indices) =>
          fc.tuple(...indices.map((_v, i) => customerArb(i))),
        ),
        // Randomly decide whether a service controller is present.
        fc.boolean(),
        async (customers, withService) => {
          const backup: M0Backup = {
            schemaVersion: "1.0",
            kind: "m0-metafield-export",
            exportedAt: "2025-01-15T12:00:00.000Z",
            storeDomain: STORE,
            totalExpected: customers.length,
            enrolledExpected: customers.filter((c) => c.enrolled).length,
            totalExported: customers.length,
            enrolledExported: customers.filter((c) => c.enrolled).length,
            customers,
          };
          const { client, store } = fakeRestoreClient();
          const service = withService ? fakeService() : undefined;

          const result = await runMetafieldRollback({ backup, client, service });
          expect(result.status).toBe("rolled_back");
          // Post-restore: every customer's metafields equal their exported values.
          for (const c of backup.customers) {
            expect(sortMf(store.get(c.gid) ?? [])).toEqual(sortMf(c.metafields));
          }
        },
      ),
    );
  });
});
