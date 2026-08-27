// Feature: customer-experience-portal, Property 8: Personalisation is deterministic
/**
 * PROPERTY 8 — spec task 13.4. Validates Requirements 12.3, 12.4, 12.5.
 *
 * The property, in two clauses:
 *   (i)  two computations over IDENTICAL inputs produce BYTE-IDENTICAL output;
 *   (ii) every product the output references is in the input set.
 *
 * ── WHY (i) NEEDS A PROPERTY TEST AND NOT AN EXAMPLE ───────────────────────
 * A unit test picks one input and shows the function is a function. The failure
 * mode this hunts is narrower and much easier to ship: a ranking that is stable
 * for distinct counts but arbitrary for EQUAL ones, because it sorts on count
 * alone and inherits whatever order the map yielded. That only shows up when two
 * families tie, which a handful of examples will not reliably produce and a
 * generator will. So the generators below are deliberately biased toward
 * collisions: a small product pool over a small vocabulary, so ties are common
 * rather than rare.
 *
 * ── WHY (ii) IS NOT TRIVIALLY TRUE ─────────────────────────────────────────
 * The taxonomy maps products the customer has never touched. A derivation that
 * iterated the TAXONOMY rather than the customer's own products would produce a
 * plausible-looking block naming other products' families — the shape of a
 * recommendation engine, which §12.4 forecloses. Generating a taxonomy strictly
 * larger than the touched set is what makes that failure observable.
 *
 * SAFETY: pure. No network, no database, no production, no clock.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  deriveInferredSignal,
  orderMonthsFromPurchaseInstants,
  staticProductTaxonomy,
  type InferredInputs,
  type ProductTaxonomyEntry,
} from "./inferred.js";
import { PREFERENCE_VOCABULARY } from "./preferences.js";

/**
 * A SMALL product pool, on purpose.
 *
 * Eight products over a five-value family vocabulary means ties are the common
 * case rather than a rare one — which is exactly where a ranking without a total
 * order comes apart.
 */
const PRODUCT_IDS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"] as const;
const FAMILIES = PREFERENCE_VOCABULARY.scent_family.slice(0, 5);
const NOTES = PREFERENCE_VOCABULARY.note.slice(0, 5);

const productId = fc.constantFrom(...PRODUCT_IDS);
const productList = fc.array(productId, { minLength: 0, maxLength: 8 });
const month = fc.integer({ min: 1, max: 12 });

/** A taxonomy over the whole pool, so it always maps MORE than any customer touched. */
const taxonomyArb = fc
  .tuple(
    ...PRODUCT_IDS.map(() =>
      fc.record({
        families: fc.uniqueArray(fc.constantFrom(...FAMILIES), { minLength: 0, maxLength: 3 }),
        notes: fc.uniqueArray(fc.constantFrom(...NOTES), { minLength: 0, maxLength: 3 }),
      }),
    ),
  )
  .map((entries) => {
    const table: Record<string, ProductTaxonomyEntry> = {};
    PRODUCT_IDS.forEach((id, index) => {
      table[id] = entries[index] as ProductTaxonomyEntry;
    });
    return table;
  });

const inputsArb: fc.Arbitrary<InferredInputs> = fc.record({
  purchasedProductIds: productList,
  wishlistProductIds: productList,
  favouriteProductIds: productList,
  recentlyViewedProductIds: productList,
  orderMonths: fc.array(month, { minLength: 0, maxLength: 8 }),
});

/** Every value the output could legitimately name. */
function referencedValues(signal: ReturnType<typeof deriveInferredSignal>): string[] {
  return [
    ...signal.scent_family.map((r) => r.value),
    ...signal.note.map((r) => r.value),
    ...(signal.insight ? [signal.insight.value] : []),
  ];
}

describe("Property 8: personalisation is deterministic", () => {
  it("produces BYTE-IDENTICAL output for identical inputs", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const taxonomy = staticProductTaxonomy(table);
        const first = JSON.stringify(deriveInferredSignal(input, taxonomy));
        const second = JSON.stringify(deriveInferredSignal(input, taxonomy));
        expect(second).toBe(first);
      }),
      { numRuns: 300 },
    );
  });

  it("is invariant under REORDERING of every input list", async () => {
    // The strongest form of (i). Two callers assembling the same sets in different
    // orders must agree, which is what a total ordering buys and what a
    // count-only sort loses.
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const taxonomy = staticProductTaxonomy(table);
        const reversed: InferredInputs = {
          purchasedProductIds: [...input.purchasedProductIds].reverse(),
          wishlistProductIds: [...input.wishlistProductIds].reverse(),
          favouriteProductIds: [...input.favouriteProductIds].reverse(),
          recentlyViewedProductIds: [...input.recentlyViewedProductIds].reverse(),
          orderMonths: [...input.orderMonths].reverse(),
        };
        expect(JSON.stringify(deriveInferredSignal(reversed, taxonomy))).toBe(
          JSON.stringify(deriveInferredSignal(input, taxonomy)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("is invariant under DUPLICATION within an input list", async () => {
    // Counts are over distinct products (§12.3 rule 1), so repeating an entry — ten
    // views of one bottle — must change nothing at all.
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const taxonomy = staticProductTaxonomy(table);
        const duplicated: InferredInputs = {
          ...input,
          recentlyViewedProductIds: [
            ...input.recentlyViewedProductIds,
            ...input.recentlyViewedProductIds,
          ],
          wishlistProductIds: [...input.wishlistProductIds, ...input.wishlistProductIds],
        };
        expect(JSON.stringify(deriveInferredSignal(duplicated, taxonomy))).toBe(
          JSON.stringify(deriveInferredSignal(input, taxonomy)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("references ONLY families and notes carried by products in the input set", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const taxonomy = staticProductTaxonomy(table);
        const signal = deriveInferredSignal(input, taxonomy);

        const touched = new Set([
          ...input.purchasedProductIds,
          ...input.wishlistProductIds,
          ...input.favouriteProductIds,
          ...input.recentlyViewedProductIds,
        ]);
        const reachable = new Set<string>();
        for (const id of touched) {
          const entry = table[id];
          if (entry === undefined) continue;
          for (const family of entry.families) reachable.add(family);
          for (const note of entry.notes) reachable.add(note);
        }

        for (const value of referencedValues(signal)) {
          // A value from an UNTOUCHED product would mean the derivation iterated the
          // taxonomy rather than the customer — a recommendation engine, which
          // §12.4 forecloses.
          expect(reachable.has(value), `${value} is not reachable from the input set`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never names a PRODUCT ID at all — only families, notes and counts", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const signal = deriveInferredSignal(input, staticProductTaxonomy(table));
        const serialised = JSON.stringify(signal);
        for (const id of PRODUCT_IDS) {
          expect(serialised.includes(`"${id}"`), id).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("keeps every count within the number of DISTINCT products touched", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const signal = deriveInferredSignal(input, staticProductTaxonomy(table));
        const distinct = new Set([
          ...input.purchasedProductIds,
          ...input.wishlistProductIds,
          ...input.favouriteProductIds,
          ...input.recentlyViewedProductIds,
        ]).size;
        for (const entry of [...signal.scent_family, ...signal.note]) {
          expect(entry.distinctProducts).toBeGreaterThan(0);
          expect(entry.distinctProducts).toBeLessThanOrEqual(distinct);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("returns rankings sorted by (count desc, key asc) and capped at three", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const signal = deriveInferredSignal(input, staticProductTaxonomy(table));
        for (const list of [signal.scent_family, signal.note]) {
          expect(list.length).toBeLessThanOrEqual(3);
          for (let i = 1; i < list.length; i += 1) {
            const prev = list[i - 1]!;
            const cur = list[i]!;
            const ordered =
              prev.distinctProducts > cur.distinctProducts ||
              (prev.distinctProducts === cur.distinctProducts && prev.value < cur.value);
            expect(ordered, `${prev.value}(${prev.distinctProducts}) then ${cur.value}(${cur.distinctProducts})`).toBe(
              true,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("keeps the insight in agreement with the top-ranked family, or null", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const signal = deriveInferredSignal(input, staticProductTaxonomy(table));
        if (signal.insight === null) {
          // Null is only legitimate when there is no family with two distinct
          // products — otherwise Req 4.9's insight has gone missing.
          const top = signal.scent_family[0];
          expect(top === undefined || top.distinctProducts < 2).toBe(true);
          return;
        }
        expect(signal.insight.kind).toBe("family_concentration");
        expect(signal.insight.value).toBe(signal.scent_family[0]?.value);
        expect(signal.insight.distinctProducts).toBe(signal.scent_family[0]?.distinctProducts);
        expect(signal.insight.distinctProducts).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: 300 },
    );
  });

  it("gates the season leaning on three orders, in both directions", async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const signal = deriveInferredSignal(input, staticProductTaxonomy(table));
        const usableMonths = input.orderMonths.filter((m) => m >= 1 && m <= 12);
        if (input.orderMonths.length < 3 || usableMonths.length === 0) {
          expect(signal.season).toBeNull();
        } else {
          expect(signal.season).not.toBeNull();
          expect(PREFERENCE_VOCABULARY.season).toContain(signal.season?.value);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("BIRTHDAY-STYLE CHECK: changing declared preferences cannot change the block", async () => {
    // The inferred block takes no declared preferences (see `InferredSignal.basis`),
    // so a customer editing their declarations cannot move a derived conclusion.
    // Asserted structurally: the derivation's input type has no declared field, so
    // there is nothing to vary.
    await fc.assert(
      fc.asyncProperty(inputsArb, taxonomyArb, async (input, table) => {
        const keys = Object.keys(input).sort();
        expect(keys).toEqual([
          "favouriteProductIds",
          "orderMonths",
          "purchasedProductIds",
          "recentlyViewedProductIds",
          "wishlistProductIds",
        ]);
        expect(JSON.stringify(deriveInferredSignal(input, staticProductTaxonomy(table)))).toBe(
          JSON.stringify(deriveInferredSignal(input, staticProductTaxonomy(table))),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("derives order months deterministically from purchase instants", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2030-12-31T00:00:00Z") }).map((d) => d.toISOString()),
            fc.constant(null),
            fc.constant(""),
            fc.constant("not-a-date"),
          ),
          { maxLength: 12 },
        ),
        async (instants) => {
          const first = orderMonthsFromPurchaseInstants(instants);
          const second = orderMonthsFromPurchaseInstants([...instants].reverse());
          // Sorted output makes the result a function of the input SET.
          expect(second).toEqual(first);
          for (const m of first) {
            expect(m).toBeGreaterThanOrEqual(1);
            expect(m).toBeLessThanOrEqual(12);
          }
          // Never more months than instants supplied — the lower-bound property.
          expect(first.length).toBeLessThanOrEqual(instants.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
