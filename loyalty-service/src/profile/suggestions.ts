/**
 * Rules-based fragrance suggestions behind a stable interface (task 14.4).
 *
 * Part of the Profile / Preferences Service (design.md "Component 9"). Implements
 * the design responsibility of composing "rules-based suggestions (A11, behind a
 * stable interface)" for the Fragrance_Profile, and backs
 * `ProfileService.getSuggestions(customerId): Promise<string[]>` /
 * `GET /v1/profile/suggestions` (Requirement 17.6, 17.7).
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *   - Req 17.6: suggestions are computed from the customer's purchase and view
 *     history, and every fragrance the customer has ALREADY PURCHASED is
 *     excluded from the result.
 *   - Req 17.7 / A11: the suggestion logic sits behind the stable
 *     {@link SuggestionEngine} interface whose OUTPUT is a plain
 *     `string[]` of suggested Shopify product ids — exactly the `/v1`
 *     Fragrance_Profile suggestion contract. A richer/model-based engine can
 *     replace {@link RulesBasedSuggestionEngine} WITHOUT changing that contract,
 *     because callers depend only on the interface, not the implementation.
 *
 * INJECTABLE DATA SOURCE (no live Shopify)
 * ----------------------------------------
 * Product/order data is reached ONLY through the injected
 * {@link SuggestionDataSource}. Production wires an implementation backed by
 * Shopify (paid orders → purchase history) and the off-ledger recently-viewed
 * store (task 14.3 → view history); tests inject a fake so NO live Shopify Admin
 * API is ever called during verification. This module itself performs pure
 * ranking/filtering and holds no I/O.
 *
 * OFF-LEDGER: computing suggestions reads only behavioural/preference data
 * (purchases + views) and NEVER touches `ledger_entries`, `point_lots`, or any
 * balance-bearing table, so it can never affect a customer's Balance or
 * Spendable_Balance (Req 17.3 / Property 13).
 *
 * SAFETY: defining this module touches no live/production system. It performs
 * network/DB access only via whatever {@link SuggestionDataSource} a caller
 * injects at runtime.
 */

/* ------------------------------- domain types ------------------------------ */

/**
 * A single product the customer has purchased, derived from that customer's
 * paid Shopify orders (Req 17.1 / 17.6). `purchasedAt` is optional so richer
 * engines can weight recency; the rules-based engine uses it only for
 * deterministic ordering when present.
 */
export interface PurchaseEvent {
  /** Shopify product id of the purchased fragrance. */
  productId: string;
  /** When the purchase occurred, if known. */
  purchasedAt?: Date;
}

/**
 * A single product-view event from the customer's recently-viewed history
 * (task 14.3). Repeated `productId`s across the array represent repeat views and
 * increase that product's view frequency for ranking.
 */
export interface ViewEvent {
  /** Shopify product id of the viewed fragrance. */
  productId: string;
  /** When the view occurred, if known. */
  viewedAt?: Date;
}

/**
 * The stable INPUT to the suggestion engine: the customer's purchase history and
 * view history (Req 17.6). This is what every {@link SuggestionEngine}
 * implementation — rules-based today, richer tomorrow — receives.
 */
export interface SuggestionInput {
  /** Products the customer has already purchased (used to EXCLUDE, Req 17.6). */
  purchaseHistory: readonly PurchaseEvent[];
  /** Products the customer has viewed (the candidate source, Req 17.6). */
  viewHistory: readonly ViewEvent[];
}

/**
 * The STABLE suggestion interface (Req 17.7 / A11).
 *
 * Input: purchase history + view history. Output: an ordered list of suggested
 * Shopify product ids. This `string[]` output IS the `/v1` Fragrance_Profile
 * suggestion contract; keeping callers bound to this interface lets a richer
 * recommendation engine replace the rules-based one without any `/v1` change.
 */
export interface SuggestionEngine {
  /**
   * Compute suggested product ids from the customer's purchase and view history.
   * Implementations MUST NOT return any product present in `purchaseHistory`
   * (Req 17.6). The result is ordered most-relevant-first and contains no
   * duplicates.
   */
  suggest(input: SuggestionInput): string[];
}

/**
 * The injectable boundary to product/order data (no live Shopify in tests).
 *
 * Production supplies an implementation that reads the customer's purchase
 * history from paid Shopify orders and view history from the off-ledger
 * recently-viewed store; tests supply a fake. The orchestrator
 * {@link getSuggestions} depends only on this interface.
 */
export interface SuggestionDataSource {
  /** Products the customer has purchased (from that customer's paid Shopify orders). */
  getPurchaseHistory(customerId: string): Promise<readonly PurchaseEvent[]>;
  /** Products the customer has recently viewed (within the retention window, task 14.3). */
  getViewHistory(customerId: string): Promise<readonly ViewEvent[]>;
}

/* --------------------------------- errors --------------------------------- */

/** Stable machine-readable error codes surfaced to callers. */
export const SUGGESTION_ERROR_CODES = {
  invalidInput: "suggestion_invalid_input",
} as const;

/** Thrown when a caller supplies an invalid customer id. No state is changed. */
export class InvalidSuggestionInputError extends Error {
  readonly code = SUGGESTION_ERROR_CODES.invalidInput;
  constructor(message: string) {
    super(message);
    this.name = "InvalidSuggestionInputError";
  }
}

/* -------------------------------- helpers --------------------------------- */

/**
 * Normalises a product id for comparison: trims surrounding whitespace and
 * returns `null` for anything empty/non-string so malformed history entries are
 * ignored rather than surfaced as suggestions. Ids are treated as opaque
 * strings (Shopify product ids) so this module stays decoupled from id shape.
 */
function normaliseProductId(productId: unknown): string | null {
  if (typeof productId !== "string") {
    return null;
  }
  const trimmed = productId.trim();
  return trimmed === "" ? null : trimmed;
}

/** Validates a local `customers.id`. */
function requireCustomerId(customerId: string): string {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new InvalidSuggestionInputError("customerId must be a non-empty string.");
  }
  return customerId;
}

/** Latest timestamp helper: returns the max of two optional dates, if any. */
function laterOf(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/* -------------------------- rules-based engine ---------------------------- */

/** Tuning knobs for {@link RulesBasedSuggestionEngine}. */
export interface RulesBasedSuggestionOptions {
  /**
   * Maximum number of suggestions to return. Defaults to 10. A non-positive or
   * non-integer value falls back to the default.
   */
  maxSuggestions?: number;
}

/** Default cap on the number of suggestions returned (Req 17.6, MVP). */
export const DEFAULT_MAX_SUGGESTIONS = 10 as const;

/** Internal per-candidate ranking accumulator. */
interface Candidate {
  productId: string;
  /** Number of times the product appears in the view history (frequency). */
  views: number;
  /** Most recent view timestamp, if any (recency tie-breaker). */
  lastViewedAt?: Date;
  /** First position in the view history (stable-order tie-breaker). */
  firstSeenIndex: number;
}

/**
 * The MVP rules-based suggestion engine (A11).
 *
 * RULES (deterministic):
 *   1. Candidates are the products in the customer's VIEW history — fragrances
 *      the customer showed interest in.
 *   2. Any product the customer has ALREADY PURCHASED is EXCLUDED (Req 17.6):
 *      purchase history is the exclusion filter, so a purchased fragrance never
 *      appears as a suggestion.
 *   3. Remaining candidates are ranked by view FREQUENCY (descending), then by
 *      most-recent view (descending), then by first appearance in the view
 *      history (ascending) so the ordering is fully deterministic and stable.
 *   4. The result is de-duplicated and truncated to `maxSuggestions`.
 *
 * This "viewed-but-not-purchased, most-engaged-first" rule is intentionally
 * simple; because it lives behind {@link SuggestionEngine}, it can later be
 * swapped for content/collaborative logic with no `/v1` contract change
 * (Req 17.7).
 */
export class RulesBasedSuggestionEngine implements SuggestionEngine {
  private readonly maxSuggestions: number;

  constructor(options: RulesBasedSuggestionOptions = {}) {
    const requested = options.maxSuggestions;
    this.maxSuggestions =
      typeof requested === "number" && Number.isInteger(requested) && requested > 0
        ? requested
        : DEFAULT_MAX_SUGGESTIONS;
  }

  suggest(input: SuggestionInput): string[] {
    const purchaseHistory = input?.purchaseHistory ?? [];
    const viewHistory = input?.viewHistory ?? [];

    // (2) Build the exclusion set from purchase history (Req 17.6).
    const purchased = new Set<string>();
    for (const event of purchaseHistory) {
      const id = normaliseProductId(event?.productId);
      if (id !== null) {
        purchased.add(id);
      }
    }

    // (1)+(3) Fold the view history into ranked candidates, skipping purchased.
    const candidates = new Map<string, Candidate>();
    let index = 0;
    for (const event of viewHistory) {
      const id = normaliseProductId(event?.productId);
      const position = index++;
      if (id === null || purchased.has(id)) {
        continue; // ignore malformed or already-purchased products (Req 17.6)
      }
      const existing = candidates.get(id);
      if (existing) {
        existing.views += 1;
        existing.lastViewedAt = laterOf(existing.lastViewedAt, event?.viewedAt);
      } else {
        candidates.set(id, {
          productId: id,
          views: 1,
          lastViewedAt: event?.viewedAt,
          firstSeenIndex: position,
        });
      }
    }

    // (3) Deterministic ranking: frequency desc, recency desc, first-seen asc.
    const ranked = [...candidates.values()].sort((a, b) => {
      if (b.views !== a.views) {
        return b.views - a.views;
      }
      const aTime = a.lastViewedAt?.getTime() ?? -Infinity;
      const bTime = b.lastViewedAt?.getTime() ?? -Infinity;
      if (bTime !== aTime) {
        return bTime - aTime;
      }
      return a.firstSeenIndex - b.firstSeenIndex;
    });

    // (4) De-duplicated by construction (Map); truncate to the cap.
    return ranked.slice(0, this.maxSuggestions).map((c) => c.productId);
  }
}

/* ------------------------------ orchestrator ------------------------------ */

/**
 * Composes the Fragrance_Profile suggestions for a customer (design
 * `ProfileService.getSuggestions`).
 *
 * It pulls the customer's purchase and view history from the injected
 * {@link SuggestionDataSource} (Shopify + recently-viewed in production; a fake
 * in tests — never live Shopify in tests) and delegates the ranking to the
 * supplied {@link SuggestionEngine}. The returned `string[]` is the stable `/v1`
 * suggestion contract (Req 17.7).
 *
 * DEFENCE-IN-DEPTH (Req 17.6): as a final guarantee at the `/v1` contract
 * boundary, any product present in the purchase history is filtered out of the
 * engine's result. This ensures an already-purchased fragrance can never be
 * suggested REGARDLESS of which engine implementation is plugged in — so
 * swapping in a richer engine cannot regress Req 17.6.
 *
 * @param customerId the local `customers.id` whose profile is being read.
 * @param dataSource injectable product/order + view-history source (fake in tests).
 * @param engine     the suggestion engine (defaults to {@link RulesBasedSuggestionEngine}).
 * @throws {@link InvalidSuggestionInputError} when `customerId` is empty/blank.
 */
export async function getSuggestions(
  customerId: string,
  dataSource: SuggestionDataSource,
  engine: SuggestionEngine = new RulesBasedSuggestionEngine(),
): Promise<string[]> {
  const cid = requireCustomerId(customerId);

  const [purchaseHistory, viewHistory] = await Promise.all([
    dataSource.getPurchaseHistory(cid),
    dataSource.getViewHistory(cid),
  ]);

  const suggestions = engine.suggest({ purchaseHistory, viewHistory });

  // Final Req 17.6 guarantee, independent of the engine implementation.
  const purchased = new Set<string>();
  for (const event of purchaseHistory) {
    const id = normaliseProductId(event?.productId);
    if (id !== null) {
      purchased.add(id);
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of suggestions) {
    const id = normaliseProductId(raw);
    if (id === null || purchased.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}
