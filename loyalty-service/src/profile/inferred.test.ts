/**
 * Inferred-signal unit tests — task 13.3, §12.3/§12.8,
 * Req 12.3, 12.4, 12.5, 12.8, 4.9, 21.7.
 *
 * SAFETY: pure functions only. No network, no database, no clock, no production.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deriveInferredSignal,
  EMPTY_PRODUCT_TAXONOMY,
  INFERRED_TOP_N,
  INSIGHT_MIN_DISTINCT_PRODUCTS,
  orderMonthsFromPurchaseInstants,
  SEASON_MIN_ORDERS,
  staticProductTaxonomy,
  type InferredInputs,
} from "./inferred.js";

const NO_ACTIVITY: InferredInputs = {
  purchasedProductIds: [],
  wishlistProductIds: [],
  favouriteProductIds: [],
  recentlyViewedProductIds: [],
  orderMonths: [],
};

function inputs(patch: Partial<InferredInputs>): InferredInputs {
  return { ...NO_ACTIVITY, ...patch };
}

/** A taxonomy where product `n` carries the families/notes given. */
const TAXONOMY = staticProductTaxonomy({
  p1: { families: ["oud"], notes: ["saffron"] },
  p2: { families: ["oud"], notes: ["rose"] },
  p3: { families: ["oud", "woody"], notes: ["saffron"] },
  p4: { families: ["woody"], notes: ["cedar"] },
  p5: { families: ["floral"], notes: ["rose"] },
});

describe("the empty case (Req 12.6, 12.7)", () => {
  it("returns a fully-formed block with nothing in it — never an error", () => {
    expect(deriveInferredSignal(NO_ACTIVITY, TAXONOMY)).toEqual({
      basis: [],
      scent_family: [],
      note: [],
      season: null,
      occasion: null,
      insight: null,
    });
  });

  it("concludes nothing when no taxonomy is wired, but still returns the block", () => {
    const signal = deriveInferredSignal(
      inputs({ purchasedProductIds: ["p1", "p2", "p3"] }),
      EMPTY_PRODUCT_TAXONOMY,
    );
    // An unmapped catalogue is "we can conclude nothing", not a failure. The basis
    // still reports what the customer did, because that part is true regardless.
    expect(signal.scent_family).toEqual([]);
    expect(signal.insight).toBeNull();
    expect(signal.basis).toEqual(["orders"]);
  });

  it("defaults to the empty taxonomy when none is passed at all", () => {
    expect(deriveInferredSignal(inputs({ wishlistProductIds: ["p1"] })).scent_family).toEqual([]);
  });
});

describe("family and note affinity — DISTINCT products (§12.3 rules 1-2)", () => {
  it("counts distinct products, so many views of one bottle cannot outrank others", () => {
    const signal = deriveInferredSignal(
      inputs({
        // p5 appears in three different lists; p1 and p2 once each.
        recentlyViewedProductIds: ["p5", "p5", "p5"],
        wishlistProductIds: ["p5"],
        favouriteProductIds: ["p5"],
        purchasedProductIds: ["p1", "p2"],
      }),
      TAXONOMY,
    );
    // oud has two DISTINCT products (p1, p2); floral has one (p5), however often
    // it was touched.
    expect(signal.scent_family).toEqual([
      { value: "oud", distinctProducts: 2 },
      { value: "floral", distinctProducts: 1 },
    ]);
  });

  it("unions the four input lists so one product counted once", () => {
    const both = deriveInferredSignal(
      inputs({ purchasedProductIds: ["p1"], wishlistProductIds: ["p1"] }),
      TAXONOMY,
    );
    expect(both.scent_family).toEqual([{ value: "oud", distinctProducts: 1 }]);
  });

  it("counts a product under EVERY family it carries", () => {
    // p3 is both oud and woody.
    const signal = deriveInferredSignal(inputs({ purchasedProductIds: ["p3"] }), TAXONOMY);
    expect(signal.scent_family).toEqual([
      { value: "oud", distinctProducts: 1 },
      { value: "woody", distinctProducts: 1 },
    ]);
  });

  it("dedupes a repeated tag within one product", () => {
    const doubled = staticProductTaxonomy({ p1: { families: ["oud", "oud"], notes: [] } });
    expect(deriveInferredSignal(inputs({ purchasedProductIds: ["p1"] }), doubled).scent_family).toEqual(
      [{ value: "oud", distinctProducts: 1 }],
    );
  });

  it("ranks notes by the identical procedure", () => {
    const signal = deriveInferredSignal(
      inputs({ purchasedProductIds: ["p1", "p3", "p2"] }),
      TAXONOMY,
    );
    // saffron: p1, p3 → 2. rose: p2 → 1.
    expect(signal.note).toEqual([
      { value: "saffron", distinctProducts: 2 },
      { value: "rose", distinctProducts: 1 },
    ]);
  });

  it("takes the TOP THREE and no more", () => {
    const many = staticProductTaxonomy({
      a: { families: ["amber"], notes: [] },
      b: { families: ["citrus"], notes: [] },
      c: { families: ["floral"], notes: [] },
      d: { families: ["green"], notes: [] },
      e: { families: ["leather"], notes: [] },
    });
    const signal = deriveInferredSignal(
      inputs({ purchasedProductIds: ["a", "b", "c", "d", "e"] }),
      many,
    );
    expect(signal.scent_family).toHaveLength(INFERRED_TOP_N);
    expect(INFERRED_TOP_N).toBe(3);
  });

  it("breaks a count TIE by key ASCENDING, which is what makes the order total", () => {
    // Without the key tie-break these five would come back in map-insertion order,
    // and the same inputs would produce different bytes depending on how they were
    // assembled — the defect Property 8 exists to catch.
    const many = staticProductTaxonomy({
      a: { families: ["woody"], notes: [] },
      b: { families: ["amber"], notes: [] },
      c: { families: ["oud"], notes: [] },
    });
    const forward = deriveInferredSignal(inputs({ purchasedProductIds: ["a", "b", "c"] }), many);
    const reverse = deriveInferredSignal(inputs({ purchasedProductIds: ["c", "b", "a"] }), many);
    expect(forward.scent_family.map((r) => r.value)).toEqual(["amber", "oud", "woody"]);
    expect(reverse.scent_family).toEqual(forward.scent_family);
  });

  it("ignores a product the taxonomy does not map", () => {
    const signal = deriveInferredSignal(
      inputs({ purchasedProductIds: ["p1", "unmapped-product"] }),
      TAXONOMY,
    );
    expect(signal.scent_family).toEqual([{ value: "oud", distinctProducts: 1 }]);
  });

  it("names only families and notes, never a product the customer has not touched", () => {
    // Property 8's second clause, as a unit case: the block references p1's family
    // and note and nothing about p4/p5, which are in the taxonomy but untouched.
    const signal = deriveInferredSignal(inputs({ purchasedProductIds: ["p1"] }), TAXONOMY);
    const serialised = JSON.stringify(signal);
    expect(serialised).not.toContain("p4");
    expect(serialised).not.toContain("p5");
    expect(serialised).not.toContain("cedar");
  });
});

describe("intensity is NEVER inferred (§12.3 rule 3)", () => {
  it("has no intensity field anywhere in the block", () => {
    const signal = deriveInferredSignal(
      inputs({ purchasedProductIds: ["p1", "p2", "p3"] }),
      TAXONOMY,
    );
    expect(signal).not.toHaveProperty("intensity");
    expect(Object.keys(signal).sort()).toEqual([
      "basis",
      "insight",
      "note",
      "occasion",
      "scent_family",
      "season",
    ]);
  });
});

describe("season leaning (§12.3 rule 4)", () => {
  it("is null below three orders — two data points do not make a pattern", () => {
    for (const months of [[], [6], [6, 7]]) {
      expect(
        deriveInferredSignal(inputs({ purchasedProductIds: ["p1"], orderMonths: months }), TAXONOMY)
          .season,
        JSON.stringify(months),
      ).toBeNull();
    }
    expect(SEASON_MIN_ORDERS).toBe(3);
  });

  it("appears at exactly three orders", () => {
    const signal = deriveInferredSignal(inputs({ orderMonths: [6, 7, 8] }), TAXONOMY);
    expect(signal.season).toEqual({ value: "summer", distinctProducts: 3 });
  });

  it("maps every month to its northern-hemisphere season", () => {
    const cases: readonly [number[], string][] = [
      [[12, 1, 2], "winter"],
      [[3, 4, 5], "spring"],
      [[6, 7, 8], "summer"],
      [[9, 10, 11], "autumn"],
    ];
    for (const [months, expected] of cases) {
      expect(
        deriveInferredSignal(inputs({ orderMonths: months }), TAXONOMY).season?.value,
        expected,
      ).toBe(expected);
    }
  });

  it("counts ORDERS, not months, so three orders in one month still qualifies", () => {
    const signal = deriveInferredSignal(inputs({ orderMonths: [1, 1, 1] }), TAXONOMY);
    expect(signal.season).toEqual({ value: "winter", distinctProducts: 3 });
  });

  it("picks the leading season and breaks a tie by key ascending", () => {
    // 2 winter (1, 2) vs 2 summer (6, 7) → `summer` precedes `winter`.
    const signal = deriveInferredSignal(inputs({ orderMonths: [1, 2, 6, 7] }), TAXONOMY);
    expect(signal.season).toEqual({ value: "summer", distinctProducts: 2 });
  });

  it("DROPS an out-of-range month rather than clamping it into a season", () => {
    // Clamping 13 into January would invent a season from a defect.
    const signal = deriveInferredSignal(inputs({ orderMonths: [13, 0, -1, 6, 6, 6] }), TAXONOMY);
    expect(signal.season).toEqual({ value: "summer", distinctProducts: 3 });
  });

  it("returns null when every month was unusable, even past the order gate", () => {
    expect(deriveInferredSignal(inputs({ orderMonths: [13, 14, 15] }), TAXONOMY).season).toBeNull();
  });
});

describe("occasion is ALWAYS null, and deliberately (documented spec gap)", () => {
  it("is null even with a long history in every input", () => {
    const signal = deriveInferredSignal(
      inputs({
        purchasedProductIds: ["p1", "p2", "p3", "p4", "p5"],
        wishlistProductIds: ["p1"],
        favouriteProductIds: ["p2"],
        recentlyViewedProductIds: ["p3"],
        orderMonths: [1, 4, 7, 10, 12],
      }),
      TAXONOMY,
    );
    // §12.3 rule 4 names occasion but gives only a month→SEASON mapping. No rule
    // anywhere maps an available signal to an occasion, and §12.7 excludes invented
    // scoring models — so the field exists for when a rule is approved and stays
    // null until then.
    expect(signal.occasion).toBeNull();
  });

  it("keeps the field present so adding a rule later is not a contract change", () => {
    expect(deriveInferredSignal(NO_ACTIVITY, TAXONOMY)).toHaveProperty("occasion");
  });
});

describe("the Requirement 4.9 insight (§12.3 rule 5)", () => {
  it("needs TWO distinct products, so one purchase is not a conclusion", () => {
    expect(deriveInferredSignal(inputs({ purchasedProductIds: ["p1"] }), TAXONOMY).insight).toBeNull();
    expect(INSIGHT_MIN_DISTINCT_PRODUCTS).toBe(2);
  });

  it("names the single highest-count family at two distinct products", () => {
    const signal = deriveInferredSignal(inputs({ purchasedProductIds: ["p1", "p2"] }), TAXONOMY);
    expect(signal.insight).toEqual({ kind: "family_concentration", value: "oud", distinctProducts: 2 });
  });

  it("AGREES with the ranking beside it — it re-ranks nothing", () => {
    const signal = deriveInferredSignal(
      inputs({ purchasedProductIds: ["p1", "p2", "p3", "p4"] }),
      TAXONOMY,
    );
    expect(signal.insight?.value).toBe(signal.scent_family[0]?.value);
    expect(signal.insight?.distinctProducts).toBe(signal.scent_family[0]?.distinctProducts);
  });

  it("emits kind as an IDENTIFIER, never a sentence (Req 21.7, Property 10)", () => {
    const signal = deriveInferredSignal(inputs({ purchasedProductIds: ["p1", "p2"] }), TAXONOMY);
    expect(signal.insight?.kind).toBe("family_concentration");
    expect(signal.insight?.kind).toMatch(/^[a-z][a-z_]*$/);
  });
});

describe("basis — an identifier list of what actually contributed (§12.5 part 3)", () => {
  it("is empty when nothing was touched", () => {
    expect(deriveInferredSignal(NO_ACTIVITY, TAXONOMY).basis).toEqual([]);
  });

  it("names only the non-empty inputs", () => {
    expect(deriveInferredSignal(inputs({ wishlistProductIds: ["p1"] }), TAXONOMY).basis).toEqual([
      "wishlist",
    ]);
    expect(
      deriveInferredSignal(
        inputs({ purchasedProductIds: ["p1"], favouriteProductIds: ["p2"] }),
        TAXONOMY,
      ).basis,
    ).toEqual(["orders", "favourites"]);
  });

  it("uses a FIXED order, independent of which input was populated first", () => {
    const all = inputs({
      purchasedProductIds: ["p1"],
      wishlistProductIds: ["p2"],
      favouriteProductIds: ["p3"],
      recentlyViewedProductIds: ["p4"],
    });
    expect(deriveInferredSignal(all, TAXONOMY).basis).toEqual([
      "orders",
      "wishlist",
      "recently_viewed",
      "favourites",
    ]);
  });

  it("emits identifiers, never sentences", () => {
    const all = inputs({
      purchasedProductIds: ["p1"],
      wishlistProductIds: ["p2"],
      favouriteProductIds: ["p3"],
      recentlyViewedProductIds: ["p4"],
    });
    for (const name of deriveInferredSignal(all, TAXONOMY).basis) {
      expect(name).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("does NOT claim recent views for a customer who has viewed nothing", () => {
    const signal = deriveInferredSignal(inputs({ purchasedProductIds: ["p1"] }), TAXONOMY);
    expect(signal.basis).not.toContain("recently_viewed");
  });
});

describe("determinism is structural (Req 12.4, 12.5, §12.3)", () => {
  it("is SYNCHRONOUS, so a network call cannot be added quietly", () => {
    // An async signature is the first thing that would have to change to reach an
    // external recommendation service, so the shape is the guard.
    const result = deriveInferredSignal(inputs({ purchasedProductIds: ["p1"] }), TAXONOMY);
    expect(result).not.toBeInstanceOf(Promise);
    expect(deriveInferredSignal.constructor.name).toBe("Function");
  });

  it("contains no randomness, no clock read and no external call site", () => {
    // Asserted against the SOURCE, because the point is that there is nowhere to
    // put such a call — not that a particular input happens not to trigger one.
    const source = readFileSync(fileURLToPath(new URL("./inferred.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of [
      "Math.random",
      "Date.now",
      "crypto",
      "fetch(",
      "axios",
      "http://",
      "https://",
      "process.env",
    ]) {
      expect(code, banned).not.toContain(banned);
    }
    // `new Date` appears only in the instant parser, which reads a SUPPLIED
    // timestamp and never the current time.
    expect(code).not.toContain("new Date()");
  });

  it("produces byte-identical output for the same inputs, twice", () => {
    const shape = inputs({
      purchasedProductIds: ["p3", "p1", "p2"],
      wishlistProductIds: ["p5"],
      recentlyViewedProductIds: ["p4"],
      orderMonths: [1, 6, 9],
    });
    expect(JSON.stringify(deriveInferredSignal(shape, TAXONOMY))).toBe(
      JSON.stringify(deriveInferredSignal(shape, TAXONOMY)),
    );
  });

  it("is independent of the ORDER the input lists arrive in", () => {
    const a = inputs({ purchasedProductIds: ["p1", "p2", "p3"], orderMonths: [1, 6, 9] });
    const b = inputs({ purchasedProductIds: ["p3", "p2", "p1"], orderMonths: [9, 6, 1] });
    expect(JSON.stringify(deriveInferredSignal(a, TAXONOMY))).toBe(
      JSON.stringify(deriveInferredSignal(b, TAXONOMY)),
    );
  });
});

describe("staticProductTaxonomy", () => {
  it("returns undefined for an unmapped product", () => {
    expect(staticProductTaxonomy({}).lookup("nope")).toBeUndefined();
  });

  it("COPIES its input, so later mutation cannot leak into a live taxonomy", () => {
    const families = ["oud"];
    const taxonomy = staticProductTaxonomy({ p1: { families, notes: [] } });
    families.push("amber");
    expect(taxonomy.lookup("p1")?.families).toEqual(["oud"]);
  });
});

describe("orderMonthsFromPurchaseInstants — a documented lower bound", () => {
  it("counts DISTINCT instants, so a multi-product order contributes one month", () => {
    const shared = "2026-06-10T12:00:00.000Z";
    expect(orderMonthsFromPurchaseInstants([shared, shared, shared])).toEqual([6]);
  });

  it("counts two different instants in the same month as two orders", () => {
    expect(
      orderMonthsFromPurchaseInstants(["2026-06-01T00:00:00.000Z", "2026-06-20T00:00:00.000Z"]),
    ).toEqual([6, 6]);
  });

  it("skips a null, an empty string and an unparseable timestamp", () => {
    expect(orderMonthsFromPurchaseInstants([null, "", "not-a-date", "2026-03-01T00:00:00.000Z"])).toEqual(
      [3],
    );
  });

  it("reads the month in UTC, so the result cannot depend on the server's zone", () => {
    // 23:30 on 31 January UTC is 1 February in a +01:00 zone. UTC keeps it January.
    expect(orderMonthsFromPurchaseInstants(["2026-01-31T23:30:00.000Z"])).toEqual([1]);
  });

  it("sorts, so the value is a function of the input SET and not its order", () => {
    expect(
      orderMonthsFromPurchaseInstants(["2026-09-01T00:00:00Z", "2026-02-01T00:00:00Z"]),
    ).toEqual([2, 9]);
  });

  it("NEVER over-counts: distinct instants are at most the true order count", () => {
    // The direction of the error is the point — under-counting can only withhold a
    // leaning, never assert one that was not earned.
    const oneOrderTwoProducts = ["2026-05-05T09:00:00.000Z", "2026-05-05T09:00:00.000Z"];
    expect(orderMonthsFromPurchaseInstants(oneOrderTwoProducts).length).toBeLessThanOrEqual(2);
    expect(orderMonthsFromPurchaseInstants(oneOrderTwoProducts)).toEqual([5]);
  });
});
