/**
 * The customer data export — tasks 15.1/15.4, §15.4/§15.9,
 * Req 23.3, 23.4, 2.4, 2.6.
 *
 * Includes the property-style isolation assertion task 15.4 asks for: an export
 * built for A contains no attribute of B.
 *
 * SAFETY: pure assembly over fake readers. No network, no database, no production.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CustomerScope } from "../auth/customerScope.js";
import {
  buildCustomerDataExport,
  EXPORT_FORMAT_VERSION,
  EXPORT_SECTIONS,
  exportFilename,
  type ExportReaders,
} from "./export.js";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCOPE_A = { customerId: A } as unknown as CustomerScope;
const SCOPE_B = { customerId: B } as unknown as CustomerScope;
const CLOCK = { now: () => new Date("2026-08-27T12:34:56.000Z") };

/** Readers that answer with a per-customer store, so isolation is observable. */
function readersOver(store: Readonly<Record<string, Record<string, unknown>>>): ExportReaders {
  const read = (section: string) => async (scope: CustomerScope) =>
    store[scope.customerId]?.[section] ?? null;
  return Object.fromEntries(EXPORT_SECTIONS.map((s) => [s, read(s)])) as ExportReaders;
}

/** Readers where every section throws. */
const FAILING: ExportReaders = Object.fromEntries(
  EXPORT_SECTIONS.map((s) => [
    s,
    async () => {
      throw new Error(`UPSTREAM-SECRET-${s}`);
    },
  ]),
) as ExportReaders;

describe("the document's shape", () => {
  it("emits every section, in a FIXED order, whatever order the readers resolve in", async () => {
    // Deliberately staggered resolution: if key order followed timing, this would
    // vary between runs.
    const readers = Object.fromEntries(
      EXPORT_SECTIONS.map((s, i) => [
        s,
        async () => {
          await new Promise((r) => setTimeout(r, (EXPORT_SECTIONS.length - i) % 5));
          return { section: s };
        },
      ]),
    ) as ExportReaders;
    const doc = await buildCustomerDataExport(readers, SCOPE_A, CLOCK);
    expect(Object.keys(doc.data)).toEqual([...EXPORT_SECTIONS]);
  });

  it("carries the format version and the clock's instant", async () => {
    const doc = await buildCustomerDataExport(readersOver({}), SCOPE_A, CLOCK);
    expect(doc.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(doc.generatedAt).toBe("2026-08-27T12:34:56.000Z");
  });

  it("covers the §15.4 contents list", async () => {
    // Every category §15.4 names has a home in the document.
    for (const section of [
      "identity",
      "addresses",
      "consent",
      "balance",
      "ledger",
      "redemptions",
      "referral",
      "wishlist",
      "favourites",
      "recentlyViewed",
      "preferences",
      "birthday",
      "portalVisits",
      "erasureRequests",
    ]) {
      expect(EXPORT_SECTIONS, section).toContain(section);
    }
    expect(EXPORT_SECTIONS).toHaveLength(14);
  });

  it("EXCLUDES the derived fragrance block and says so (§15.9)", async () => {
    const doc = await buildCustomerDataExport(readersOver({}), SCOPE_A, CLOCK);
    // Not a section...
    expect(Object.keys(doc.data)).not.toContain("inferred");
    expect(Object.keys(doc.data)).not.toContain("inferredFragranceProfile");
    // ...and its absence is DECLARED, so a customer need not wonder whether it was
    // forgotten. An inference is our reading of behaviour and may be wrong;
    // exporting it as the customer's data would misrepresent a guess as a record.
    expect(doc.excluded.map((e) => e.section)).toContain("inferredFragranceProfile");
    expect(doc.excluded.find((e) => e.section === "inferredFragranceProfile")?.reason).toBe(
      "derived_not_stored",
    );
  });

  it("EXCLUDES internal system rows and says so", async () => {
    const doc = await buildCustomerDataExport(readersOver({}), SCOPE_A, CLOCK);
    for (const forbidden of [
      "webhookEvents",
      "webhook_events",
      "idempotency",
      "idempotencyKeys",
      "scheduledRuns",
      "backupRuns",
      "jobs",
    ]) {
      expect(Object.keys(doc.data), forbidden).not.toContain(forbidden);
    }
    expect(doc.excluded.map((e) => e.section)).toContain("internalSystemRecords");
  });

  it("includes the INPUTS to personalisation rather than the derived block (task 15.4)", async () => {
    const doc = await buildCustomerDataExport(readersOver({}), SCOPE_A, CLOCK);
    // The inputs §12.3 names, all present as their own sections.
    for (const input of ["ledger", "wishlist", "favourites", "recentlyViewed", "preferences"]) {
      expect(Object.keys(doc.data), input).toContain(input);
    }
  });
});

describe("cross-customer isolation (Req 23.4)", () => {
  it("Property: an export for A contains NO attribute of B", async () => {
    await fc.assert(
      fc.asyncProperty(
        // DISJOINT ALPHABETS, not merely distinct strings. `fc.pre(a !== b)` is not
        // enough: if B's marker were a SUBSTRING of A's (say "ABCDEF" inside
        // "ABCDEFG"), a correct export containing only A's data would still contain
        // B's marker and the assertion would fail for a reason that is not a leak.
        // Drawing the two from non-overlapping character sets makes that impossible.
        fc.stringMatching(/^[a-j]{6,14}$/),
        fc.stringMatching(/^[q-z]{6,14}$/),
        async (secretOfA, secretOfB) => {
          const store = {
            [A]: Object.fromEntries(EXPORT_SECTIONS.map((s) => [s, `A-${secretOfA}-${s}`])),
            [B]: Object.fromEntries(EXPORT_SECTIONS.map((s) => [s, `B-${secretOfB}-${s}`])),
          };
          const doc = await buildCustomerDataExport(readersOver(store), SCOPE_A, CLOCK);
          const serialised = JSON.stringify(doc);
          // B's marker appears nowhere, in any section, at any depth.
          expect(serialised).not.toContain(secretOfB);
          expect(serialised).not.toContain(B);
          // And A's own data IS there, so the assertion is not passing vacuously by
          // producing an empty document.
          expect(serialised).toContain(secretOfA);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("passes the SAME scope to every reader, so none can widen", async () => {
    const seen: string[] = [];
    const readers = Object.fromEntries(
      EXPORT_SECTIONS.map((s) => [
        s,
        async (scope: CustomerScope) => {
          seen.push(scope.customerId);
          return null;
        },
      ]),
    ) as ExportReaders;
    await buildCustomerDataExport(readers, SCOPE_A, CLOCK);
    expect(seen).toHaveLength(EXPORT_SECTIONS.length);
    expect(new Set(seen)).toEqual(new Set([A]));
  });

  it("produces a DIFFERENT document for B than for A over the same store", async () => {
    const store = {
      [A]: { identity: "A-only" },
      [B]: { identity: "B-only" },
    };
    const docA = await buildCustomerDataExport(readersOver(store), SCOPE_A, CLOCK);
    const docB = await buildCustomerDataExport(readersOver(store), SCOPE_B, CLOCK);
    expect(docA.data.identity).toBe("A-only");
    expect(docB.data.identity).toBe("B-only");
    expect(JSON.stringify(docA)).not.toContain("B-only");
  });
});

describe("a failing section degrades honestly", () => {
  it("reports the section as unavailable rather than failing the whole export", async () => {
    const doc = await buildCustomerDataExport(FAILING, SCOPE_A, CLOCK);
    expect([...doc.unavailable].sort()).toEqual([...EXPORT_SECTIONS].sort());
    for (const section of EXPORT_SECTIONS) {
      expect(doc.data[section], section).toBeNull();
    }
  });

  it("carries NO upstream text from the failure (§5.5, §15.7)", async () => {
    const doc = await buildCustomerDataExport(FAILING, SCOPE_A, CLOCK);
    const serialised = JSON.stringify(doc);
    expect(serialised).not.toContain("UPSTREAM-SECRET");
    expect(serialised).not.toContain("Error");
  });

  it("reports unavailable as IDENTIFIERS, never sentences", async () => {
    const doc = await buildCustomerDataExport(FAILING, SCOPE_A, CLOCK);
    for (const name of doc.unavailable) {
      expect(name).toMatch(/^[a-zA-Z]+$/);
    }
  });

  it("keeps a partial failure partial: the sections that worked are present", async () => {
    const readers = {
      ...readersOver({ [A]: { identity: "kept", wishlist: ["1001"] } }),
      balance: async () => {
        throw new Error("boom");
      },
    } as ExportReaders;
    const doc = await buildCustomerDataExport(readers, SCOPE_A, CLOCK);
    expect(doc.unavailable).toEqual(["balance"]);
    expect(doc.data.identity).toBe("kept");
    expect(doc.data.wishlist).toEqual(["1001"]);
  });
});

describe("determinism (task 15.1)", () => {
  it("produces BYTE-IDENTICAL output for unchanged data", async () => {
    const store = {
      [A]: Object.fromEntries(EXPORT_SECTIONS.map((s, i) => [s, { s, i }])),
    };
    const first = JSON.stringify(await buildCustomerDataExport(readersOver(store), SCOPE_A, CLOCK));
    const second = JSON.stringify(await buildCustomerDataExport(readersOver(store), SCOPE_A, CLOCK));
    expect(second).toBe(first);
  });

  it("has exactly one non-deterministic value, and it is injected", async () => {
    const store = { [A]: { identity: "x" } };
    const early = await buildCustomerDataExport(readersOver(store), SCOPE_A, {
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    const late = await buildCustomerDataExport(readersOver(store), SCOPE_A, CLOCK);
    // Only `generatedAt` differs; everything else is identical.
    expect({ ...early, generatedAt: "" }).toEqual({ ...late, generatedAt: "" });
    expect(early.generatedAt).not.toBe(late.generatedAt);
  });
});

describe("the filename carries no identifier", () => {
  it("names the date and nothing else", () => {
    expect(exportFilename("2026-08-27T12:34:56.000Z")).toBe("athoor-data-export-2026-08-27.json");
  });

  it("contains no customer id and no email, even given a malformed instant", () => {
    for (const instant of ["", "nonsense", A, `${A}@example.com`]) {
      const name = exportFilename(instant);
      // A filename ends up in a downloads folder, a browser history entry and quite
      // possibly a support screenshot.
      expect(name, instant).not.toContain(A);
      expect(name, instant).not.toContain("@");
      expect(name).toMatch(/^athoor-data-export-[\w-]+\.json$/);
    }
  });
});
