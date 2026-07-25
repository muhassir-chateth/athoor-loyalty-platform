/**
 * Unit tests for Fragrance_Profile composition + Fragrance_Journey_Timeline
 * (task 14.5, Requirement 17).
 *
 * NO live/production Shopify Admin API or database is touched. Product/order and
 * preference data is supplied through an in-memory fake
 * {@link InMemoryFragranceProfileDataSource}; the composition and journey
 * builder are pure, so verification runs entirely offline.
 *
 * Covers:
 *   - 17.1/17.10: purchased fragrances come solely from the (injected) Shopify
 *     source; only the requesting customer's data is returned;
 *   - 17.8: the journey timeline returns first purchase, favourites added, and
 *     tier changes, ordered chronologically;
 *   - 17.9: empty categories return empty arrays, never an error;
 *   - input validation (the sole rejectable condition).
 */
import { describe, expect, it } from "vitest";
import {
  buildJourneyTimeline,
  FragranceProfileService,
  InMemoryFragranceProfileDataSource,
  InvalidFragranceProfileInputError,
  type FavouriteRecord,
  type PurchasedFragrance,
  type TierChangeRecord,
} from "./fragranceProfile.js";

const CUST = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const purchase = (
  productId: string,
  firstPurchasedAt: string | null = null,
  extra: Partial<PurchasedFragrance> = {},
): PurchasedFragrance => ({
  productId,
  title: extra.title ?? null,
  firstPurchasedAt,
  lastPurchasedAt: extra.lastPurchasedAt ?? firstPurchasedAt,
  purchaseCount: extra.purchaseCount ?? 1,
});

const favourite = (productId: string, addedAt: string | null = null): FavouriteRecord => ({
  productId,
  addedAt,
});

const tierChange = (
  toTier: string,
  at: string,
  fromTier: string | null = null,
  reason = "order completion",
): TierChangeRecord => ({ fromTier, toTier, at, reason });

/* ----------------------------- journey builder ---------------------------- */

describe("buildJourneyTimeline (Req 17.8)", () => {
  it("emits a single first-purchase milestone at the earliest dated purchase", () => {
    const journey = buildJourneyTimeline(
      [
        purchase("100", "2024-03-01T00:00:00.000Z"),
        purchase("200", "2024-01-01T00:00:00.000Z"),
        purchase("300", "2024-02-01T00:00:00.000Z"),
      ],
      [],
      [],
    );
    const firsts = journey.filter((m) => m.type === "first_purchase");
    expect(firsts).toHaveLength(1);
    expect(firsts[0]).toMatchObject({ productId: "200", at: "2024-01-01T00:00:00.000Z" });
  });

  it("emits one favourite_added milestone per dated favourite", () => {
    const journey = buildJourneyTimeline(
      [],
      [favourite("100", "2024-05-01T00:00:00.000Z"), favourite("200", "2024-06-01T00:00:00.000Z")],
      [],
    );
    expect(journey.filter((m) => m.type === "favourite_added").map((m) => m.productId)).toEqual([
      "100",
      "200",
    ]);
  });

  it("emits one tier_change milestone per change, carrying from/to tiers", () => {
    const journey = buildJourneyTimeline(
      [],
      [],
      [tierChange("silver", "2024-07-01T00:00:00.000Z", "bronze")],
    );
    expect(journey).toHaveLength(1);
    expect(journey[0]).toMatchObject({
      type: "tier_change",
      fromTier: "bronze",
      toTier: "silver",
    });
  });

  it("orders all milestone kinds chronologically, oldest first", () => {
    const journey = buildJourneyTimeline(
      [purchase("100", "2024-01-01T00:00:00.000Z")],
      [favourite("200", "2024-03-01T00:00:00.000Z")],
      [tierChange("silver", "2024-02-01T00:00:00.000Z", "bronze")],
    );
    expect(journey.map((m) => m.type)).toEqual([
      "first_purchase",
      "tier_change",
      "favourite_added",
    ]);
    // Strictly ascending timestamps.
    const times = journey.map((m) => Date.parse(m.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("omits milestones that carry no timestamp (nothing to place chronologically)", () => {
    const journey = buildJourneyTimeline(
      [purchase("100", null)],
      [favourite("200", null)],
      [],
    );
    expect(journey).toEqual([]);
  });

  it("returns an empty timeline for a customer with no history (Req 17.9)", () => {
    expect(buildJourneyTimeline([], [], [])).toEqual([]);
  });
});

/* --------------------------- profile composition -------------------------- */

describe("FragranceProfileService.getFragranceProfile (Req 17.1/17.2/17.4/17.5/17.6/17.8)", () => {
  it("composes purchases, favourites, wishlist, recently-viewed, suggestions, and journey", async () => {
    const ds = new InMemoryFragranceProfileDataSource({
      purchasedFragrances: { [CUST]: [purchase("100", "2024-01-01T00:00:00.000Z")] },
      favourites: { [CUST]: [favourite("200", "2024-02-01T00:00:00.000Z")] },
      wishlist: { [CUST]: ["300", "400"] },
      recentlyViewed: { [CUST]: [{ productId: "500", viewedAt: "2024-03-01T00:00:00.000Z" }] },
      suggestions: { [CUST]: ["600"] },
      tierChanges: { [CUST]: [tierChange("silver", "2024-02-15T00:00:00.000Z", "bronze")] },
    });
    const service = new FragranceProfileService(ds);

    const profile = await service.getFragranceProfile(CUST);

    expect(profile.customerId).toBe(CUST);
    expect(profile.purchasedFragrances.map((p) => p.productId)).toEqual(["100"]);
    expect(profile.favourites).toEqual(["200"]);
    expect(profile.wishlist).toEqual(["300", "400"]);
    expect(profile.recentlyViewed.map((r) => r.productId)).toEqual(["500"]);
    expect(profile.suggestions).toEqual(["600"]);
    // Chronological: purchase 01-01, favourite 02-01, tier change 02-15.
    expect(profile.journey.map((m) => m.type)).toEqual([
      "first_purchase",
      "favourite_added",
      "tier_change",
    ]);
  });

  it("returns empty categories (not an error) for a customer with no data (Req 17.9)", async () => {
    const service = new FragranceProfileService(new InMemoryFragranceProfileDataSource());
    const profile = await service.getFragranceProfile(CUST);
    expect(profile).toEqual({
      customerId: CUST,
      purchasedFragrances: [],
      favourites: [],
      wishlist: [],
      recentlyViewed: [],
      suggestions: [],
      journey: [],
    });
  });

  it("returns only the requesting customer's data (Req 17.10)", async () => {
    const ds = new InMemoryFragranceProfileDataSource({
      purchasedFragrances: {
        [CUST]: [purchase("100")],
        [OTHER]: [purchase("999")],
      },
      wishlist: { [OTHER]: ["888"] },
    });
    const service = new FragranceProfileService(ds);

    const profile = await service.getFragranceProfile(CUST);
    expect(profile.purchasedFragrances.map((p) => p.productId)).toEqual(["100"]);
    expect(profile.purchasedFragrances.map((p) => p.productId)).not.toContain("999");
    expect(profile.wishlist).toEqual([]); // OTHER's wishlist never leaks
  });

  it("rejects an empty/blank customer id", async () => {
    const service = new FragranceProfileService(new InMemoryFragranceProfileDataSource());
    await expect(service.getFragranceProfile("")).rejects.toBeInstanceOf(
      InvalidFragranceProfileInputError,
    );
    await expect(service.getFragranceProfile("   ")).rejects.toBeInstanceOf(
      InvalidFragranceProfileInputError,
    );
  });
});

describe("FragranceProfileService.getJourneyTimeline (Req 17.8/17.9)", () => {
  it("returns only the chronological milestones", async () => {
    const ds = new InMemoryFragranceProfileDataSource({
      purchasedFragrances: { [CUST]: [purchase("100", "2024-01-01T00:00:00.000Z")] },
      favourites: { [CUST]: [favourite("200", "2024-04-01T00:00:00.000Z")] },
      tierChanges: { [CUST]: [tierChange("silver", "2024-02-01T00:00:00.000Z", "bronze")] },
    });
    const service = new FragranceProfileService(ds);

    const journey = await service.getJourneyTimeline(CUST);
    expect(journey.map((m) => m.type)).toEqual([
      "first_purchase",
      "tier_change",
      "favourite_added",
    ]);
  });

  it("returns an empty timeline for a customer with no history (Req 17.9)", async () => {
    const service = new FragranceProfileService(new InMemoryFragranceProfileDataSource());
    await expect(service.getJourneyTimeline(CUST)).resolves.toEqual([]);
  });
});
