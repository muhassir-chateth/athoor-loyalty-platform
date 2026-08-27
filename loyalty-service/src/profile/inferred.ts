/**
 * The inferred behavioural signal (spec task 13.3, design §12.1/§12.3/§12.8,
 * Req 12.3, 12.4, 12.5, 12.8, 4.9, 21.7).
 *
 * ── STORED NOWHERE ─────────────────────────────────────────────────────────
 * §12.1 is emphatic and the reason is worth restating: a stored inference is a
 * second copy of a fact whose source of truth is the behaviour itself, and it
 * OUTLIVES that behaviour. A customer who removes a product from their wishlist
 * would keep the taste conclusion drawn from it. So this module is a pure
 * function, there is no table, no cache and no migration, and the block is
 * recomputed on every read.
 *
 * ── DETERMINISM IS STRUCTURAL, NOT A CONVENTION (Req 12.4, Property 8) ──────
 * Three things are banned by §12.3 and none of them appear in this file:
 *   1. randomness of any kind — there is no `Math.random`, no shuffle, no id;
 *   2. any dependence on `now()` inside ranking — nothing here reads a clock, so
 *      recency-weighting cannot silently make two calls a second apart differ.
 *      Recency is already expressed by the 90-day window on `recently_viewed`;
 *   3. iteration over a hash-ordered collection without an explicit sort — every
 *      ranking below sorts by (count descending, key ascending), and the key
 *      tie-break is what makes the order TOTAL rather than merely stable.
 * A tie-break on count alone would leave two equal-count families in whatever
 * order the map yielded them, which is exactly the defect Property 8 hunts.
 *
 * ── DISTINCT PRODUCTS, NOT EVENTS (§12.3 rule 1) ───────────────────────────
 * Ten views of one bottle must not outrank four different purchases, so every
 * count is over a SET of product ids. This is also why the four input lists are
 * unioned before counting rather than counted separately and added: a product
 * that was viewed, wishlisted and then bought is one product, not three.
 *
 * ── NO EXTERNAL CALL SITE EXISTS (Req 12.5) ────────────────────────────────
 * This module does not merely avoid calling a recommendation, ML or generative
 * service — it has nowhere to put such a call. It takes plain data and returns
 * plain data, with no injected client, no fetch, no URL and no async boundary.
 * `inferred.test.ts` asserts the function is synchronous, because an async
 * signature is the first thing that would have to change to add a network call.
 *
 * ── TWO PLACES THE APPROVED DESIGN DOES NOT REACH, HANDLED CONSERVATIVELY ──
 * Both are documented at their use site below and neither is filled in by
 * invention:
 *   • `occasion` has no derivation rule anywhere in the design (see
 *     {@link InferredSignal.occasion});
 *   • order COUNT is not available from the data the profile already holds, so a
 *     conservative lower bound is used (see {@link InferredInputs.orderMonths}).
 *
 * SAFETY: pure. No I/O, no SQL, no clock, no randomness, no network.
 */

/* ========================================================================== *
 * The server-owned product taxonomy
 * ========================================================================== */

/** The families and notes a single product carries. */
export interface ProductTaxonomyEntry {
  readonly families: readonly string[];
  readonly notes: readonly string[];
}

/**
 * The server-owned product→family/note mapping (§12.3 rule 1).
 *
 * ── WHY THIS IS AN INJECTED LOOKUP AND NOT A SHOPIFY CALL ───────────────────
 * §12.3 describes the mapping as "derived from the product's collections and
 * tags", which says where the CONTENT comes from, not that it is fetched per
 * request. §12.4 settles the timing: personalisation is "a set of counting rules
 * over the customer's own rows, executed inside the same request that reads
 * them", with "no third-party origin, and no capability that degrades if an
 * external service is unavailable". Fetching collections and tags from Shopify on
 * every `GET /v1/profile` would contradict that, and would add a network
 * dependency and its latency to an endpoint already shipped and in production.
 *
 * So the mapping is local data behind a lookup. Populating it from collections and
 * tags is a separate concern that can be done without touching this file, the
 * contract, or the derivation rules.
 */
export interface ProductTaxonomy {
  /** Families and notes for a product, or `undefined` when it is not mapped. */
  lookup(productId: string): ProductTaxonomyEntry | undefined;
}

/**
 * The taxonomy used when none is wired: every product is unmapped.
 *
 * This yields an inferred block with empty rankings and a null insight, which is
 * a truthful "we can conclude nothing" rather than a guess. It is NOT a failure
 * state and must not become one: §12.6 gives the client the empty-state
 * presentation for exactly this, and Req 12.7 requires an empty category to
 * render as empty and never as an error.
 */
export const EMPTY_PRODUCT_TAXONOMY: ProductTaxonomy = {
  lookup(): undefined {
    return undefined;
  },
};

/** Builds a taxonomy from a plain map. Values are copied, so later mutation cannot leak in. */
export function staticProductTaxonomy(
  entries: Readonly<Record<string, ProductTaxonomyEntry>>,
): ProductTaxonomy {
  const table = new Map<string, ProductTaxonomyEntry>(
    Object.entries(entries).map(([productId, entry]) => [
      productId,
      { families: [...entry.families], notes: [...entry.notes] },
    ]),
  );
  return {
    lookup(productId: string): ProductTaxonomyEntry | undefined {
      return table.get(productId);
    },
  };
}

/* ========================================================================== *
 * Inputs and output
 * ========================================================================== */

/**
 * The complete input set (§12.3), and nothing else.
 *
 * No other customer's data appears here, in any form, aggregated or otherwise.
 * There is no collaborative filtering and no place to put it: the function's only
 * arguments are one customer's own lists.
 */
export interface InferredInputs {
  /** Product ids from the customer's own paid orders. */
  readonly purchasedProductIds: readonly string[];
  /** The customer's own `customer_wishlist`. */
  readonly wishlistProductIds: readonly string[];
  /** The customer's own `customer_favourites`. */
  readonly favouriteProductIds: readonly string[];
  /** The customer's own `customer_recently_viewed`, already 90-day bounded. */
  readonly recentlyViewedProductIds: readonly string[];
  /**
   * Calendar months (1–12) of the customer's own orders, one entry per ORDER.
   *
   * ── A CONSERVATIVE LOWER BOUND, STATED RATHER THAN HIDDEN ─────────────────
   * §12.3 rule 4 gates the season leaning on "at least three orders", but the data
   * the profile already holds is per PRODUCT, not per order: two products bought
   * together are two records sharing one timestamp. The adapter therefore derives
   * this from DISTINCT purchase instants, which is a lower bound on the true order
   * count — never an over-count.
   *
   * The direction of the error is the point. Under-counting can only WITHHOLD a
   * leaning the customer had earned; it can never assert one they had not. §12.6
   * already requires that withholding to be silent, so a customer never sees a
   * "not enough data" apology for it. Over-counting would have produced a
   * confident claim from two data points, which rule 4 exists to prevent.
   */
  readonly orderMonths: readonly number[];
}

/** One ranked value and the number of DISTINCT products that support it. */
export interface InferredRanking {
  readonly value: string;
  readonly distinctProducts: number;
}

/**
 * The Requirement 4.9 insight for Portal Home.
 *
 * `kind` is an identifier, not a sentence: §18.9 maps it to copy, so the wording
 * changes without a service deploy and a mobile client can use its own (Req 21.7,
 * Property 10).
 */
export interface InferredInsight {
  readonly kind: "family_concentration";
  readonly value: string;
  readonly distinctProducts: number;
}

/** Which inputs actually contributed. An identifier list, never a sentence. */
export type InferredBasis = "orders" | "wishlist" | "recently_viewed" | "favourites";

/** The additive `inferred` block on `GET /v1/profile` (§12.8). */
export interface InferredSignal {
  /**
   * The inputs that were non-empty, in a fixed order.
   *
   * The UI turns this into the derived block's one-line explanation (§12.5 part
   * 3), so it lists only what genuinely contributed — naming "recent views" to a
   * customer who has viewed nothing would be a false statement about where a
   * conclusion came from.
   *
   * DECLARED PREFERENCES ARE NOT LISTED, though §12.3 counts them among the
   * inputs. Nothing in rules 1–5 consumes them: rule 3 makes intensity declared-
   * only and therefore absent from this block entirely, and no other rule reads
   * them. Listing them as a basis for a conclusion they did not contribute to
   * would misdescribe the derivation.
   */
  readonly basis: readonly InferredBasis[];
  /** Top three families by distinct products (§12.3 rule 1). */
  readonly scent_family: readonly InferredRanking[];
  /** Top three notes, by the identical procedure (§12.3 rule 2). */
  readonly note: readonly InferredRanking[];
  /** Season leaning, or `null` below three orders (§12.3 rule 4). */
  readonly season: InferredRanking | null;
  /**
   * ALWAYS `null`, and deliberately.
   *
   * §12.3 rule 4 names season and occasion together, but the only derivation it
   * gives is "the purchase MONTH of the customer's own orders, mapped to a
   * season". No rule anywhere in the approved design maps any available signal to
   * an occasion, and nothing in the order or product data implies one — a bottle
   * bought in December is not thereby a gift.
   *
   * The field is present so the contract does not change when a rule is approved,
   * and null so that no invented rule ships in the meantime. §12.7 excludes "a
   * scent quiz with a scoring model" and "a match % figure" for the same reason:
   * a value implying precision the rules cannot justify is worse than no value.
   */
  readonly occasion: InferredRanking | null;
  /** The Req 4.9 insight, or `null` when no family has two distinct products. */
  readonly insight: InferredInsight | null;
}

/* ========================================================================== *
 * Derivation
 * ========================================================================== */

/** How many ranked values each dimension returns (§12.3 rules 1–2: "top three"). */
export const INFERRED_TOP_N = 3;

/** Distinct products a family needs before it can become an insight (§12.3 rule 5). */
export const INSIGHT_MIN_DISTINCT_PRODUCTS = 2;

/** Orders needed before a season leaning is presented (§12.3 rule 4). */
export const SEASON_MIN_ORDERS = 3;

/** Fixed order for {@link InferredSignal.basis}, so two identical inputs agree. */
const BASIS_ORDER: readonly InferredBasis[] = ["orders", "wishlist", "recently_viewed", "favourites"];

/**
 * Northern-hemisphere meteorological seasons, indexed by month 1–12.
 *
 * The store is in London and prices in GBP, so a single hemisphere is the honest
 * mapping rather than a limitation — inferring hemisphere from a delivery address
 * would read an address for a purpose the customer did not give it for.
 */
const SEASON_BY_MONTH: readonly string[] = [
  "", // index 0 unused: months are 1-based
  "winter", // January
  "winter", // February
  "spring", // March
  "spring", // April
  "spring", // May
  "summer", // June
  "summer", // July
  "summer", // August
  "autumn", // September
  "autumn", // October
  "autumn", // November
  "winter", // December
];

/**
 * Ranks counted values by (count DESCENDING, key ASCENDING) and takes the top `n`.
 *
 * The key tie-break is not cosmetic. Without it, two families with equal counts
 * would be ordered by whatever the map yielded, which varies with insertion order
 * and would make the same inputs produce different bytes — the exact failure
 * Property 8 exists to catch.
 */
function rank(counts: ReadonlyMap<string, Set<string>>, n: number): readonly InferredRanking[] {
  return [...counts.entries()]
    .map(([value, products]) => ({ value, distinctProducts: products.size }))
    .filter((entry) => entry.distinctProducts > 0)
    .sort((a, b) =>
      b.distinctProducts !== a.distinctProducts
        ? b.distinctProducts - a.distinctProducts
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0,
    )
    .slice(0, n);
}

/**
 * Computes the inferred block from one customer's own activity.
 *
 * SYNCHRONOUS ON PURPOSE. There is no `await` and no promise, so adding an
 * external recommendation call would require changing this signature and every
 * caller — which turns Requirement 12.5 from a rule someone must remember into a
 * change that cannot be made quietly. `inferred.test.ts` asserts it.
 */
export function deriveInferredSignal(
  inputs: InferredInputs,
  taxonomy: ProductTaxonomy = EMPTY_PRODUCT_TAXONOMY,
): InferredSignal {
  // ── The union of touched products, deduplicated ──────────────────────────
  //
  // One SET across all four sources, so a product that was viewed, wishlisted and
  // bought counts once. Sorted before use: the taxonomy lookup cannot depend on
  // iteration order, but a sort here makes that independence provable rather than
  // incidental, and costs nothing at these sizes.
  const touched = new Set<string>([
    ...inputs.purchasedProductIds,
    ...inputs.wishlistProductIds,
    ...inputs.favouriteProductIds,
    ...inputs.recentlyViewedProductIds,
  ]);
  const productIds = [...touched].sort();

  const familyProducts = new Map<string, Set<string>>();
  const noteProducts = new Map<string, Set<string>>();

  for (const productId of productIds) {
    const entry = taxonomy.lookup(productId);
    if (entry === undefined) continue;
    // Dedupe within a product too: a product tagged `oud` twice is one product for
    // `oud`, and the set makes that true without a uniqueness assumption about the
    // taxonomy data.
    for (const family of entry.families) {
      let bucket = familyProducts.get(family);
      if (bucket === undefined) {
        bucket = new Set<string>();
        familyProducts.set(family, bucket);
      }
      bucket.add(productId);
    }
    for (const note of entry.notes) {
      let bucket = noteProducts.get(note);
      if (bucket === undefined) {
        bucket = new Set<string>();
        noteProducts.set(note, bucket);
      }
      bucket.add(productId);
    }
  }

  const scentFamily = rank(familyProducts, INFERRED_TOP_N);
  const note = rank(noteProducts, INFERRED_TOP_N);

  // ── Season (§12.3 rule 4) ────────────────────────────────────────────────
  //
  // Gated on the order count, not the month count: three orders in one month is
  // still three orders, and the gate is about how much evidence exists.
  let season: InferredRanking | null = null;
  if (inputs.orderMonths.length >= SEASON_MIN_ORDERS) {
    const seasonOrders = new Map<string, Set<string>>();
    inputs.orderMonths.forEach((month, index) => {
      const name = SEASON_BY_MONTH[month];
      // An out-of-range month is DROPPED rather than clamped. Clamping December+1
      // into January would invent a season from a defect.
      if (name === undefined || name === "") return;
      let bucket = seasonOrders.get(name);
      if (bucket === undefined) {
        bucket = new Set<string>();
        seasonOrders.set(name, bucket);
      }
      // Keyed by position so two orders in the same month both count — here the
      // unit of evidence is the order, not the product.
      bucket.add(String(index));
    });
    season = rank(seasonOrders, 1)[0] ?? null;
  }

  // ── Insight (§12.3 rule 5, Req 4.9) ─────────────────────────────────────
  //
  // The single highest-count family, and only with at least two distinct products.
  // `scentFamily[0]` is already the highest by the total ordering above, so this
  // re-ranks nothing and cannot disagree with the block it sits beside.
  const top = scentFamily[0];
  const insight: InferredInsight | null =
    top !== undefined && top.distinctProducts >= INSIGHT_MIN_DISTINCT_PRODUCTS
      ? { kind: "family_concentration", value: top.value, distinctProducts: top.distinctProducts }
      : null;

  // ── Basis ───────────────────────────────────────────────────────────────
  const present = new Set<InferredBasis>();
  if (inputs.purchasedProductIds.length > 0) present.add("orders");
  if (inputs.wishlistProductIds.length > 0) present.add("wishlist");
  if (inputs.recentlyViewedProductIds.length > 0) present.add("recently_viewed");
  if (inputs.favouriteProductIds.length > 0) present.add("favourites");

  return {
    basis: BASIS_ORDER.filter((name) => present.has(name)),
    scent_family: scentFamily,
    note,
    season,
    occasion: null,
    insight,
  };
}

/**
 * Derives {@link InferredInputs.orderMonths} from per-product purchase instants.
 *
 * See that field's documentation for why this is a lower bound. Distinct INSTANTS
 * are counted, so a multi-product order contributes one month; a malformed or
 * absent timestamp contributes nothing rather than a guessed month.
 *
 * Returns months sorted ascending so the value is a function of the input SET and
 * not of the order the records arrived in.
 */
export function orderMonthsFromPurchaseInstants(
  instants: readonly (string | null)[],
): readonly number[] {
  const byInstant = new Map<string, number>();
  for (const instant of instants) {
    if (instant === null || instant === "") continue;
    const at = new Date(instant);
    if (Number.isNaN(at.getTime())) continue;
    // UTC, not local: the month must not depend on the server's zone, which would
    // make the same data yield different seasons on two machines.
    byInstant.set(at.toISOString(), at.getUTCMonth() + 1);
  }
  return [...byInstant.values()].sort((a, b) => a - b);
}
