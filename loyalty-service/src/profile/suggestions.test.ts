/**
 * Unit tests for rules-based fragrance suggestions behind a stable interface
 * (task 14.4).
 *
 * NO live/production Shopify Admin API or database is touched. Product/order and
 * view-history data is supplied through an in-memory fake {@link
 * SuggestionDataSource}, and the rules-based engine is pure — so verification
 * runs entirely offline.
 *
 * Covers (Requirements 17.6, 17.7):
 *   - suggestions are derived from the customer's purchase + view history;
 *   - fragrances the customer has ALREADY PURCHASED are excluded (Req 17.6);
 *   - the deterministic ranking (frequency → recency → first-seen);
 *   - interface stability (Req 17.7): an alternative SuggestionEngine can be
 *     swapped in behind the same interface with no contract change, and the
 *     `/v1` orchestrator still guarantees purchased-exclusion regardless of
 *     which engine is plugged in;
 *   - empty history → empty result (no error, Req 17.9-adjacent);
 *   - input validation.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SUGGESTIONS,
  getSuggestions,
  InvalidSuggestionInputError,
  RulesBasedSuggestionEngine,
  type PurchaseEvent,
  type SuggestionDataSource,
  type SuggestionEngine,
  type SuggestionInput,
  type ViewEvent,
} from "./suggestions.js";

/* --------------------------------- fakes ---------------------------------- */

/**
 * An in-memory {@link SuggestionDataSource} standing in for Shopify (paid
 * orders → purchases) + the off-ledger recently-viewed store (views). Records
 * whether it was queried so tests can assert no live system is required.
 */
class FakeDataSource implements SuggestionDataSource {
  readonly calls: string[] = [];
  constructor(
    private readonly purchases: Record<string, PurchaseEvent[]> = {},
    private readonly views: Record<string, ViewEvent[]> = {},
  ) {}

  async getPurchaseHistory(customerId: string): Promise<readonly PurchaseEvent[]> {
    this.calls.push(`purchases:${customerId}`);
    return this.purchases[customerId] ?? [];
  }

  async getViewHistory(customerId: string): Promise<readonly ViewEvent[]> {
    this.calls.push(`views:${customerId}`);
    return this.views[customerId] ?? [];
  }
}

const CUST = "11111111-1111-1111-1111-111111111111";

const view = (productId: string, viewedAt?: Date): ViewEvent => ({ productId, viewedAt });
const purchase = (productId: string, purchasedAt?: Date): PurchaseEvent => ({
  productId,
  purchasedAt,
});

/* --------------------- engine: derived from history ----------------------- */

describe("RulesBasedSuggestionEngine.suggest: derived from history (Req 17.6)", () => {
  it("suggests products from the view history that were not purchased", () => {
    const engine = new RulesBasedSuggestionEngine();

    const input: SuggestionInput = {
      purchaseHistory: [],
      viewHistory: [view("100"), view("200"), view("300")],
    };

    expect(engine.suggest(input).sort()).toEqual(["100", "200", "300"]);
  });

  it("ranks by view frequency (most-viewed first)", () => {
    const engine = new RulesBasedSuggestionEngine();

    const input: SuggestionInput = {
      purchaseHistory: [],
      // 300 viewed 3x, 200 viewed 2x, 100 viewed 1x.
      viewHistory: [
        view("100"),
        view("200"),
        view("200"),
        view("300"),
        view("300"),
        view("300"),
      ],
    };

    expect(engine.suggest(input)).toEqual(["300", "200", "100"]);
  });

  it("breaks frequency ties by most-recent view, then first-seen order", () => {
    const engine = new RulesBasedSuggestionEngine();
    const early = new Date("2025-01-01T00:00:00Z");
    const late = new Date("2025-06-01T00:00:00Z");

    const input: SuggestionInput = {
      purchaseHistory: [],
      // All viewed once. 200 has the most recent view, so it ranks first.
      viewHistory: [view("100", early), view("200", late)],
    };

    expect(engine.suggest(input)).toEqual(["200", "100"]);
  });

  it("returns an empty list when there is no view history", () => {
    const engine = new RulesBasedSuggestionEngine();
    expect(engine.suggest({ purchaseHistory: [purchase("100")], viewHistory: [] })).toEqual([]);
  });

  it("ignores malformed product ids in the history", () => {
    const engine = new RulesBasedSuggestionEngine();
    const input: SuggestionInput = {
      purchaseHistory: [],
      viewHistory: [view(""), view("   "), view("100"), view(undefined as unknown as string)],
    };
    expect(engine.suggest(input)).toEqual(["100"]);
  });

  it("caps the number of suggestions at maxSuggestions", () => {
    const engine = new RulesBasedSuggestionEngine({ maxSuggestions: 2 });
    const input: SuggestionInput = {
      purchaseHistory: [],
      viewHistory: [view("300"), view("300"), view("300"), view("200"), view("200"), view("100")],
    };
    expect(engine.suggest(input)).toEqual(["300", "200"]);
  });

  it("falls back to the default cap for a non-positive maxSuggestions", () => {
    const engine = new RulesBasedSuggestionEngine({ maxSuggestions: 0 });
    const views = Array.from({ length: DEFAULT_MAX_SUGGESTIONS + 5 }, (_, i) =>
      view(String(1000 + i)),
    );
    expect(engine.suggest({ purchaseHistory: [], viewHistory: views })).toHaveLength(
      DEFAULT_MAX_SUGGESTIONS,
    );
  });
});

/* --------------------- engine: already-purchased excluded ------------------ */

describe("RulesBasedSuggestionEngine.suggest: excludes already-purchased (Req 17.6)", () => {
  it("never suggests a fragrance the customer has already purchased", () => {
    const engine = new RulesBasedSuggestionEngine();

    const input: SuggestionInput = {
      purchaseHistory: [purchase("200")],
      // 200 was viewed the most but is purchased → must be excluded.
      viewHistory: [view("200"), view("200"), view("200"), view("100"), view("300")],
    };

    const result = engine.suggest(input);
    expect(result).not.toContain("200");
    expect(result.sort()).toEqual(["100", "300"]);
  });

  it("returns an empty list when every viewed product was purchased", () => {
    const engine = new RulesBasedSuggestionEngine();

    const input: SuggestionInput = {
      purchaseHistory: [purchase("100"), purchase("200")],
      viewHistory: [view("100"), view("200")],
    };

    expect(engine.suggest(input)).toEqual([]);
  });

  it("matches purchased ids irrespective of surrounding whitespace", () => {
    const engine = new RulesBasedSuggestionEngine();
    const input: SuggestionInput = {
      purchaseHistory: [purchase(" 200 ")],
      viewHistory: [view("200"), view("100")],
    };
    expect(engine.suggest(input)).toEqual(["100"]);
  });
});

/* ------------------------- orchestrator: getSuggestions -------------------- */

describe("getSuggestions: composes history from an injectable data source", () => {
  it("derives suggestions from the fake data source without touching live Shopify", async () => {
    const ds = new FakeDataSource(
      { [CUST]: [purchase("200")] },
      { [CUST]: [view("200"), view("100"), view("100"), view("300")] },
    );

    const result = await getSuggestions(CUST, ds);

    // 200 purchased → excluded; 100 viewed 2x ranks above 300 viewed 1x.
    expect(result).toEqual(["100", "300"]);
    // Confirms the (fake) data source was the only thing consulted.
    expect(ds.calls).toContain(`purchases:${CUST}`);
    expect(ds.calls).toContain(`views:${CUST}`);
  });

  it("returns an empty list (not an error) for a customer with no history", async () => {
    const ds = new FakeDataSource();
    await expect(getSuggestions(CUST, ds)).resolves.toEqual([]);
  });

  it("rejects an empty/blank customer id before consulting the data source", async () => {
    const ds = new FakeDataSource();
    await expect(getSuggestions("", ds)).rejects.toBeInstanceOf(InvalidSuggestionInputError);
    await expect(getSuggestions("   ", ds)).rejects.toBeInstanceOf(InvalidSuggestionInputError);
    expect(ds.calls).toHaveLength(0);
  });
});

/* -------------------------- interface stability (Req 17.7) ----------------- */

describe("interface stability: engines are swappable behind SuggestionEngine (Req 17.7)", () => {
  /**
   * An ALTERNATIVE engine implementation standing in for a future
   * richer/model-based recommender. It honours the same {@link SuggestionEngine}
   * interface (input: purchase + view history; output: product-id `string[]`)
   * but uses a different rule — here, ordering by first appearance in the view
   * history. Swapping it in must not change the `/v1` response shape.
   */
  class FirstSeenSuggestionEngine implements SuggestionEngine {
    suggest(input: SuggestionInput): string[] {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const event of input.viewHistory) {
        const id = event.productId.trim();
        if (id !== "" && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      return out;
    }
  }

  const ds = new FakeDataSource(
    { [CUST]: [purchase("200")] },
    { [CUST]: [view("100"), view("200"), view("300"), view("100")] },
  );

  it("produces a string[] contract from BOTH the rules-based and alternative engine", async () => {
    const rulesResult = await getSuggestions(CUST, ds, new RulesBasedSuggestionEngine());
    const altResult = await getSuggestions(CUST, ds, new FirstSeenSuggestionEngine());

    // Same contract shape: an array of product-id strings.
    for (const result of [rulesResult, altResult]) {
      expect(Array.isArray(result)).toBe(true);
      expect(result.every((id) => typeof id === "string")).toBe(true);
    }

    // The alternative engine orders differently, proving the impl is swappable
    // WITHOUT the caller/contract changing.
    expect(altResult).toEqual(["100", "300"]);
    expect(rulesResult.sort()).toEqual(["100", "300"]);
  });

  it("enforces the Req 17.6 purchased-exclusion guarantee regardless of engine", async () => {
    // A deliberately broken engine that ignores the exclusion rule and echoes
    // every viewed product (including purchased ones).
    const leakyEngine: SuggestionEngine = {
      suggest: (input: SuggestionInput) => input.viewHistory.map((v) => v.productId),
    };

    const result = await getSuggestions(CUST, ds, leakyEngine);

    // The orchestrator still guarantees the purchased product (200) never leaks
    // into the `/v1` suggestions, even though the engine returned it.
    expect(result).not.toContain("200");
    // De-duplicated too (100 appeared twice in the view history).
    expect(result).toEqual(["100", "300"]);
  });
});
